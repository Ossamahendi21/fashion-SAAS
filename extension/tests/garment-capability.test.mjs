// Step 3B.1: every garment command requires an extension-issued, single-use capability.
//
// A shopping page is the room iframe's parent, so `event.source === window.parent` cannot
// distinguish our content script from hostile page JavaScript. Garment handoff therefore uses
// the same scoped-capability mechanism as Save: the content script mints a garment-scoped
// token into `chrome.storage.session` (page-inaccessible), the room validates the message
// shape and consumes the token before `tryOn` ever runs. Synthetic messages and Blobs only:
// no network, no providers, no live sites.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

async function bundleModule(relative) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, format: "esm", write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

const saver = await bundleModule("../lib/wardrobe-save.ts")

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, "utf8")
const room = read("tabs/room.tsx")
const content = read("content.tsx")

function fakeTokenStore(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => store.has(key)).map(key => [key, store.get(key)])),
    set: async (items) => { for (const [key, value] of Object.entries(items)) store.set(key, value) },
    remove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) store.delete(key) }
  }
}

const garmentMessage = (overrides = {}) => ({
  type: "openwear:garment",
  capability: "owcap-garment-test-id",
  url: "https://shop.example.com/images/blue.jpg",
  name: "Blue Shirt",
  ...overrides
})

/** Room-side gate, mirroring handleGarmentMessage without React. */
async function gate(store, data, onTryOn) {
  const command = saver.parseGarmentMessage(data)
  if (!command) return "ignored-shape"
  if (!(await saver.consumeCapability(store, command.capability, "garment"))) return "ignored-token"
  const { capability: _used, ...incoming } = command
  await onTryOn(incoming)
  return "accepted"
}

// ---------- Capability mechanics ----------

test("garment capabilities are scoped, single-use, and expiring", async () => {
  const store = fakeTokenStore()
  const token = await saver.issueCapability(store, "garment", () => "g1")
  assert.equal(token, "owcap-garment-g1")
  assert.equal(await saver.consumeCapability(store, token, "garment"), true)
  assert.equal(await saver.consumeCapability(store, token, "garment"), false)
})

test("6/7: scopes never cross: save tokens cannot authorize garments and vice versa", async () => {
  const store = fakeTokenStore()
  const saveToken = await saver.issueCapability(store, "save", () => "s1")
  const garmentToken = await saver.issueCapability(store, "garment", () => "g1")
  assert.equal(await saver.consumeCapability(store, saveToken, "garment"), false, "save token cannot satisfy garment")
  assert.equal(await saver.consumeCapability(store, garmentToken, "save"), false, "garment token cannot satisfy save")
  // A wrong-scope attempt burns the token: fail closed, never leave it usable afterwards.
  assert.equal(await saver.consumeCapability(store, saveToken, "save"), false)
  assert.equal(await saver.consumeCapability(store, garmentToken, "garment"), false)
  const freshSave = await saver.issueCapability(store, "save", () => "s2")
  const freshGarment = await saver.issueCapability(store, "garment", () => "g2")
  assert.equal(await saver.consumeCapability(store, freshSave, "save"), true)
  assert.equal(await saver.consumeCapability(store, freshGarment, "garment"), true)
})

test("5: expired capabilities fail closed", async () => {
  const store = fakeTokenStore()
  const token = await saver.issueCapability(store, "garment", () => "old")
  assert.equal(await saver.consumeCapability(store, token, "garment", Date.now() + 11 * 60 * 1000), false)
})

test("17: token cleanup is idempotent and storage errors fail closed", async () => {
  const store = fakeTokenStore()
  const token = await saver.issueCapability(store, "garment", () => "cleanup")
  assert.equal(await saver.consumeCapability(store, token, "garment"), true)
  assert.equal(await saver.consumeCapability(store, token, "garment"), false, "second consume finds nothing")
  assert.equal(store.store.size, 0, "no residue left behind")
  const broken = { get: async () => { throw new Error("denied") }, set: async () => {}, remove: async () => {} }
  assert.equal(await saver.consumeCapability(broken, token, "garment"), false)
  await assert.doesNotReject(saver.issueCapability({ ...broken, set: async () => {} }, "garment"))
})

// ---------- Message validation ----------

test("1: a valid garment capability is accepted exactly once", async () => {
  const store = fakeTokenStore()
  const token = await saver.issueCapability(store, "garment", () => "valid-1")
  const triedOn = []
  assert.equal(await gate(store, garmentMessage({ capability: token, sourcePageUrl: "https://shop.example.com/p/1" }), async (incoming) => triedOn.push(incoming)), "accepted")
  assert.equal(triedOn.length, 1)
  assert.equal(triedOn[0].url, "https://shop.example.com/images/blue.jpg")
  assert.equal(triedOn[0].sourcePageUrl, "https://shop.example.com/p/1", "provenance survives validation")
})

test("2: replay of a consumed capability is rejected", async () => {
  const store = fakeTokenStore()
  const token = await saver.issueCapability(store, "garment", () => "replay-1")
  let calls = 0
  assert.equal(await gate(store, garmentMessage({ capability: token }), async () => { calls++ }), "accepted")
  assert.equal(await gate(store, garmentMessage({ capability: token }), async () => { calls++ }), "ignored-token")
  assert.equal(calls, 1, "tryOn ran exactly once")
})

test("3/4: random forged and missing tokens are rejected silently", async () => {
  const store = fakeTokenStore()
  let calls = 0
  const onTryOn = async () => { calls++ }
  assert.equal(await gate(store, garmentMessage({ capability: "owcap-garment-forged" }), onTryOn), "ignored-token")
  const { capability: _missing, ...noToken } = garmentMessage()
  assert.equal(await gate(store, noToken, onTryOn), "ignored-shape")
  assert.equal(await gate(store, null, onTryOn), "ignored-shape")
  assert.equal(await gate(store, "a string", onTryOn), "ignored-shape")
  assert.equal(calls, 0)
})

test("8: a hostile page postMessage without a token cannot change the garment", async () => {
  const store = fakeTokenStore()
  let calls = 0
  const hostile = [
    { type: "openwear:garment", url: "https://evil.example/steal.jpg", name: "Free money" },
    { type: "openwear:garment", url: "https://evil.example/steal.jpg", capability: "" },
    { type: "openwear:garment", url: "https://evil.example/steal.jpg", capability: "save-" },
    { type: "openwear:garment", url: "https://evil.example/steal.jpg", capability: 42 }
  ]
  for (const message of hostile) {
    assert.equal(await gate(store, message, async () => { calls++ }), message.capability === "" || typeof message.capability !== "string" ? "ignored-shape" : "ignored-token")
  }
  assert.equal(calls, 0, "no tryOn from any forged message")
})

test("13: malformed garment payloads are rejected", async () => {
  const store = fakeTokenStore()
  const token = (id) => saver.issueCapability(store, "garment", () => id)
  let calls = 0
  const onTryOn = async () => { calls++ }
  assert.equal(await gate(store, garmentMessage({ capability: await token("m1"), url: "javascript:alert(1)" }), onTryOn), "ignored-shape")
  assert.equal(await gate(store, garmentMessage({ capability: await token("m2"), url: "x".repeat(3000) }), onTryOn), "ignored-shape")
  assert.equal(await gate(store, garmentMessage({ capability: await token("m3"), url: undefined, file: undefined }), onTryOn), "ignored-shape")
  assert.equal(await gate(store, garmentMessage({ capability: await token("m4"), name: "x".repeat(501) }), onTryOn), "ignored-shape")
  assert.equal(await gate(store, garmentMessage({ capability: await token("m5"), name: 42 }), onTryOn), "ignored-shape")
  assert.equal(await gate(store, garmentMessage({ capability: await token("m6"), sourcePageUrl: 42 }), onTryOn), "ignored-shape")
  assert.equal(calls, 0)
})

test("9/10: valid drag URL and local File garments pass validation", async () => {
  const store = fakeTokenStore()
  let triedOn = []
  const onTryOn = async (incoming) => { triedOn.push(incoming) }
  const urlToken = await saver.issueCapability(store, "garment", () => "drag-url")
  assert.equal(await gate(store, garmentMessage({ capability: urlToken }), onTryOn), "accepted")
  const fileToken = await saver.issueCapability(store, "garment", () => "drag-file")
  const file = new Blob(["fake-bytes"], { type: "image/jpeg" })
  assert.equal(
    await gate(store, { type: "openwear:garment", capability: fileToken, file, name: "Local photo" }, onTryOn),
    "accepted"
  )
  assert.equal(triedOn.length, 2)
  assert.ok(triedOn[1].file instanceof Blob, "file survives validation without touching storage")
  assert.ok(!("capability" in triedOn[1]), "the capability never reaches tryOn")
})

test("15: storage holds token metadata only, never garment images or blobs", async () => {
  const store = fakeTokenStore()
  const file = new Blob(["fake-bytes"], { type: "image/jpeg" })
  await gate(store, garmentMessage({ capability: await saver.issueCapability(store, "garment", () => "meta") }), async () => {})
  await gate(store, { type: "openwear:garment", capability: await saver.issueCapability(store, "garment", () => "meta2"), file }, async () => {})
  const serialized = JSON.stringify([...store.store.entries()])
  assert.ok(!serialized.includes("fake-bytes"), "no file contents in storage")
  assert.ok(!serialized.includes("shop.example.com"), "no garment URLs in storage")
})

test("16: no JWT, Clerk, or service secrets in the capability mechanism", () => {
  // Strip line AND block comments: intentional documentation may describe the prohibitions.
  const source = read("lib/wardrobe-save.ts").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
  for (const forbidden of ["jwt", "Jwt", "JWT", "CLERK_SECRET", "AGENT_SERVICE", "serviceKey", "service-key", "localStorage", "chrome.storage.local"]) {
    assert.ok(!source.includes(forbidden), `wardrobe-save must not reference ${forbidden}`)
  }
  assert.ok(source.includes("chrome.storage.session") === false, "storage passed in, never hardcoded")
})

// ---------- Wiring: content posts capabilities, room gates on them ----------

test("every content garment post carries a fresh capability", () => {
  assert.ok(content.includes("issueCapability(chrome.storage.session, \"garment\")"), "capabilities minted in the page")
  const posts = [...content.matchAll(/type: "openwear:garment"/g)]
  assert.ok(posts.length >= 1)
  const forward = content.slice(content.indexOf("const forwardGarment"), content.indexOf("/** Try on:"))
  assert.ok(forward.includes("capability"), "the shared forwarder attaches the capability")
  assert.ok(forward.includes("pendingTryOnRef.current = message"), "queued posts keep their capability")
})

test("11: contextual Try on uses the exact same trusted handoff", () => {
  const sender = content.slice(content.indexOf("const sendTryOn"), content.indexOf("/** Save:"))
  assert.ok(sender.includes("forwardGarment"), "no separate weaker path for hover actions")
})

test("room consumes the garment capability before tryOn, in order", () => {
  assert.ok(room.includes("parseGarmentMessage(data)"), "shape validated first")
  assert.ok(room.includes('consumeCapability(chrome.storage.session, capability, "garment")'), "capability consumed second")
  const handler = room.slice(room.indexOf("const handleGarmentMessage"), room.indexOf("}, [tryOn])"))
  const parsed = handler.indexOf("parseGarmentMessage(data)")
  const consumed = handler.indexOf("consumeCapability(")
  const tried = handler.indexOf("void tryOn(incoming)")
  assert.ok(parsed >= 0 && consumed > parsed && tried > consumed, "validate → consume → tryOn, in that order")
})

test("12: Try on still authorizes nothing", () => {
  const handler = room.slice(room.indexOf("const handleGarmentMessage"), room.indexOf("}, [tryOn])"))
  assert.ok(!handler.includes("authorizer") && !handler.includes("liveMirrorAction") && !handler.includes("authorize"), "no authorization in the garment gate")
})

test("7: openwear:drag stays visual-only with no sensitive side effects", () => {
  const dragLine = room.split("\n").find(line => line.includes('"openwear:drag"'))
  assert.ok(dragLine, "drag handler exists")
  assert.ok(dragLine.includes("setDragging"), "drag only flips the drop indicator")
  for (const forbidden of ["tryOn", "stop(", "upload", "save", "authorize", "connect(", "camera"]) {
    assert.ok(!dragLine.includes(forbidden), `drag must not trigger ${forbidden}`)
  }
})
