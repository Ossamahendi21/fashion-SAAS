// Test-only backend stub for the shopping-extension browser E2E.
//
// Implements the authenticated Convex boundary the room talks to (upload URL, blob
// store, import registration, import status, styling, advice, ownership) with scripted,
// deterministic responses. It performs ZERO network I/O and never touches OpenAI, the
// AI Gateway, Decart, retailers, credits, or Clerk. Framework-free and injected: the
// harness room passes these functions as the Room's platform props.
//
// This module is bundled ONLY into the test-extension overlay (e2e/.work). It must never
// ship in production builds — see the bundle-content regression tests.

import type {
  AdviceMatchItem,
  AdviceSignal,
  AdviceSimilarItem,
  ShoppingAdvice,
  ShoppingImportStatus,
  StyledSuggestion,
} from "../../lib/wardrobe-save"

export type E2eEvent = { at: number; event: string; detail?: string }

export type ScriptedSaveState = "processing" | "ready" | "needs_credits" | "no_item" | "failed"

export type E2eBackend = {
  calls: {
    uploadUrl: number
    blobStore: number
    register: number
    status: number
    style: number
    advice: number
    owned: number
    liveMirror: number
    quota: number
  }
  registered: Array<{ uploadId: string; fileName: string; storageId: string }>
  /** Step 3: server-fetched image lifecycle, mirroring convex shoppingImages:fetchRemote / :discardFetch. */
  remote: {
    fetchRemote: number
    discardFetch: number
    /** storageId -> bytes fetched from the fixture server, so try-on reads real image bytes. */
    stored: Map<string, Blob>
  }
  events: E2eEvent[]
  /** Base URL of the fixture server; item thumbnail URLs are built from it at call time. */
  fixtureBase: string
  setFixtureBase: (url: string) => void
  /** Status walk per save; the cursor sticks at the last entry. */
  saveSequence: ScriptedSaveState[]
  setSaveSequence: (sequence: ScriptedSaveState[]) => void
  /** Artificial latency before each backend answer, for race tests. */
  delays: { statusMs: number; styleMs: number; adviceMs: number }
  setDelays: (delays: Partial<E2eBackend["delays"]>) => void
  styleError: string | null
  setStyleError: (message: string | null) => void
  adviceError: string | null
  setAdviceError: (message: string | null) => void
  /** Step 3 server boundary: fetch + store the bytes, returning a download URL (no Convex here). */
  fetchRemote: (url: string) => Promise<{ storageId: string; mimeType: string; sizeBytes: number; downloadUrl: string }>
  /** Step 3 server boundary: reference-safe delete of an unregistered blob. */
  discardFetch: (storageId: string) => Promise<void>
  generateUploadUrl: () => Promise<string>
  postBlob: () => Promise<string>
  registerImport: (input: { fileName: string; storageId?: string }) => Promise<{ uploadId: string; jobId: string; deduped: boolean }>
  queryStatus: (uploadId: string) => Promise<ShoppingImportStatus>
  requestStyling: () => Promise<{ suggestions: StyledSuggestion[] }>
  requestAdvice: () => Promise<ShoppingAdvice>
  markOwned: () => Promise<null>
  reset: () => void
}

const delay = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve())

export function createE2eBackend(): E2eBackend {
  const backend: E2eBackend = {
    calls: { uploadUrl: 0, blobStore: 0, register: 0, status: 0, style: 0, advice: 0, owned: 0, liveMirror: 0, quota: 0 },
    registered: [],
    remote: { fetchRemote: 0, discardFetch: 0, stored: new Map<string, Blob>() },
    events: [],
    fixtureBase: "",
    saveSequence: ["processing", "ready"],
    delays: { statusMs: 0, styleMs: 0, adviceMs: 0 },
    styleError: null,
    adviceError: null,
    setFixtureBase(url: string) {
      backend.fixtureBase = url.replace(/\/+$/, "")
    },
    setSaveSequence(sequence: ScriptedSaveState[]) {
      backend.saveSequence = [...sequence]
      cursors.clear()
    },
    setDelays(patch: Partial<E2eBackend["delays"]>) {
      Object.assign(backend.delays, patch)
    },
    setStyleError(message: string | null) {
      backend.styleError = message
    },
    setAdviceError(message: string | null) {
      backend.adviceError = message
    },
    async fetchRemote(url: string) {
      backend.remote.fetchRemote += 1
      // Stands in for convex/lib/imageFetch.ts: the bytes come from the local fixture server
      // (the only host this test extension is allowed to fetch), raster types only, size-capped.
      // This keeps the E2E real for URL garments without giving the extension arbitrary egress.
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Image or page returned ${response.status}`)
      const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
      if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) throw new Error("Use a JPG, PNG or WebP image")
      const blob = await response.blob()
      const storageId = `storage-e2e-remote-${backend.remote.fetchRemote}`
      backend.remote.stored.set(storageId, blob)
      log("remote-fetched", storageId)
      // String key so the harness can serve the bytes in-memory (a real Convex storage URL,
      // which the production client downloads with fetch, never has this prefix).
      return { storageId, mimeType, sizeBytes: blob.size, downloadUrl: `e2e-storage:${storageId}` }
    },
    async discardFetch(storageId: string) {
      backend.remote.discardFetch += 1
      // Same reference-safe contract as the server: a blob a save already registered stays.
      if (backend.registered.some((row) => row.storageId === storageId)) return
      backend.remote.stored.delete(storageId)
      log("remote-discarded", storageId)
    },
    async generateUploadUrl() {
      backend.calls.uploadUrl += 1
      log("upload-url")
      return "https://e2e.invalid/upload"
    },
    async postBlob() {
      backend.calls.blobStore += 1
      log("blob-stored")
      return "storage-e2e-1"
    },
    async registerImport(input: { fileName: string; storageId?: string }) {
      backend.calls.register += 1
      const uploadId = `uploads-e2e-${backend.calls.register}`
      backend.registered.push({ uploadId, fileName: input.fileName, storageId: input.storageId ?? "" })
      log("save-started", input.fileName)
      return { uploadId, jobId: `jobs-e2e-${backend.calls.register}`, deduped: false }
    },
    async queryStatus(uploadId: string) {
      backend.calls.status += 1
      await delay(backend.delays.statusMs)
      const cursor = Math.min(cursors.get(uploadId) ?? 0, backend.saveSequence.length - 1)
      cursors.set(uploadId, cursor + 1)
      const state = backend.saveSequence[cursor] ?? "ready"
      log(`save-status:${state}`, uploadId)
      return {
        state,
        uploadId,
        jobId: "jobs-e2e-1",
        ...(state === "ready" || state === "needs_credits"
          ? { itemId: "items-e2e-1", itemName: "E2E Field Jacket", ownership: "considering" as const }
          : {}),
      }
    },
    async requestStyling() {
      backend.calls.style += 1
      log("style-started")
      await delay(backend.delays.styleMs)
      if (backend.styleError) throw Object.assign(new Error("e2e"), { data: { message: backend.styleError } })
      const thumb = (name: string) => (backend.fixtureBase ? `${backend.fixtureBase}/images/${name}` : null)
      const suggestions: StyledSuggestion[] = [
        {
          outfitId: "outfits-e2e-1",
          name: "E2E Riverside Combo",
          reasoning: "E2E reasoning one.",
          items: [
            { _id: "items-e2e-1", name: "E2E Field Jacket", category: "outerwear", url: thumb("product-jacket.png") },
            { _id: "items-e2e-2", name: "E2E Indigo Jeans", category: "bottom", url: thumb("product-dress.png") },
          ],
        },
        {
          outfitId: "outfits-e2e-2",
          name: "E2E Gallery Evening",
          reasoning: "E2E reasoning two.",
          items: [{ _id: "items-e2e-1", name: "E2E Field Jacket", category: "outerwear", url: thumb("product-jacket.png") }],
        },
      ]
      log("style-ready", "2 cards")
      return { suggestions }
    },
    async requestAdvice() {
      backend.calls.advice += 1
      log("advice-started")
      await delay(backend.delays.adviceMs)
      if (backend.adviceError) throw Object.assign(new Error("e2e"), { data: { message: backend.adviceError } })
      const thumb = (name: string) => (backend.fixtureBase ? `${backend.fixtureBase}/images/${name}` : null)
      const similar: AdviceSimilarItem[] = [
        {
          itemId: "items-e2e-9",
          name: "E2E Charcoal Overshirt",
          category: "outerwear",
          url: thumb("product-jacket.png"),
          similarity: 0.94,
          duplicate: true,
        },
      ]
      const matching: AdviceMatchItem[] = [
        { _id: "items-e2e-2", name: "E2E Indigo Jeans", category: "bottom", url: thumb("product-dress.png") },
      ]
      const signals: AdviceSignal[] = [{ type: "many_matches", message: "Works with 7 pieces you own" }]
      log("advice-ready")
      return {
        candidate: { itemId: "items-e2e-1", name: "E2E Field Jacket" },
        similarOwnedItems: similar,
        matchingOwnedItems: matching,
        matchCount: 7,
        outfitPotential: { estimatedCombinations: 8, display: "8 outfit possibilities" },
        label: "versatile",
        signals,
        summary: "E2E summary: works with your indigo jeans.",
        pros: ["E2E pro one", "E2E pro two"],
        considerations: ["E2E consideration one"],
        smallWardrobe: false,
        cached: false,
      }
    },
    async markOwned() {
      backend.calls.owned += 1
      log("owned-marked")
      return null
    },
    reset() {
      backend.calls = { uploadUrl: 0, blobStore: 0, register: 0, status: 0, style: 0, advice: 0, owned: 0, liveMirror: 0, quota: 0 }
      backend.registered = []
      backend.remote = { fetchRemote: 0, discardFetch: 0, stored: new Map<string, Blob>() }
      backend.events = []
      backend.saveSequence = ["processing", "ready"]
      backend.delays = { statusMs: 0, styleMs: 0, adviceMs: 0 }
      backend.styleError = null
      backend.adviceError = null
      cursors.clear()
    },
  }
  const cursors = new Map<string, number>()
  function log(event: string, detail?: string) {
    // NEVER log token values, URLs with secrets, or bytes — names/phases only.
    backend.events.push({ at: Date.now(), event, ...(detail ? { detail } : {}) })
  }
  return backend
}
