// Step 2E3.1: legacy credential-era storage is actively purged, and the local auto-freeze
// preference can only ever shorten a session.
//
// An old installation cleans itself on service-worker startup without ever opening Options:
// `background.ts` purges at top level, and `loadSettings()` purges defensively. No test
// contacts Decart, Clerk, or Convex. The storage backend is an in-memory fake.

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

async function bundleModule(relative) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, format: "esm", write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

/** In-memory chrome.storage.local supporting exactly what settings/background use. */
function fakeStorage(seed = {}) {
  const store = new Map(Object.entries(structuredClone(seed)))
  return {
    store,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : Object.keys(keys ?? {})
      return Object.fromEntries(names.filter(name => store.has(name)).map(name => [name, store.get(name)]))
    },
    async set(patch) {
      for (const [key, value] of Object.entries(patch)) store.set(key, value)
    },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) store.delete(key)
    }
  }
}

function fakeChrome(storage) {
  return {
    storage: { local: storage, onChanged: { addListener() {}, removeListener() {} } },
    runtime: {
      id: "ext",
      getURL: path => `chrome-extension://ext/${path}`,
      openOptionsPage() {},
      getManifest: () => ({}),
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onMessageExternal: { addListener() {} }
    },
    tabs: { query: async () => [], sendMessage: async () => {} },
    scripting: { executeScript: async () => {} },
    management: { getSelf: async () => ({}) }
  }
}

const settings = await bundleModule("../lib/settings.ts")
const liveMirror = await bundleModule("../lib/live-mirror.ts")

// ---------- Active purge on worker startup ----------

test("1–3: importing the background worker purges apiKey, fastMode and sessionMinutes", async () => {
  const storage = fakeStorage({
    apiKey: "dct_stale_permanent_key",
    fastMode: true,
    sessionMinutes: 20,
    autoFreezeSeconds: 30,
    unrelated: { theme: "dark" }
  })
  globalThis.chrome = fakeChrome(storage)
  try {
    await bundleModule("../background.ts")
    // The top-level purge is fire-and-forget; let the microtask settle.
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(storage.store.has("apiKey"), false, "stale permanent key is gone")
    assert.equal(storage.store.has("fastMode"), false)
    assert.equal(storage.store.has("sessionMinutes"), false)
  } finally {
    delete globalThis.chrome
  }
})

test("4–5: autoFreezeSeconds and unrelated storage survive the startup purge", async () => {
  const storage = fakeStorage({
    apiKey: "dct_stale_permanent_key",
    autoFreezeSeconds: 30,
    unrelated: { theme: "dark" }
  })
  globalThis.chrome = fakeChrome(storage)
  try {
    await bundleModule("../background.ts")
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(storage.store.get("autoFreezeSeconds"), 30)
    assert.deepEqual(storage.store.get("unrelated"), { theme: "dark" })
  } finally {
    delete globalThis.chrome
  }
})

test("6: the purge is idempotent", async () => {
  const storage = fakeStorage({ apiKey: "dct_old", autoFreezeSeconds: 45 })
  globalThis.chrome = fakeChrome(storage)
  try {
    await settings.purgeLegacySettings()
    await settings.purgeLegacySettings()
    assert.equal(storage.store.has("apiKey"), false)
    assert.equal(storage.store.get("autoFreezeSeconds"), 45)
  } finally {
    delete globalThis.chrome
  }
})

test("purge is safe when storage is unavailable", async () => {
  delete globalThis.chrome
  await assert.doesNotReject(settings.purgeLegacySettings())
})

// ---------- loadSettings defense in depth ----------

test("7: no legacy credential is ever read back into application behavior", async () => {
  const storage = fakeStorage({
    apiKey: "dct_stale_permanent_key",
    fastMode: true,
    sessionMinutes: 20,
    autoFreezeSeconds: 30
  })
  globalThis.chrome = fakeChrome(storage)
  try {
    const loaded = await settings.loadSettings()
    assert.deepEqual(loaded, { autoFreezeSeconds: 30, shoppingActionsEnabled: true }, "only safe preferences are returned")
    assert.equal(storage.store.has("apiKey"), false, "loading also cleans")
  } finally {
    delete globalThis.chrome
  }
})

test("settings sanitize the auto-freeze preference without ever raising it", async () => {
  const cases = [
    [{}, 60, "missing preference falls back to the safe default"],
    [{ autoFreezeSeconds: -5 }, 60, "negative values fall back"],
    [{ autoFreezeSeconds: Number.NaN }, 60, "NaN falls back"],
    [{ autoFreezeSeconds: "60" }, 60, "non-numbers fall back"],
    [{ autoFreezeSeconds: 45.7 }, 45, "fractional values floor"],
    [{ autoFreezeSeconds: 0 }, 0, "zero is valid and means no early freeze"],
    [{ autoFreezeSeconds: 15 }, 15, "shorter values pass through"]
  ]
  for (const [seed, expected, message] of cases) {
    const storage = fakeStorage(seed)
    globalThis.chrome = fakeChrome(storage)
    try {
      assert.equal((await settings.loadSettings()).autoFreezeSeconds, expected, message)
    } finally {
      delete globalThis.chrome
    }
  }
})

// ---------- Auto-freeze clamp audit ----------

test("8–9: the local preference shortens only — server 60/local 30, server 30/local 60, server 45/local 0", () => {
  const { effectiveSessionSeconds } = liveMirror
  assert.equal(effectiveSessionSeconds(30, 60), 30, "server 60, local 30 → 30")
  assert.equal(effectiveSessionSeconds(60, 30), 30, "server 30, local 60 → 30")
  assert.equal(effectiveSessionSeconds(0, 45), 45, "server 45, local 0 → 45 (no early freeze)")
  assert.equal(effectiveSessionSeconds(Number.NaN, 45), 45, "server 45, local invalid → 45")
  assert.equal(effectiveSessionSeconds(-5, 45), 45, "server 45, local negative → 45")
})

// ---------- Secure flow unchanged ----------

test("10: resolution still returns the server grant, clamped, with no legacy surface", async () => {
  const GRANT = {
    token: "dc_live_purge_audit",
    expiresIn: 60,
    sessionSeconds: 60,
    model: "lucy-vton-latest",
    sessionId: "liveMirrorSessions-3",
    monthlyAllowanceSessions: 2,
    remainingSessions: 1
  }
  const grant = await liveMirror.resolveLiveMirrorSession({
    status: { state: "signed-in", convexAuthenticated: true },
    authorize: async () => ({ ...GRANT }),
    autoFreezeSeconds: 30
  })
  assert.equal(grant.token, GRANT.token)
  assert.equal(grant.sessionSeconds, 30, "local 30 shortens server 60")
  assert.deepEqual(Object.keys(grant).sort(), ["model", "monthlyAllowanceSessions", "remainingSessions", "sessionId", "sessionSeconds", "token"])
})
