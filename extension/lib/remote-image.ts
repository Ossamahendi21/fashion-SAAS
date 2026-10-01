// Server-side shopping-image client (Original Step 3, Requirement A).
//
// The background worker no longer fetches retailer images. The room calls the
// authenticated Convex action (shoppingImages:fetchRemote) with ONLY the public URL;
// the server SSRF-gates, fetches and stores the bytes, and returns a small payload
// (storage id + MIME + size + bearer download URL). Everything else stays local:
// blob download, and normalization for the Decart reference image.
//
// Two save shapes land on the SAME server blob, so nothing is uploaded or duplicated:
//   - try-on first (prepare), then Save via registerBlob (reuses the fetched storageId);
//   - a headless page save via registerRemote (fetch + register in one op).
// registerServerBlob relays the storageId into shoppingImports:register (which mints
// the wardrobe import on the server-stored file); local file uploads keep the old
// generateUploadUrl → POST → register flow untouched (see wardrobe-save.ts).
//
// Framework-free and fully injected for the browser harness: no React, no Clerk, no
// chrome.* here. The client validates the URL shape only for fast feedback; the server
// is authoritative for every network policy.

import type { ShoppingImportInput } from "./wardrobe-save"

export type ServerImageFetch = {
  storageId: string
  mimeType: string
  sizeBytes: number
  downloadUrl: string
}

/** The identity fields a save needs off an already-fetched server blob. */
export type ServerImageBlob = {
  storageId: string
  mimeType: string
  sizeBytes: number
}

export type PreparedImage = {
  blob: Blob
  preview: string
  storageId: string
  mimeType: string
  sizeBytes: number
  fileName: string
}

export type RemoteImageDeps = {
  /** Authenticated shoppingImages:fetchRemote wrapper. URL only, always. */
  fetchRemote: (url: string) => Promise<ServerImageFetch>
  /** Downloads the server-stored bytes (Convex storage URL). */
  readBlob: (downloadUrl: string) => Promise<Blob>
  /** Normalizes a local raster blob for the Decart reference image. */
  normalizeImage: (source: Blob | string) => Promise<{ blob: Blob; preview: string }>
  /** Authenticated shoppingImports:register wrapper. */
  registerImport: (input: ShoppingImportInput) => Promise<{ uploadId: string; jobId: string; deduped: boolean }>
  /** Authenticated shoppingImages:discardFetch wrapper. No-op when the blob is referenced. */
  discardRemote: (storageId: string) => Promise<void>
}

export type RemoteImageRegister = {
  clientImportId: string
  fileName?: string
  productTitle?: string
  sourcePageUrl?: string
}

/**
 * Fast client-side URL gate (mirrors the room's drag rules; the SERVER enforces the same
 * policy authoritatively). Rejects non-http(s), credentials, whitespace, absurd lengths,
 * and obvious loopback/local forms so an obviously-bad address never costs a round-trip.
 */
export function validateRemoteUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /\s/.test(value)) {
    throw new Error("Drag a web image or upload a file")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Drag a web image or upload a file")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Drag a web image or upload a file")
  if (url.username || url.password) throw new Error("Image addresses with credentials are not supported.")
  const host = url.hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Private-network image URLs are not supported.")
  }
  return url.href
}

export type RemoteImageClient = {
  /** Try-on: server fetch → blob → normalize. Fast-fails on an invalid URL shape. */
  prepare: (url: string) => Promise<PreparedImage>
  /** Save an already-fetched (try-on) server blob: register only, never re-upload. */
  registerBlob: (image: ServerImageBlob, input: RemoteImageRegister) => Promise<{ uploadId: string; jobId: string }>
  /** Headless page save: fetch + register the same server blob in one op. */
  registerRemote: (url: string, input: RemoteImageRegister) => Promise<{ uploadId: string; jobId: string }>
  /** Discard a server blob the user walked away from. No-op when registered. */
  discard: (storageId: string) => Promise<void>
}

export function createRemoteImageClient(deps: RemoteImageDeps): RemoteImageClient {
  async function register(
    fetchResult: ServerImageBlob,
    input: RemoteImageRegister,
    fileFallbackName: string
  ): Promise<{ uploadId: string; jobId: string }> {
    const registerInput: ShoppingImportInput = {
      storageId: fetchResult.storageId,
      fileName: input.fileName ?? fileFallbackName,
      mimeType: fetchResult.mimeType,
      sizeBytes: fetchResult.sizeBytes,
      clientImportId: input.clientImportId
    }
    if (input.productTitle) registerInput.productTitle = input.productTitle
    if (input.sourcePageUrl) registerInput.sourcePageUrl = input.sourcePageUrl
    const registered = await deps.registerImport(registerInput)
    return { uploadId: registered.uploadId, jobId: registered.jobId }
  }

  return {
    async prepare(url: string): Promise<PreparedImage> {
      const checked = validateRemoteUrl(url)
      const fetched = await deps.fetchRemote(checked)
      const blob = await deps.readBlob(fetched.downloadUrl)
      const normalized = await deps.normalizeImage(blob)
      return {
        blob: normalized.blob,
        preview: normalized.preview,
        storageId: fetched.storageId,
        mimeType: fetched.mimeType,
        sizeBytes: fetched.sizeBytes,
        fileName: fileNameFromRemoteUrl(checked)
      }
    },
    async registerBlob(image: ServerImageFetch, input: RemoteImageRegister) {
      return register(image, input, "shopping-garment.jpg")
    },
    async registerRemote(url: string, input: RemoteImageRegister) {
      const checked = validateRemoteUrl(url)
      const fetched = await deps.fetchRemote(checked)
      return register(fetched, input, fileNameFromRemoteUrl(checked))
    },
    discard(storageId: string) {
      return deps.discardRemote(storageId)
    }
  }
}

/** A display file name for URL-sourced garments; the server caps length authoritatively. */
export function fileNameFromRemoteUrl(url: string): string {
  try {
    const segment = new URL(url).pathname.split("/").pop() || ""
    const name = segment.trim()
    if (name.length > 0) return name.slice(0, 128)
  } catch {
    // Fall through to the fallback below.
  }
  return "shopping-garment.jpg"
}