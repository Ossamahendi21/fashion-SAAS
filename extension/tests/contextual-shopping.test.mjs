// Step 3B: contextual shopping actions wiring (content script ↔ room iframe).
//
// Proves the page integration contract by reading the authored sources: one delegated
// pointer listener, exclusion rules, the try-on message reusing the drag path, the
// ping/ready handshake, token-gated headless saves, and the preference gate. Behavioral
// logic itself is unit-tested in product-image, hover-overlay, and wardrobe-save suites.
// No DOM, no network, no live sites.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, "utf8")
const content = read("content.tsx")
const room = read("tabs/room.tsx")
const style = read("style.css")
const settings = read("lib/settings.ts")
const options = read("options.tsx")

// ---------- Event strategy (38, 39) ----------

test("38: one delegated pointer listener, never one listener per image", () => {
  const additions = [...content.matchAll(/\.addEventListener\("pointer(over|out)"/g)]
  assert.equal(additions.length, 2, "exactly one pointerover + one pointerout listener on the document")
  assert.ok(!content.includes("querySelectorAll(\"img\")") && !content.includes("querySelectorAll('img')"), "no image census")
  assert.ok(!content.includes("getElementsByTagName"), "no live collections scanned")
})

test("39: no unbounded query-all loop on pointer movement", () => {
  const handler = content.slice(content.indexOf("const onPointerOver"), content.indexOf("const onPointerOut"))
  assert.ok(!handler.includes("querySelectorAll"), "the hot path resolves one element only")
  assert.ok(handler.includes("lastHoverImgRef"), "repeat hovers short-circuit without recompute")
})

// ---------- Exclusion rules (14, 18) ----------

test("14: extension UI, chrome pages, localhost and non-http contexts are excluded", () => {
  assert.ok(content.includes("isExcludedContext()"), "the pointer handler gates on context")
  const gate = content.slice(content.indexOf("function isExcludedContext"), content.indexOf("}", content.indexOf('return false', content.indexOf("function isExcludedContext"))) + 1)
  assert.ok(gate.includes("http:") && gate.includes("https:"), "only web schemes pass")
  assert.ok(gate.includes("localhost"), "local dev UI excluded")
  assert.ok(content.includes('tagName === "OPENWEAR-ROOT"'), "our own root never targeted")
  assert.ok(content.includes('hasAttribute?.("data-ow-ui")'), "our own pill never retargets")
  assert.ok(content.includes("chrome-extension://"), "extension-owned images rejected")
})

test("18: the overlay can never target extension roots or its own pill", () => {
  assert.ok(content.includes('img.closest("openwear-root")'), "images inside our UI are extension-owned")
  assert.ok(content.includes('related.closest("[data-ow-ui]")'), "moving onto the pill keeps it alive")
})

// ---------- Try on (19–22) ----------

test("19/20: Try on sends one garment message with sanitized provenance and a capability", () => {
  assert.ok(content.includes("const forwardGarment"), "one shared garment forwarder for drag and hover paths")
  const forward = content.slice(content.indexOf("const forwardGarment"), content.indexOf("/** Try on:"))
  assert.ok(forward.includes('type: "openwear:garment"'), "reuses the drag message contract")
  assert.ok(forward.includes("issueCapability(chrome.storage.session, \"garment\")"), "every garment post carries a fresh capability")
  assert.ok(forward.includes("pendingTryOnRef.current = message"), "early posts wait for the room")
  assert.ok(forward.includes("setOpen(true)"), "closed room is opened")
  assert.ok(!forward.includes("authorize") && !forward.includes("Convex") && !forward.includes("liveMirror"), "no authorization path")
  assert.ok(content.includes("void forwardGarment({"), "try-on and both drop paths share the forwarder")
})

test("21: Try on opens the room when needed and flushes after load", () => {
  assert.ok(content.includes("pendingTryOnRef"), "early clicks wait for the room")
  assert.ok(content.includes("roomReadyRef.current = true"), "ready handshake tracked")
  assert.ok(content.includes("pendingTryOnRef.current = null"), "flushed pending posts are cleared")
})

test("22: Try on alone never authorizes Live Mirror", () => {
  const forward = content.slice(content.indexOf("const forwardGarment"), content.indexOf("/** Try on:"))
  assert.ok(!forward.includes("requestRemoteSave") && !forward.includes("issueToken") && !forward.includes("awaitSaveStatus"), "no save protocol")
  assert.ok(room.includes("void handleGarmentMessage(event.data)"), "room gates every garment post through validation")
})

// ---------- Save wiring (23–25, 31, 32) ----------

test("23: Save reuses the Step 3A saver through the room, never directly", () => {
  assert.ok(content.includes("requestRemoteSave("), "content drives the shared request flow")
  assert.ok(!content.includes("createWardrobeSaver"), "no second saver in the page")
  assert.ok(!content.includes("generateUploadUrl") && !content.includes("registerShoppingImport"), "no Convex calls from the page")
  assert.ok(!content.includes("useConvex") && !content.includes("useMutation"), "no Convex hooks in the page")
})

test("31: Save never authorizes Live Mirror anywhere in the chain", () => {
  assert.ok(!content.includes("authorizeLiveMirror") && !content.includes("authorizer"), "page has no authz path")
  const handler = room.slice(room.indexOf('event.data.type === "openwear:save-garment"'))
  assert.ok(!handler.includes("authorizer") && !handler.includes("liveMirrorAction"), "room save handler has no authz path")
})

test("signed-out Save opens sign-in and keeps the product for retry", () => {
  const saver = read("lib/wardrobe-save.ts")
  assert.ok(saver.includes('deps.reply("signed_out")'), "signed-out replies instead of saving")
  assert.ok(room.includes("openSignIn: signInOnFitcheck"), "sign-in opens on the same click")
  const sender = content.slice(content.indexOf("const sendSave"), content.indexOf("  // ---------- Contextual shopping actions wiring"))
  assert.ok(sender.includes("pendingSaveRef.current = { targetKey: target.key, clientImportId }"), "payload retained")
  assert.ok(sender.includes('live.setSaveState("error", OVERLAY_COPY.signIn)'), "compact sign-in state shown")
})

// ---------- Ping/ready handshake ----------

test("room announces readiness and answers pings; the page handshakes before sending", () => {
  assert.ok(room.includes('postToParent({ type: "openwear:room-ready" })'), "ready announced on mount and on ping")
  assert.ok(room.includes('event.data.type === "openwear:room-ping"'), "ping handled")
  assert.ok(content.includes("awaitRoomReady"), "content verifies listeners before sending")
  assert.ok(content.includes('event.origin !== ROOM_ORIGIN'), "replies accepted from our iframe only")
  assert.ok(content.includes("event.source !== frameRef.current?.contentWindow"), "replies matched to our frame")
})

// ---------- Preference gate (15) ----------

test("15: the shopping-actions preference gates the overlay and touches nothing else", () => {
  assert.ok(settings.includes("shoppingActionsEnabled: boolean"), "typed preference exists")
  assert.ok(settings.includes("shoppingActionsEnabled: true"), "default on")
  assert.ok(content.includes('"shoppingActionsEnabled"'), "content reads the preference")
  assert.ok(content.includes("overlayRef.current?.teardown()"), "disabling tears the overlay down")
  assert.ok(options.includes("shoppingActionsEnabled"), "options page exposes the toggle")
  assert.ok(options.includes("Show Try on / Save buttons on shopping images"), "plain-language toggle copy")
  assert.ok(!options.includes("billing") || options.includes("never affects billing"), "no billing implications")
})

// ---------- Privacy (33–37) ----------

test("33–35: no cookies, storage, or HTML cross into any message", () => {
  assert.ok(!/document\.cookie/.test(content), "no cookies read")
  assert.ok(!/localStorage/.test(content), "no localStorage read")
  assert.ok(!/outerHTML/.test(content), "no HTML serialization")
  assert.ok(!/\.innerHTML\s*=/.test(content), "no HTML injection")
  assert.ok(!content.includes("Authorization"), "no auth headers built in the page")
})

test("36/37: no userId/plan accepted from the page; no secrets in content code", () => {
  assert.ok(!content.includes("userId") && !content.includes("plan"), "page sends no identity or plan")
  const stripped = content.replace(/\/\/.*$/gm, "")
  for (const secret of ["DECART_API_KEY", "CLERK_SECRET_KEY", "AGENT_SERVICE_KEY"]) {
    assert.ok(!stripped.includes(secret), `content must not reference ${secret}`)
  }
  assert.ok(!/sk_(test|live)_[A-Za-z0-9]{8,}/.test(stripped), "no key-shaped literals")
  assert.ok(room.includes('consumeCapability(chrome.storage.session, token, "save")'), "save capabilities verified against page-inaccessible storage")
})

// ---------- Overlay DOM contract ----------

test("pill markup, labels, and styles exist", () => {
  assert.ok(content.includes('"ow-contextual"'), "pill class")
  assert.ok(content.includes('"data-ow-ui"'), "pill marker attribute")
  assert.ok(content.includes('aria-label", "Try on this product') || content.includes('aria-label", "Try on this product"'), "try-on label")
  assert.ok(style.includes(".ow-contextual"), "pill styles")
  assert.ok(style.includes(".ow-contextual-btn"), "button styles")
  assert.ok(style.includes("2147483647"), "topmost z-index")
})
