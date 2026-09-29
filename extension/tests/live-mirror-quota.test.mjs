// Step 2E1: quota-aware secure authorization in the OpenWear fitting room.
//
// The server now returns quota fields with every minted token and the secure path disables
// Fast Mode. Stale billing recovers automatically with exactly one refresh plus one retry.
// No test contacts Clerk, Convex, or Decart.

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
  liveMirrorMessage,
  LiveMirrorError,
  resolveLiveMirrorSession,
  toLiveMirrorFailure
} = liveMirror

const SIGNED_IN = { state: "signed-in", convexAuthenticated: true }
const GRANT = {
  token: "dc_live_quota_test_token",
  expiresIn: 60,
  sessionSeconds: 60,
  model: "lucy-vton-latest",
  sessionId: "liveMirrorSessions-1",
  monthlyAllowanceSessions: 2,
  remainingSessions: 1
}

function convexError(code, serverMessage) {
  const error = new ConvexError(`[CONVEX Q(liveMirror:authorizeLiveMirror)] Server Error: ${serverMessage}`)
  error.data = { code, message: serverMessage }
  return error
}

const secureDeps = (overrides = {}) => ({
  status: SIGNED_IN,
  authorize: async () => ({ ...GRANT }),
  refreshBilling: undefined,
  autoFreezeSeconds: 300,
  ...overrides
})

async function assertDenies(failure, promise) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof LiveMirrorError, `expected a LiveMirrorError, got ${error}`)
    assert.equal(error.failure, failure)
    assert.equal(error.message, liveMirrorMessage(failure))
    return true
  })
}

test("quota fields are returned and unknown server fields are dropped", async () => {
  const grant = await resolveLiveMirrorSession(secureDeps({
    authorize: async () => ({ ...GRANT, apiKey: "sk_live_SERVER_LEAK", plan: "pro" })
  }))
  assert.equal(grant.sessionId, GRANT.sessionId)
  assert.equal(grant.monthlyAllowanceSessions, 2)
  assert.equal(grant.remainingSessions, 1)
  assert.ok(!JSON.stringify(grant).includes("sk_live_SERVER_LEAK"))
})

test("malformed quota fields fail closed instead of minting a session", async () => {
  for (const bad of [
    { ...GRANT, sessionId: "" },
    { ...GRANT, monthlyAllowanceSessions: -1 },
    { ...GRANT, remainingSessions: Number.NaN },
    { ...GRANT, monthlyAllowanceSessions: undefined }
  ]) {
    await assertDenies("UNKNOWN", resolveLiveMirrorSession(secureDeps({ authorize: async () => bad })))
  }
})

test("secure authorization carries no speed concept", async () => {
  const grant = await resolveLiveMirrorSession(secureDeps())
  assert.ok(!("fastMode" in grant), "no fastMode on the resolved grant")
  const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
  assert.ok(!room.includes("speed:"), "the room never sends a speed option to the SDK")
})

test("exhausted allowance maps to LIMIT_REACHED with safe copy and no fallback", async () => {
  await assertDenies(
    "LIVE_MIRROR_LIMIT_REACHED",
    resolveLiveMirrorSession(secureDeps({
      authorize: async () => { throw convexError("LIVE_MIRROR_LIMIT_REACHED", "quota exhausted") }
    }))
  )
  assert.equal(liveMirrorMessage("LIVE_MIRROR_LIMIT_REACHED"), "You've used your Live Mirror sessions for this billing cycle.")
  assert.equal(toLiveMirrorFailure(convexError("LIVE_MIRROR_LIMIT_REACHED", "x")), "LIVE_MIRROR_LIMIT_REACHED")
  const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
  assert.ok(room.includes("LIVE_MIRROR_LIMIT_REACHED"), "the room knows the quota denial")
})

test("stale billing refreshes once and retries authorization once", async () => {
  const calls = { authorize: 0, refresh: 0 }
  const grant = await resolveLiveMirrorSession(secureDeps({
    authorize: async () => {
      calls.authorize++
      if (calls.authorize === 1) throw convexError("SUBSCRIPTION_REFRESH_REQUIRED", "stale snapshot")
      return { ...GRANT }
    },
    refreshBilling: async () => { calls.refresh++ }
  }))
  assert.equal(grant.token, GRANT.token)
  assert.equal(calls.authorize, 2)
  assert.equal(calls.refresh, 1)
})

test("stale billing without an injected refresh still fails without a fallback", async () => {
  const calls = { authorize: 0 }
  await assertDenies(
    "SUBSCRIPTION_REFRESH_REQUIRED",
    resolveLiveMirrorSession(secureDeps({
      authorize: async () => { calls.authorize++; throw convexError("SUBSCRIPTION_REFRESH_REQUIRED", "stale snapshot") }
    }))
  )
  assert.equal(calls.authorize, 1)
})

test("a failed billing refresh surfaces safely and never loops", async () => {
  const calls = { authorize: 0, refresh: 0 }
  await assertDenies(
    "UPSTREAM_FAILED",
    resolveLiveMirrorSession(secureDeps({
      authorize: async () => { calls.authorize++; throw convexError("SUBSCRIPTION_REFRESH_REQUIRED", "stale snapshot") },
      refreshBilling: async () => { calls.refresh++; throw convexError("UPSTREAM_FAILED", "Clerk unavailable") }
    }))
  )
  assert.equal(calls.authorize, 1)
  assert.equal(calls.refresh, 1)
})

test("a retry that is still stale stops after one refresh and one retry", async () => {
  const calls = { authorize: 0, refresh: 0 }
  await assertDenies(
    "SUBSCRIPTION_REFRESH_REQUIRED",
    resolveLiveMirrorSession(secureDeps({
      authorize: async () => { calls.authorize++; throw convexError("SUBSCRIPTION_REFRESH_REQUIRED", "still stale") },
      refreshBilling: async () => { calls.refresh++ }
    }))
  )
  assert.equal(calls.authorize, 2)
  assert.equal(calls.refresh, 1)
})

for (const failure of ["FEATURE_LOCKED", "LIVE_MIRROR_LIMIT_REACHED", "UPSTREAM_FAILED", "UNAUTHENTICATED"]) {
  test(`${failure} never triggers an automatic billing refresh`, async () => {
    const calls = { authorize: 0, refresh: 0 }
    await assertDenies(
      failure,
      resolveLiveMirrorSession(secureDeps({
        authorize: async () => { calls.authorize++; throw convexError(failure, "do not refresh") },
        refreshBilling: async () => { calls.refresh++; throw new Error("refresh must not be called") }
      }))
    )
    assert.equal(calls.authorize, 1)
    assert.equal(calls.refresh, 0)
  })
}

test("concurrent stale starts share one refresh and one retry", async () => {
  const calls = { authorize: 0, refresh: 0 }
  let release
  const gate = new Promise(resolve => { release = resolve })
  const authorizer = createLiveMirrorAuthorizer()
  const deps = secureDeps({
    authorize: async () => {
      calls.authorize++
      if (calls.authorize === 1) await gate
      if (calls.authorize === 1) throw convexError("SUBSCRIPTION_REFRESH_REQUIRED", "stale snapshot")
      return { ...GRANT }
    },
    refreshBilling: async () => { calls.refresh++ }
  })
  const attempts = [authorizer.acquire(deps), authorizer.acquire(deps), authorizer.acquire(deps)]
  release()
  const grants = await Promise.all(attempts)
  assert.ok(grants.every(grant => grant.token === GRANT.token))
  assert.equal(calls.authorize, 2)
  assert.equal(calls.refresh, 1)
})

test("authorization and refresh calls carry no client billing values", async () => {
  const calls = { authorize: [], refresh: 0 }
  await assertDenies(
    "SUBSCRIPTION_REFRESH_REQUIRED",
    resolveLiveMirrorSession(secureDeps({
      authorize: async args => { calls.authorize.push(args); throw convexError("SUBSCRIPTION_REFRESH_REQUIRED", "stale") },
      refreshBilling: async () => { calls.refresh++; return null }
    }))
  )
  assert.deepEqual(calls.authorize, [{}, {}])
  assert.equal(calls.refresh, 1)
})
