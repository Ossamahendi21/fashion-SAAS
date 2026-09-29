// The fitting room: camera, body-framing guide, Decart live try-on and the laser-scan effect.
//
// It runs as an extension page (tabs/room.html) inside an iframe that content.tsx places on the shop.
// Keeping it on the extension's own origin isolates the camera, the Decart session and the MediaPipe
// runtime from the shop's scripts and security policy.
//
// Flow: Enable camera → framing guide (head + shoulders in the outline) → garment dropped →
//       connect to Decart with that garment → laser scan while it applies → reveal the AI video.
//       Later garments reuse the same connection via set().

import { createDecartClient, models } from "../vendor/decart-sdk.mjs"
import { acquireCamera, stopStream } from "../lib/camera"
import { useAction, useConvex, useMutation } from "convex/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fitcheckSignInUrl, getAuthConfig, isAuthConfigured, type ExtensionAuthStatus } from "../lib/auth-config"
import { ExtensionAuthProvider, useExtensionAuthStatus } from "../lib/auth-provider"
import { nameFromFile, parseDrop, type Incoming } from "../lib/drop"
import { buildPrompt, cleanName, normalizeImage } from "../lib/garment"
import {
  authorizeLiveMirror,
  createLiveMirrorAuthorizer,
  liveMirrorStatus,
  LiveMirrorError,
  liveMirrorMessage,
  quotaStatusCopy,
  refreshSubscription,
  resolveRealtimeModel,
  type LiveMirrorAuthorization,
  type LiveMirrorStatus
} from "../lib/live-mirror"
import {
  canvasToFrozenFrame,
  clearTimerRef,
  defaultSnapshotDeps,
  downloadSnapshot,
  drawRemoteFrameToCanvas,
  FROZEN_COPY,
  hasUsableRemoteFrame,
  releaseProviderConnection,
  revokeFrozenPreview,
  takeProviderConnection
} from "../lib/freeze"
import { DEFAULT_SETTINGS, loadSettings } from "../lib/settings"
import {
  createWardrobeSaver,
  generateShoppingUploadUrl,
  postBlobToConvex,
  registerShoppingImport,
  SAVE_COPY,
  shoppingImportStatus,
  toSaveFailureMessage,
  type SavePhase,
  type WardrobeSaveDeps
} from "../lib/wardrobe-save"
import { createPoseTracker, coverRect, guide, silhouetteBox, SILHOUETTE, type Point } from "../lib/vision"
import "./room.css"

type Reply<T> = { ok: true; data: T } | { ok: false; error: string }
type Phase = "idle" | "starting" | "framing" | "ready"
type GarmentStatus = "reading" | "waiting" | "fitting" | "live" | "failed"
type Garment = {
  id: number
  name: string
  preview: string
  status: GarmentStatus
  /** Original upload file name, or a fallback for URL-sourced garments. */
  fileName: string
  /** Canonical shop page the garment was dragged from, if any. Provenance only. */
  sourcePageUrl?: string
  /** Idempotency key for wardrobe saves of this garment. New garment, new id. */
  clientImportId: string
}
type NoticeAction = "grant" | "restart" | "signin"
type Notice = { message: string; action?: NoticeAction }
const noticeButtonLabel: Record<NoticeAction, string> = {
  grant: "Allow camera",
  restart: "Start again",
  signin: "Sign in on Fitcheck"
}
/** The id union the vendored SDK accepts; the server may only pick from this catalogue. */
type RealtimeModelId = Parameters<typeof models.realtime>[0]

// Capture sizing only. The model actually connected to comes from the server authorization
// (see connect()), so the browser never chooses which model bills the session.
const capture = models.realtime("lucy-vton-latest")
const SCAN_REVEAL_MS = 1300 // final top-to-bottom sweep that reveals the AI video
const SETTLE_MS = 900 // Decart needs a moment after set() before frames show the new garment
const HOLD_MS = 900 // how long the user must stay in the outline before framing completes
// The same page doubles as a full-tab "allow camera" screen when opened with ?grant (see GrantPage).
const isGrantPage = new URLSearchParams(location.search).has("grant")

// The room always runs authenticated: RoomPage renders a setup error when public
// Clerk/Convex config is missing, so by the time this module's Room mounts, the server-side
// Live Mirror authorization is the only credential path.

/** One-line Clerk + Convex state for the room. Rendered inside the provider only. */
function RoomAuthBadge() {
  const status = useExtensionAuthStatus()
  if (status.state === "loading") return <small>Checking Fitcheck sign-in…</small>
  if (status.state === "signed-out") return <small>Not signed in — the fitting room needs a Fitcheck account.</small>
  return <small>Signed in · Convex {status.convexAuthenticated ? "connected" : "connecting…"}</small>
}

/** Opens the Fitcheck sign-in page on the web app, where the Clerk session actually lives. */
function signInOnFitcheck() {
  void chrome.tabs.create({ url: fitcheckSignInUrl(getAuthConfig()) })
}

/** Sends an image request to background.ts, which fetches garment images without site cookies. */
async function background<T>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
  const response: Reply<T> = await chrome.runtime.sendMessage({ type, ...fields })
  if (!response?.ok) throw new Error((response as { error?: string })?.error || "OpenWear is unavailable")
  return response.data
}

/** Maps camera, key and network failures to a message plus the one action that fixes it. */
function friendly(error: any): Notice {
  // Secure authorization failures already carry safe copy; never rewrite or detail them.
  if (error instanceof LiveMirrorError) {
    // A retry button is only offered where retrying can actually change the outcome.
    if (error.failure === "UNAUTHENTICATED") return { message: error.message, action: "signin" }
    if (error.failure === "FEATURE_LOCKED" || error.failure === "LIVE_MIRROR_LIMIT_REACHED" || error.failure === "SUBSCRIPTION_REFRESH_REQUIRED") return { message: error.message }
    return { message: error.message, action: "restart" }
  }
  const message = String(error?.message || error || "")
  if (error?.name === "NotAllowedError") return { message: "Camera access is blocked for OpenWear.", action: "grant" }
  // Reached only after the generic retry also failed; see lib/camera.ts.
  if (error?.name === "NotFoundError") return { message: "No camera was available to OpenWear." }
  if (error?.name === "OverconstrainedError") return { message: "Your camera could not use the requested video settings." }
  if (error?.code?.startsWith?.("WEBRTC")) return { message: "Couldn't reach Decart's video servers. Check your network and try again.", action: "restart" }
  // The background image worker answers with short reason strings; anything else
  // reaching here is an unexpected throw (a Convex hybrid stack trace, a Decart body, a JS
  // TypeError) and must not be rendered.
  if (!/^[A-Z_]{3,32}$/.test(message) && message.length <= 80) return { message: message || "Something went wrong. Try again.", action: "restart" }
  return { message: "Something went wrong. Try again.", action: "restart" }
}

/** Fallback when the browser won't prompt for the camera inside the iframe: ask from a full tab instead. */
function GrantPage() {
  const [state, setState] = useState<"ask" | "done" | "blocked">("ask")
  const ask = async () => {
    try { stopStream(await navigator.mediaDevices.getUserMedia({ video: true })); setState("done") }
    catch { setState("blocked") }
  }
  return <main className="grant">
    <span className="kicker">OPENWEAR · CAMERA</span>
    <h1>{state === "done" ? "Camera allowed." : "Let OpenWear use your camera"}</h1>
    <p>{state === "done" ? "Close this tab, go back to your shopping tab and press Enable camera." : state === "blocked" ? "Your browser blocked the camera. Click the camera icon in the address bar, allow it, then try again." : "Video goes to Decart only while the fitting room is open. Nothing is recorded."}</p>
    {state !== "done" && <button className="primary" onClick={() => void ask()}>Allow camera</button>}
    {state === "done" && <button className="primary" onClick={() => window.close()}>Close tab</button>}
  </main>
}

/**
 * Bridges the auth hooks to Room. Kept separate so the room body itself never calls a hook
 * conditionally: without configured auth there is no Clerk/Convex provider to call them against.
 */
function RoomWithAuth() {
  const status = useExtensionAuthStatus()
  const liveMirrorAction = useAction(authorizeLiveMirror)
  const refreshBillingAction = useAction(refreshSubscription)
  const convex = useConvex()
  // Read-only allowance status. Never mints a token; loaded once per sign-in, refreshed after
  // each successful authorization. Display only — authorizeLiveMirror stays authoritative.
  const loadQuotaStatus = useCallback(() => convex.query(liveMirrorStatus, {}), [convex])
  // Wardrobe saving: authenticated Convex storage + shopping imports. Independent of Live
  // Mirror — saving never authorizes, never reads quota, never touches the camera.
  const generateUploadUrl = useMutation(generateShoppingUploadUrl)
  const registerImport = useMutation(registerShoppingImport)
  const wardrobeSave = useMemo<WardrobeSaveDeps>(
    () => ({
      generateUploadUrl: () => generateUploadUrl({}),
      postBlob: postBlobToConvex,
      registerImport: (input) => registerImport(input),
      queryStatus: (uploadId) => convex.query(shoppingImportStatus, { uploadId })
    }),
    [convex, generateUploadUrl, registerImport]
  )
  return (
    <Room
      authStatus={status}
      liveMirrorAction={liveMirrorAction}
      refreshBilling={() => refreshBillingAction({})}
      loadQuotaStatus={loadQuotaStatus}
      wardrobeSave={wardrobeSave}
    />
  )
}

function Room({ authStatus, liveMirrorAction, refreshBilling, loadQuotaStatus, wardrobeSave }: {
  authStatus: ExtensionAuthStatus | null
  liveMirrorAction: (args: Record<string, never>) => Promise<LiveMirrorAuthorization>
  refreshBilling?: () => Promise<unknown>
  loadQuotaStatus?: () => Promise<LiveMirrorStatus>
  wardrobeSave: WardrobeSaveDeps
}) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [garment, setGarment] = useState<Garment | null>(null)
  const [guidance, setGuidance] = useState({ ok: false, message: "Step into the frame" })
  const [holding, setHolding] = useState(false)
  const [visionReady, setVisionReady] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [remoteVisible, setRemoteVisible] = useState(false)
  const [connection, setConnection] = useState("")
  const [queue, setQueue] = useState<{ position: number; queueSize: number } | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [editingName, setEditingName] = useState(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [preferences, setPreferences] = useState({ autoFreezeSeconds: DEFAULT_SETTINGS.autoFreezeSeconds })
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  // Frozen preview: a local still of the last usable AI frame, shown after the provider
  // connection is closed. The webcam, garment and room stay exactly as they were.
  const [frozenPreview, setFrozenPreview] = useState<{ url: string; width: number; height: number } | null>(null)
  const frozenPreviewRef = useRef<{ url: string; width: number; height: number } | null>(null)
  frozenPreviewRef.current = frozenPreview
  const frozenBlobRef = useRef<Blob | null>(null)
  const freezingRef = useRef(false)
  // A new authorization is in flight from frozen state ("Go live again").
  const [reconnecting, setReconnecting] = useState(false)
  const reconnectingRef = useRef(false)
  // Informational quota display. Loaded without minting; authorizeLiveMirror stays authoritative.
  const [quotaStatus, setQuotaStatus] = useState<LiveMirrorStatus | null>(null)
  const loadQuotaStatusRef = useRef(loadQuotaStatus)
  loadQuotaStatusRef.current = loadQuotaStatus
  // Wardrobe save UI, scoped to the current garment: a new garment always starts idle with a
  // fresh idempotency key, and a stale save can never overwrite newer UI (see saveToWardrobe).
  const [saveState, setSaveState] = useState<{ garmentId: number; clientImportId: string; phase: SavePhase } | null>(null)
  const saveStateRef = useRef<typeof saveState>(null)
  saveStateRef.current = saveState
  // Server authorization: one in-flight mint at a time, shared by concurrent starts.
  const authorizer = useMemo(() => createLiveMirrorAuthorizer(), [])
  // Wardrobe saver: single-flight per idempotency key, independent of Live Mirror entirely.
  const saver = useMemo(() => createWardrobeSaver(wardrobeSave), [wardrobeSave])

  // Refs mirror state that the animation loop and async callbacks read without re-rendering.
  const stageRef = useRef<HTMLDivElement>(null)
  const cameraRef = useRef<HTMLVideoElement>(null)
  const remoteRef = useRef<HTMLVideoElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const connectionRef = useRef<any>(null)
  const connectingRef = useRef<Promise<any> | null>(null)
  const connectingForRef = useRef(0)
  const remoteShownRef = useRef(false)
  const trackerRef = useRef<Awaited<ReturnType<typeof createPoseTracker>> | null>(null)
  const poseRef = useRef<Point[] | null>(null)
  const phaseRef = useRef<Phase>("idle")
  const framedRef = useRef(false)
  const framedWaitersRef = useRef<(() => void)[]>([])
  const holdStartRef = useRef(0)
  const scanRef = useRef<{ mode: "off" | "loop" | "reveal"; start: number; revealRemote: boolean }>({ mode: "off", start: 0, revealRemote: false })
  const garmentRef = useRef<Garment | null>(null)
  const imageRef = useRef<Blob | null>(null)
  const sessionRef = useRef(0) // bumped on stop(); async work from an older session bails out
  const garmentSeqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  phaseRef.current = phase
  garmentRef.current = garment

  const updateGarment = useCallback((id: number, patch: Partial<Garment>) => {
    setGarment(current => current && current.id === id ? { ...current, ...patch } : current)
  }, [])

  // ---------- Session lifecycle ----------

  /**
   * Realtime-only teardown, shared by freeze, auto-freeze and full stop so the provider is
   * closed exactly one way: disconnect the Decart session, clear its timer, drop the remote
   * video. The webcam, garment and frozen preview are untouched — use stop() to end those.
   */
  const closeProvider = useCallback(() => {
    clearTimerRef(timerRef)
    releaseProviderConnection(takeProviderConnection(connectionRef))
    connectingRef.current = null
    connectingForRef.current = 0
    if (remoteRef.current) remoteRef.current.srcObject = null
    remoteShownRef.current = false
    setRemoteVisible(false); setConnection(""); setQueue(null); setRemaining(0)
  }, [])

  /** Releases the frozen preview URL. Only full stop (or a newer frame) calls this. */
  const revokeFrozen = useCallback(() => {
    revokeFrozenPreview(frozenPreviewRef.current, url => URL.revokeObjectURL(url))
    frozenPreviewRef.current = null
    frozenBlobRef.current = null
    setFrozenPreview(null)
  }, [])

  /** Ends everything: Decart connection, camera, timers, frozen preview and effects. Always safe to call. */
  const stop = useCallback((reason?: Notice) => {
    sessionRef.current++
    closeProvider()
    stopStream(streamRef.current)
    streamRef.current = null
    revokeFrozen()
    freezingRef.current = false
    reconnectingRef.current = false
    setReconnecting(false)
    if (cameraRef.current) cameraRef.current.srcObject = null
    framedRef.current = false
    framedWaitersRef.current = []
    scanRef.current = { mode: "off", start: 0, revealRemote: false }
    setRemoteVisible(false); setConnection(""); setQueue(null); setPhase("idle")
    setGarment(current => current && current.status !== "live" ? { ...current, status: "failed" } : current)
    if (reason) setNotice(reason)
  }, [closeProvider, revokeFrozen])

  // Track the local auto-freeze preference, and stop the (billed) session when the tab is
  // hidden or the room closes.
  useEffect(() => {
    loadSettings().then(setPreferences).catch(() => {})
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.autoFreezeSeconds) void loadSettings().then(setPreferences).catch(() => {})
    }
    chrome.storage.onChanged.addListener(onStorage)
    const onHidden = () => { if (document.hidden && streamRef.current) stop({ message: "Paused while you were away.", action: "restart" }) }
    const onUnload = () => stop()
    document.addEventListener("visibilitychange", onHidden)
    window.addEventListener("pagehide", onUnload)
    return () => { chrome.storage.onChanged.removeListener(onStorage); document.removeEventListener("visibilitychange", onHidden); window.removeEventListener("pagehide", onUnload); stop() }
  }, [stop])

  // Initial allowance display: one read-only status load once the account is connected. No
  // polling, no token mint, no provider call. Any failure (including stale billing) leaves the
  // display empty; authorization remains the authoritative decision.
  useEffect(() => {
    if (authStatus?.state !== "signed-in" || !authStatus.convexAuthenticated) {
      setQuotaStatus(null)
      return
    }
    const loader = loadQuotaStatusRef.current
    if (!loader) return
    let cancelled = false
    loader().then(status => { if (!cancelled) setQuotaStatus(status) }).catch(() => { if (!cancelled) setQuotaStatus(null) })
    return () => { cancelled = true }
  }, [authStatus])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  // ---------- Framing guide ----------

  const enterFraming = useCallback(() => {
    holdStartRef.current = 0
    setHolding(false)
    setPhase("framing")
  }, [])

  const markFramed = useCallback(() => {
    framedRef.current = true
    setPhase("ready")
    framedWaitersRef.current.splice(0).forEach(resolve => resolve())
  }, [])

  /** Resolves once the user is framed (or skipped the guide), so garments dropped early wait their turn. */
  const waitUntilFramed = useCallback((session: number) => {
    if (framedRef.current) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      framedWaitersRef.current.push(() => session === sessionRef.current ? resolve() : reject(Error("stopped")))
    })
  }, [])

  /** Enable camera: open the webcam with Decart's preferred size, load the body tracker, start framing. */
  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return
    setNotice(null)
    // Fail before the camera opens: a signed-out user has no way to obtain a token, so
    // granting webcam access and framing first would be a prompt for nothing.
    if (authStatus?.state === "signed-out") { setNotice({ message: liveMirrorMessage("UNAUTHENTICATED"), action: "signin" }); return }
    const session = ++sessionRef.current
    setPhase("starting")
    try {
      const stream = await acquireCamera(capture)
      if (session !== sessionRef.current) { stopStream(stream); return }
      streamRef.current = stream
      stream.getVideoTracks()[0].onended = () => stop({ message: "Camera disconnected.", action: "restart" })
      const camera = cameraRef.current!
      camera.srcObject = stream
      await camera.play()
      if (!trackerRef.current) {
        try { trackerRef.current = await createPoseTracker(); setVisionReady(true) }
        catch (error) { console.warn("OpenWear framing guide unavailable", error) }
      }
      if (session !== sessionRef.current) return
      if (trackerRef.current) enterFraming()
      else markFramed()
    } catch (error) {
      if (session !== sessionRef.current) return
      stop(friendly(error))
    }
  }, [authStatus, enterFraming, markFramed, stop])

  /**
   * Freeze & inspect: capture the latest usable AI frame, then terminate ONLY the realtime
   * Decart connection. The webcam stream, garment, image and room stay exactly as they are,
   * and the frozen still can be inspected locally for as long as the user likes at zero
   * provider cost. No server call, no quota change, no refund — a minted session stays consumed.
   *
   * Returns true when a frozen preview is (or already is) on screen. Manual freezes require a
   * usable frame up front; a timeout with no usable frame still closes the provider and shows
   * safe copy instead of a fake blank image.
   */
  const freezeRealtime = useCallback(async (reason: "manual" | "timeout"): Promise<boolean> => {
    if (freezingRef.current || frozenPreviewRef.current) return frozenPreviewRef.current !== null
    if (!connectionRef.current) return false
    const video = remoteRef.current
    const usable = hasUsableRemoteFrame(video?.videoWidth, video?.videoHeight)
    if (reason === "manual" && !usable) return false
    // Draw synchronously, then close the provider immediately — blob encoding happens after.
    const drawn = drawRemoteFrameToCanvas(video, (width, height) => {
      const canvas = document.createElement("canvas")
      canvas.width = width; canvas.height = height
      return canvas
    })
    closeProvider()
    const session = sessionRef.current
    freezingRef.current = true
    try {
      if (!drawn) {
        if (reason === "timeout") setNotice({ message: FROZEN_COPY.noPreview })
        return false
      }
      const frozen = await canvasToFrozenFrame(drawn.canvas, drawn.width, drawn.height, {
        createCanvas: (width, height) => {
          const canvas = document.createElement("canvas")
          canvas.width = width; canvas.height = height
          return canvas
        },
        createObjectURL: blob => URL.createObjectURL(blob)
      })
      // A full stop landed mid-capture: drop the still instead of leaking it.
      if (session !== sessionRef.current) {
        if (frozen) URL.revokeObjectURL(frozen.url)
        return false
      }
      if (!frozen) {
        if (reason === "timeout") setNotice({ message: FROZEN_COPY.noPreview })
        return false
      }
      frozenBlobRef.current = frozen.blob
      setFrozenPreview({ url: frozen.url, width: frozen.width, height: frozen.height })
      setNotice(null)
      return true
    } finally {
      freezingRef.current = false
    }
  }, [closeProvider])

  /**
   * Opens the Decart realtime session with the first garment as its initial state.
   * The token, the model and the session cap all come from the resolved authorization.
   */
  const connect = useCallback(async (image: Blob, prompt: string, session: number) => {
    // Single-flight: concurrent garment drops share one authorization, so one token is minted.
    const grant = await authorizer.acquire({
      status: authStatus,
      authorize: liveMirrorAction,
      refreshBilling,
      autoFreezeSeconds: preferencesRef.current.autoFreezeSeconds
    })
    if (session !== sessionRef.current) throw Error("stopped")
    // Server-named model on the secure path. The SDK's id union is narrower than the string
    // the server returns, so widen once here: the runtime catalogue still throws for any id
    // Decart does not know, and resolveRealtimeModel turns that into a safe failure.
    const model = grant.model
      ? resolveRealtimeModel(grant.model, id => models.realtime(id as RealtimeModelId))
      : models.realtime("lucy-vton-latest")
    const client = createDecartClient({ apiKey: grant.token, telemetry: false })
    const realtime = await client.realtime.connect(streamRef.current!, {
      model,
      mirror: true, // desktop webcams rarely report facingMode, so mirror explicitly (Decart best practice)
      initialState: { prompt: { text: prompt, enhance: true }, image },
      onRemoteStream: (remote: MediaStream) => {
        if (session !== sessionRef.current || !remoteRef.current) return
        remoteRef.current.srcObject = remote
        remoteRef.current.play().catch(() => {})
      }
    })
    if (session !== sessionRef.current) { realtime.disconnect(); throw Error("stopped") }
    realtime.on("connectionChange", (state: string) => {
      if (session !== sessionRef.current) return
      setConnection(state)
      if (state === "generating" || state === "connected") setQueue(null)
      if (state === "disconnected") stop({ message: "The try-on session ended.", action: "restart" })
    })
    realtime.on("queuePosition", (position: { position: number; queueSize: number }) => { if (session === sessionRef.current) setQueue(position) })
    realtime.on("sessionEnded", (event: { reason: string }) => { if (session === sessionRef.current) stop({ message: `Session ended${event?.reason ? ` (${event.reason})` : ""}.`, action: "restart" }) })
    realtime.on("error", (error: any) => { if (session === sessionRef.current) stop(friendly(error)) })
    connectionRef.current = realtime
    setConnection(realtime.getConnectionState?.() || "connected")
    // The authorization just consumed one monthly session: refresh the informational display
    // (no mint, no provider call) so the remaining count stays truthful.
    void loadQuotaStatusRef.current?.().then(setQuotaStatus).catch(() => {})
    // Realtime video is billed per second, so enforce the already-clamped session limit. At zero
    // the provider work ends but the room does not: auto-freeze keeps the last usable AI frame
    // on screen instead of throwing the user back to the empty intro.
    const started = Date.now()
    setRemaining(grant.sessionSeconds)
    timerRef.current = setInterval(() => {
      const left = Math.max(0, grant.sessionSeconds - Math.floor((Date.now() - started) / 1000))
      setRemaining(left)
      if (!left) void freezeRealtime("timeout")
    }, 1000)
    return realtime
  }, [authStatus, freezeRealtime, liveMirrorAction, refreshBilling, stop])

  // ---------- Garment pipeline ----------

  const waitForRemoteFrame = () => new Promise<void>(resolve => {
    const video = remoteRef.current
    if (!video) return resolve()
    if (video.readyState >= 2 && video.videoWidth) return resolve()
    const done = () => { video.removeEventListener("loadeddata", done); resolve() }
    video.addEventListener("loadeddata", done)
  })

  /** Puts a prepared garment on the user: first one connects, later ones swap in with set(). */
  const apply = useCallback(async (id: number, image: Blob) => {
    const session = sessionRef.current
    await waitUntilFramed(session)
    const current = garmentRef.current
    if (session !== sessionRef.current || current?.id !== id) return
    // Read the name after framing so a rename made while waiting is honoured.
    const prompt = buildPrompt(current.name)
    updateGarment(id, { status: "fitting" })
    scanRef.current = { mode: "loop", start: performance.now(), revealRemote: false }
    const firstLook = !remoteShownRef.current
    if (!connectionRef.current) {
      // If another garment is already connecting, wait for it, then swap this one in.
      if (!connectingRef.current) { connectingRef.current = connect(image, prompt, session); connectingForRef.current = id }
      try { await connectingRef.current }
      catch (error) { if (session === sessionRef.current) connectingRef.current = null; throw error }
      if (connectingForRef.current !== id) await connectionRef.current?.set({ prompt, image, enhance: true })
    } else {
      await connectionRef.current.set({ prompt, image, enhance: true })
    }
    await waitForRemoteFrame()
    await new Promise(resolve => setTimeout(resolve, firstLook ? SETTLE_MS + 500 : SETTLE_MS))
    if (session !== sessionRef.current || garmentRef.current?.id !== id) return
    // The new provider session is showing a usable frame: only now is the frozen still replaced,
    // so there is never a blank screen between frozen and reconnecting. A denied authorization
    // throws before this point and leaves the frozen preview exactly as it was.
    if (frozenPreviewRef.current) revokeFrozen()
    scanRef.current = { mode: "reveal", start: performance.now(), revealRemote: firstLook }
    if (firstLook) { remoteShownRef.current = true; setRemoteVisible(true) }
    updateGarment(id, { status: "live" })
  }, [connect, revokeFrozen, updateGarment, waitUntilFramed])

  /**
   * Go live again from a frozen preview. Always mints a NEW authorization through the existing
   * single-flight authorizer — the previous token is never reused and a disconnected session is
   * never restored locally — so a successful reconnect consumes a new monthly session exactly
   * like any other authorization. The frozen still stays on screen until the first usable frame
   * of the new session replaces it; a denial or provider error leaves it untouched.
   */
  const goLiveAgain = useCallback(async () => {
    if (reconnectingRef.current || connectingRef.current) return
    const current = garmentRef.current
    if (!frozenPreviewRef.current || !current || !imageRef.current || !streamRef.current) {
      setNotice({ message: "Turn on your camera — it applies next" })
      return
    }
    reconnectingRef.current = true
    setReconnecting(true)
    setNotice(null)
    try {
      await apply(current.id, imageRef.current)
    } catch (error: any) {
      if (error?.message === "stopped") return
      setNotice(friendly(error))
    } finally {
      reconnectingRef.current = false
      setReconnecting(false)
    }
  }, [apply])

  /**
   * Save the current garment to the wardrobe. Uses only the normalized image and authenticated
   * Convex storage + shopping imports — never Live Mirror, never the camera. Works in every
   * provider state (never started, connecting, live, frozen, quota exhausted) and never disturbs
   * the live/frozen preview. Retries reuse the garment's idempotency key, so the server stays
   * idempotent; a stale completion (older garment id) resolves server-side but never touches UI.
   */
  const saveToWardrobe = useCallback(async () => {
    const current = garmentRef.current
    const blob = imageRef.current
    if (!current || !blob) return
    const state = saveStateRef.current
    if (state && state.garmentId === current.id && (state.phase === "saving" || state.phase === "processing")) return
    const { id, clientImportId } = current
    const applyPhase = (phase: SavePhase) => {
      if (garmentRef.current?.id === id) setSaveState({ garmentId: id, clientImportId, phase })
    }
    applyPhase("saving")
    try {
      const input: { blob: Blob; fileName: string; productTitle?: string; sourcePageUrl?: string; clientImportId: string } = {
        blob,
        fileName: current.fileName,
        clientImportId
      }
      if (current.name) input.productTitle = current.name
      if (current.sourcePageUrl) input.sourcePageUrl = current.sourcePageUrl
      const { uploadId } = await saver.save(input)
      if (garmentRef.current?.id !== id) return
      applyPhase("processing")
      const terminal = await saver.watch(uploadId, {
        onPhase: applyPhase,
        isCurrent: () => garmentRef.current?.id === id
      })
      if (garmentRef.current?.id !== id) return
      applyPhase(terminal)
      if (terminal === "failed") setNotice({ message: "Couldn't save. Try again." })
      if (terminal === "needs_credits") setNotice({ message: SAVE_COPY.needs_credits.note! })
      if (terminal === "no_item") setNotice({ message: SAVE_COPY.no_item.note! })
    } catch (error: any) {
      if (error?.message === "stopped" || garmentRef.current?.id !== id) return
      applyPhase("failed")
      setNotice({ message: toSaveFailureMessage(error) })
    }
  }, [saver])

  /** Entry point for every garment: load and normalise the image, then apply it. */
  const tryOn = useCallback(async (incoming: Incoming) => {
    setNotice(null); setDragging(false)
    const id = ++garmentSeqRef.current
    const name = cleanName(incoming.name || "")
    // A new garment always gets a fresh save identity: new idempotency key, idle save UI.
    // An older save finishing later resolves server-side but can never touch this UI.
    const clientImportId = crypto.randomUUID()
    setGarment({
      id,
      name,
      preview: "",
      status: "reading",
      fileName: incoming.file instanceof File ? incoming.file.name : "shopping-garment.jpg",
      ...(typeof incoming.sourcePageUrl === "string" && incoming.sourcePageUrl ? { sourcePageUrl: incoming.sourcePageUrl } : {}),
      clientImportId
    })
    setSaveState({ garmentId: id, clientImportId, phase: "idle" })
    if (phaseRef.current === "idle") void start()
    // The scan only runs once the user is framed; apply() starts it.
    try {
      const prepared = incoming.file ? await normalizeImage(incoming.file) : await normalizeImage(await background<string>("image", { url: incoming.url }))
      if (garmentRef.current?.id !== id) return
      imageRef.current = prepared.blob
      updateGarment(id, { preview: prepared.preview, status: phaseRef.current === "ready" ? "fitting" : "waiting" })
      await apply(id, prepared.blob)
    } catch (error: any) {
      if (error?.message === "stopped") return
      if (garmentRef.current?.id === id) updateGarment(id, { status: "failed" })
      scanRef.current = { mode: "off", start: 0, revealRemote: false }
      setNotice(friendly(error))
    }
  }, [apply, start, updateGarment])

  /** Renaming the garment re-sends it, since the name is part of the Decart prompt. */
  const rename = useCallback((name: string) => {
    const current = garmentRef.current
    if (!current) return
    const next = { ...current, name }
    setGarment(next); garmentRef.current = next
    // A garment still loading, waiting or fitting picks up the change on its own.
    if (!imageRef.current || !streamRef.current || !["live", "failed"].includes(current.status)) return
    void apply(next.id, imageRef.current).catch(error => { if (error?.message !== "stopped") setNotice(friendly(error)) })
  }, [apply])

  // Garments dragged on the host page arrive from the content script.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || typeof event.data !== "object" || !event.data) return
      if (event.data.type === "openwear:drag") setDragging(!!event.data.active)
      if (event.data.type === "openwear:garment") void tryOn({ file: event.data.file instanceof Blob ? event.data.file : undefined, url: typeof event.data.url === "string" ? event.data.url : undefined, name: typeof event.data.name === "string" ? event.data.name : "", sourcePageUrl: typeof event.data.sourcePageUrl === "string" ? event.data.sourcePageUrl : undefined })
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [tryOn])

  // ---------- Vision + scan effect loop ----------
  // One requestAnimationFrame loop: runs pose detection (~15 fps) while framing or scanning, feeds the
  // framing guide, and draws the laser scan. The scan either loops while Decart works ("loop") or does
  // a single top-to-bottom sweep that reveals the AI video underneath ("reveal").

  useEffect(() => {
    let frame = 0, lastDetect = 0
    const fx = document.createElement("canvas")
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      const camera = cameraRef.current, canvas = fxRef.current, tracker = trackerRef.current
      if (!camera || !canvas || !streamRef.current || !camera.videoWidth) return
      const scan = scanRef.current
      const framing = phaseRef.current === "framing"
      if (tracker && (framing || scan.mode !== "off") && now - lastDetect > 66) {
        lastDetect = now
        poseRef.current = tracker.detect(camera)
      }
      const width = canvas.clientWidth, height = canvas.clientHeight, dpr = Math.min(2, devicePixelRatio || 1)
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = fx.width = Math.round(width * dpr)
        canvas.height = fx.height = Math.round(height * dpr)
      }
      const geometry = { width, height, videoWidth: camera.videoWidth, videoHeight: camera.videoHeight }
      if (framing && tracker) {
        const result = guide(poseRef.current, geometry)
        setGuidance(previous => previous.message === result.message && previous.ok === result.ok ? previous : result)
        if (result.ok) {
          holdStartRef.current ||= now
          setHolding(true)
          if (now - holdStartRef.current > HOLD_MS) markFramed()
        } else if (holdStartRef.current) { holdStartRef.current = 0; setHolding(false) }
      }
      const context = canvas.getContext("2d")!
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      const remote = remoteRef.current
      if (scan.mode === "off") { if (remote && scan.revealRemote === false) remote.style.clipPath = ""; return }

      const elapsed = now - scan.start
      let y: number, intensity = 1
      if (scan.mode === "loop") {
        const phase = (elapsed % 2400) / 2400
        const eased = 0.5 - Math.cos(phase * Math.PI * 2) / 2
        y = height * (0.04 + 0.92 * eased)
        intensity = Math.min(1, elapsed / 300)
      } else {
        const progress = Math.min(1, elapsed / SCAN_REVEAL_MS)
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
        y = height * eased
        intensity = progress > 0.85 ? (1 - progress) / 0.15 : 1
        if (remote) remote.style.clipPath = scan.revealRemote ? `inset(0 0 ${Math.max(0, 100 - (y / height) * 100)}% 0)` : ""
        if (progress >= 1) { scanRef.current = { mode: "off", start: 0, revealRemote: false }; if (remote) remote.style.clipPath = ""; return }
      }

      // Body-conforming glow: draw the scan band, then keep only the pixels inside the person mask.
      const fxContext = fx.getContext("2d")!
      fxContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      fxContext.globalCompositeOperation = "source-over"
      fxContext.clearRect(0, 0, width, height)
      const wake = scan.mode === "reveal" ? Math.min(y, 220) : 150
      const wakeGradient = fxContext.createLinearGradient(0, y - wake, 0, y)
      wakeGradient.addColorStop(0, "rgba(90,255,230,0)")
      wakeGradient.addColorStop(1, "rgba(120,255,238,0.34)")
      fxContext.fillStyle = wakeGradient
      fxContext.fillRect(0, y - wake, width, wake)
      fxContext.fillStyle = "rgba(210,255,250,0.22)"
      for (let line = y - wake; line < y; line += 5) fxContext.fillRect(0, line, width, 1)
      fxContext.fillStyle = "rgba(160,255,245,0.16)"
      for (let column = (elapsed / 40) % 18; column < width; column += 18) fxContext.fillRect(column, y - wake * 0.6, 1, wake * 0.6)
      const band = fxContext.createLinearGradient(0, y - 22, 0, y + 22)
      band.addColorStop(0, "rgba(120,255,240,0)")
      band.addColorStop(0.5, "rgba(235,255,253,0.95)")
      band.addColorStop(1, "rgba(120,255,240,0)")
      fxContext.fillStyle = band
      fxContext.fillRect(0, y - 22, width, 44)
      for (let spark = 0; spark < 36; spark++) {
        fxContext.fillStyle = `rgba(255,255,255,${0.4 + Math.random() * 0.6})`
        fxContext.fillRect(Math.random() * width, y - 16 + Math.random() * 20, 2, 2)
      }
      if (tracker && poseRef.current) {
        const cover = coverRect(geometry)
        fxContext.globalCompositeOperation = "destination-in"
        fxContext.save()
        fxContext.translate(width, 0); fxContext.scale(-1, 1)
        fxContext.imageSmoothingEnabled = true
        fxContext.filter = "blur(2px)"
        fxContext.drawImage(tracker.mask, cover.x, cover.y, cover.width, cover.height)
        fxContext.restore()
        fxContext.filter = "none"
      }
      context.globalAlpha = intensity
      context.drawImage(fx, 0, 0)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      // The scanner beam itself spans the whole frame, a thin laser over the masked glow.
      context.shadowColor = "rgba(110,255,236,0.95)"
      context.shadowBlur = 14
      context.fillStyle = "rgba(225,255,252,0.9)"
      context.fillRect(0, y - 1, width, 2)
      context.shadowBlur = 0
      context.fillStyle = "rgba(130,255,240,0.85)"
      context.fillRect(8, y - 6, 3, 12)
      context.fillRect(width - 11, y - 6, 3, 12)
      context.globalAlpha = 1
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [markFramed])

  // ---------- Actions ----------

  /** Saves the current AI frame as a JPEG: the frozen still when frozen, else the live video. */
  const snapshot = () => {
    // Frozen first: downloading the still never restarts Decart.
    if (frozenPreviewRef.current && frozenBlobRef.current) {
      downloadSnapshot(frozenBlobRef.current, defaultSnapshotDeps())
      return
    }
    const video = remoteRef.current
    if (!video?.videoWidth) return
    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    canvas.getContext("2d")!.drawImage(video, 0, 0)
    canvas.toBlob(blob => {
      if (!blob) return
      downloadSnapshot(blob, defaultSnapshotDeps())
    }, "image/jpeg", 0.95)
  }

  const onNoticeAction = () => {
    if (notice?.action === "grant") window.open(chrome.runtime.getURL("tabs/room.html?grant=1"), "_blank")
    if (notice?.action === "signin") void chrome.tabs.create({ url: fitcheckSignInUrl(getAuthConfig()) })
    if (notice?.action === "restart") { setNotice(null); void start() }
  }

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const incoming = parseDrop(event.dataTransfer)
    if (incoming) void tryOn(incoming)
    else setNotice({ message: "Drop a product image or image link." })
  }

  // ---------- Render ----------

  const box = silhouetteBox(size.width, size.height)
  const statusText: Record<GarmentStatus, string> = {
    reading: "Reading garment…", waiting: phase === "framing" ? "Get in frame — it applies next" : "Turn on your camera — it applies next",
    fitting: queue ? `In Decart queue · #${queue.position} of ${queue.queueSize}` : "Tailoring it to you…", live: "Live", failed: "Didn't apply"
  }
  const live = remoteVisible && (connection === "generating" || connection === "connected")
  const cameraOn = phase !== "idle" && phase !== "starting"
  // Save button state belongs to the visible garment only; a stale save can never paint it.
  const savePhase: SavePhase = saveState && garment && saveState.garmentId === garment.id ? saveState.phase : "idle"
  const saveBusy = savePhase === "saving" || savePhase === "processing"
  // Informational only: authorizeLiveMirror stays authoritative for every new session.
  const quotaCopy = quotaStatusCopy(quotaStatus)
  // The Freeze control appears only once a usable AI frame is on screen (live implies the
  // remote video already showed one), and can never fire twice.
  const canFreeze = live && !frozenPreview && !reconnecting && !freezingRef.current

  return <div className={`room ${dragging ? "is-dragging" : ""}`} onDragEnter={e => { e.preventDefault(); setDragging(true) }} onDragOver={e => e.preventDefault()} onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false) }} onDrop={onDrop}>
    <div className="stage" ref={stageRef}>
      <video className="camera" ref={cameraRef} muted playsInline />
      <video className={`remote ${remoteVisible ? "visible" : ""}`} ref={remoteRef} muted playsInline />
      {frozenPreview && <div className="frozen">
        <img className="frozen-frame" src={frozenPreview.url} alt={FROZEN_COPY.badge} />
        <div className="frozen-copy">
          <span className="frozen-badge">{FROZEN_COPY.badge}</span>
          <span>{FROZEN_COPY.support}</span>
          {reconnecting
            ? <span className="frozen-loading"><span className="spinner" />{FROZEN_COPY.reconnecting}</span>
            : <button className="primary" onClick={() => void goLiveAgain()} disabled={!garment}>{FROZEN_COPY.resume}</button>}
        </div>
      </div>}
      <canvas className="fx" ref={fxRef} />

      {phase === "framing" && size.width > 0 && <div className={`framing ${holding ? "holding" : ""}`}>
        <svg width={size.width} height={size.height} aria-hidden="true">
          <defs><mask id="cutout"><rect width="100%" height="100%" fill="white" /><path d={SILHOUETTE} fill="black" transform={`translate(${box.left} ${box.top}) scale(${box.side / 100})`} /></mask></defs>
          <rect width="100%" height="100%" fill="rgba(8,8,8,0.62)" mask="url(#cutout)" />
          <path className="outline" d={SILHOUETTE} transform={`translate(${box.left} ${box.top}) scale(${box.side / 100})`} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="framing-copy">
          <strong key={guidance.message}>{guidance.ok ? "Hold still" : guidance.message}</strong>
          <span>Line your head and shoulders up with the outline</span>
          <button className="skip" onClick={markFramed}>Skip guide</button>
        </div>
      </div>}

      {phase === "idle" && <div className="intro">
        <span className="kicker">YOUR LIVE FITTING ROOM</span>
        <h1>See it on you.</h1>
        <ol>
          <li><b>1</b>Turn on your camera</li>
          <li><b>2</b>Line yourself up with the outline</li>
          <li><b>3</b>Drag any product photo in here</li>
        </ol>
        {authStatus?.state === "signed-out"
          ? <div className="signin-prompt">
              <span>{liveMirrorMessage("UNAUTHENTICATED")}</span>
              <button className="primary" onClick={signInOnFitcheck}>Sign in on Fitcheck</button>
            </div>
          : <button className="primary" onClick={() => void start()} disabled={authStatus?.state === "loading"}>Enable camera</button>}
        <small>Video streams to Decart only while this window is open.</small>
        <RoomAuthBadge />
      </div>}

      {phase === "starting" && <div className="intro loading"><div className="spinner" /><span>{visionReady ? "Opening camera…" : "Opening camera and loading the body guide…"}</span></div>}

      {garment && <div className={`garment-card status-${garment.status}`}>
        <div className="garment-thumb">{garment.preview ? <img src={garment.preview} alt="" /> : <span className="thumb-skeleton" />}{["reading", "fitting"].includes(garment.status) && <i className="thumb-scan" />}</div>
        <div className="garment-meta">
          {editingName
            ? <input autoFocus defaultValue={garment.name} placeholder="e.g. slim straight blue jeans" onBlur={e => { setEditingName(false); if (e.target.value.trim() !== garment.name) rename(cleanName(e.target.value)) }} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
            : <button className="garment-name" onClick={() => setEditingName(true)} title="Rename to describe the item better">{garment.name || "Look from photo"}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4Z" /></svg></button>}
          <span className="garment-status">{garment.status === "live" && <i className="dot" />}{statusText[garment.status]}</span>
        </div>
        {garment.preview ? <div className="save-row">
          <button className="save" onClick={() => void saveToWardrobe()} disabled={saveBusy || savePhase === "ready"} title="Save this garment to your Fitcheck wardrobe">
            {SAVE_COPY[savePhase].button}
          </button>
        </div> : null}
      </div>}

      {cameraOn && <div className="toolbar">
        {(live || frozenPreview) && <button onClick={snapshot} title="Save a snapshot" aria-label="Save a snapshot"><svg viewBox="0 0 24 24"><path d="M4 8h3l1.5-2h7L17 8h3v11H4Z" /><circle cx="12" cy="13.5" r="3.3" /></svg></button>}
        {live && <button className="freeze" onClick={() => void freezeRealtime("manual")} disabled={!canFreeze} title={FROZEN_COPY.freezeButton} aria-label={FROZEN_COPY.freezeAriaLabel}><svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14" /></svg><span>{FROZEN_COPY.freezeButton}</span></button>}
        <button onClick={() => chrome.runtime.openOptionsPage()} title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></svg></button>
        <button onClick={() => stop()} title="Turn camera off" aria-label="Turn camera off"><svg viewBox="0 0 24 24"><path d="M12 3v8" /><path d="M6.3 6.8a8 8 0 1 0 11.4 0" /></svg></button>
      </div>}

      {phase !== "starting" && phase !== "framing" && <button className={`drop-pill ${cameraOn ? "" : "subtle"}`} onClick={() => fileRef.current?.click()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m4 18 5-5 4 4 3-3 4 4" /></svg>
        <span>{dragging ? "Drop to try it on" : "Drag a product image here"}</span>
      </button>}
      {dragging && <div className="drop-glow" />}

      {phase !== "framing" && <div className="footer-note">
        <strong>OpenWear</strong>
        <span>AI can make mistakes · Visual preview only</span>
        {quotaCopy && <span className="quota">{quotaCopy}</span>}
        {live && remaining > 0 && <span className="timer">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span>}
      </div>}
      {connection === "reconnecting" && <div className="banner">Reconnecting…</div>}
      {notice && <div className="notice" role="alert"><span>{notice.message}</span>{notice.action && <button onClick={onNoticeAction}>{noticeButtonLabel[notice.action]}</button>}<button className="close" onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}
    </div>
    <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void tryOn({ file, name: nameFromFile(file) }); e.target.value = "" }} />
  </div>
}

/** Shown when the public Clerk/Convex configuration is missing. Fails closed with setup
 *  guidance; never exposes env values and never offers direct provider access. */
function ConfigError() {
  let detail = ""
  try {
    getAuthConfig()
  } catch (error) {
    detail = error instanceof Error ? error.message : ""
  }
  return <main className="grant">
    <span className="kicker">OPENWEAR · SETUP</span>
    <h1>Fitting room setup incomplete</h1>
    <p>OpenWear needs its Fitcheck connection before it can start. Ask your Fitcheck administrator to configure the extension.</p>
    {detail && <p>{detail}</p>}
  </main>
}

export default function RoomPage() {
  if (isGrantPage) return <GrantPage />
  // The extension is a Fitcheck SaaS companion: without Clerk/Convex configuration there is
  // no standalone mode. Step 2E3 removed the legacy browser-key path completely.
  if (!isAuthConfigured()) return <ConfigError />
  return <ExtensionAuthProvider><RoomWithAuth /></ExtensionAuthProvider>
}
