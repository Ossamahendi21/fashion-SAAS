// Background service worker: downloads garment/product images without site cookies, and mints
// the one-time capabilities that authorise a garment handoff or a save.
//
// It holds no credentials. Step 2E3 removed the browser-side permanent Decart credential
// completely (the `token`, `status` and `test-key` handlers are gone): Live Mirror
// authorization is a server-side Convex action (convex/liveMirror.ts), and the ONLY permanent
// Decart credential is the server-side DECART_API_KEY env variable.
//
// Capability minting lives here rather than in the content script because
// `chrome.storage.session` is only exposed to trusted extension contexts; a content script
// cannot write it at all. See lib/capability-service.ts. The image path below keeps its own
// stricter gate and is untouched by that change.

import { handleIssueCapability, ISSUE_CAPABILITY_MESSAGE } from "./lib/capability-service"
import { purgeLegacySettings } from "./lib/settings"

// Runs on every service-worker startup (install, update, browser launch, wake): an old
// installation cleans its removed credential-era keys itself without ever opening Options.
void purgeLegacySettings()

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/svg+xml"])

type OpenWearRequest = { type: "image"; url?: string }

// ---------- Image download ----------

/** Only public http(s) URLs: never localhost or private-network addresses. */
function imageUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid image URL")
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Drag a web image or upload a file")
  const host = url.hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "0.0.0.0") {
    throw new Error("Private-network image URLs are not supported")
  }
  return url.href
}

/** Returns a dragged image as a data URL. A product-page link resolves to its og:image / twitter:image. */
async function getImage(url: string) {
  url = imageUrl(url)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetchPublic(url, controller.signal)
    const mime = response.headers.get("content-type")?.split(";")[0].toLowerCase() || ""
    if (mime === "text/html") {
      const page = new TextDecoder().decode(await readBytes(response, MAX_PAGE_BYTES, { truncate: true }))
      const preview = previewImageUrl(page, url)
      if (!preview) throw new Error("This link has no public product image. Drag the photo itself or upload a file")
      const image = await fetchPublic(imageUrl(preview), controller.signal)
      return imageDataUrl(image)
    }
    return imageDataUrl(response)
  } finally { clearTimeout(timeout) }
}

/** credentials: "omit" so the shop never sees the request as coming from the logged-in user. */
async function fetchPublic(url: string, signal: AbortSignal) {
  const response = await fetch(url, { credentials: "omit", redirect: "follow", signal })
  if (!response.ok) throw new Error(`Image or page returned ${response.status}`)
  return response
}

/** Reads a response body up to `limit` bytes. Pages are truncated (preview tags live in <head>);
 *  images over the limit are rejected. */
async function readBytes(response: Response, limit: number, { truncate = false } = {}) {
  if (!truncate && Number(response.headers.get("content-length")) > limit) throw new Error("Image exceeds 8 MB")
  if (!response.body) throw new Error("Image or page could not be read")
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  while (total < limit) {
    const { done, value } = await reader.read()
    if (done) break
    if (!truncate && total + value.length > limit) { await reader.cancel(); throw new Error("Image exceeds 8 MB") }
    const part = value.subarray(0, limit - total)
    chunks.push(part); total += part.length
  }
  if (total >= limit) await reader.cancel()
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

/** Finds the page's share image in its <meta property="og:image"> style tags. */
function previewImageUrl(html: string, pageUrl: string) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(match => [match[1].toLowerCase(), match[2] || match[3] || match[4]]))
    const name = (attributes.property || attributes.name || "").toLowerCase()
    if (!["og:image", "og:image:secure_url", "twitter:image"].includes(name) || !attributes.content) continue
    const decoded = attributes.content.replace(/&amp;/gi, "&").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    try { return new URL(decoded, pageUrl).href } catch { /* Try the next tag. */ }
  }
  return null
}

async function imageDataUrl(response: Response) {
  const mime = response.headers.get("content-type")?.split(";")[0].toLowerCase() || ""
  if (!IMAGE_TYPES.has(mime)) throw new Error("Use a JPG, PNG or WebP image")
  const bytes = await readBytes(response, MAX_IMAGE_BYTES)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mime};base64,${btoa(binary)}`
}

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

chrome.runtime.onMessage.addListener((message: OpenWearRequest, sender, sendResponse) => {
  // Only OpenWear's own pages (fitting room) may fetch images; content scripts on shops may not.
  const fromExtensionPage = sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""))
  if (!fromExtensionPage) return false
  const run = async () => {
    switch (message?.type) {
      case "image": return getImage(message.url || "")
      default: throw new Error("Unknown OpenWear request")
    }
  }
  run().then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: String(error?.message || error) }))
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
