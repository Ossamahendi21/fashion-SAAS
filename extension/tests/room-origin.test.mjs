// Step 3, Requirement B: the room's parent-origin gate.
//
// The room is embedded in arbitrary shop pages, so this is the unit-level proof that the
// message namespace fails closed until a browser-verified handshake, and stays closed to
// every other origin afterwards.
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

// Bundled like the other extension tests, so the gate is exercised exactly as it ships and a
// stray browser/node-only import would fail here rather than in the room.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../lib/room-origin.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  write: false,
})
const { createOriginGuardCore, fromParent, isHttpOrigin } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

const SHOP = "https://shop.example.com"
const EVIL = "https://evil.example"

test("nothing is accepted before the handshake: the gate fails closed", () => {
  const guard = createOriginGuardCore()
  assert.equal(guard.ready(), false)
  assert.equal(guard.origin, null)
  assert.equal(guard.accept(SHOP), false, "a plausible origin alone must not arm the room")
  assert.equal(guard.accept(EVIL), false)
  assert.equal(guard.accept(""), false)
  // Outgoing posts before arming still work, or the ready handshake could never be answered.
  assert.equal(guard.targetOrigin(), "*")
})

test("a matching http(s) handshake arms the guard for that origin only", () => {
  const guard = createOriginGuardCore()
  assert.equal(guard.establish(SHOP, SHOP), true)
  assert.equal(guard.ready(), true)
  assert.equal(guard.origin, SHOP)
  assert.equal(guard.accept(SHOP), true)
  assert.equal(guard.accept(EVIL), false)
  assert.equal(guard.accept("http://shop.example.com"), false, "scheme is part of the origin")
  assert.equal(guard.accept("https://shop.example.com:8443"), false, "port is part of the origin")
  assert.equal(guard.accept("https://shop.example.com.evil.test"), false, "no prefix matching")
  assert.equal(guard.targetOrigin(), SHOP)
})

test("a forged handshake never arms the guard, whatever it claims", () => {
  for (const claim of ["https://evil.example", "shop.example.com", "", null, undefined, 42, {}, [], "javascript:alert(1)", "data:text/html,x"]) {
    const guard = createOriginGuardCore()
    assert.equal(guard.establish(SHOP, claim), false, `claim must be rejected: ${String(claim)}`)
    assert.equal(guard.ready(), false)
    assert.equal(guard.accept(SHOP), false, "an unarmed guard accepts nothing, not even the real origin")
  }
})

test("a non-http(s) event origin cannot arm the guard either side of the handshake", () => {
  const guard = createOriginGuardCore()
  assert.equal(guard.establish("null", "null"), false, "an opaque origin is not a shop page")
  assert.equal(guard.establish("file://", "file://"), false)
  assert.equal(guard.establish("chrome-extension://abc", "chrome-extension://abc"), false)
  assert.equal(guard.ready(), false)
})

test("outgoing posts target the verified origin once armed, and never '*' afterwards", () => {
  const guard = createOriginGuardCore()
  assert.equal(guard.targetOrigin(), "*")
  guard.establish(SHOP, SHOP)
  assert.notEqual(guard.targetOrigin(), "*")
  assert.equal(guard.targetOrigin(), SHOP)
})

test("a page navigation to a new origin re-arms through a second verified handshake", () => {
  const guard = createOriginGuardCore()
  guard.establish(SHOP, SHOP)
  assert.equal(guard.accept(SHOP), true)
  assert.equal(guard.accept("https://other.example"), false)
  guard.establish("https://other.example", "https://other.example")
  assert.equal(guard.accept("https://other.example"), true)
  assert.equal(guard.accept(SHOP), false, "the old origin is no longer trusted")
  assert.equal(guard.targetOrigin(), "https://other.example")
})

test("a mismatched or malformed handshake cannot disturb an armed guard", () => {
  const guard = createOriginGuardCore()
  guard.establish(SHOP, SHOP)
  // A forged claim that disagrees with the browser-reported origin never arms anything.
  assert.equal(guard.establish(EVIL, SHOP), false, "claim must match the browser's origin")
  assert.equal(guard.establish("", ""), false)
  assert.equal(guard.accept(SHOP), true)
  assert.equal(guard.accept(EVIL), false)
  assert.equal(guard.targetOrigin(), SHOP)
})

test("fromParent only accepts the exact embedding window object", () => {
  const parent = { name: "parent" }
  assert.equal(fromParent(parent, parent), true)
  assert.equal(fromParent({ name: "parent" }, parent), false, "a look-alike object is not the parent")
  assert.equal(fromParent(null, parent), false)
  assert.equal(fromParent(undefined, parent), false)
  assert.equal(fromParent("string", parent), false)
  assert.equal(fromParent(parent, null), false)
})

test("isHttpOrigin accepts only http(s) origins", () => {
  assert.equal(isHttpOrigin(SHOP), true)
  assert.equal(isHttpOrigin("http://shop.example.com"), true)
  assert.equal(isHttpOrigin("null"), false)
  assert.equal(isHttpOrigin("file:///tmp"), false)
  assert.equal(isHttpOrigin("chrome-extension://abc"), false)
  assert.equal(isHttpOrigin("javascript:alert(1)"), false)
})
