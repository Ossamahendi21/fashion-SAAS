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
  idle: { button: "Save to wardrobe", note: null },
  saving: { button: "Saving…", note: null },
  processing: { button: "Processing…", note: null },
  ready: { button: "Saved to wardrobe ✓", note: null },
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
      const mimeType = input.blob.type.startsWith("image/") ? input.blob.type : "image/jpeg"
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
