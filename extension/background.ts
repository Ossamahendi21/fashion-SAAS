// Background service worker: mints the one-time capabilities that authorise a garment handoff
// or a save, and injects the content script into already-open tabs on install.
//
// It holds no credentials and fetches nothing. Step 2E3 removed the browser-side permanent
// Decart credential completely (the `token`, `status` and `test-key` handlers are gone): Live
// Mirror authorization is a server-side Convex action (convex/liveMirror.ts), and the ONLY
// permanent Decart credential is the server-side DECART_API_KEY env variable.
//
// Step 3 moved retail-image fetching to the server as well: the `image` message handler and its
// entire fetch/SVG/data-URL pipeline are gone. The room now calls the authenticated Convex
// action shoppingImages:fetchRemote (convex/lib/imageFetch.ts), which SSRF-gates the URL, caps
// size and MIME, and stores the bytes. A dead handler here could only be reached by a
// compromised extension page, so removing it removes an attack surface rather than a feature.
//
// Capability minting lives here rather than in the content script because
// `chrome.storage.session` is only exposed to trusted extension contexts; a content script
// cannot write it at all. See lib/capability-service.ts.

import { handleIssueCapability, ISSUE_CAPABILITY_MESSAGE } from "./lib/capability-service"
import { purgeLegacySettings } from "./lib/settings"

// Runs on every service-worker startup (install, update, browser launch, wake): an old
// installation cleans its removed credential-era keys itself without ever opening Options.
void purgeLegacySettings()

// ---------- Message handling ----------

/**
 * Capability issuance, as its own explicit case: only this extension's own top-frame content
 * script may ask, only for the two known scopes, and the reply is the opaque token alone.
 * Returns the token, never the store contents.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== ISSUE_CAPABILITY_MESSAGE) return false
  handleIssueCapability(message, sender, { store: chrome.storage.session, runtimeId: chrome.runtime.id }).then(sendResponse)
  return true
})

chrome.runtime.onInstalled.addListener(async () => {
  // Content scripts only run on pages loaded after install; add the launcher to tabs that are already open.
  const script = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0]
  if (!script) return
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    if (tab.id) chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [script] }).catch(() => {})
  }
})

// Dev-only: an unpacked install can be reloaded from a localhost page, so new builds can be picked
// up without visiting the extensions page. Packed (store) installs ignore this.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.type !== "dev-reload" || !/^http:\/\/localhost(:\d+)?\//.test(sender.url || "")) return false
  chrome.management.getSelf().then(self => {
    if (self.installType !== "development") return sendResponse({ ok: false })
    sendResponse({ ok: true })
    setTimeout(() => chrome.runtime.reload(), 100)
  })
  return true
})
