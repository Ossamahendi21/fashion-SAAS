// Secure-only Live Mirror token acquisition in the OpenWear fitting room.
//
// Step 2E3 removed the legacy browser-key fallback completely: authorization always goes
// through the server action, and missing auth configuration fails closed at the UI layer.
// Pure logic tests against the real `lib/live-mirror.ts` with injected fakes. No browser, no
// Chrome APIs, no Clerk, no Convex deployment and no Decart session: every provider boundary
// is a stub. The contract under test is the security boundary itself — the room must call
// the server action with no arguments, must never see a permanent key, and must never let
// the browser raise the server's session cap or substitute the model.
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

const AUTHORIZATION = { token: "decart-client-token-abc", expiresIn: 60, sessionSeconds: 300, model: "lucy-vton-latest", sessionId: "liveMirrorSessions-1", monthlyAllowanceSessions: 2, remainingSessions: 1 }
const SIGNED_IN = { state: "signed-in", convexAuthenticated: true }
const SIGNED_OUT = { state: "signed-out" }
const LOADING = { state: "loading" }

/** Records every call so a test can assert what did and did not cross the boundary. */
function probe() {
  const calls = { authorize: [] }
  return {
    calls,
    authorize: async args => { calls.authorize.push(args); return { ...AUTHORIZATION } }
  }
}

const baseDeps = (overrides = {}) => ({ status: SIGNED_IN, autoFreezeSeconds: 300, ...overrides })

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
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize }))
  assert.deepEqual(p.calls.authorize, [{}])
  assert.equal(grant.token, AUTHORIZATION.token)
})

test("the secure path never sends identity, plan, model, duration or a Decart key", async () => {
  const p = probe()
  await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize, autoFreezeSeconds: 9999 }))
  const [args] = p.calls.authorize
  assert.deepEqual(Object.keys(args), [])
  const serialized = JSON.stringify(args)
  for (const forbidden of ["userId", "clerkUserId", "plan", "model", "duration", "sessionSeconds", "apiKey", "token"]) {
    assert.ok(!serialized.includes(forbidden), `action args must not carry ${forbidden}`)
  }
  assert.ok(!serialized.includes("sk-"), "action args must never carry key material")
})

test("signed out: no session, sign-in state shown", async () => {
  const p = probe()
  await assert.rejects(
    () => resolveLiveMirrorSession(baseDeps({ status: SIGNED_OUT, authorize: p.authorize })),
    error => error instanceof LiveMirrorError && error.failure === "UNAUTHENTICATED"
  )
  assert.equal(p.calls.authorize.length, 0, "signed-out must not mint a token")
  assert.equal(liveMirrorMessage("UNAUTHENTICATED"), "Sign in to Fitcheck to use Live Mirror.")
})

test("Clerk still loading or Convex not yet connected: no token minted", async () => {
  for (const status of [LOADING, { state: "signed-in", convexAuthenticated: false }]) {
    const p = probe()
    await assert.rejects(
      () => resolveLiveMirrorSession(baseDeps({ status, authorize: p.authorize })),
      error => error instanceof LiveMirrorError && error.failure === "PENDING"
    )
    assert.equal(p.calls.authorize.length, 0)
  }
})

for (const code of ["FEATURE_LOCKED", "SUBSCRIPTION_REFRESH_REQUIRED", "UPSTREAM_FAILED", "UNAUTHENTICATED"]) {
  test(`${code}: fails closed with safe copy`, async () => {
    const p = probe()
    const deny = async () => { throw convexError(code) }
    await assert.rejects(
      () => resolveLiveMirrorSession(baseDeps({ authorize: deny })),
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
  })
}

test("an unknown server error becomes a generic safe message", async () => {
  const p = probe()
  const boom = async () => { throw new Error("ECONNREFUSED 10.0.0.7:3210 stack at authorizeLiveMirror") }
  await assert.rejects(
    () => resolveLiveMirrorSession(baseDeps({ authorize: boom })),
    error => error instanceof LiveMirrorError && error.failure === "UNKNOWN" && error.message === liveMirrorMessage("UNKNOWN")
  )
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
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize }))
  // This is the exact value the room hands to createDecartClient as apiKey.
  assert.equal(grant.token, "decart-client-token-abc")
  assert.ok(!grant.token.startsWith("sk_"), "a permanent key must never reach the room")
})

test("the returned model is used and the client cannot substitute another", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize }))
  assert.equal(grant.model, AUTHORIZATION.model)
  // A server-named model is resolved through the SDK catalogue; an unknown id fails closed.
  assert.equal(resolveRealtimeModel("lucy-vton-latest", id => ({ id })).id, "lucy-vton-latest")
  const catalogue = new Set(["lucy-vton-latest"])
  assert.throws(() => resolveRealtimeModel("lucy-2.1", id => { if (!catalogue.has(id)) throw new Error("unknown model"); return { id } }), LiveMirrorError)
})

test("a malformed authorization payload is rejected instead of used", async () => {
  for (const bad of [{ ...AUTHORIZATION, token: "" }, { ...AUTHORIZATION, model: "" }, { ...AUTHORIZATION, sessionSeconds: 0 }, { ...AUTHORIZATION, expiresIn: undefined }, { ...AUTHORIZATION, sessionId: "" }, { ...AUTHORIZATION, monthlyAllowanceSessions: -1 }, { ...AUTHORIZATION, remainingSessions: undefined }]) {
    const p = probe()
    await assert.rejects(
      () => resolveLiveMirrorSession(baseDeps({ authorize: async () => bad })),
      error => error instanceof LiveMirrorError && error.failure === "UNKNOWN"
    )
  }
})

test("server sessionSeconds = 15 with a local auto-freeze of 300 clamps the client timer to 15", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({
    authorize: async () => ({ ...AUTHORIZATION, sessionSeconds: 15 }),
    autoFreezeSeconds: 300
  }))
  assert.equal(grant.sessionSeconds, 15)
  assert.ok(grant.sessionSeconds <= 15)
})

test("server sessionSeconds = 300 with a local auto-freeze of 60 keeps the local 60", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize, autoFreezeSeconds: 60 }))
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
    authorize: async () => { calls.authorize++; await gate; return { ...AUTHORIZATION } }
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
    authorize: async () => { calls.authorize++; if (calls.authorize === 1) throw convexError("UPSTREAM_FAILED"); return { ...AUTHORIZATION } }
  })
  await assert.rejects(() => authorizer.acquire(failOnce), LiveMirrorError)
  const grant = await authorizer.acquire(failOnce)
  assert.equal(grant.token, AUTHORIZATION.token)
  assert.equal(calls.authorize, 2)
})

test("the secure grant carries no speed concept: Fast Mode is fully removed", async () => {
  const p = probe()
  const grant = await resolveLiveMirrorSession(baseDeps({ authorize: p.authorize }))
  assert.ok(!("fastMode" in grant), "no fastMode on the resolved grant")
  assert.ok(!("source" in grant), "no legacy source discriminator on the resolved grant")
  const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
  assert.ok(!room.includes("speed:"), "the room never sends a speed option to the SDK")
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

test("settings hold only the local auto-freeze preference, never a credential", async () => {
  const raw = readFileSync(fileURLToPath(new URL("../lib/settings.ts", import.meta.url)), "utf8")
  // Strip line comments (intentional documentation may name the removed concepts) and the
  // one-way legacy-cleanup list itself; what remains must reference no credential workflow.
  const code = raw.replace(/\/\/.*$/gm, "").replace(/LEGACY_SETTING_KEYS = \[.*?\]/, "")
  for (const forbidden of ["apiKey", "fastMode", "sessionMinutes", "test-key"]) {
    assert.ok(!code.includes(forbidden), `settings must not reference ${forbidden}`)
  }
  assert.ok(code.includes("autoFreezeSeconds"), "the local auto-freeze preference remains")
})

test("the room wires only the secure authorizer, with no legacy handler", () => {
  const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
  assert.ok(room.includes("createLiveMirrorAuthorizer"), "room uses the single-flight authorizer")
  assert.ok(room.includes("liveMirrorAction"), "room calls the injected Convex action")
  assert.ok(!room.includes('background<Token>("token")'), "no background token minting from the room")
  assert.ok(!room.includes("legacyToken"), "no legacy token callback in the room")
  assert.ok(room.includes("loadSettings()"), "the room reads preferences through the credential-free settings loader")
})
