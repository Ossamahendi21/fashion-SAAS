// Auth foundation tests: public config validation, signed-out safety, and a static
// guard that no secret ever enters client auth code. No real Clerk, no real Decart.
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const bundled = await build({ entryPoints: [fileURLToPath(new URL("../lib/auth-config.ts", import.meta.url))], bundle: true, format: "esm", write: false })
const { deriveAuthStatus, getAuthConfig, isAuthConfigured } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)

const fullEnv = () => ({
  PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc123",
  PLASMO_PUBLIC_CLERK_SYNC_HOST: "http://localhost:3000",
  PLASMO_PUBLIC_CONVEX_URL: "https://test-123.convex.cloud",
})

test("full public config resolves with trimmed values", () => {
  const config = getAuthConfig({ ...fullEnv(), PLASMO_PUBLIC_CLERK_SYNC_HOST: "  http://localhost:3000  " })
  assert.deepEqual(config, {
    clerkPublishableKey: "pk_test_abc123",
    clerkSyncHost: "http://localhost:3000",
    convexUrl: "https://test-123.convex.cloud",
  })
  assert.equal(isAuthConfigured(fullEnv()), true)
})

test("missing publishable key fails clearly and disables auth", () => {
  const env = fullEnv()
  delete env.PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY
  assert.throws(() => getAuthConfig(env), /PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY/)
  assert.equal(isAuthConfigured(env), false)
  assert.equal(isAuthConfigured({}), false)
})

test("a secret key in the publishable slot is rejected, not shipped", () => {
  assert.throws(() => getAuthConfig({ ...fullEnv(), PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY: "sk_test_secret" }), /publishable key/)
})

test("missing Convex URL fails clearly and disables auth", () => {
  const env = fullEnv()
  delete env.PLASMO_PUBLIC_CONVEX_URL
  assert.throws(() => getAuthConfig(env), /PLASMO_PUBLIC_CONVEX_URL/)
  assert.equal(isAuthConfigured(env), false)
})

test("missing Sync Host is allowed and means extension-only auth", () => {
  const env = fullEnv()
  delete env.PLASMO_PUBLIC_CLERK_SYNC_HOST
  assert.equal(getAuthConfig(env).clerkSyncHost, null)
  assert.equal(isAuthConfigured(env), true)
})

test("signed-out state never presents itself as authenticated", () => {
  assert.deepEqual(deriveAuthStatus({ clerkLoaded: false, isSignedIn: true, convexAuthenticated: true }), { state: "loading" })
  assert.deepEqual(deriveAuthStatus({ clerkLoaded: false, isSignedIn: false, convexAuthenticated: false }), { state: "loading" })
  // The critical cases: even a stale true Convex flag must not leak through.
  assert.deepEqual(deriveAuthStatus({ clerkLoaded: true, isSignedIn: false, convexAuthenticated: true }), { state: "signed-out" })
  assert.deepEqual(deriveAuthStatus({ clerkLoaded: true, isSignedIn: undefined, convexAuthenticated: true }), { state: "signed-out" })
  assert.deepEqual(deriveAuthStatus({ clerkLoaded: true, isSignedIn: false, convexAuthenticated: false }), { state: "signed-out" })
  assert.deepEqual(deriveAuthStatus({ clerkLoaded: true, isSignedIn: true, convexAuthenticated: true }), { state: "signed-in", convexAuthenticated: true })
  assert.deepEqual(deriveAuthStatus({ clerkLoaded: true, isSignedIn: true, convexAuthenticated: false }), { state: "signed-in", convexAuthenticated: false })
})

test("no secret enters client auth code", () => {
  const dir = fileURLToPath(new URL("../lib/", import.meta.url))
  for (const file of ["auth-config.ts", "auth-provider.tsx"]) {
    // Warning comments name the forbidden keys on purpose; strip them so the guard
    // checks actual code references, not the warnings themselves.
    const source = readFileSync(`${dir}${file}`, "utf8").replace(/\/\/.*$/gm, "")
    for (const secret of ["CLERK_SECRET_KEY", "DECART_API_KEY", "AGENT_SERVICE_KEY"]) {
      assert.ok(!source.includes(secret), `${file} must not reference ${secret}`)
    }
    assert.ok(!source.match(/sk_(test|live)_[A-Za-z0-9]+/), `${file} must not contain a secret key value`)
  }
})

test("client auth code references only public env names", () => {
  const dir = fileURLToPath(new URL("../lib/", import.meta.url))
  const configSource = readFileSync(`${dir}auth-config.ts`, "utf8")
  for (const name of ["PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY", "PLASMO_PUBLIC_CLERK_SYNC_HOST", "PLASMO_PUBLIC_CONVEX_URL"]) {
    assert.ok(configSource.includes(name), `auth-config.ts should read ${name}`)
  }
  const providerSource = readFileSync(`${dir}auth-provider.tsx`, "utf8")
  assert.ok(!providerSource.match(/process\.env\.[A-Z_]+/), "auth-provider.tsx must not read env directly; it goes through getAuthConfig()")
})
