// Test-only room entry for the shopping-extension browser E2E.
//
// Mounts the REAL production Room component with stub platform adapters: a scripted
// backend replaces every authenticated Convex call, Live Mirror authorization throws a
// sentinel (it must never be reached), and quota/billing are inert. The content script,
// overlay, capabilities, postMessage flow, background image fetch, and all room UI
// state machines run UNMODIFIED.
//
// Bundled ONLY into the assembled test extension (e2e/.work). Never part of the
// production build — the bundle-content regression tests fail the run if any marker
// below ever appears in production output.
import { useEffect, useMemo, useRef } from "react"
import { createRoot } from "react-dom/client"
import { Room } from "../../tabs/room"
import { issueCapability, type WardrobeSaveDeps } from "../../lib/wardrobe-save"
import { normalizeImage } from "../../lib/garment"
import { createRemoteImageClient, type RemoteImageClient } from "../../lib/remote-image"
import { createE2eBackend, type E2eBackend } from "./backend-stub"

declare global {
  interface Window {
    __owE2e?: {
      ready: boolean
      events: Array<{ at: number; event: string; detail?: string }>
      calls: E2eBackend["calls"]
      registered: E2eBackend["registered"]
      setFixtureBase: (url: string) => void
      setSaveSequence: (sequence: Array<"processing" | "ready" | "needs_credits" | "no_item" | "failed">) => void
      setDelays: (delays: Partial<E2eBackend["delays"]>) => void
      replayLastGarment: () => boolean
      mintToken: (kind: "save" | "garment") => Promise<string>
      reset: () => void
    }
  }
}

const E2E_LIVE_MIRROR_SENTINEL = "E2E_LIVE_MIRROR_BLOCKED"

function HarnessRoom() {
  const backend = useMemo(() => createE2eBackend(), [])
  const lastGarmentRef = useRef<Record<string, unknown> | null>(null)

  // Observe garment handoffs at the room boundary for the event log. Capability values
  // are stripped before logging; the full message is retained in memory ONLY so the
  // replay test can re-dispatch it without the page ever seeing a token.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent && event.source !== window) return
      const data = event.data
      if (!data || typeof data !== "object" || data.type !== "openwear:garment") return
      const { capability: _dropped, ...rest } = data as Record<string, unknown>
      void _dropped
      lastGarmentRef.current = data as Record<string, unknown>
      backend.events.push({ at: Date.now(), event: "garment-received", detail: String(rest.name || "") })
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [backend])

  const wardrobeSave = useMemo<WardrobeSaveDeps>(
    () => ({
      generateUploadUrl: () => backend.generateUploadUrl(),
      postBlob: () => backend.postBlob(),
      registerImport: (input) => backend.registerImport(input),
      queryStatus: (uploadId: string) => backend.queryStatus(uploadId),
    }),
    [backend]
  )

  // Step 3 remote-image client against the stubbed server boundary. The fixture server is the
  // only fetchable host (extension host permissions are restricted in the test build), which
  // keeps the "server fetch" real enough to exercise the URL garment path end to end.
  const remoteImage = useMemo<RemoteImageClient>(
    () =>
      createRemoteImageClient({
        fetchRemote: (url) => backend.fetchRemote(url),
        readBlob: (downloadUrl) => {
          const storageId = downloadUrl.startsWith("e2e-storage:") ? downloadUrl.slice("e2e-storage:".length) : ""
          const stored = storageId ? backend.remote.stored.get(storageId) : undefined
          return stored ? Promise.resolve(stored) : fetch(downloadUrl).then((res) => res.blob())
        },
        normalizeImage,
        registerImport: (input) => backend.registerImport(input),
        discardRemote: (storageId) => backend.discardFetch(storageId),
      }),
    [backend]
  )

  useEffect(() => {
    window.__owE2e = {
      ready: true,
      events: backend.events,
      calls: backend.calls,
      registered: backend.registered,
      setFixtureBase: (url: string) => backend.setFixtureBase(url),
      setSaveSequence: (sequence) => backend.setSaveSequence(sequence),
      setDelays: (patch) => backend.setDelays(patch),
      replayLastGarment: () => {
        const message = lastGarmentRef.current
        if (!message) return false
        backend.events.push({ at: Date.now(), event: "garment-replayed" })
        window.postMessage(message, "*")
        return true
      },
      // Test-only: the room is a trusted extension page, so it mints directly the way the
      // service worker does in production. This cannot be done from the content script --
      // chrome.storage.session is not exposed there -- which is why production issuance is
      // delegated to the worker and exercised for real by the Try on click in test 7.
      mintToken: (kind: "save" | "garment") => issueCapability(chrome.storage.session, kind),
      reset: () => {
        lastGarmentRef.current = null
        backend.reset()
        backend.events.push({ at: Date.now(), event: "harness-reset" })
      },
    }
  }, [backend])

  return (
    <Room
      authStatus={{ state: "signed-in", convexAuthenticated: true }}
      liveMirrorAction={async () => {
        backend.calls.liveMirror += 1
        backend.events.push({ at: Date.now(), event: "live-mirror-blocked" })
        throw new Error(E2E_LIVE_MIRROR_SENTINEL)
      }}
      refreshBilling={async () => {}}
      loadQuotaStatus={async () => {
        backend.calls.quota += 1
        return null
      }}
      wardrobeSave={wardrobeSave}
      requestStyling={async (args) => {
        void args
        return backend.requestStyling()
      }}
      saveOutfitProposal={async () => null}
      markOwned={async () => backend.markOwned()}
      requestAdvice={async (args) => {
        void args
        return backend.requestAdvice()
      }}
      remoteImage={remoteImage}
    />
  )
}

const mount = document.getElementById("__plasmo") ?? document.body
createRoot(mount).render(<HarnessRoom />)
