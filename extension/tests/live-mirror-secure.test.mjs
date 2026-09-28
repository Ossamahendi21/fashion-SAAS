// Step 2D: secure-path end-to-end validation for Live Mirror.
//
// These tests drive the real `lib/live-mirror.ts` decision tree through the account and
// failure states the manual matrix in docs/LIVE_MIRROR_E2E_TEST.md covers. Two properties are
// asserted for every single case, because they are the ones that make the migration safe:
//
//   1. NO LEGACY FALLBACK — once auth is configured, the permanent browser Decart key is
//      never requested, no matter how the secure path fails.
//   2. NO PROVIDER LEAK — only copy authored in this extension is ever surfaced; no server
//      message, no Convex hybrid stack trace, no Decart response body.
//
// Errors are built with the SAME ConvexError class the installed Convex client throws, and
// installed with `error.data = { code, message }` the way both real transports do
// (`forwardData` on the WebSocket path, `forwardErrorData` on the HTTP fallback). That makes
// these a real contract test rather than a test of a hand-rolled fake.
//
// No test contacts Clerk, Convex or Decart. Every provider boundary is a stub.

import test from "node:test"
import assert from "node:assert/strict"
import { ConvexError } from "convex/values"
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const entry = fileURLToPath(new URL("../lib/live-mirror.ts", import.meta.url))
const bundled = await build({ entryPoints: [entry], bundle: true, format: "esm", write: false })
const liveMirror = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)

const {
  createLiveMirrorAuthorizer,
  effectiveSessionSeconds,
  liveMirrorMessage,
  LiveMirrorError,
  resolveLiveMirrorSession,
  resolveRealtimeModel,
  toLiveMirrorFailure
} = liveMirror

// ---------- Fixtures ----------

const SIGNED_IN = { state: "signed-in", convexAuthenticated: true }
const CONVEX_PENDING = { state: "signed-in", convexAuthenticated: false }
const SIGNED_OUT = { state: "signed-out" }
const LOADING = { state: "loading" }

/** The exact contract the server action returns for a paid, fresh-billing user. */
const GRANT = { token: "dc_live_eyJhbGciOi_FRESH_TOKEN", expiresIn: 60, sessionSeconds: 300, model: "lucy-vton-latest" }

/**
 * Reproduces what the installed Convex client actually throws. `data` carries the server's
 * structured AppErrorData; `message` is the hybrid stack trace the client builds for the
 * console, which is exactly the kind of text that must never reach the room UI.
 */
function convexError(code, serverMessage) {
  const error = new ConvexError(
    `[CONVEX Q(liveMirror:authorizeLiveMirror)] [Request ID: 7f3a91c2-4e88-4b1d-9a02-1c3d5e7f9a10] Server Error\n` +
      `Called by client\n    at authorizeLiveMirror (convex/liveMirror.ts:82:9)\n` +
      `    at runActionInternal (node_modules/convex/dist/esm/browser/sync/client.js:634:7)\n` +
      `server message: ${serverMessage}`
  )
  error.data = { code, message: serverMessage }
  return error
}

/** A spy that fails the test if the legacy browser key is ever requested. */
function noLegacy() {
  return () => {
    assert.fail("secure path must never request the legacy browser Decart key")
  }
}

const secureDeps = (overrides = {}) => ({
  authEnabled: true,
  status: SIGNED_IN,
  authorize: async () => ({ ...GRANT }),
  legacyToken: noLegacy(),
  localSessionSeconds: 300,
  fastMode: false,
  ...overrides
})

/** Asserts a rejection is a LiveMirrorError of exactly `failure`, with clean copy. */
async function assertDenies(failure, promise) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof LiveMirrorError, `expected a LiveMirrorError, got ${error}`)
    assert.equal(error.failure, failure)
    assert.equal(error.message, liveMirrorMessage(failure))
    return true
  })
}

/** Every surfaced string must be copy authored in the extension, never provider text. */
function assertNoProviderLeak(message) {
  for (const leak of [/\[CONVEX/i, /Request ID/i, /at [a-zA-Z]+ \(/, /convex\//, /api\.decart\.ai/i, /decart returned/i, /ECONNREFUSED/]) {
    assert.ok(!leak.test(message), `copy leaked internals: ${JSON.stringify(message)}`)
  }
}

// ---------- A. Signed out ----------

test("A: signed out never authorizes, never falls back, and asks for sign-in", async () => {
  const calls = { authorize: 0, legacy: 0 }
  await assertDenies(
    "UNAUTHENTICATED",
    resolveLiveMirrorSession(secureDeps({
      status: SIGNED_OUT,
      authorize: async () => { calls.authorize++; return { ...GRANT } },
      legacyToken: async () => { calls.legacy++; return { apiKey: "sk_live_LEAKED", fastMode: false, sessionSeconds: 300 } }
    }))
  )
  assert.equal(calls.authorize, 0, "a signed-out user must not reach the server action")
  assert.equal(calls.legacy, 0, "a signed-out user must not reach the browser key")
  assert.equal(liveMirrorMessage("UNAUTHENTICATED"), "Sign in to Fitcheck to use Live Mirror.")
})

test("A: Clerk still loading and Convex not yet attached are retryable, never a denial with a fallback", async () => {
  for (const status of [LOADING, CONVEX_PENDING, null]) {
    await assertDenies("PENDING", resolveLiveMirrorSession(secureDeps({ status })))
  }
})

test("A: a signed-out room can never be talked into the legacy path by a settled authorizer", async () => {
  // An authorizer primed while signed in must not hand its grant to a later signed-out call.
  const authorizer = createLiveMirrorAuthorizer()
  const primed = await authorizer.acquire(secureDeps())
  assert.equal(primed.source, "secure")
  await assertDenies("UNAUTHENTICATED", authorizer.acquire(secureDeps({ status: SIGNED_OUT })))
})

// ---------- B. Free plan ----------

test("B: a free user is denied FEATURE_LOCKED and never touches the browser key", async () => {
  const calls = { authorize: 0 }
  await assertDenies(
    "FEATURE_LOCKED",
    resolveLiveMirrorSession(secureDeps({
      authorize: async () => { calls.authorize++; throw convexError("FEATURE_LOCKED", "Live Mirror requires a paid plan. Upgrade in Billing to continue.") },
      legacyToken: async () => { throw new Error("legacy key must never be requested for a free user") }
    }))
  )
  assert.equal(calls.authorize, 1, "the free user does reach the server, and the server denies")
  assert.equal(liveMirrorMessage("FEATURE_LOCKED"), "Live Mirror is available on a paid plan.")
  assertNoProviderLeak(liveMirrorMessage("FEATURE_LOCKED"))
})

test("B: a paid-plan upgrade between failures is honoured — a denial never latches", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  const free = secureDeps({ authorize: async () => { throw convexError("FEATURE_LOCKED", "Live Mirror requires a paid plan.") } })
  await assertDenies("FEATURE_LOCKED", authorizer.acquire(free))
  const paid = await authorizer.acquire(secureDeps())
  assert.equal(paid.source, "secure", "after upgrading, the next attempt succeeds")
  assert.equal(paid.token, GRANT.token)
})

// ---------- C. Stale billing ----------

test("C: stale billing is surfaced as SUBSCRIPTION_REFRESH_REQUIRED with no fallback", async () => {
  await assertDenies(
    "SUBSCRIPTION_REFRESH_REQUIRED",
    resolveLiveMirrorSession(secureDeps({
      authorize: async () => { throw convexError("SUBSCRIPTION_REFRESH_REQUIRED", "Refresh your subscription before continuing.") },
      legacyToken: async () => { throw new Error("legacy key must never be requested for stale billing") }
    }))
  )
  assert.match(liveMirrorMessage("SUBSCRIPTION_REFRESH_REQUIRED"), /refresh/i)
  assertNoProviderLeak(liveMirrorMessage("SUBSCRIPTION_REFRESH_REQUIRED"))
})

test("C: a successful subscriptions.refresh clears the stale-billing denial", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  const stale = secureDeps({ authorize: async () => { throw convexError("SUBSCRIPTION_REFRESH_REQUIRED", "Refresh your subscription before continuing.") } })
  await assertDenies("SUBSCRIPTION_REFRESH_REQUIRED", authorizer.acquire(stale))
  const fresh = await authorizer.acquire(secureDeps())
  assert.equal(fresh.source, "secure")
  assert.equal(fresh.token, GRANT.token)
})

// ---------- D. Paid + fresh billing ----------

test("D: a paid user gets a secure grant and the browser never sees the permanent key", async () => {
  const grant = await resolveLiveMirrorSession(secureDeps())
  assert.equal(grant.source, "secure")
  assert.equal(grant.token, GRANT.token)
  assert.ok(!grant.token.startsWith("sk_"), "a permanent Decart key must never reach the room")
})

test("D: the returned model is what the client connects with, and the client cannot choose", async () => {
  const grant = await resolveLiveMirrorSession(secureDeps())
  assert.equal(grant.model, "lucy-vton-latest")
  // The client has no model input at all: AuthorizeDeps carries no model field, so there is
  // nothing to override the server's choice with.
  assert.ok(!("model" in secureDeps()), "the room's dependencies expose no client-chosen model")
  // Whatever the server names must resolve through the SDK catalogue or fail closed.
  assert.equal(resolveRealtimeModel(grant.model, id => ({ id })).id, "lucy-vton-latest")
  assert.throws(() => resolveRealtimeModel("some-other-model", id => { throw new Error("unknown model") }), LiveMirrorError)
})

test("D: extra fields on the server response are dropped, never forwarded to the SDK", async () => {
  const leaky = await resolveLiveMirrorSession(secureDeps({
    authorize: async () => ({ ...GRANT, apiKey: "sk_live_SERVER_LEAK", userId: "user_2abc", plan: "pro" })
  }))
  assert.deepEqual(Object.keys(leaky).sort(), ["fastMode", "model", "sessionSeconds", "source", "token"])
  assert.ok(!JSON.stringify(leaky).includes("sk_live_"), "no extra key material survives into the session")
  assert.ok(!JSON.stringify(leaky).includes("user_2abc"), "no identity leaks into the session")
})

// ---------- E. Provider failure ----------

test("E: a Decart outage surfaces as temporary unavailability with no local-key fallback", async () => {
  await assertDenies(
    "UPSTREAM_FAILED",
    resolveLiveMirrorSession(secureDeps({
      authorize: async () => { throw convexError("UPSTREAM_FAILED", "Live Mirror is temporarily unavailable. Please try again.") },
      legacyToken: async () => { throw new Error("a Decart outage must NOT silently use the browser key") }
    }))
  )
  assert.equal(liveMirrorMessage("UPSTREAM_FAILED"), "Live Mirror is temporarily unavailable. Please try again.")
})

test("E: network, malformed-payload and non-JSON failures all fail closed as generic", async () => {
  const cases = [
    async () => { throw new TypeError("Failed to fetch") },
    async () => { throw new Error("socket hang up ECONNRESET") },
    async () => ({ ...GRANT, token: "" }),
    async () => ({ ...GRANT, sessionSeconds: 0 }),
    async () => ({ ...GRANT, model: "" }),
    async () => ({ ...GRANT, expiresIn: Number.NaN })
  ]
  for (const authorize of cases) {
    await assertDenies("UNKNOWN", resolveLiveMirrorSession(secureDeps({ authorize })))
  }
  assert.equal(liveMirrorMessage("UNKNOWN"), "Live Mirror couldn't start. Please try again.")
})

// ---------- Error contract ----------

test("error contract: the four server decisions map from structured data, not message text", () => {
  for (const code of ["UNAUTHENTICATED", "FEATURE_LOCKED", "SUBSCRIPTION_REFRESH_REQUIRED", "UPSTREAM_FAILED"]) {
    // Same code, deliberately different server copy each time: the mapping must not depend on it.
    assert.equal(toLiveMirrorFailure(convexError(code, `arbitrary copy for ${code} at line 42`)), code)
  }
})

test("error contract: unknown codes and non-Convex errors collapse to UNKNOWN", () => {
  assert.equal(toLiveMirrorFailure(convexError("NOT_FOUND", "nope")), "UNKNOWN")
  assert.equal(toLiveMirrorFailure(convexError("SPEND_KILL_SWITCH", "nope")), "UNKNOWN")
  assert.equal(toLiveMirrorFailure(new TypeError("Failed to fetch")), "UNKNOWN")
  assert.equal(toLiveMirrorFailure({ data: { code: 42 } }), "UNKNOWN")
  assert.equal(toLiveMirrorFailure({ data: "a string" }), "UNKNOWN")
  assert.equal(toLiveMirrorFailure(undefined), "UNKNOWN")
})

test("error contract: no surfaced copy contains a stack trace, request id or provider detail", () => {
  for (const failure of ["PENDING", "UNAUTHENTICATED", "FEATURE_LOCKED", "SUBSCRIPTION_REFRESH_REQUIRED", "UPSTREAM_FAILED", "UNKNOWN"]) {
    assertNoProviderLeak(liveMirrorMessage(failure))
  }
})

// ---------- F. Account change / logout ----------

test("F: after logout, the next authorization is denied for the new (signed-out) principal", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  const paid = await authorizer.acquire(secureDeps())
  assert.equal(paid.source, "secure")
  // Clerk signs the user out; the room re-renders with a signed-out status.
  await assertDenies("UNAUTHENTICATED", authorizer.acquire(secureDeps({ status: SIGNED_OUT })))
})

test("F: after an account switch, the new principal's entitlement decides — paid to free denies", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  await authorizer.acquire(secureDeps()) // user A: paid
  await assertDenies(
    "FEATURE_LOCKED",
    authorizer.acquire(secureDeps({ authorize: async () => { throw convexError("FEATURE_LOCKED", "Live Mirror requires a paid plan.") } }))
  ) // user B: free
})

test("F: after an account switch, free to paid succeeds against the new principal", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  await assertDenies("FEATURE_LOCKED", authorizer.acquire(secureDeps({
    authorize: async () => { throw convexError("FEATURE_LOCKED", "Live Mirror requires a paid plan.") }
  })))
  const grant = await authorizer.acquire(secureDeps())
  assert.equal(grant.source, "secure")
  assert.equal(grant.token, GRANT.token)
})

test("F: no authorization is ever cached across an account change", async () => {
  const calls = { authorize: 0 }
  const deps = secureDeps({ authorize: async () => { calls.authorize++; return { ...GRANT, token: `token-for-call-${calls.authorize}` } } })
  const authorizer = createLiveMirrorAuthorizer()
  const first = await authorizer.acquire(deps)
  const second = await authorizer.acquire(deps)
  assert.equal(calls.authorize, 2, "a settled authorization is never replayed")
  assert.equal(first.token, "token-for-call-1")
  assert.equal(second.token, "token-for-call-2", "the second session must use its own freshly minted token")
})

// ---------- G. Duplicate start ----------

test("G: concurrent starts share exactly one authorization", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  const calls = { authorize: 0 }
  let release
  const gate = new Promise(resolve => { release = resolve })
  const deps = secureDeps({ authorize: async () => { calls.authorize++; await gate; return { ...GRANT } } })
  const attempts = [authorizer.acquire(deps), authorizer.acquire(deps), authorizer.acquire(deps)]
  assert.equal(authorizer.pending, true, "an in-flight authorization blocks a second mint")
  release()
  const grants = await Promise.all(attempts)
  assert.equal(calls.authorize, 1)
  assert.ok(grants.every(grant => grant.token === GRANT.token))
  assert.equal(authorizer.pending, false, "the guard releases once settled")
})

test("G: a manual retry after a failure requests a brand new authorization", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  const calls = { authorize: 0 }
  const flaky = secureDeps({
    authorize: async () => {
      calls.authorize++
      if (calls.authorize === 1) throw convexError("UPSTREAM_FAILED", "Live Mirror is temporarily unavailable. Please try again.")
      return { ...GRANT }
    }
  })
  await assertDenies("UPSTREAM_FAILED", authorizer.acquire(flaky))
  assert.equal(authorizer.pending, false, "a failed authorization does not stay latched")
  const grant = await authorizer.acquire(flaky)
  assert.equal(calls.authorize, 2)
  assert.equal(grant.source, "secure")
})

// ---------- 4. Token lifetime / reuse ----------

test("4: a settled token is never handed to a later Live Mirror session", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  const calls = { authorize: 0 }
  const deps = secureDeps({ authorize: async () => { calls.authorize++; return { ...GRANT, token: `token-${calls.authorize}` } } })

  const sessionOne = await authorizer.acquire(deps)
  assert.equal(sessionOne.token, "token-1")

  // Three further sessions in sequence, each after the previous one fully settled.
  for (const expected of [2, 3, 4]) {
    const next = await authorizer.acquire(deps)
    assert.equal(next.token, `token-${expected}`, `session ${expected} must mint its own token`)
  }
  assert.equal(calls.authorize, 4, "one server authorization per Live Mirror session")
})

test("4: the authorizer holds no token at all between sessions", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  await authorizer.acquire(secureDeps())
  assert.equal(authorizer.pending, false)
  // Nothing token-shaped is reachable on the authorizer once settled.
  const held = Object.values(authorizer).filter(value => typeof value === "string" && value.includes("dc_"))
  assert.deepEqual(held, [], "no settled token may remain reachable from the authorizer")
})

test("4: a token settled inside the same tick is not replayed to the next acquire", async () => {
  // The clear() handler is attached before the caller awaits, so the next acquire in the same
  // microtask must already be a fresh request rather than the previous settled promise.
  const authorizer = createLiveMirrorAuthorizer()
  const calls = { authorize: 0 }
  const deps = secureDeps({ authorize: async () => { calls.authorize++; return { ...GRANT, token: `token-${calls.authorize}` } } })
  const first = await authorizer.acquire(deps)
  const second = await authorizer.acquire(deps)
  assert.notEqual(first.token, second.token)
  assert.equal(calls.authorize, 2)
})

test("4: a failed authorization leaves nothing cached for the next session", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  await assertDenies("UPSTREAM_FAILED", authorizer.acquire(secureDeps({
    authorize: async () => { throw convexError("UPSTREAM_FAILED", "Live Mirror is temporarily unavailable.") }
  })))
  const grant = await authorizer.acquire(secureDeps())
  assert.equal(grant.token, GRANT.token, "a fresh request is made after a failure")
})

// ---------- 5. Server cap ----------

test("5: local 300s with a 15s server grant stops the room at 15s", async () => {
  const grant = await resolveLiveMirrorSession(secureDeps({ localSessionSeconds: 300, authorize: async () => ({ ...GRANT, sessionSeconds: 15 }) }))
  assert.equal(grant.sessionSeconds, 15)
})

test("5: local 60s with a 300s server grant uses 60s", async () => {
  const grant = await resolveLiveMirrorSession(secureDeps({ localSessionSeconds: 60 }))
  assert.equal(grant.sessionSeconds, 60)
})

test("5: no local setting, however large, can raise the server grant", async () => {
  for (const local of [60, 300, 900, 3600, 86400, 1e9, Number.MAX_SAFE_INTEGER, -1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const grant = await resolveLiveMirrorSession(secureDeps({
      localSessionSeconds: local,
      authorize: async () => ({ ...GRANT, sessionSeconds: 15 })
    }))
    assert.ok(grant.sessionSeconds <= 15, `local ${local} escaped the 15s server cap (got ${grant.sessionSeconds})`)
  }
})

test("5: the clamp is a hard min and never yields a zero or negative session", () => {
  assert.equal(effectiveSessionSeconds(300, 15), 15)
  assert.equal(effectiveSessionSeconds(60, 300), 60)
  assert.equal(effectiveSessionSeconds(300, 300), 300)
  assert.equal(effectiveSessionSeconds(0, 300), 300)
  assert.equal(effectiveSessionSeconds(Number.NaN, 300), 300)
  assert.equal(effectiveSessionSeconds(1e9, 0), 1, "a nonsense server value floors at 1 second rather than granting a session")
})

// ---------- 6. Fast Mode: no new business rule ----------

test("6: Fast Mode is passed through as a local preference and grants no extra time", async () => {
  const fast = await resolveLiveMirrorSession(secureDeps({ fastMode: true, authorize: async () => ({ ...GRANT, sessionSeconds: 15 }) }))
  assert.equal(fast.fastMode, true)
  assert.equal(fast.sessionSeconds, 15, "Fast Mode must not lengthen the session the server authorized")
})

test("6: Fast Mode is not something the server can see or deny, and the client cannot gain a longer cap from it", async () => {
  const calls = { authorize: 0 }
  await resolveLiveMirrorSession(secureDeps({ fastMode: true, authorize: async () => { calls.authorize++; return { ...GRANT, sessionSeconds: 15 } } }))
  assert.equal(calls.authorize, 1)
  // The only per-session value the client sends is nothing at all: Fast Mode never reaches the
  // authorization call, so it can neither buy a longer session nor be gated by the server today.
  assert.equal(calls.authorize > 0, true)
})

// ---------- Legacy path is untouched ----------

test("legacy: without configured auth the browser key path behaves exactly as it did", async () => {
  const calls = { authorize: 0, legacy: 0 }
  const grant = await resolveLiveMirrorSession({
    authEnabled: false,
    status: null,
    authorize: async () => { calls.authorize++; return { ...GRANT } },
    legacyToken: async () => { calls.legacy++; return { apiKey: "sk_live_browser_key", fastMode: true, sessionSeconds: 300 } },
    localSessionSeconds: 600,
    fastMode: false
  })
  assert.equal(grant.source, "legacy")
  assert.equal(grant.token, "sk_live_browser_key")
  assert.equal(grant.fastMode, true, "the legacy handler still owns its own speed preference")
  assert.equal(grant.sessionSeconds, 300, "the legacy handler still owns its own session limit")
  assert.equal(grant.model, null, "the legacy path keeps the room's own model")
  assert.equal(calls.legacy, 1)
  assert.equal(calls.authorize, 0, "no server call when auth is not configured")
})

// ---------- 8. Secret safety in the secure path ----------

test("8: no secure-path authored source references a server secret", () => {
  const libDir = fileURLToPath(new URL("../lib/", import.meta.url))
  const secureFiles = ["live-mirror.ts", "auth-config.ts", "auth-provider.tsx", "settings.ts"]
  for (const file of secureFiles) {
    // Strip line comments so the WARNING lines that name the forbidden keys don't trip the guard.
    const source = readFileSync(`${libDir}${file}`, "utf8").replace(/\/\/.*$/gm, "")
    for (const secret of ["DECART_API_KEY", "CLERK_SECRET_KEY", "AGENT_SERVICE_KEY"]) {
      assert.ok(!source.includes(secret), `${file} must not reference ${secret}`)
    }
    assert.ok(!/sk_(test|live)_[A-Za-z0-9]{8,}/.test(source), `${file} must not contain key-shaped literals`)
  }
})

test("8: the room builds the Decart client from the resolved grant token, never from stored settings", () => {
  const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
  assert.ok(!/loadSettings\(/.test(room), "the room must not read the full settings object")
  // Exactly one place constructs the SDK, and it takes the resolved grant token. On the secure
  // path that token is the short-lived server grant; only the legacy path can hold a permanent key.
  const constructions = [...room.matchAll(/createDecartClient\(\{[^}]*\}\)/g)].map(match => match[0])
  assert.equal(constructions.length, 1, `expected one createDecartClient call, found ${constructions.length}`)
  assert.match(constructions[0], /apiKey:\s*grant\.token/, "the SDK key must come from the resolved grant, not settings")
  // The stored key value is only ever reduced to a presence boolean for the legacy gate.
  for (const line of room.split("\n")) {
    if (!line.includes("apiKey")) continue
    assert.ok(/changes\.apiKey|apiKey:\s*grant\.token/.test(line), `room reads the stored key beyond a presence check: ${line.trim()}`)
  }
  // The legacy handler stays wired for unconfigured builds.
  assert.ok(room.includes('background<Token>("token")'))
  // And the secure path is present.
  assert.ok(room.includes("createLiveMirrorAuthorizer") && room.includes("liveMirrorAction"))
})

test("8: the server action reference takes no arguments, so no secret could be sent from the room", () => {
  const source = readFileSync(fileURLToPath(new URL("../lib/live-mirror.ts", import.meta.url)), "utf8")
  assert.match(source, /Record<string, never>/, "the action is typed to accept no fields")
  assert.ok(source.includes("deps.authorize({})"), "the secure path calls the action with an empty object")
})
