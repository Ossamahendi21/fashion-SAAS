// Save-to-wardrobe client for the OpenWear fitting room.
//
// Uploads the normalized garment Blob through the authenticated Convex storage flow
// (`uploads:generateUploadUrl` → POST → `shoppingImports:register`), then watches the import
// status until it settles. Framework-free and fully injected: no React, no Clerk, no camera,
// no Live Mirror, no credentials. The room owns UI state; this module owns the protocol.

import { makeFunctionReference } from "convex/server"

/** Server `shoppingImports:register` input. Ids are Convex `Id`s at runtime, plain strings here. */
export type ShoppingImportInput = {
  storageId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  productTitle?: string
  sourcePageUrl?: string
  clientImportId: string
}

export type ShoppingImportState = "processing" | "ready" | "needs_credits" | "no_item" | "failed"

export type ShoppingImportStatus = {
  state: ShoppingImportState
  uploadId: string
  jobId?: string
  itemId?: string
  itemName?: string
  itemUrl?: string
  duplicateOfId?: string
  ownership?: "owned" | "considering"
}

/** Authenticated Convex references. The extension never imports the Convex backend. */
export const generateShoppingUploadUrl = makeFunctionReference<"mutation", Record<string, never>, string>(
  "uploads:generateUploadUrl"
)
export const registerShoppingImport = makeFunctionReference<
  "mutation",
  ShoppingImportInput,
  { uploadId: string; jobId: string; deduped: boolean }
>("shoppingImports:register")
export const shoppingImportStatus = makeFunctionReference<"query", { uploadId: string }, ShoppingImportStatus>(
  "shoppingImports:status"
)

/** Step 3 server boundary: fetch + store a public retailer image server-side (SSRF-gated). */
export const fetchRemoteServerImage = makeFunctionReference<
  "action",
  { url: string },
  { storageId: string; mimeType: string; sizeBytes: number; downloadUrl: string }
>("shoppingImages:fetchRemote")
/** Authenticated discard of an unregistered server-fetched blob (safe no-op when referenced). */
export const discardServerImage = makeFunctionReference<"action", { storageId: string }, null>(
  "shoppingImages:discardFetch"
)

// ---------- Style this item (Step 3C) ----------

/** Authenticated styling request. Takes only the saved item id; everything else is server-side. */
export const requestItemStyling = makeFunctionReference<
  "action",
  { itemId: string },
  StylingResult
>("styling:suggestOutfits")

/** Keeps one proposal outfit. The web stylist UI uses this same mutation from its own cards. */
export const saveOutfitProposal = makeFunctionReference<"mutation", { outfitId: string }, null>(
  "threads:saveProposal"
)

/** Purchase transition for a saved shopping candidate. No upload, AI, extraction, or mint. */
export const markItemOwned = makeFunctionReference<"mutation", { itemId: string }, null>(
  "items:markOwned"
)

// ---------- Should I buy this? (Step 3E) ----------

export type AdviceSignal = {
  type: "similar_owned" | "many_matches" | "wardrobe_gap" | "limited_matches"
  message: string
}

export type AdviceSimilarItem = {
  itemId: string
  name: string
  category: string
  url: string | null
  similarity: number
  duplicate: boolean
}

export type AdviceMatchItem = {
  _id: string
  name: string
  category: string
  url: string | null
}

export type ShoppingAdvice = {
  candidate: { itemId: string; name: string }
  similarOwnedItems: AdviceSimilarItem[]
  matchingOwnedItems: AdviceMatchItem[]
  matchCount: number
  outfitPotential: { estimatedCombinations: number; display: string }
  label: "duplicate-heavy" | "versatile" | "wardrobe-gap" | "limited-match"
  signals: AdviceSignal[]
  summary?: string
  pros: string[]
  considerations: string[]
  note?: string
  smallWardrobe: boolean
  cached: boolean
}

/** Authenticated advice request. Takes only the saved item id; everything else is server-side. */
export const requestShoppingAdvice = makeFunctionReference<
  "action",
  { itemId: string },
  ShoppingAdvice
>("shoppingAdvice:analyze")

export type AdvicePhase = "idle" | "analyzing" | "ready" | "failed"

/** Exact advice-button copy per phase. No scores, no percentages, no provider names. */
export const ADVICE_COPY = {
  adviceButton: "Should I buy this?",
  analyzingButton: "Analyzing…",
  failedButton: "Couldn't analyze. Try again."
} as const

/**
 * Maps an advice failure onto safe UI copy. Server `appError` messages are user-facing by
 * repository convention, so a structured server message passes through; everything else
 * becomes the generic retry copy. Never surfaces stacks or provider internals.
 */
export function toAdviceFailureMessage(error: unknown): string {
  const message = (error as { data?: { message?: unknown } } | null | undefined)?.data?.message
  if (typeof message === "string" && message.trim().length > 0) return message
  return "Couldn't analyze this item. Try again."
}

export type AdviceDeps = {
  /** Authenticated `shoppingAdvice:analyze` wrapper. Item id only, always. */
  requestAdvice: (args: { itemId: string }) => Promise<ShoppingAdvice>
}

/**
 * One advice client per room: duplicate clicks for the same item share one in-flight
 * analysis, and a settled request leaves no residue for the next garment. Analysis only:
 * never saves, never uploads, never styles, never authorizes Live Mirror.
 */
export function createAdviceClient(deps: AdviceDeps) {
  const inflight = new Map<string, Promise<ShoppingAdvice>>()

  async function analyze(itemId: string): Promise<ShoppingAdvice> {
    const running = inflight.get(itemId)
    if (running) return running
    const current = deps.requestAdvice({ itemId })
    inflight.set(itemId, current)
    try {
      return await current
    } finally {
      if (inflight.get(itemId) === current) inflight.delete(itemId)
    }
  }

  return { analyze }
}

export type AdviceClient = ReturnType<typeof createAdviceClient>

export type StyledSuggestionItem = {
  _id: string
  name: string
  category: string
  url: string | null
}

export type StyledSuggestion = {
  outfitId: string
  name: string
  reasoning: string
  items: StyledSuggestionItem[]
}

export type StylingResult = {
  threadId?: string
  suggestions: StyledSuggestion[]
  note?: string
}

export type StylePhase = "idle" | "styling" | "ready" | "failed"

/** Exact style-button copy per phase. */
export const STYLE_COPY = {
  styleButton: "Style this item",
  stylingButton: "Styling…",
  failedButton: "Couldn't style. Try again.",
  viewButton: "View in Fitcheck",
  saveButton: "Save outfit",
  savedButton: "Saved ✓"
} as const

/**
 * Maps a styling failure onto safe UI copy. Server `appError` messages are user-facing by
 * repository convention, so a structured server message passes through; everything else
 * becomes the generic retry copy. Never surfaces stacks or provider internals.
 */
export function toStyleFailureMessage(error: unknown): string {
  const message = (error as { data?: { message?: unknown } } | null | undefined)?.data?.message
  if (typeof message === "string" && message.trim().length > 0) return message
  return "Couldn't style this item. Try again."
}

/**
 * Web handoff URL for one proposal outfit. Carries only the opaque outfit id — never a JWT,
 * never wardrobe data, never a prompt.
 */
export function buildOutfitUrl(appUrl: string, outfitId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/outfits/${outfitId}`
}

export type OwnPhase = "idle" | "marking" | "owned"

/** Exact purchase-transition copy. Shown only in the room result area, never on hover pills. */
export const OWN_COPY = {
  ownButton: "I bought this",
  markingButton: "Adding…",
  ownedButton: "Added to your wardrobe ✓"
} as const

export type WardrobeSaveDeps = {
  /** Authenticated `uploads:generateUploadUrl` wrapper. No arguments, always. */
  generateUploadUrl: () => Promise<string>
  /** POSTs the blob to the signed URL; resolves with the stored blob's id. */
  postBlob: (url: string, blob: Blob, mimeType: string) => Promise<string>
  /** Authenticated `shoppingImports:register` wrapper. */
  registerImport: (input: ShoppingImportInput) => Promise<{ uploadId: string; jobId: string; deduped: boolean }>
  /** Authenticated `shoppingImports:status` wrapper. Read-only, never mints anything. */
  queryStatus: (uploadId: string) => Promise<ShoppingImportStatus>
}

export type SavePhase = "idle" | "saving" | "processing" | "ready" | "needs_credits" | "no_item" | "failed"

/** Exact save-button copy per phase. The room renders `note` wherever a notice fits. */
export const SAVE_COPY: Record<SavePhase, { button: string; note: string | null }> = {
  idle: { button: "Save item", note: null },
  saving: { button: "Saving…", note: null },
  processing: { button: "Processing…", note: null },
  ready: { button: "Saved ✓", note: null },
  needs_credits: {
    button: "Needs 1 credit to finish",
    note: "Saved, but you need a credit to finish adding it to your wardrobe."
  },
  no_item: {
    button: "Couldn't identify this product",
    note: "We couldn't identify that product. Try another product image."
  },
  failed: { button: "Couldn't save. Try again.", note: null }
}

/**
 * POSTs a blob to a signed Convex storage URL and resolves with the stored id.
 * Same protocol as the web app's `useUpload`: the endpoint answers `{ storageId }`.
 */
export async function postBlobToConvex(url: string, blob: Blob, mimeType: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": mimeType }, body: blob })
  } catch {
    throw new Error("Upload failed. Check your connection and try again.")
  }
  if (!response.ok) throw new Error(`Upload failed (${response.status}). Please try again.`)
  const body = (await response.json().catch(() => null)) as { storageId?: unknown } | null
  const storageId = body?.storageId
  if (typeof storageId !== "string" || !storageId) throw new Error("Upload did not return a storage id.")
  return storageId
}

/**
 * Maps a save/register failure onto safe UI copy. Server `appError` messages are user-facing
 * by repository convention, so a structured server message passes through; everything else
 * becomes the generic retry copy. Never surfaces stacks, URLs, or key material.
 */
export function toSaveFailureMessage(error: unknown): string {
  const message = (error as { data?: { message?: unknown } } | null | undefined)?.data?.message
  if (typeof message === "string" && message.trim().length > 0) return message
  return "Couldn't save. Try again."
}

export type WatchOptions = {
  /** Called with each observed phase; skipped entirely once `isCurrent` returns false. */
  onPhase?: (phase: SavePhase) => void
  /** Room-level staleness guard: an older garment's completion must never touch new UI. */
  isCurrent?: () => boolean
  intervalMs?: number
  timeoutMs?: number
}

/**
 * One saver per room: duplicate clicks for the same `clientImportId` share one in-flight save,
 * and a retry after settling reuses the same id so the server stays idempotent.
 */
export function createWardrobeSaver(deps: WardrobeSaveDeps) {
  const inflight = new Map<string, Promise<{ uploadId: string; jobId: string }>>()

  async function save(
    input: Omit<ShoppingImportInput, "storageId" | "mimeType" | "sizeBytes"> & { blob: Blob }
  ): Promise<{ uploadId: string; jobId: string }> {
    const running = inflight.get(input.clientImportId)
    if (running) return running
    const current = (async () => {
      if (!(input.blob instanceof Blob) || input.blob.size <= 0) {
        throw new Error("There is no garment image to save yet.")
      }
      // Raster only, never a blanket image/*: SVG is markup that executes in any renderer that
      // takes it, so a Blob whose declared type is SVG (or any other non-raster image type) is
      // refused here. A blank type is treated as a re-encoded JPEG (canvas output); the canvas
      // normalization upstream already went raster-only.
      const RASTER = ["image/jpeg", "image/png", "image/webp"]
      if (input.blob.type && !RASTER.includes(input.blob.type)) throw new Error("Use a JPG, PNG or WebP image.")
      const mimeType = input.blob.type || "image/jpeg"
      const url = await deps.generateUploadUrl()
      const storageId = await deps.postBlob(url, input.blob, mimeType)
      const { uploadId, jobId } = await deps.registerImport({
        storageId,
        fileName: input.fileName,
        mimeType,
        sizeBytes: input.blob.size,
        ...(input.productTitle ? { productTitle: input.productTitle } : {}),
        ...(input.sourcePageUrl ? { sourcePageUrl: input.sourcePageUrl } : {}),
        clientImportId: input.clientImportId
      })
      return { uploadId, jobId }
    })()
    inflight.set(input.clientImportId, current)
    try {
      return await current
    } finally {
      if (inflight.get(input.clientImportId) === current) inflight.delete(input.clientImportId)
    }
  }

  /**
   * Polls the import status until a terminal state. Stale watchers resolve quietly without
   * notifying; query errors and timeouts resolve to a safe phase the room can render.
   */
  async function watch(uploadId: string, options: WatchOptions = {}): Promise<SavePhase> {
    const intervalMs = options.intervalMs ?? 2500
    const deadline = Date.now() + (options.timeoutMs ?? 120000)
    for (;;) {
      let state: ShoppingImportState
      try {
        state = (await deps.queryStatus(uploadId)).state
      } catch {
        return "failed"
      }
      const phase: SavePhase = state === "processing" ? "processing" : state
      if (options.isCurrent?.() === false) return phase
      options.onPhase?.(phase)
      if (phase !== "processing") return phase
      if (Date.now() >= deadline) return "processing"
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  return { save, watch }
}

export type WardrobeSaver = ReturnType<typeof createWardrobeSaver>

// ---------- Cross-context save protocol (content overlay ↔ room iframe) ----------
//
// The content script cannot touch Convex auth, so saving from the page goes through the room:
// the overlay asks the room to save, the room (ExtensionAuthProvider + this saver) does the
// authenticated work, and replies with the terminal phase. Because any frame embedded in the
// shop page — including the page itself — can postMessage an iframe, state-changing requests
// carry a one-time scoped capability minted into `chrome.storage.session`, which pages cannot
// read. Without a valid unused token of the right scope the room silently ignores the message:
// a hostile page can neither spend the user's credits nor start try-ons nor learn anything
// beyond public terminal phases.

/**
 * Capability scopes. `save` authorizes one headless wardrobe save; `garment` authorizes one
 * garment handoff into the room. Scopes never overlap: a token minted for one cannot satisfy
 * the other.
 */
export type CapabilityKind = "save" | "garment"

/** One-time capabilities live only minutes and are consumed on first use. */
export const CAPABILITY_TTL_MS = 10 * 60 * 1000
const CAPABILITY_PREFIX = "owcap-"

export type TokenStore = {
  get: (keys: string | string[]) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: string | string[]) => Promise<void>
}

export async function issueCapability(
  store: TokenStore,
  kind: CapabilityKind,
  createId: () => string = () => crypto.randomUUID()
): Promise<string> {
  const token = `${CAPABILITY_PREFIX}${kind}-${createId()}`
  await store.set({ [token]: { kind, createdAt: Date.now() } })
  return token
}

/**
 * Consumes the capability: true exactly once per fresh token of the expected scope; false for
 * forged, stale, replayed, malformed, or wrong-scope tokens. Uses only `chrome.storage.session`
 * (never localStorage, never chrome.storage.local): no JWTs, no Clerk tokens, no service keys,
 * no permanent secrets — just random one-time metadata.
 */
export async function consumeCapability(
  store: TokenStore,
  token: unknown,
  expectedKind: CapabilityKind,
  now: number = Date.now()
): Promise<boolean> {
  if (typeof token !== "string" || !token.startsWith(CAPABILITY_PREFIX) || token.length > 200) return false
  let record: Record<string, unknown>
  try {
    record = await store.get(token)
  } catch {
    return false
  }
  try {
    await store.remove(token)
  } catch {
    // Already gone: still fail closed below unless this call saw a fresh entry first.
  }
  const entry = record?.[token] as { kind?: unknown; createdAt?: unknown } | undefined
  return (
    !!entry &&
    entry.kind === expectedKind &&
    typeof entry.createdAt === "number" &&
    Number.isFinite(entry.createdAt) &&
    now - entry.createdAt >= 0 &&
    now - entry.createdAt < CAPABILITY_TTL_MS
  )
}

/** Client idempotency keys are opaque but bounded and URL-safe, mirroring the server rule. */
export function isValidClientImportId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

/** A display file name for URL-sourced garments; the server caps length authoritatively. */
export function fileNameFromUrl(imageUrl: string): string {
  try {
    const segment = new URL(imageUrl).pathname.split("/").pop() || ""
    const name = segment.trim()
    if (name.length > 0) return name.slice(0, 128)
  } catch {
    // Fall through to the fallback below.
  }
  return "shopping-garment.jpg"
}

/** Promise registry matching async replies (room-ready pings, save statuses) to requests. */
export function createReplyWaiter<T>() {
  const pending = new Map<string, { resolve: (value: T) => void; timer: ReturnType<typeof setTimeout> }>()
  function cancel(key: string) {
    const entry = pending.get(key)
    if (entry) {
      pending.delete(key)
      clearTimeout(entry.timer)
    }
  }
  function wait(key: string, timeoutMs: number, onTimeout: T): Promise<T> {
    cancel(key)
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(key)
        resolve(onTimeout)
      }, timeoutMs)
      pending.set(key, {
        resolve: (value: T) => {
          clearTimeout(timer)
          resolve(value)
        },
        timer
      })
    })
  }
  function resolve(key: string, value: T): boolean {
    const entry = pending.get(key)
    if (!entry) return false
    pending.delete(key)
    entry.resolve(value)
    return true
  }
  return {
    wait,
    resolve,
    cancel,
    pendingCount: () => pending.size
  }
}

export type ReplyWaiter<T> = ReturnType<typeof createReplyWaiter<T>>

export type RemoteSaveTarget = {
  imageUrl: string
  productTitle?: string
  sourcePageUrl?: string
}

export type RemoteSaveDeps = {
  /** Opens the room if closed. No-op when already open. Must not start camera or Live Mirror. */
  openRoom: () => void
  postToRoom: (message: Record<string, unknown>) => void
  /** Ping/pong handshake proving the room is listening; false on timeout. */
  awaitRoomReady: (timeoutMs?: number) => Promise<boolean>
  issueToken: () => Promise<string>
  /** Terminal save phase for this id; "timeout" when the room never answers. */
  awaitSaveStatus: (clientImportId: string, timeoutMs?: number) => Promise<SavePhase | "signed_out" | "timeout">
  createImportId?: () => string
}

/**
 * Content-side Save: open the room if needed, verify it listens, hand it a one-time token
 * plus the sanitized target, and wait for the terminal phase. Returns the id used so the
 * overlay can retry the same product with the same idempotency key.
 */
export async function requestRemoteSave(
  deps: RemoteSaveDeps,
  target: RemoteSaveTarget,
  clientImportId?: string
): Promise<{ clientImportId: string; phase: SavePhase | "signed_out" | "failed" }> {
  const id = clientImportId ?? (deps.createImportId ? deps.createImportId() : crypto.randomUUID())
  deps.openRoom()
  const ready = await deps.awaitRoomReady(5000)
  if (!ready) return { clientImportId: id, phase: "failed" }
  const token = await deps.issueToken()
  deps.postToRoom({
    type: "openwear:save-garment",
    imageUrl: target.imageUrl,
    ...(target.productTitle ? { productTitle: target.productTitle } : {}),
    ...(target.sourcePageUrl ? { sourcePageUrl: target.sourcePageUrl } : {}),
    clientImportId: id,
    token
  })
  const phase = await deps.awaitSaveStatus(id, 150000)
  if (phase === "signed_out") return { clientImportId: id, phase }
  if (phase === "timeout") return { clientImportId: id, phase: "failed" }
  return { clientImportId: id, phase }
}

export type RemoteSaveInput = {
  imageUrl: unknown
  productTitle?: unknown
  sourcePageUrl?: unknown
  clientImportId: unknown
  token: unknown
}

/** Titles arriving over postMessage are local-only display strings; bounded before use. */
export const MAX_GARMENT_TITLE_CHARS = 500

export type GarmentCommand = {
  capability: string
  file?: Blob
  url?: string
  name?: string
  sourcePageUrl?: string
}

/**
 * Validates an untrusted `openwear:garment` page message WITHOUT consuming anything. Returns
 * the capability plus a sanitized garment command, or null for anything malformed. The caller
 * must still consume the capability (proving extension origin) before acting; a valid shape
 * alone authorizes nothing. Never renders, never fetches, never throws.
 */
export function parseGarmentMessage(data: unknown): GarmentCommand | null {
  if (typeof data !== "object" || data === null) return null
  const { capability, file, url, name, sourcePageUrl } = data as Record<string, unknown>
  if (typeof capability !== "string" || !capability) return null
  const hasFile = file instanceof Blob
  const hasUrl =
    typeof url === "string" && url.length > 0 && url.length <= 2048 && /^https?:\/\//.test(url)
  if (!hasFile && !hasUrl) return null
  if (name !== undefined && (typeof name !== "string" || name.length > MAX_GARMENT_TITLE_CHARS)) return null
  if (sourcePageUrl !== undefined && typeof sourcePageUrl !== "string") return null
  const command: GarmentCommand = { capability }
  if (hasFile) command.file = file as Blob
  if (hasUrl) command.url = url as string
  if (typeof name === "string" && name) command.name = name
  if (typeof sourcePageUrl === "string" && sourcePageUrl) command.sourcePageUrl = sourcePageUrl
  return command
}

export type RemoteSaveRoomDeps = {
  isSignedIn: () => boolean
  openSignIn: () => void
  takeToken: (token: string) => Promise<boolean>
  /** Step 3 server boundary: fetch + register a remote image on the server-stored blob. */
  remoteImage: {
    registerRemote: (url: string, input: RemoteImageRegisterInput) => Promise<{ uploadId: string; jobId: string }>
  }
  saver: WardrobeSaver
  /** Terminal phase (or signed_out) back to the page. Carries no secrets. */
  reply: (phase: SavePhase | "signed_out") => void
  /**
   * Optional: adopt a successful save into the room's saved-item state (the same transition
   * the in-room Save button uses) so a page-pill save exposes Style / Advice / I bought this.
   * Receives the uploadId of the already-completed save; it must NOT re-save. Re-entrancy and
   * stale-garment safety are the callee's responsibility (it knows the current garment).
   */
  adoptSavedItem?: (uploadId: string) => Promise<void>
}

/**
 * Room-side headless save: validates the untrusted page message, consumes the one-time token
 * (silently ignoring forged, replayed, or malformed requests), then registers the image
 * through the Step 3 server boundary (server fetch + storage + shoppingImports:register) —
 * no camera, no Live Mirror, no quota read, no client upload. Malformed input and token
 * failures never reply: there is nothing for an attacker to learn.
 */
export async function saveRemoteGarment(deps: RemoteSaveRoomDeps, input: RemoteSaveInput): Promise<void> {
  const { imageUrl, clientImportId, token } = input ?? {}
  if (!isValidClientImportId(clientImportId)) return
  if (typeof imageUrl !== "string" || imageUrl.length === 0 || imageUrl.length > 2048 || !/^https?:\/\//.test(imageUrl)) {
    return
  }
  if (typeof token !== "string" || !(await deps.takeToken(token))) return
  if (!deps.isSignedIn()) {
    deps.openSignIn()
    deps.reply("signed_out")
    return
  }
  try {
    const registerInput: RemoteImageRegisterInput = { clientImportId }
    if (typeof input.productTitle === "string" && input.productTitle) registerInput.productTitle = input.productTitle
    if (typeof input.sourcePageUrl === "string" && input.sourcePageUrl) registerInput.sourcePageUrl = input.sourcePageUrl
    const { uploadId } = await deps.remoteImage.registerRemote(imageUrl, registerInput)
    const terminal = await deps.saver.watch(uploadId, {})
    // A page-pill save and the in-room button must land on the SAME saved-item state, so the
    // room's canonical adoption runs here too. It only reads the completed save; it never
    // uploads, registers, or spends another credit.
    if (terminal === "ready" && deps.adoptSavedItem) await deps.adoptSavedItem(uploadId)
    deps.reply(terminal)
  } catch {
    deps.reply("failed")
  }
}

/** Register input for the Step 3 server boundary (see remote-image.ts). */
export type RemoteImageRegisterInput = {
  clientImportId: string
  productTitle?: string
  sourcePageUrl?: string
}
