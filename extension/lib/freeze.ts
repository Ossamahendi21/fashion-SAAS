// Freeze & inspect helpers for the OpenWear fitting room.
//
// Freezing ends provider realtime work while keeping everything local: the webcam stream, the
// current garment, and a captured still of the last usable AI frame. Nothing here calls the
// server, refunds quota, reports usage, or touches billing. Authorization stays in
// `lib/live-mirror.ts`; teardown stays split between realtime-only release and full stop.
//
// The room owns React state. These helpers own the injectable side effects (canvas capture,
// object URLs, connection/timer refs) so every safety property is unit-testable with fakes.

/** Exact user-facing copy for the frozen state. No provider names. */
export const FROZEN_COPY = {
  freezeButton: "Freeze & inspect",
  freezeAriaLabel: "Freeze and inspect",
  badge: "Frozen preview",
  support: "Live processing stopped. Inspect this look for as long as you like.",
  resume: "Go live again",
  reconnecting: "Connecting live again…",
  noPreview: "The live session ended before a preview was ready.",
} as const

export type FrozenPreview = {
  url: string
  width: number
  height: number
}

export type FrozenFrame = FrozenPreview & {
  blob: Blob
  capturedAt: number
}

/** A remote video element only needs usable dimensions to be freezable. */
export function hasUsableRemoteFrame(
  videoWidth: number | null | undefined,
  videoHeight: number | null | undefined,
): boolean {
  return (
    typeof videoWidth === "number" &&
    typeof videoHeight === "number" &&
    Number.isFinite(videoWidth) &&
    Number.isFinite(videoHeight) &&
    videoWidth > 0 &&
    videoHeight > 0
  )
}

export type FrameCanvas = {
  getContext(contextId: "2d"): { drawImage(video: unknown, x: number, y: number): void } | null
  toBlob?: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void
}

export type FrameCaptureDeps = {
  createCanvas: (width: number, height: number) => FrameCanvas
  createObjectURL: (blob: Blob) => string
  now?: () => number
}

export type DrawnRemoteFrame = {
  canvas: FrameCanvas
  width: number
  height: number
}

/**
 * Draws the current remote frame synchronously so the caller can terminate the provider
 * connection immediately, before the async blob encoding below. Returns null — never a fake
 * blank frame — when the video has no usable dimensions or the draw fails.
 */
export function drawRemoteFrameToCanvas(
  video: { videoWidth?: number | null; videoHeight?: number | null } | null | undefined,
  createCanvas: FrameCaptureDeps["createCanvas"],
): DrawnRemoteFrame | null {
  if (!video || !hasUsableRemoteFrame(video.videoWidth, video.videoHeight)) return null
  const width = Math.floor(video.videoWidth as number)
  const height = Math.floor(video.videoHeight as number)
  const canvas = createCanvas(width, height)
  const context = canvas.getContext("2d")
  if (!context) return null
  try {
    context.drawImage(video, 0, 0)
  } catch {
    return null
  }
  return { canvas, width, height }
}

/** Encodes an already-drawn canvas. A null blob means the browser could not capture a frame. */
export async function canvasToFrozenFrame(
  canvas: FrameCanvas,
  width: number,
  height: number,
  deps: FrameCaptureDeps,
): Promise<FrozenFrame | null> {
  const toBlob = canvas.toBlob
  if (typeof toBlob !== "function") return null
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      toBlob.call(canvas, (result) => resolve(result), "image/jpeg", 0.92)
    } catch {
      resolve(null)
    }
  })
  if (!blob) return null
  return {
    url: deps.createObjectURL(blob),
    blob,
    width,
    height,
    capturedAt: deps.now ? deps.now() : Date.now(),
  }
}

/** Convenience wrapper for tests and simple call sites: draw, then encode. */
export async function captureFrozenFrame(
  video: { videoWidth?: number | null; videoHeight?: number | null } | null | undefined,
  deps: FrameCaptureDeps,
): Promise<FrozenFrame | null> {
  if (!video || !hasUsableRemoteFrame(video.videoWidth, video.videoHeight)) return null
  const drawn = drawRemoteFrameToCanvas(video, deps.createCanvas)
  if (!drawn) return null
  return canvasToFrozenFrame(drawn.canvas, drawn.width, drawn.height, deps)
}

/** Revokes a frozen preview URL. Safe to call with null; never throws for a missing preview. */
export function revokeFrozenPreview(
  preview: { url: string } | null | undefined,
  revokeObjectURL: (url: string) => void,
): void {
  if (!preview) return
  revokeObjectURL(preview.url)
}

export type Disconnectable = { disconnect(): void }

/**
 * Takes the provider connection out of its ref exactly once. The second call sees null, so a
 * repeated Freeze cannot disconnect twice and cannot touch a newer connection.
 */
export function takeProviderConnection<T extends Disconnectable>(ref: { current: T | null }): T | null {
  const connection = ref.current
  ref.current = null
  return connection
}

/** Disconnects a taken connection. Returns false when there was nothing to close. */
export function releaseProviderConnection(connection: Disconnectable | null | undefined): boolean {
  if (!connection) return false
  connection.disconnect()
  return true
}

/** Clears a provider timer ref exactly once. Returns false when no timer was running. */
export function clearTimerRef(ref: { current: ReturnType<typeof setInterval> | null }): boolean {
  if (!ref.current) return false
  clearInterval(ref.current)
  ref.current = null
  return true
}

export type SnapshotDownloadDeps = {
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  createAnchor: () => { href: string; download: string; click(): void }
  now?: () => number
  revokeDelayMs?: number
}

/**
 * Downloads a blob (live snapshot or frozen still) without involving Decart. Returns the object
 * URL so callers can revoke it deterministically in tests; the room also schedules revocation.
 */
export function downloadSnapshot(blob: Blob, deps: SnapshotDownloadDeps): string {
  const url = deps.createObjectURL(blob)
  const anchor = deps.createAnchor()
  anchor.href = url
  anchor.download = `openwear-${(deps.now ?? Date.now)()}.jpg`
  anchor.click()
  const delay = deps.revokeDelayMs ?? 1000
  setTimeout(() => deps.revokeObjectURL(url), delay)
  return url
}

/** Browser-backed snapshot download deps for the room. */
export function defaultSnapshotDeps(): SnapshotDownloadDeps {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement("a"),
  }
}
