import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";

// No HTTP route is exposed for Live Mirror: `authorizeLiveMirror` is a Convex action whose
// calls carry the Clerk JWT over the Convex transport. There is therefore no browser CORS
// surface to test here (no Access-Control-Allow-Origin, no origin allowlist). If a future
// step adds an HTTP endpoint, origin tests belong with it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      for (const extension of [".ts", ".js"]) {
        const candidate = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
});

// Convex function modules evaluate against the Convex runtime host; the unit-test host only
// needs the function-handle syscall they use at import time. No workflow, scheduler, or
// Decart call ever runs: fetch is mocked per test below.
globalThis.Convex = {
  async asyncSyscall(operation, args) {
    assert.equal(operation, "1.0/createFunctionHandle");
    return JSON.stringify(`handle:${JSON.parse(args).name}`);
  },
};

const {
  LIVE_MIRROR_MODEL,
  LIVE_MIRROR_TOKEN_EXPIRES_IN_SECONDS,
  clientTokenRequestBody,
  parseClientTokenResponse,
  parseSessionCap,
} = await import("../convex/liveMirror/decart.ts");
const liveMirror = await import("../convex/liveMirror.ts");
const { dayKey } = await import("../convex/shared/credits.ts");

const now = Date.parse("2026-09-17T12:00:00Z");
const periodEnd = now + 30 * 24 * 60 * 60 * 1000;
const SERVER_KEY = "test-server-decart-key";
const CLIENT_TOKEN = "dct_client_test_token";
const SESSION_SECONDS = 300;

const errorCode = (code) => (error) => error?.data?.code === code;

function fixture() {
  const rows = new Map();
  const put = (id, data) => rows.set(id, structuredClone({ ...data, _id: id }));
  const spend = { dayKey: dayKey(now), credits: 0 };
  put("paid", {
    clerkId: "paid-sub",
    plan: "pro",
    planCredits: 100,
    packCredits: 0,
    features: ["sharing"],
    planPeriodEnd: periodEnd,
    billingCheckedAt: now - 1000,
    dailySpend: spend,
  });
  put("free", {
    clerkId: "free-sub",
    plan: "free",
    planCredits: 0,
    packCredits: 25,
    features: [],
    dailySpend: spend,
  });
  put("stale", {
    clerkId: "stale-sub",
    plan: "pro",
    planCredits: 100,
    packCredits: 0,
    features: ["sharing"],
    planPeriodEnd: periodEnd,
    billingCheckedAt: now - 61_000,
    dailySpend: spend,
  });
  put("expired", {
    clerkId: "expired-sub",
    plan: "pro",
    planCredits: 100,
    packCredits: 0,
    features: ["sharing"],
    planPeriodEnd: now - 1000,
    billingCheckedAt: now - 1000,
    dailySpend: spend,
  });
  const db = {
    async get(id) {
      return structuredClone(rows.get(id) ?? null);
    },
    query(table) {
      assert.equal(table, "users");
      const filters = [];
      const query = {
        withIndex(_name, build) {
          const index = {
            eq(field, value) {
              filters.push([field, value]);
              return index;
            },
          };
          build(index);
          return query;
        },
        async unique() {
          const found = [...rows.values()].filter((row) => filters.every(([field, value]) => row[field] === value));
          assert.ok(found.length <= 1);
          return structuredClone(found[0] ?? null);
        },
      };
      return query;
    },
  };
  const calls = { fetch: [], entitlementFor: null };
  const actionContext = (subject) => ({
    auth: {
      async getUserIdentity() {
        return subject ? { subject } : null;
      },
    },
    async runQuery(_reference, args) {
      calls.entitlementFor = args.clerkId;
      return liveMirror.checkEntitlement._handler({ db }, args);
    },
  });
  return { db, calls, actionContext };
}

function mockFetch(calls, implementation) {
  globalThis.fetch = async (url, init) => {
    calls.fetch.push({ url, init: structuredClone({ ...init, headers: { ...init.headers } }) });
    return implementation(url, init);
  };
}

const okResponse = () => ({ ok: true, status: 200, async json() { return { apiKey: CLIENT_TOKEN }; } });

test.beforeEach(() => {
  mock.method(Date, "now", () => now);
  process.env.DECART_API_KEY = SERVER_KEY;
  process.env.LIVE_MIRROR_SESSION_MAX_SECONDS = String(SESSION_SECONDS);
});

test.afterEach(() => {
  mock.restoreAll();
  delete process.env.DECART_API_KEY;
  delete process.env.LIVE_MIRROR_SESSION_MAX_SECONDS;
  delete globalThis.fetch;
});

test("unauthenticated request is denied before any provider call", async () => {
  const f = fixture();
  mockFetch(f.calls, okResponse);
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext(null), {}),
    errorCode("UNAUTHENTICATED"),
  );
  assert.equal(f.calls.fetch.length, 0);
});

test("Free-plan user is denied without contacting Decart", async () => {
  const f = fixture();
  mockFetch(f.calls, okResponse);
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("free-sub"), {}),
    errorCode("FEATURE_LOCKED"),
  );
  assert.equal(f.calls.fetch.length, 0);
});

test("stale billing is denied per the repository freshness rule", async () => {
  const f = fixture();
  mockFetch(f.calls, okResponse);
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("stale-sub"), {}),
    errorCode("SUBSCRIPTION_REFRESH_REQUIRED"),
  );
  assert.equal(f.calls.fetch.length, 0);
});

test("expired paid period is denied per the repository freshness rule", async () => {
  const f = fixture();
  mockFetch(f.calls, okResponse);
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("expired-sub"), {}),
    errorCode("SUBSCRIPTION_REFRESH_REQUIRED"),
  );
  assert.equal(f.calls.fetch.length, 0);
});

test("unknown account is denied while it is still being set up", async () => {
  const f = fixture();
  await assert.rejects(
    liveMirror.checkEntitlement._handler({ db: f.db }, { clerkId: "ghost-sub" }),
    errorCode("UNAUTHENTICATED"),
  );
});

test("paid user with fresh billing receives a scoped token via the exact Decart request", async () => {
  const f = fixture();
  mockFetch(f.calls, okResponse);
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  assert.deepEqual(result, {
    token: CLIENT_TOKEN,
    expiresIn: 60,
    sessionSeconds: SESSION_SECONDS,
    model: "lucy-vton-latest",
  });
  assert.equal(f.calls.entitlementFor, "paid-sub");
  assert.equal(f.calls.fetch.length, 1);
  const [call] = f.calls.fetch;
  assert.equal(call.url, "https://api.decart.ai/v1/client/tokens");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["X-API-KEY"], SERVER_KEY);
  assert.equal(
    call.init.body,
    JSON.stringify({
      expiresIn: 60,
      allowedModels: ["lucy-vton-latest"],
      constraints: { realtime: { maxSessionDuration: SESSION_SECONDS } },
    }),
  );
});

test("caller-supplied fields cannot override model, duration, user, or subscription", async () => {
  const f = fixture();
  mockFetch(f.calls, okResponse);
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {
    model: "evil-model",
    sessionSeconds: 99999,
    clerkId: "free-sub",
    plan: "plus",
  });
  assert.equal(result.model, LIVE_MIRROR_MODEL);
  assert.equal(result.sessionSeconds, SESSION_SECONDS);
  assert.equal(f.calls.entitlementFor, "paid-sub");
  const [call] = f.calls.fetch;
  assert.deepEqual(JSON.parse(call.init.body).allowedModels, ["lucy-vton-latest"]);
  assert.equal(JSON.parse(call.init.body).constraints.realtime.maxSessionDuration, SESSION_SECONDS);
});

test("the permanent server key is never present in the public response", async () => {
  const f = fixture();
  mockFetch(f.calls, okResponse);
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  assert.deepEqual(Object.keys(result).sort(), ["expiresIn", "model", "sessionSeconds", "token"]);
  assert.ok(!JSON.stringify(result).includes(SERVER_KEY));
});

test("provider rejection fails safely with no token", async () => {
  const f = fixture();
  mockFetch(f.calls, async () => ({ ok: false, status: 500, async json() { return { detail: "boom" }; } }));
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
    errorCode("UPSTREAM_FAILED"),
  );
});

test("provider transport failure fails safely with no token", async () => {
  const f = fixture();
  mockFetch(f.calls, async () => { throw new Error("socket hang up"); });
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
    errorCode("UPSTREAM_FAILED"),
  );
});

test("malformed provider response fails safely with no token", async () => {
  for (const body of [null, {}, { apiKey: "" }, { apiKey: 42 }]) {
    const f = fixture();
    mockFetch(f.calls, async () => ({ ok: true, status: 200, async json() { return body; } }));
    await assert.rejects(
      liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
      errorCode("UPSTREAM_FAILED"),
    );
  }
  assert.equal(parseClientTokenResponse({ apiKey: CLIENT_TOKEN }), CLIENT_TOKEN);
});

test("missing session-cap configuration fails closed without contacting Decart", async () => {
  const f = fixture();
  delete process.env.LIVE_MIRROR_SESSION_MAX_SECONDS;
  mockFetch(f.calls, okResponse);
  await assert.rejects(liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}));
  assert.equal(f.calls.fetch.length, 0);
});

test("session cap accepts only finite positive integers within bounds", () => {
  assert.equal(parseSessionCap("1"), 1);
  assert.equal(parseSessionCap("3600"), 3600);
  assert.equal(parseSessionCap(" 300 "), 300);
  for (const raw of ["0", "-5", "1.5", "3601", "abc", "", "300s", "0x12"]) {
    assert.throws(() => parseSessionCap(raw), /LIVE_MIRROR_SESSION_MAX_SECONDS/);
  }
  assert.throws(() => parseSessionCap(undefined), /LIVE_MIRROR_SESSION_MAX_SECONDS/);
});

test("token request body is pinned to the server model, lifetime, and granted cap", () => {
  assert.equal(
    clientTokenRequestBody(120),
    JSON.stringify({
      expiresIn: LIVE_MIRROR_TOKEN_EXPIRES_IN_SECONDS,
      allowedModels: [LIVE_MIRROR_MODEL],
      constraints: { realtime: { maxSessionDuration: 120 } },
    }),
  );
});
