// Auth foundation tests: public config validation, signed-out safety, and a static
// guard that no secret ever enters client auth code. No real Clerk, no real Decart.
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const bundled = await build({ entryPoints: [fileURLToPath(new URL("../lib/auth-config.ts", import.meta.url))], bundle: true, format: "esm", write: false })
const { deriveAuthStatus, fitcheckSignInUrl, getAuthConfig, isAuthConfigured } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)

const fullEnv = () => ({
  PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc123",
  PLASMO_PUBLIC_CLERK_SYNC_HOST: "http://localhost",
  PLASMO_PUBLIC_CONVEX_URL: "https://test-123.convex.cloud",
  PLASMO_PUBLIC_FITCHECK_APP_URL: "http://localhost:3000",
})

test("full public config resolves with trimmed values", () => {
  const config = getAuthConfig({ ...fullEnv(), PLASMO_PUBLIC_CLERK_SYNC_HOST: "  http://localhost  " })
  assert.deepEqual(config, {
    clerkPublishableKey: "pk_test_abc123",
    clerkSyncHost: "http://localhost",
    convexUrl: "https://test-123.convex.cloud",
    fitcheckAppUrl: "http://localhost:3000",
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

test("missing Fitcheck app URL fails clearly and disables auth", () => {
  const env = fullEnv()
  delete env.PLASMO_PUBLIC_FITCHECK_APP_URL
  assert.throws(() => getAuthConfig(env), /PLASMO_PUBLIC_FITCHECK_APP_URL/)
  assert.equal(isAuthConfigured(env), false)
})

test("Fitcheck app URL accepts http localhost:3000 and https origins", () => {
  assert.equal(getAuthConfig({ ...fullEnv(), PLASMO_PUBLIC_FITCHECK_APP_URL: "http://localhost:3000" }).fitcheckAppUrl, "http://localhost:3000")
  assert.equal(getAuthConfig({ ...fullEnv(), PLASMO_PUBLIC_FITCHECK_APP_URL: "http://localhost:3000/" }).fitcheckAppUrl, "http://localhost:3000")
  assert.equal(getAuthConfig({ ...fullEnv(), PLASMO_PUBLIC_FITCHECK_APP_URL: "https://app.fitcheck.example" }).fitcheckAppUrl, "https://app.fitcheck.example")
})

test("Fitcheck app URL rejects non-URL and non-http(s) values", () => {
  for (const bad of ["", "notaurl", "ftp://files.example/file", "chrome-extension://abc", "http://"]) {
    assert.throws(() => getAuthConfig({ ...fullEnv(), PLASMO_PUBLIC_FITCHECK_APP_URL: bad }), /PLASMO_PUBLIC_FITCHECK_APP_URL/, `should reject ${JSON.stringify(bad)}`)
  }
})

test("Sync Host stays independent from the Fitcheck app URL", () => {
  // The dev Sync Host is bare http://localhost while the app serves on :3000.
  const config = getAuthConfig(fullEnv())
  assert.equal(config.clerkSyncHost, "http://localhost")
  assert.equal(config.fitcheckAppUrl, "http://localhost:3000")
  // The app URL works with no Sync Host at all.
  const standalone = getAuthConfig({ ...fullEnv(), PLASMO_PUBLIC_CLERK_SYNC_HOST: "" })
  assert.equal(standalone.clerkSyncHost, null)
  assert.equal(standalone.fitcheckAppUrl, "http://localhost:3000")
})

test("generated sign-in URL points at the Fitcheck app, never the Sync Host", () => {
  assert.equal(fitcheckSignInUrl(getAuthConfig(fullEnv())), "http://localhost:3000/sign-in")
  assert.ok(!fitcheckSignInUrl(getAuthConfig(fullEnv())).startsWith("http://localhost/sign-in"))
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
  for (const name of ["PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY", "PLASMO_PUBLIC_CLERK_SYNC_HOST", "PLASMO_PUBLIC_CONVEX_URL", "PLASMO_PUBLIC_FITCHECK_APP_URL"]) {
    assert.ok(configSource.includes(name), `auth-config.ts should read ${name}`)
  }
  const providerSource = readFileSync(`${dir}auth-provider.tsx`, "utf8")
  assert.ok(!providerSource.match(/process\.env\.[A-Z_]+/), "auth-provider.tsx must not read env directly; it goes through getAuthConfig()")
})

test("default build-env path picks up statically replaced values (Plasmo simulation)", async () => {
  // Plasmo/Parcel replace DIRECT process.env.PLASMO_PUBLIC_* references at compile time.
  // This bundles with esbuild `define` (the same static mechanism) and calls the functions
  // with NO arguments, proving the default BUILD_ENV path — not just injected envs — works.
  // Against the old `env = process.env` + `env.NAME` pattern this fails, because `env.NAME`
  // is not a statically replaceable reference.
  const injected = {
    "process.env.PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY": JSON.stringify("pk_test_buildenv"),
    "process.env.PLASMO_PUBLIC_CONVEX_URL": JSON.stringify("https://buildenv.convex.cloud"),
    "process.env.PLASMO_PUBLIC_CLERK_SYNC_HOST": JSON.stringify("http://localhost"),
    "process.env.PLASMO_PUBLIC_FITCHECK_APP_URL": JSON.stringify("http://localhost:3000"),
  }
  const rebuilt = await build({ entryPoints: [fileURLToPath(new URL("../lib/auth-config.ts", import.meta.url))], bundle: true, format: "esm", write: false, define: injected })
  const buildEnv = await import(`data:text/javascript;base64,${Buffer.from(rebuilt.outputFiles[0].text).toString("base64")}`)
  // The real shell env must not provide these, or the test would pass for the wrong reason.
  const saved = {}
  for (const name of ["PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY", "PLASMO_PUBLIC_CONVEX_URL", "PLASMO_PUBLIC_CLERK_SYNC_HOST", "PLASMO_PUBLIC_FITCHECK_APP_URL"]) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  try {
    assert.equal(buildEnv.isAuthConfigured(), true)
    assert.deepEqual(buildEnv.getAuthConfig(), {
      clerkPublishableKey: "pk_test_buildenv",
      clerkSyncHost: "http://localhost",
      convexUrl: "https://buildenv.convex.cloud",
      fitcheckAppUrl: "http://localhost:3000",
    })
    assert.equal(buildEnv.fitcheckSignInUrl(buildEnv.getAuthConfig()), "http://localhost:3000/sign-in")
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
