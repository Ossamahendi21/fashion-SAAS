// Step 4A.1: capability issuance runs in the service worker, not the content script.
//
// Real Chrome finding: `chrome.storage.session` is not exposed to content scripts, so the
// content script's own mint call always rejected and the whole handoff was silently dead in
// production. Minting moved to the background worker; storage.session stays trusted-only.
// These tests pin the trust model, the scope isolation, and the absence of a widened access
// level. Browser-level proof of the real route lives in e2e/shopping-loop.e2e.mjs.

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { build } from "esbuild"

async function bundleModule(relative) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, format: "esm", write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

const { handleIssueCapability, isOwnContentScript, isCapabilityKind, ISSUE_CAPABILITY_MESSAGE } =
  await bundleModule("../lib/capability-service.ts")
const { consumeCapability, CAPABILITY_TTL_MS } = await bundleModule("../lib/wardrobe-save.ts")

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, "utf8")
const content = read("content.tsx")
const background = read("background.ts")
const room = read("tabs/room.tsx")
const packageJson = read("package.json")

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop"

/** In-memory stand-in for chrome.storage.session. */
function fakeStore() {
  const data = {}
  return {
    data,
    get: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys]
      const out = {}
      for (const key of list) if (key in data) out[key] = data[key]
      return out
    },
    set: async (items) => { Object.assign(data, items) },
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]
    }
  }
}

/** A sender as Chrome reports it for this extension's own top-frame content script. */
function ownContentScript(url = "https://shop.example.com/product") {
  return { id: RUNTIME_ID, url, tab: { id: 7 }, frameId: 0 }
}

let counter = 0
function deps(overrides = {}) {
  return { store: fakeStore(), runtimeId: RUNTIME_ID, createId: () => `id-${++counter}`, ...overrides }
}

// ---------- Trust model ----------

test("1: the content script can no longer issue through session storage", () => {
  assert.equal(content.includes("chrome.storage.session"), false, "content script never touches session storage")
  assert.equal(content.includes("issueCapability"), false, "content script no longer mints directly")
  assert.equal(content.includes("consumeCapability"), false, "consumption stays in the trusted room")
})

test("2: content requests the garment capability from the background worker", () => {
  assert.ok(content.includes('requestCapability("garment")'), "garment flow asks the worker")
  assert.ok(!content.includes('requestCapability("garment", "'), "no extra identity or user data is sent")
})

test("3: content requests the save capability from the background worker", () => {
  assert.ok(content.includes('requestCapability("save")'), "save flow asks the worker")
})

test("4: the worker accepts a valid internal request", async () => {
  const d = deps()
  const response = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "garment" }, ownContentScript(), d)
  assert.equal(response.ok, true)
  assert.equal(typeof response.token, "string")
  assert.match(response.token, /^owcap-garment-/)
})

test("5: the worker rejects an unknown capability kind", async () => {
  for (const kind of ["admin", "", null, undefined, 42, "GARMENT", "save ", ["save"]]) {
    const response = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind }, ownContentScript(), deps())
    assert.equal(response.ok, false, `kind ${JSON.stringify(kind)} rejected`)
    assert.equal(response.error, "Unknown capability kind")
  }
})

test("6: the worker rejects any untrusted or external sender", async () => {
  const rejected = [
    ["another extension", { id: "someotherextensionid", url: "https://evil.example/", tab: { id: 1 }, frameId: 0 }],
    ["no id", { url: "https://shop.example.com/", tab: { id: 1 }, frameId: 0 }],
    ["extension page (the room)", { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/tabs/room.html`, tab: undefined, frameId: 0 }],
    ["sub-frame", { id: RUNTIME_ID, url: "https://shop.example.com/", tab: { id: 1 }, frameId: 3 }],
    ["no tab", { id: RUNTIME_ID, url: "https://shop.example.com/", frameId: 0 }],
    ["file url", { id: RUNTIME_ID, url: "file:///etc/passwd", tab: { id: 1 }, frameId: 0 }],
    ["chrome url", { id: RUNTIME_ID, url: "chrome://extensions", tab: { id: 1 }, frameId: 0 }],
    ["malformed url", { id: RUNTIME_ID, url: "not a url", tab: { id: 1 }, frameId: 0 }],
    ["missing url", { id: RUNTIME_ID, tab: { id: 1 }, frameId: 0 }],
    ["empty url", { id: RUNTIME_ID, url: "", tab: { id: 1 }, frameId: 0 }],
    ["no sender", undefined]
  ]
  for (const [label, sender] of rejected) {
    assert.equal(isOwnContentScript(sender, RUNTIME_ID), false, `${label} is not our content script`)
    const d = deps()
    const response = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "garment" }, sender, d)
    assert.equal(response.ok, false, `${label} cannot mint`)
    assert.equal(Object.keys(d.store.data).length, 0, `${label} stored nothing`)
  }
})

test("6b: a sender from another extension id is rejected even with a matching url", async () => {
  const response = await handleIssueCapability(
    { type: ISSUE_CAPABILITY_MESSAGE, kind: "save" },
    { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", url: "https://shop.example.com/", tab: { id: 2 }, frameId: 0 },
    deps()
  )
  assert.equal(response.ok, false)
})

test("6c: an unknown message type is refused by the capability case", async () => {
  for (const type of ["image", "dev-reload", undefined, null, "openwear:garment"]) {
    const response = await handleIssueCapability({ type, kind: "garment" }, ownContentScript(), deps())
    assert.equal(response.ok, false, `type ${JSON.stringify(type)} refused`)
  }
})

test("6d: issuance failure fails closed instead of returning a token", async () => {
  const broken = deps()
  broken.store.set = async () => { throw new Error("storage unavailable") }
  const response = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "garment" }, ownContentScript(), broken)
  assert.deepEqual(response, { ok: false, error: "Capability could not be issued" })
  assert.equal("token" in response, false, "no token in a failure response")
})

// ---------- Storage and response hygiene ----------

test("7: the token is stored only in the session store, with metadata only", async () => {
  const d = deps()
  const response = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "save" }, ownContentScript(), d)
  const keys = Object.keys(d.store.data)
  assert.deepEqual(keys, [response.token], "exactly one session entry, keyed by the token")
  const entry = d.store.data[response.token]
  assert.equal(entry.kind, "save")
  assert.equal(typeof entry.createdAt, "number")
  const serialized = JSON.stringify(d.store.data)
  for (const forbidden of ["fake-bytes", "blob", "http", "shop.example.com", "jwt", "clerk", "secret"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, `store holds no ${forbidden}`)
  }
})

test("7b: the worker is wired to chrome.storage.session, not local storage", () => {
  assert.ok(
    background.includes("store: chrome.storage.session"),
    "issuance targets the in-memory session area"
  )
  assert.equal(/store:\s*chrome\.storage\.local/.test(background), false, "never mints into local storage")
})

test("8: the response returns the token and nothing else", async () => {
  const d = deps()
  const response = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "garment" }, ownContentScript(), d)
  assert.deepEqual(Object.keys(response).sort(), ["ok", "token"], "no metadata, no store contents")
  const serialized = JSON.stringify(response)
  for (const forbidden of ["createdAt", "kind", "owcap-garment-id-1", "data", "store"]) {
    if (forbidden === "owcap-garment-id-1") continue
    assert.equal(serialized.includes(forbidden), false, `response omits ${forbidden}`)
  }
})

// ---------- Scope isolation, replay, forgery ----------

test("9: the room consumes a valid garment token", async () => {
  const d = deps()
  const { token } = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "garment" }, ownContentScript(), d)
  assert.equal(await consumeCapability(d.store, token, "garment"), true, "garment token authorises a garment")
})

test("10: the room consumes a valid save token", async () => {
  const d = deps()
  const { token } = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "save" }, ownContentScript(), d)
  assert.equal(await consumeCapability(d.store, token, "save"), true, "save token authorises a save")
})

test("11: a replayed token is rejected on second use", async () => {
  const d = deps()
  const { token } = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "garment" }, ownContentScript(), d)
  assert.equal(await consumeCapability(d.store, token, "garment"), true)
  assert.equal(await consumeCapability(d.store, token, "garment"), false, "consume-on-read still holds")
})

test("12: a wrong-scope token is rejected and burned", async () => {
  const garment = deps()
  const g = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "garment" }, ownContentScript(), garment)
  assert.equal(await consumeCapability(garment.store, g.token, "save"), false, "a garment token cannot Save")
  assert.equal(await consumeCapability(garment.store, g.token, "garment"), false, "and it is spent by the attempt")

  const save = deps()
  const s = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "save" }, ownContentScript(), save)
  assert.equal(await consumeCapability(save.store, s.token, "garment"), false, "a save token cannot become a garment")
})

test("13: forged, malformed and expired tokens are rejected", async () => {
  const d = deps()
  const { token } = await handleIssueCapability({ type: ISSUE_CAPABILITY_MESSAGE, kind: "garment" }, ownContentScript(), d)
  const forgeries = [
    `owcap-garment-${crypto.randomUUID()}`,
    "owcap-garment-",
    "not-a-token",
    token.replace("owcap-", "owcapX-"),
    token + "-extra",
    "",
    null,
    undefined,
    42,
    { length: 200 }
  ]
  for (const forged of forgeries) {
    assert.equal(await consumeCapability(d.store, forged, "garment"), false, `forgery rejected: ${String(forged).slice(0, 24)}`)
  }
  // Expired: same entry, evaluated past the TTL.
  assert.equal(await consumeCapability(d.store, token, "garment", Date.now() + CAPABILITY_TTL_MS), false, "TTL enforced")
})

test("13b: only the two documented scopes exist", () => {
  assert.deepEqual(["save", "garment"].filter(isCapabilityKind), ["save", "garment"])
  assert.equal(isCapabilityKind("token"), false)
  assert.equal(isCapabilityKind(""), false)
})

// ---------- Existing flows still request a capability ----------

test("14/15/16: drag, contextual Try on and contextual Save all request a capability", () => {
  const forward = content.slice(content.indexOf("const forwardGarment"), content.indexOf("/** Try on:"))
  assert.ok(forward.includes('requestCapability("garment")'), "drag and Try on share the garment request")
  assert.ok(content.includes("void forwardGarment({"), "try-on and the drop paths share the forwarder")
  assert.ok(content.includes("const sendSave = useCallback"), "Save is a separate flow")
  assert.ok(content.includes("issueToken: () => requestCapability(\"save\")"), "Save asks for a save-scoped token")
  assert.equal(room.includes('consumeCapability(chrome.storage.session, capability, "garment")'), true, "room still validates in a trusted context")
  assert.equal(room.includes('consumeCapability(chrome.storage.session, token, "save")'), true, "save still validated in the room")
})

test("17: page JavaScript cannot mint a capability", async () => {
  // A page can only reach the extension through window.postMessage, which the content script
  // treats as untrusted; the worker's own gate additionally requires a content-script sender.
  const d = deps()
  const fromPage = await handleIssueCapability(
    { type: ISSUE_CAPABILITY_MESSAGE, kind: "garment" },
    { id: undefined, url: "https://shop.example.com/", tab: { id: 5 }, frameId: 0 },
    d
  )
  assert.equal(fromPage.ok, false, "a page has no extension sender id")
  assert.equal(Object.keys(d.store.data).length, 0, "nothing stored")
  assert.equal(background.includes("externally_connectable"), false, "no externally_connectable manifest entry is added")
})

// ---------- Storage access level must stay trusted-only ----------

test("18: session storage access is never widened to untrusted contexts", () => {
  const sources = {
    "background.ts": background,
    "content.tsx": content,
    "tabs/room.tsx": room,
    "lib/capability-service.ts": read("lib/capability-service.ts"),
    "lib/capability-client.ts": read("lib/capability-client.ts"),
    "package.json": packageJson
  }
  for (const [name, source] of Object.entries(sources)) {
    assert.equal(source.includes("TRUSTED_AND_UNTRUSTED_CONTEXTS"), false, `${name} does not widen access`)
    assert.equal(source.includes("setAccessLevel"), false, `${name} never calls setAccessLevel`)
  }
  assert.equal(packageJson.includes('"access_level"'), false, "manifest declares no storage access level")
})

// ---------- No secrets, and the image path is untouched ----------

test("19: no credential or identity material is introduced", () => {
  // Strip comments so prose about what is excluded cannot trip the scan.
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const added = [background, read("lib/capability-service.ts"), read("lib/capability-client.ts")].map(code).join("\n")
  for (const forbidden of ["JWT", "Clerk", "CLERK_SECRET", "AGENT_SERVICE", "serviceKey", "userId", "user_id", "apiKey", "DECART_API_KEY", "localStorage"]) {
    assert.equal(added.includes(forbidden), false, `no ${forbidden} in the issuance path`)
  }
  // The client sends nothing but the type and the scope name.
  const client = read("lib/capability-client.ts")
  assert.ok(client.includes("chrome.runtime.sendMessage({ type: ISSUE_CAPABILITY_MESSAGE, kind })"), "the request body is type + kind only")
  assert.equal(/sendMessage\(\{[^}]*,[^}]*,/.test(client), false, "no extra request fields")
})

test("20: the worker issues capabilities only, and has no fetch path at all (Step 3)", () => {
  // Step 3 removed the image message entirely: retail images are fetched and stored by the
  // authenticated Convex action shoppingImages:fetchRemote. What remains in the worker is
  // capability minting, gated so only this extension's own top frame can ask.
  assert.ok(/\)\?\.type !== ISSUE_CAPABILITY_MESSAGE\) return false/.test(background), "only capability issuance is handled")
  assert.ok(background.includes("handleIssueCapability(message, sender"), "issuance is delegated to the gated service")
  assert.ok(!background.includes('case "image"'), "the image handler is gone")
  assert.ok(!background.includes("getImage"), "no image fetch helper remains")
  assert.ok(!background.includes("fromExtensionPage"), "the old image-path sender gate is gone with it")
  // No image pipeline survives anywhere in the worker, in any of its former shapes.
  for (const gone of ["imageDataUrl", "previewImageUrl", "fetchPublic", "readBytes", "IMAGE_TYPES", "MAX_IMAGE_BYTES", "MAX_PAGE_BYTES", "imageUrl("]) {
    assert.ok(!background.includes(gone), `the worker must not keep ${gone}`)
  }
  // A service worker with no fetch path must not even be able to reach the network layer.
  assert.equal(background.includes("fetch("), false, "the worker performs no fetch")
  assert.equal(background.includes("XMLHttpRequest"), false, "the worker opens no XHR")
  // Issuance itself stays narrow: no storage, no secrets, no provider call.
  assert.equal(background.includes("chrome.storage.local"), false, "issuance does not touch persistent storage")
  assert.equal(background.includes("api.decart.ai"), false, "issuance never calls the provider")
})
