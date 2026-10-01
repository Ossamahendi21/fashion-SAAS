// Step 2E3: the legacy browser Decart credential is gone, and tests pin it down.
//
// Scans authored extension source (never vendor/ or build/ output) and fails if any permanent
// credential workflow reappears: secret names, key-shaped values, the background token mint,
// key testing, apiKey storage, Fast Mode, or the legacy fallback. Intentional documentation
// comments may name removed concepts; line comments are stripped before secret-name checks,
// while workflow markers are matched as code patterns so a live workflow can never hide
// behind a comment.
//
// No browser, no Clerk, no Convex, no Decart. Pure source assertions plus the real
// `lib/live-mirror.ts` decision tree.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, "utf8")
// Intentional documentation may name removed concepts; strip it so the guards inspect live code.
const codeOf = (relative) => read(relative).replace(/\/\/.*$/gm, "")

/** Authored UI modules. Vendor SDK and build output are never scanned: their strings are not ours. */
const MODULES = [
  "background.ts",
  "popup.tsx",
  "options.tsx",
  "content.tsx",
  "tabs/room.tsx",
  "lib/settings.ts",
  "lib/live-mirror.ts",
  "lib/freeze.ts",
  "lib/camera.ts",
  "lib/auth-config.ts",
  "lib/auth-provider.tsx"
]

test("no authored module references a server secret", () => {
  for (const file of MODULES) {
    const source = codeOf(file)
    for (const secret of ["DECART_API_KEY", "CLERK_SECRET_KEY", "AGENT_SERVICE_KEY"]) {
      assert.ok(!source.includes(secret), `${file} must not reference ${secret}`)
    }
    assert.ok(!/sk_(test|live)_[A-Za-z0-9]{8,}/.test(source), `${file} must not contain key-shaped literals`)
  }
})

test("no background token minting, and the worker no longer fetches images either", () => {
  const source = codeOf("background.ts")
  assert.ok(!source.includes('"test-key"'), "the test-key message is gone")
  assert.ok(!source.includes('"token"'), "the token message is gone")
  assert.ok(!source.includes('"status"'), "the key-status message is gone")
  assert.ok(!source.includes("loadSettings"), "the worker reads no settings at all")
  assert.ok(!source.includes("api.decart.ai"), "the worker never calls the provider")
  // Step 3 moved retail-image fetching server-side (convex/lib/imageFetch.ts). The worker keeps
  // only capability minting and install-time injection, so it has no fetch path at all.
  assert.ok(!source.includes('case "image"'), "the image message handler is gone")
  assert.ok(!source.includes("fetch("), "the worker performs no network fetch")
  assert.ok(!source.includes("data:image"), "the worker never builds data URLs")
  assert.ok(source.includes("handleIssueCapability"), "capability minting remains the worker's job")
  assert.ok(source.includes("chrome.scripting.executeScript"), "install-time content-script injection remains")
})

test("no apiKey storage field anywhere in authored code", () => {
  for (const file of ["background.ts", "popup.tsx", "options.tsx", "content.tsx", "lib/settings.ts", "lib/live-mirror.ts", "lib/auth-provider.tsx", "lib/auth-config.ts"]) {
    // The one-way storage cleanup list names the removed keys so they can never be read back.
    const source = codeOf(file).replace(/LEGACY_SETTING_KEYS = \[.*?\]/, "")
    assert.ok(!source.includes("apiKey"), `${file} must not mention apiKey`)
  }
  // The room passes the short-lived server grant to the SDK parameter of the same name. That
  // single construction is the only allowed occurrence in the whole extension.
  const roomLines = codeOf("tabs/room.tsx").split("\n").filter(line => line.includes("apiKey"))
  assert.equal(roomLines.length, 1, `expected only the SDK construction to mention apiKey, found: ${roomLines.join(" | ")}`)
  assert.match(roomLines[0], /apiKey:\s*grant\.token/, "the SDK receives only the short-lived grant token")
})

test("no Fast Mode, session minutes, key presence, or legacy plumbing in authored code", () => {
  for (const file of MODULES) {
    // The one-way storage cleanup list names the removed keys so they can never be read back.
    const source = codeOf(file).replace(/LEGACY_SETTING_KEYS = \[.*?\]/, "")
    for (const forbidden of ["fastMode", "sessionMinutes", "hasKey", "LegacyToken", "legacyToken", "loadSessionPreferences", "SessionPreferences", '"legacy"', "'legacy'"]) {
      assert.ok(!source.includes(forbidden), `${file} must not reference ${forbidden}`)
    }
  }
})

test("the authorization module is secure-only", () => {
  const source = codeOf("lib/live-mirror.ts")
  for (const forbidden of ["authEnabled", "legacyToken", "LegacyToken", "fastMode", "localSessionSeconds", '"secure"', "'secure'", "source:"]) {
    assert.ok(!source.includes(forbidden), `live-mirror.ts must not reference ${forbidden}`)
  }
  assert.ok(source.includes("autoFreezeSeconds"), "the local auto-freeze preference is the only client-side duration input")
  assert.ok(source.includes("deps.authorize({})"), "the action is still called with an empty object")
})

test("the room has one architecture: authenticated SaaS or a setup error", () => {
  const room = codeOf("tabs/room.tsx")
  assert.ok(!/\bauthEnabled\b/.test(room), "no unconfigured-auth branches left in the room")
  assert.ok(!room.includes("legacy"), "no legacy concept left in the room")
  assert.ok(room.includes("if (!isAuthConfigured()) return <ConfigError />"), "missing config fails closed")
  assert.ok(room.includes("Fitting room setup incomplete"), "the setup error names the product state")
  assert.ok(!room.includes("process.env"), "the setup error exposes no env values")
  assert.ok(!room.includes('"settings"'), "no settings notice action remains")
  assert.ok(!room.includes("Add your Decart API key"), "no key-entry UI remains")
})

test("the popup fails closed without config and never mentions provider setup", () => {
  const popup = codeOf("popup.tsx")
  assert.ok(popup.includes("if (!isAuthConfigured()) return <SetupError />"), "missing config fails closed")
  assert.ok(!popup.includes("apiKey") && !popup.includes("hasKey"), "no key state in the popup")
  assert.ok(!popup.includes("platform.decart.ai"), "no provider setup links")
  assert.ok(!popup.includes("Decart"), "no provider name for normal users")
  assert.ok(popup.includes("convex.query(liveMirrorStatus, {})"), "allowance line is read-only")
  assert.ok(popup.includes("Sign in on Fitcheck") && popup.includes("Open fitting room"), "core popup actions remain")
})

test("the options page holds only the auto-freeze preference", () => {
  const options = codeOf("options.tsx")
  assert.ok(!options.includes("test-key"), "no key verification workflow")
  assert.ok(!options.includes("platform.decart.ai"), "no provider links")
  assert.ok(options.includes("autoFreezeSeconds"), "the auto-freeze preference remains")
  assert.ok(options.includes("Server limit (no early freeze)"), "the no-shortening escape hatch remains")
})

test("settings expose only the auto-freeze preference with a safe default", async () => {
  const source = codeOf("lib/settings.ts")
  assert.ok(source.includes("autoFreezeSeconds: 60") || source.includes("autoFreezeSeconds:60"), "default at the production target")
  assert.ok(source.includes("chrome.storage.local.remove"), "legacy stored values are cleaned up")
})

// ---------- Closed-contract behavior ----------

const liveMirrorEntry = fileURLToPath(new URL("../lib/live-mirror.ts", import.meta.url))
const liveMirrorBundled = await build({ entryPoints: [liveMirrorEntry], bundle: true, format: "esm", write: false })
const liveMirror = await import(`data:text/javascript;base64,${Buffer.from(liveMirrorBundled.outputFiles[0].text).toString("base64")}`)
const { LiveMirrorError, liveMirrorMessage, resolveLiveMirrorSession } = liveMirror

const SIGNED_IN = { state: "signed-in", convexAuthenticated: true }
const GRANT = {
  token: "dc_live_closed_contract",
  expiresIn: 60,
  sessionSeconds: 60,
  model: "lucy-vton-latest",
  sessionId: "liveMirrorSessions-9",
  monthlyAllowanceSessions: 2,
  remainingSessions: 1
}
const deps = (overrides = {}) => ({
  status: SIGNED_IN,
  authorize: async () => ({ ...GRANT }),
  autoFreezeSeconds: 60,
  ...overrides
})
const convexError = (code) => Object.assign(new Error("server detail"), { data: { code, message: "server copy" } })

test("signed out resolves to the sign-in state with no authorization attempt", async () => {
  let calls = 0
  await assert.rejects(
    resolveLiveMirrorSession(deps({ status: { state: "signed-out" }, authorize: async () => { calls++; return { ...GRANT } } })),
    error => error instanceof LiveMirrorError && error.failure === "UNAUTHENTICATED"
  )
  assert.equal(calls, 0)
})

test("free users hit the paid gate through the server denial", async () => {
  await assert.rejects(
    resolveLiveMirrorSession(deps({ authorize: async () => { throw convexError("FEATURE_LOCKED") } })),
    error => error instanceof LiveMirrorError && error.message === liveMirrorMessage("FEATURE_LOCKED")
  )
})

test("paid users authorize securely with quota fields and no legacy surface", async () => {
  const grant = await resolveLiveMirrorSession(deps())
  assert.equal(grant.token, GRANT.token)
  assert.equal(grant.sessionId, GRANT.sessionId)
  assert.equal(grant.remainingSessions, GRANT.remainingSessions)
  assert.deepEqual(Object.keys(grant).sort(), ["model", "monthlyAllowanceSessions", "remainingSessions", "sessionId", "sessionSeconds", "token"])
})

test("exhausted quota denies without destroying anything the caller holds", async () => {
  await assert.rejects(
    resolveLiveMirrorSession(deps({ authorize: async () => { throw convexError("LIVE_MIRROR_LIMIT_REACHED") } })),
    error => error instanceof LiveMirrorError && error.failure === "LIVE_MIRROR_LIMIT_REACHED"
  )
})
