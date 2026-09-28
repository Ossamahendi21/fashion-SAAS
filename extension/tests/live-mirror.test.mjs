// Step 2C: secure Live Mirror token acquisition in the OpenWear fitting room.
//
// Pure logic tests against the real `lib/live-mirror.ts` with injected fakes. No browser, no
// Chrome APIs, no Clerk, no Convex deployment and no Decart session: every provider boundary
// is a stub. The contract under test is the security boundary itself — the secure path must
// call the server action with no arguments, must never touch the legacy Decart key, and must
// never let the browser raise the server's session cap or substitute the model.
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const entry = fileURLToPath(new URL("../lib/live-mirror.ts", import.meta.url))
const bundled = await build({ entryPoints: [entry], bundle: true, format: "esm", write: false })
const liveMirror = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)

const {
  authorizeLiveMirror,
  createLiveMirrorAuthorizer,
  effectiveSessionSeconds,
  liveMirrorMessage,
  LiveMirrorError,
  resolveLiveMirrorSession,
  resolveRealtimeModel,
  toLiveMirrorFailure
} = liveMirror

const AUTHORIZATION = { token: "decart-client-token-abc", expiresIn: 60, sessionSeconds: 300, model: "lucy-vton-latest" }
const SIGNED_IN = { state: "signed-in", convexAuthenticated: true }
const SIGNED_OUT = { state: "signed-out" }
const LOADING = { state: "loading" }

/** Records every call so a test can assert what did and did not cross the boundary. */
function probe() {
  const calls = { authorize: [], legacy: 0 }
  return {
    calls,
    authorize: async args => { calls.authorize.push(args); return { ...AUTHORIZATION } },
    legacyToken: async () => { calls.legacy++; return { apiKey: "sk-decart-permanent", fastMode: false, sessionSeconds: 300 } }
  }
}

const baseDeps = (overrides = {}) => ({ authEnabled: true, status: SIGNED_IN, localSessionSeconds: 300, fastMode: false, ...overrides })

/** Builds the appError the Convex server throws, so failure mapping is tested against the real shape. */
const convexError = code => Object.assign(new Error(`internal detail for ${code}`), { data: { code, message: `server copy for ${code}` } })

test("the action reference is the no-args server function", () => {
  // Convex tags a function reference with a symbol, not a string key.
  const symbol = Object.getOwnPropertySymbols(authorizeLiveMirror).find(key => key === Symbol.for("functionName"))
  assert.ok(symbol, "the reference must carry Convex's functionName symbol")
  assert.equal(authorizeLiveMirror[symbol], "liveMirror:authorizeLiveMirror")
  assert.equal(Object.keys(authorizeLiveMirror).length, 0, "no stray enumerable properties on the reference")
})

test("authenticated + Convex connected calls authorizeLiveMirror with no arguments", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize, legacyToken: p.legacyToken }))
  assert.deepEqual(p.calls.authorize, [{}])
  assert.equal(grant.source, "secure")
  assert.equal(grant.token, AUTHORIZATION.token)
  assert.equal(p.calls.legacy, 0)
})

test("the secure path never sends identity, plan, model, duration or a Decart key", async () => {
  const p = probe()
  await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize, legacyToken: p.legacyToken, localSessionSeconds: 9999 }))
  const [args] = p.calls.authorize
  assert.deepEqual(Object.keys(args), [])
  const serialized = JSON.stringify(args)
  for (const forbidden of ["userId", "clerkUserId", "plan", "model", "duration", "sessionSeconds", "apiKey", "token"]) {
    assert.ok(!serialized.includes(forbidden), `action args must not carry ${forbidden}`)
  }
  assert.ok(!serialized.includes("sk-"), "action args must never carry key material")
})

test("auth configured + signed out: no legacy token request, no session, sign-in state shown", async () => {
  const p = probe()
  await assert.rejects(
    () => resolveLiveMirrorSession(baseDeps({ status: SIGNED_OUT, authorize: p.authorize, legacyToken: p.legacyToken })),
    error => error instanceof LiveMirrorError && error.failure === "UNAUTHENTICATED"
  )
  assert.equal(p.calls.legacy, 0, "signed-out must never fall back to the browser key")
  assert.equal(p.calls.authorize.length, 0, "signed-out must not mint a token")
  assert.equal(liveMirrorMessage("UNAUTHENTICATED"), "Sign in to Fitcheck to use Live Mirror.")
})

test("Clerk still loading or Convex not yet connected: no token, no legacy fallback", async () => {
  for (const status of [LOADING, { state: "signed-in", convexAuthenticated: false }]) {
    const p = probe()
    await assert.rejects(
      () => resolveLiveMirrorSession(baseDeps({ status, authorize: p.authorize, legacyToken: p.legacyToken })),
      error => error instanceof LiveMirrorError && error.failure === "PENDING"
    )
    assert.equal(p.calls.legacy, 0)
    assert.equal(p.calls.authorize.length, 0)
  }
})

for (const code of ["FEATURE_LOCKED", "SUBSCRIPTION_REFRESH_REQUIRED", "UPSTREAM_FAILED", "UNAUTHENTICATED"]) {
  test(`${code}: fails closed with safe copy and no browser-key fallback`, async () => {
    const p = probe()
    const deny = async () => { throw convexError(code) }
    await assert.rejects(
      () => resolveLiveMirrorSession(baseDeps({ authorize: deny, legacyToken: p.legacyToken })),
      error => {
        assert.ok(error instanceof LiveMirrorError)
        assert.equal(error.failure, code)
        assert.equal(error.message, liveMirrorMessage(code))
        // The server's own message and any internal detail never reach the room.
        assert.ok(!error.message.includes("server copy"))
        assert.ok(!error.message.includes("internal detail"))
        return true
      }
    )
    assert.equal(p.calls.legacy, 0, `${code} must never fall back to the browser key`)
  })
}

test("an unknown server error becomes a generic safe message", async () => {
  const p = probe()
  const boom = async () => { throw new Error("ECONNREFUSED 10.0.0.7:3210 stack at authorizeLiveMirror") }
  await assert.rejects(
    () => resolveLiveMirrorSession(baseDeps({ authorize: boom, legacyToken: p.legacyToken })),
    error => error instanceof LiveMirrorError && error.failure === "UNKNOWN" && error.message === liveMirrorMessage("UNKNOWN")
  )
  assert.equal(p.calls.legacy, 0)
})

test("the safe copy for each server decision says what to do, not what the provider said", () => {
  assert.equal(liveMirrorMessage("FEATURE_LOCKED"), "Live Mirror is available on a paid plan.")
  assert.equal(liveMirrorMessage("UPSTREAM_FAILED"), "Live Mirror is temporarily unavailable. Please try again.")
  assert.match(liveMirrorMessage("SUBSCRIPTION_REFRESH_REQUIRED"), /subscription status needs refreshing/i)
  for (const value of Object.values(liveMirrorMessage ? {
    a: liveMirrorMessage("PENDING"), b: liveMirrorMessage("UNAUTHENTICATED"), c: liveMirrorMessage("FEATURE_LOCKED"),
    d: liveMirrorMessage("SUBSCRIPTION_REFRESH_REQUIRED"), e: liveMirrorMessage("UPSTREAM_FAILED"), f: liveMirrorMessage("UNKNOWN")
  } : {})) {
    assert.ok(!/decart|sk_|api key|token|stack|http/i.test(value), `copy must not leak internals: ${value}`)
  }
})

test("failure mapping only trusts known server codes", () => {
  assert.equal(toLiveMirrorFailure(convexError("FEATURE_LOCKED")), "FEATURE_LOCKED")
  assert.equal(toLiveMirrorFailure(convexError("NOT_FOUND")), "UNKNOWN")
  assert.equal(toLiveMirrorFailure(new Error("boom")), "UNKNOWN")
  assert.equal(toLiveMirrorFailure(null), "UNKNOWN")
  assert.equal(toLiveMirrorFailure({ data: { code: 42 } }), "UNKNOWN")
})

test("a successful authorization feeds the realtime flow with the server token", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize, legacyToken: p.legacyToken }))
  // This is the exact value the room hands to createDecartClient as apiKey.
  assert.equal(grant.token, "decart-client-token-abc")
  assert.notEqual(grant.token, "sk-decart-permanent")
})

test("the returned model is used and the client cannot substitute another", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize, legacyToken: p.legacyToken }))
  assert.equal(grant.model, AUTHORIZATION.model)
  // A server-named model is resolved through the SDK catalogue; an unknown id fails closed.
  assert.equal(resolveRealtimeModel("lucy-vton-latest", id => ({ id })).id, "lucy-vton-latest")
  const catalogue = new Set(["lucy-vton-latest"])
  assert.throws(() => resolveRealtimeModel("lucy-2.1", id => { if (!catalogue.has(id)) throw new Error("unknown model"); return { id } }), LiveMirrorError)
})

test("a malformed authorization payload is rejected instead of used", async () => {
  for (const bad of [{ ...AUTHORIZATION, token: "" }, { ...AUTHORIZATION, model: "" }, { ...AUTHORIZATION, sessionSeconds: 0 }, { ...AUTHORIZATION, expiresIn: undefined }]) {
    const p = probe()
    await assert.rejects(
      () => resolveLiveMirrorSession(baseDeps({ authorize: async () => bad, legacyToken: p.legacyToken })),
      error => error instanceof LiveMirrorError && error.failure === "UNKNOWN"
    )
    assert.equal(p.calls.legacy, 0)
  }
})

test("server sessionSeconds = 15 with a local request of 300 clamps the client timer to 15", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({
    authorize: async () => ({ ...AUTHORIZATION, sessionSeconds: 15 }),
    legacyToken: p.legacyToken,
    localSessionSeconds: 300
  }))
  assert.equal(grant.sessionSeconds, 15)
  assert.ok(grant.sessionSeconds <= 15)
})

test("server sessionSeconds = 300 with a local request of 60 keeps the local 60", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize, legacyToken: p.legacyToken, localSessionSeconds: 60 }))
  assert.equal(grant.sessionSeconds, 60)
})

test("the local setting can never raise the server cap", () => {
  assert.equal(effectiveSessionSeconds(3600, 15), 15)
  assert.equal(effectiveSessionSeconds(60, 300), 60)
  assert.equal(effectiveSessionSeconds(300, 300), 300)
  assert.equal(effectiveSessionSeconds(1, 300), 1)
  // A nonsense local value cannot unlock more than the server allows.
  assert.equal(effectiveSessionSeconds(0, 300), 300)
  assert.equal(effectiveSessionSeconds(-5, 300), 300)
  assert.equal(effectiveSessionSeconds(Number.NaN, 300), 300)
  for (const local of [1, 60, 300, 3600, 99999]) {
    assert.ok(effectiveSessionSeconds(local, 42) <= 42, `local ${local} must not exceed the server cap`)
  }
})

test("duplicate start while authorization is pending mints exactly one token", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  const calls = { authorize: 0 }
  let release
  const gate = new Promise(resolve => { release = resolve })
  const deps = baseDeps({
    authorize: async () => { calls.authorize++; await gate; return { ...AUTHORIZATION } },
    legacyToken: async () => { calls.authorize++; return { apiKey: "sk-decart-permanent", fastMode: false, sessionSeconds: 300 } }
  })
  const attempts = [authorizer.acquire(deps), authorizer.acquire(deps), authorizer.acquire(deps)]
  assert.equal(authorizer.pending, true, "an in-flight authorization blocks a second mint")
  release()
  const grants = await Promise.all(attempts)
  assert.equal(calls.authorize, 1, "three concurrent starts must share one authorization")
  assert.ok(grants.every(grant => grant.token === AUTHORIZATION.token))
  assert.equal(authorizer.pending, false, "the guard releases after settling")
})

test("a settled authorizer allows a deliberate manual retry", async () => {
  const authorizer = createLiveMirrorAuthorizer()
  const calls = { authorize: 0 }
  const failOnce = baseDeps({
    authorize: async () => { calls.authorize++; if (calls.authorize === 1) throw convexError("UPSTREAM_FAILED"); return { ...AUTHORIZATION } },
    legacyToken: async () => { throw new Error("legacy must not be used") }
  })
  await assert.rejects(() => authorizer.acquire(failOnce), LiveMirrorError)
  const grant = await authorizer.acquire(failOnce)
  assert.equal(grant.source, "secure")
  assert.equal(calls.authorize, 2)
})

test("auth NOT configured: the legacy token path still works exactly as before", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession({
    authEnabled: false,
    status: null,
    authorize: p.authorize,
    legacyToken: async () => { p.calls.legacy++; return { apiKey: "sk-decart-permanent", fastMode: true, sessionSeconds: 300 } },
    localSessionSeconds: 600,
    fastMode: false
  })
  assert.equal(grant.source, "legacy")
  assert.equal(grant.token, "sk-decart-permanent")
  // Legacy speed and limit come from the handler's own response, exactly as before.
  assert.equal(grant.fastMode, true)
  assert.equal(grant.sessionSeconds, 300, "the legacy handler owns its own session limit")
  assert.equal(grant.model, null, "the legacy path keeps the room's own model")
  assert.equal(p.calls.authorize.length, 0, "no server call without configured auth")
  assert.equal(p.calls.legacy, 1)
})

test("Fast Mode survives the secure path as a local speed preference", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize, legacyToken: p.legacyToken, fastMode: true }))
  assert.equal(grant.fastMode, true)
  assert.equal(grant.source, "secure")
})

test("no secret name reaches the room's secure auth code", () => {
  const libDir = fileURLToPath(new URL("../lib/", import.meta.url))
  for (const file of ["live-mirror.ts", "auth-config.ts", "auth-provider.tsx", "settings.ts"]) {
    // Warning comments name the forbidden keys on purpose; strip them so the guard inspects
    // actual code references rather than the warnings.
    const source = readFileSync(`${libDir}${file}`, "utf8").replace(/\/\/.*$/gm, "")
    for (const secret of ["DECART_API_KEY", "CLERK_SECRET_KEY", "AGENT_SERVICE_KEY"]) {
      assert.ok(!source.includes(secret), `${file} must not reference ${secret}`)
    }
    assert.ok(!source.match(/sk_(test|live)_[A-Za-z0-9]+/), `${file} must not contain a secret value`)
  }
})

test("the room reads session preferences without ever reading the stored Decart key", async () => {
  const settings = readFileSync(fileURLToPath(new URL("../lib/settings.ts", import.meta.url)), "utf8")
  const preferences = settings.slice(settings.indexOf("loadSessionPreferences"))
  assert.ok(preferences.includes('"sessionMinutes", "fastMode"'), "preferences read only the non-secret keys")
  const body = preferences.slice(0, preferences.indexOf("export function", 1) === -1 ? undefined : preferences.indexOf("export function", 1))
  assert.ok(!body.includes("apiKey"), "the preference loader must not read apiKey")
})

test("the room wires the secure authorizer and keeps the legacy handler reachable", () => {
  const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
  assert.ok(room.includes("createLiveMirrorAuthorizer"), "room uses the single-flight authorizer")
  assert.ok(room.includes("liveMirrorAction"), "room calls the injected Convex action")
  assert.ok(room.includes('background<Token>("token")'), "the legacy handler stays wired for unconfigured builds")
  // The room must not reach into the permanent key itself.
  assert.ok(!/loadSettings\(/.test(room), "the room must not load the full settings object")
})
