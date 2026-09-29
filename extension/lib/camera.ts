/**
 * Camera acquisition for the fitting room.
 *
 * Decart's realtime models carry a preferred capture size, but a desktop webcam is free to
 * refuse it: plenty of built-in and external webcams do not offer the model's exact
 * width/height, or offer it at a different frame rate, and Chrome then fails the whole
 * `getUserMedia` call with `OverconstrainedError` (or `NotFoundError` when the constraint set
 * matches no device at all). The camera works fine, so we retry once with the generic
 * `{ video: true }` request that the grant page already uses successfully.
 *
 * Exactly two rules keep this from becoming a retry loop or a permission bug:
 *   - `NotAllowedError` is NEVER retried. A denied permission is final; retrying only
 *     re-prompts and would turn a permission problem into a misleading "no camera" problem.
 *   - There is no third attempt and no backoff. Preferred, then generic, then done.
 *
 * The generic stream is an ordinary `MediaStream`: the same track reaches MediaPipe for framing
 * and Decart for realtime, and `stopStream` tears it down on the room's existing teardown path.
 */

/** The subset of Decart's model capture description this helper needs. */
export type PreferredCapture = {
  width: number
  height: number
  fps: number | { max?: number; min?: number; ideal?: number; exact?: number }
}

/** The `navigator.mediaDevices` surface used here. Injectable so tests need no browser. */
export type CameraMediaDevices = {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  getSupportedConstraints?(): MediaTrackSupportedConstraints
  enumerateDevices?(): Promise<MediaDeviceInfo[]>
}

/**
 * The only two failure names that mean "these constraints didn't work, try simpler ones".
 * Anything else — permission denied, a device in use, a hardware error — is final.
 */
const RETRYABLE = new Set(["NotFoundError", "OverconstrainedError"])

/** The generic request, also used by the full-tab grant page. */
const GENERIC_CONSTRAINTS: MediaStreamConstraints = { video: true, audio: false }

/**
 * `MediaTrackSettings` carries `deviceId` and `groupId` on some platforms, so diagnostics copy
 * an explicit allowlist rather than spreading the object. Nothing identifying may be logged.
 */
const SAFE_TRACK_SETTINGS = [
  "aspectRatio",
  "channelCount",
  "displaySurface",
  "facingMode",
  "frameRate",
  "height",
  "resizeMode",
  "sampleRate",
  "width"
] as const

const errorName = (error: unknown): string =>
  typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "UnknownError"

/** Supported constraint flags. A map of booleans; nothing sensitive. */
function supportedConstraints(media: CameraMediaDevices): MediaTrackSupportedConstraints | "unavailable" {
  try {
    return media.getSupportedConstraints?.() ?? "unavailable"
  } catch {
    return "unavailable"
  }
}

/** How many cameras the browser can see. A count only — never ids, labels or groups. */
async function videoInputCount(media: CameraMediaDevices): Promise<number | "unavailable"> {
  try {
    const devices = await media.enumerateDevices?.()
    if (!devices) return "unavailable"
    return devices.filter(device => device.kind === "videoinput").length
  } catch {
    return "unavailable"
  }
}

/** The resulting track's settings, allowlisted. */
function trackSettings(stream: MediaStream): Record<string, unknown> {
  const track = stream.getVideoTracks?.()[0]
  let settings: Record<string, unknown> = {}
  try {
    settings = (track?.getSettings?.() ?? {}) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
  const safe: Record<string, unknown> = {}
  for (const key of SAFE_TRACK_SETTINGS) {
    if (settings[key] !== undefined) safe[key] = settings[key]
  }
  return safe
}

async function report(stage: "preferred" | "fallback", media: CameraMediaDevices, extra: Record<string, unknown>) {
  // The comparison is written inline so Parcel folds it to a constant in a production build and
  // drops the whole diagnostic body, rather than leaving inert debug code in the shipped bundle.
  if (process.env.NODE_ENV === "production") return
  console.warn("[OpenWear camera]", {
    stage,
    ...extra,
    supportedConstraints: supportedConstraints(media),
    videoInputCount: await videoInputCount(media)
  })
}

/**
 * Opens the camera, preferring the Decart model's capture size.
 *
 * Throws the ORIGINAL error when the fallback also fails, so the room's messaging keeps the
 * semantics of the request the user actually made: a preferred `NotFoundError` still reads as
 * "no camera", a preferred `OverconstrainedError` still reads as "could not use the requested
 * settings". The fallback's own error is reported in development.
 */
export async function acquireCamera(capture: PreferredCapture, devices?: CameraMediaDevices): Promise<MediaStream> {
  const media = devices ?? navigator.mediaDevices
  const fps = typeof capture.fps === "number" ? { ideal: capture.fps } : capture.fps
  const preferred: MediaStreamConstraints = {
    video: {
      width: { ideal: capture.width },
      height: { ideal: capture.height },
      ...(fps ? { frameRate: fps } : {}),
      facingMode: "user"
    },
    audio: false
  }

  try {
    const stream = await media.getUserMedia(preferred)
    await report("preferred", media, { errorName: null, trackSettings: trackSettings(stream) })
    return stream
  } catch (error) {
    const name = errorName(error)
    await report("preferred", media, { errorName: name, trackSettings: null })

    // Permission denial and every other non-retryable failure stay as-is.
    if (!RETRYABLE.has(name)) throw error

    try {
      const stream = await media.getUserMedia(GENERIC_CONSTRAINTS)
      await report("fallback", media, { errorName: null, trackSettings: trackSettings(stream) })
      return stream
    } catch (fallbackError) {
      await report("fallback", media, { errorName: errorName(fallbackError), trackSettings: null })
      throw error
    }
  }
}

/**
 * Releases every track of a stream. Shared by the room's teardown and by any stream the room
 * has to drop, so a stream acquired through the fallback is torn down by the same code path as
 * one acquired with the preferred constraints.
 */
export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach(track => track.stop())
}
