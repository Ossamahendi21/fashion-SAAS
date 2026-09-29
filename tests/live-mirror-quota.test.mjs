import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";

// Step 2E1 quota and cost guardrails. Every Decart boundary is mocked; no test may contact
// Clerk, Convex, or Decart. The in-memory database below emulates one Convex mutation at a
// time for the race test because Convex executes each mutation transactionally.
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

globalThis.Convex = {
  async asyncSyscall(operation, args) {
    assert.equal(operation, "1.0/createFunctionHandle");
    return JSON.stringify(`handle:${JSON.parse(args).name}`);
  },
};

const liveMirror = await import("../convex/liveMirror.ts");
const { parseDailyAuthorizedSecondsCap } = await import("../convex/liveMirror/decart.ts");
const { reconcileSubscription } = await import("../convex/model/credits.ts");
const { PLANS, dayKey } = await import("../convex/shared/credits.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-30T12:00:00Z");
const periodStart = now - DAY_MS;
const periodEnd = now + 29 * DAY_MS;
const SESSION_SECONDS = 60;
const SERVER_KEY = "test-server-decart-key";
const CLIENT_TOKEN = "dct_client_test_token";
let currentNow = now;
let fetchCalls = [];

const errorCode = (code) => (error) => error?.data?.code === code;

function baseUser(overrides = {}) {
  return {
    clerkId: "paid-sub",
    plan: "pro",
    planCredits: 100,
    packCredits: 0,
    features: [...PLANS.pro.features],
    planPeriodStart: periodStart,
    planPeriodEnd: periodEnd,
    billingCheckedAt: currentNow - 1000,
    dailySpend: { dayKey: dayKey(currentNow), credits: 0 },
    ...overrides,
  };
}

function fixture(userOverrides = {}) {
  const tables = {
    users: new Map(),
    liveMirrorSessions: new Map(),
    systemCounters: new Map(),
    creditLedger: new Map(),
    dailyStats: new Map(),
  };
  let nextId = 0;
  const put = (table, id, fields) => tables[table].set(id, structuredClone({ ...fields, _id: id }));
  const locate = (id) => {
    for (const [table, rows] of Object.entries(tables)) {
      if (rows.has(id)) return { table, row: rows.get(id) };
    }
    assert.fail(`Missing fixture row: ${id}`);
  };
  put("users", "paid", baseUser(userOverrides));
  put("users", "free", {
    clerkId: "free-sub",
    plan: "free",
    planCredits: 0,
    packCredits: 25,
    features: [],
    planPeriodEnd: undefined,
    planPeriodStart: undefined,
    billingCheckedAt: undefined,
    dailySpend: { dayKey: dayKey(currentNow), credits: 0 },
  });
  const db = {
    async get(id) {
      return structuredClone(locate(id).row);
    },
    async patch(id, fields) {
      const found = locate(id);
      const next = { ...found.row };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete next[key];
        else next[key] = structuredClone(value);
      }
      tables[found.table].set(id, next);
    },
    async insert(table, fields) {
      const id = `${table}-${++nextId}`;
      put(table, id, fields);
      return id;
    },
    query(table) {
      const filters = [];
      const selected = () =>
        [...tables[table].values()].filter((row) => filters.every(([field, value]) => row[field] === value));
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
        async first() {
          return structuredClone(selected()[0] ?? null);
        },
        async unique() {
          assert.ok(selected().length <= 1);
          return structuredClone(selected()[0] ?? null);
        },
        async collect() {
          return structuredClone(selected());
        },
      };
      return query;
    },
  };
  const actionContext = (subject) => ({
    auth: {
      async getUserIdentity() {
        return subject ? { subject } : null;
      },
    },
    async runMutation(_reference, args) {
      // Route by shape: the reserve mutation takes a Clerk id, finalization takes a session id.
      // Reference identity cannot be relied on across generated API accessors in the unit host.
      if (args && typeof args === "object" && "clerkId" in args) {
        return liveMirror.reserveLiveMirrorSession._handler({ db }, args);
      }
      if (args && typeof args === "object" && "sessionId" in args) {
        return liveMirror.finalizeLiveMirrorSession._handler({ db }, args);
      }
      throw new Error("Unexpected test mutation");
    },
  });
  const queryContext = (subject) => ({
    auth: {
      async getUserIdentity() {
        return subject ? { subject } : null;
      },
    },
    db,
  });
  return {
    db,
    put,
    rows: (table) => structuredClone([...tables[table].values()]),
    actionContext,
    queryContext,
  };
}

function stubFetch(implementation) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    return implementation(url, init);
  };
}

const okResponse = () => ({ ok: true, status: 200, async json() { return { apiKey: CLIENT_TOKEN }; } });

async function addSession(f, userId, overrides = {}) {
  return f.db.insert("liveMirrorSessions", {
    userId,
    plan: "pro",
    periodStart,
    periodEnd,
    authorizedSeconds: SESSION_SECONDS,
    model: "lucy-vton-latest",
    status: "authorized",
    createdAt: currentNow,
    updatedAt: currentNow,
    ...overrides,
  });
}

/** Emulates Convex serializing whole mutations while Promise.all starts them together. */
function serialTransaction() {
  let tail = Promise.resolve();
  return (operation) => {
    const current = tail.then(operation, operation);
    tail = current.catch(() => {});
    return current;
  };
}

function dailyAuthorizedTotal(f) {
  return f.rows("systemCounters").reduce((total, row) => total + row.value, 0);
}

test.beforeEach(() => {
  currentNow = now;
  fetchCalls = [];
  mock.method(Date, "now", () => currentNow);
  process.env.DECART_API_KEY = SERVER_KEY;
  process.env.LIVE_MIRROR_SESSION_MAX_SECONDS = String(SESSION_SECONDS);
  process.env.LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_CAP = "1000000";
});

test.afterEach(() => {
  mock.restoreAll();
  delete process.env.DECART_API_KEY;
  delete process.env.LIVE_MIRROR_SESSION_MAX_SECONDS;
  delete process.env.LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_CAP;
  delete globalThis.fetch;
});

// ---------- Plan rules ----------

test("1: free allowance is zero", () => {
  assert.equal(PLANS.free.monthlyLiveMirrorSessions, 0);
});

test("2: pro allowance is two", () => {
  assert.equal(PLANS.pro.monthlyLiveMirrorSessions, 2);
});

test("3: plus allowance is four", () => {
  assert.equal(PLANS.plus.monthlyLiveMirrorSessions, 4);
});

// ---------- Billing period ----------

test("4: paid user without periodStart fails closed", async () => {
  const f = fixture();
  await f.db.patch("paid", { planPeriodStart: undefined });
  await assert.rejects(
    liveMirror.reserveLiveMirrorSession._handler({ db: f.db }, { clerkId: "paid-sub" }),
    errorCode("SUBSCRIPTION_REFRESH_REQUIRED"),
  );
  assert.equal(f.rows("liveMirrorSessions").length, 0);
});

test("5: paid user without periodEnd fails closed", async () => {
  const f = fixture();
  await f.db.patch("paid", { planPeriodEnd: undefined });
  await assert.rejects(
    liveMirror.reserveLiveMirrorSession._handler({ db: f.db }, { clerkId: "paid-sub" }),
    errorCode("SUBSCRIPTION_REFRESH_REQUIRED"),
  );
  assert.equal(f.rows("liveMirrorSessions").length, 0);
});

test("billing refresh persists Clerk periodStart and clears both bounds for free", async () => {
  const f = fixture();
  const paid = await f.db.get("paid");
  assert.equal(
    await reconcileSubscription({ db: f.db }, paid, {
      readStartedAt: currentNow,
      plan: "pro",
      features: [...PLANS.pro.features],
      periodStart,
      periodEnd,
    }),
    true,
  );
  assert.equal((await f.db.get("paid")).planPeriodStart, periodStart);
  assert.equal((await f.db.get("paid")).planPeriodEnd, periodEnd);
  const refreshed = await f.db.get("paid");
  assert.equal(
    await reconcileSubscription({ db: f.db }, refreshed, { readStartedAt: currentNow + 1, plan: "free", features: [] }),
    true,
  );
  const free = await f.db.get("paid");
  assert.equal(free.plan, "free");
  assert.equal(free.planPeriodStart, undefined);
  assert.equal(free.planPeriodEnd, undefined);
});

test("6: same billing period preserves usage", async () => {
  const f = fixture();
  await addSession(f, "paid");
  await addSession(f, "paid");
  const status = await liveMirror.status._handler(f.queryContext("paid-sub"), {});
  assert.equal(status.usedSessions, 2);
  assert.equal(status.remainingSessions, 0);
});

test("7: a new Clerk periodStart starts a fresh allowance without deleting history", async () => {
  const f = fixture();
  await addSession(f, "paid");
  const nextPeriod = periodStart + 30 * DAY_MS;
  currentNow = nextPeriod;
  await f.db.patch("paid", {
    planPeriodStart: nextPeriod,
    planPeriodEnd: nextPeriod + 30 * DAY_MS,
    billingCheckedAt: currentNow,
    dailySpend: { dayKey: dayKey(currentNow), credits: 0 },
  });
  const status = await liveMirror.status._handler(f.queryContext("paid-sub"), {});
  assert.equal(status.usedSessions, 0);
  assert.equal(status.remainingSessions, PLANS.pro.monthlyLiveMirrorSessions);
  stubFetch(okResponse);
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  assert.equal(result.remainingSessions, PLANS.pro.monthlyLiveMirrorSessions - 1);
  assert.equal(f.rows("liveMirrorSessions").length, 2);
});

test("8: upgrade in the same period increases allowance without erasing used sessions", async () => {
  const f = fixture();
  await addSession(f, "paid");
  await f.db.patch("paid", { plan: "plus", features: [...PLANS.plus.features] });
  const status = await liveMirror.status._handler(f.queryContext("paid-sub"), {});
  assert.equal(status.plan, "plus");
  assert.equal(status.monthlyAllowanceSessions, 4);
  assert.equal(status.usedSessions, 1);
  assert.equal(status.remainingSessions, 3);
});

test("9: downgrade in the same period cannot create allowance", async () => {
  const f = fixture();
  await f.db.patch("paid", { plan: "plus", features: [...PLANS.plus.features] });
  await addSession(f, "paid", { plan: "plus" });
  await addSession(f, "paid", { plan: "plus" });
  await addSession(f, "paid", { plan: "plus" });
  await f.db.patch("paid", { plan: "pro", features: [...PLANS.pro.features] });
  const status = await liveMirror.status._handler(f.queryContext("paid-sub"), {});
  assert.equal(status.monthlyAllowanceSessions, 2);
  assert.equal(status.usedSessions, 3);
  assert.equal(status.remainingSessions, 0);
  stubFetch(okResponse);
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
    errorCode("LIVE_MIRROR_LIMIT_REACHED"),
  );
  assert.equal(fetchCalls.length, 0);
});

// ---------- Quota ----------

test("10: first Pro authorization leaves one session", async () => {
  const f = fixture();
  stubFetch(okResponse);
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  assert.equal(result.monthlyAllowanceSessions, 2);
  assert.equal(result.remainingSessions, 1);
  assert.equal(result.sessionSeconds, SESSION_SECONDS);
  assert.equal(typeof result.sessionId, "string");
});

test("11: second Pro authorization leaves zero sessions", async () => {
  const f = fixture();
  stubFetch(okResponse);
  await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  assert.equal(result.remainingSessions, 0);
  assert.equal(fetchCalls.length, 2);
});

test("12: third Pro authorization is denied without contacting Decart", async () => {
  const f = fixture();
  stubFetch(okResponse);
  await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
    errorCode("LIVE_MIRROR_LIMIT_REACHED"),
  );
  assert.equal(fetchCalls.length, 2);
  assert.equal(f.rows("liveMirrorSessions").length, 2);
});

test("13: Plus allows exactly four sessions", async () => {
  const f = fixture({ plan: "plus", features: [...PLANS.plus.features] });
  stubFetch(okResponse);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
    assert.equal(result.monthlyAllowanceSessions, 4);
    assert.equal(result.remainingSessions, 4 - attempt);
  }
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
    errorCode("LIVE_MIRROR_LIMIT_REACHED"),
  );
  assert.equal(fetchCalls.length, 4);
});

test("14: free users are locked before quota and never reserve", async () => {
  const f = fixture();
  stubFetch(okResponse);
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("free-sub"), {}),
    errorCode("FEATURE_LOCKED"),
  );
  assert.equal(fetchCalls.length, 0);
  assert.equal(f.rows("liveMirrorSessions").length, 0);
});

// ---------- Provider success/failure ----------

test("15: provider success consumes the monthly session and daily seconds", async () => {
  const f = fixture();
  stubFetch(okResponse);
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  const [session] = f.rows("liveMirrorSessions");
  assert.equal(session.status, "authorized");
  assert.equal(session.authorizedSeconds, SESSION_SECONDS);
  assert.equal(session.sessionId, undefined);
  assert.equal(result.sessionId, session._id);
  const [counter] = f.rows("systemCounters");
  assert.equal(counter.dayKey, dayKey(currentNow));
  assert.equal(counter.key, "live_mirror_authorized_seconds");
  assert.equal(counter.value, SESSION_SECONDS);
});

test("16: network failure restores monthly and daily reservations", async () => {
  const f = fixture();
  stubFetch(async () => {
    throw new Error("socket hang up");
  });
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
    errorCode("UPSTREAM_FAILED"),
  );
  const [session] = f.rows("liveMirrorSessions");
  assert.equal(session.status, "provider_failed");
  const status = await liveMirror.status._handler(f.queryContext("paid-sub"), {});
  assert.equal(status.usedSessions, 0);
  assert.equal(status.remainingSessions, 2);
  assert.equal(dailyAuthorizedTotal(f), 0);
});

test("17: non-2xx provider response restores reservations", async () => {
  const f = fixture();
  stubFetch(async () => ({ ok: false, status: 500, async json() { return { detail: "boom" }; } }));
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
    errorCode("UPSTREAM_FAILED"),
  );
  assert.equal(f.rows("liveMirrorSessions")[0].status, "provider_failed");
  assert.equal(dailyAuthorizedTotal(f), 0);
});

test("18: malformed token response restores reservations", async () => {
  for (const body of [null, {}, { apiKey: "" }, { apiKey: 42 }]) {
    const f = fixture();
    stubFetch(async () => ({ ok: true, status: 200, async json() { return body; } }));
    await assert.rejects(
      liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
      errorCode("UPSTREAM_FAILED"),
    );
    assert.equal(f.rows("liveMirrorSessions")[0].status, "provider_failed");
    assert.equal(dailyAuthorizedTotal(f), 0);
  }
});

test("19: repeated failure release is idempotent", async () => {
  const f = fixture();
  const reservation = await liveMirror.reserveLiveMirrorSession._handler({ db: f.db }, { clerkId: "paid-sub" });
  const first = await liveMirror.finalizeLiveMirrorSession._handler(
    { db: f.db },
    { sessionId: reservation.sessionId, outcome: "provider_failed" },
  );
  const second = await liveMirror.finalizeLiveMirrorSession._handler(
    { db: f.db },
    { sessionId: reservation.sessionId, outcome: "provider_failed" },
  );
  assert.equal(first.released, true);
  assert.equal(second.released, false);
  assert.equal(f.rows("liveMirrorSessions")[0].status, "provider_failed");
  assert.equal(dailyAuthorizedTotal(f), 0);
  const status = await liveMirror.status._handler(f.queryContext("paid-sub"), {});
  assert.equal(status.usedSessions, 0);
  assert.equal(status.remainingSessions, 2);
});

// ---------- Global daily guard ----------

test("20: authorization increments worst-case seconds", async () => {
  const f = fixture();
  stubFetch(okResponse);
  await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  assert.equal(f.rows("systemCounters")[0].value, SESSION_SECONDS);
});

test("21: provider failure releases global seconds", async () => {
  const f = fixture();
  stubFetch(async () => {
    throw new Error("socket hang up");
  });
  await assert.rejects(liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}));
  assert.equal(dailyAuthorizedTotal(f), 0);
  stubFetch(okResponse);
  await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  assert.equal(f.rows("systemCounters")[0].value, SESSION_SECONDS);
});

test("22: a successful session keeps daily seconds counted", async () => {
  const f = fixture();
  stubFetch(okResponse);
  await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  assert.equal(f.rows("systemCounters")[0].value, SESSION_SECONDS);
  const status = await liveMirror.status._handler(f.queryContext("paid-sub"), {});
  assert.equal(status.usedSessions, 1);
});

test("23: daily cap reached denies with SPEND_KILL_SWITCH before Decart", async () => {
  process.env.LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_CAP = String(SESSION_SECONDS);
  const f = fixture();
  stubFetch(okResponse);
  await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  await assert.rejects(
    liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}),
    errorCode("SPEND_KILL_SWITCH"),
  );
  assert.equal(fetchCalls.length, 1);
  assert.equal(f.rows("liveMirrorSessions").length, 1);
});

test("24: daily counter is isolated by UTC day", async () => {
  const f = fixture();
  stubFetch(okResponse);
  await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  currentNow += DAY_MS;
  await f.db.patch("paid", { billingCheckedAt: currentNow - 1000, dailySpend: { dayKey: dayKey(currentNow), credits: 0 } });
  await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  const counters = f.rows("systemCounters");
  assert.equal(counters.find((row) => row.dayKey === dayKey(now))?.value, SESSION_SECONDS);
  assert.equal(counters.find((row) => row.dayKey === dayKey(currentNow))?.value, SESSION_SECONDS);
});

test("missing daily-cap configuration fails closed without contacting Decart", async () => {
  const f = fixture();
  delete process.env.LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_CAP;
  stubFetch(okResponse);
  await assert.rejects(liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {}));
  assert.equal(fetchCalls.length, 0);
  assert.equal(f.rows("liveMirrorSessions").length, 0);
});

test("invalid daily-cap configuration fails closed", () => {
  for (const raw of ["0", "-5", "1.5", "abc", ""]) {
    assert.throws(() => parseDailyAuthorizedSecondsCap(raw), /LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_CAP/);
  }
  assert.throws(() => parseDailyAuthorizedSecondsCap(undefined), /LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_CAP/);
});

// ---------- Concurrency/idempotency ----------

test("two reservations racing for the final session cannot both exceed the allowance", async () => {
  const f = fixture();
  await addSession(f, "paid");
  const transact = serialTransaction();
  const attempts = await Promise.allSettled([
    transact(() => liveMirror.reserveLiveMirrorSession._handler({ db: f.db }, { clerkId: "paid-sub" })),
    transact(() => liveMirror.reserveLiveMirrorSession._handler({ db: f.db }, { clerkId: "paid-sub" })),
  ]);
  const succeeded = attempts.filter((attempt) => attempt.status === "fulfilled");
  const denied = attempts.filter((attempt) => attempt.status !== "fulfilled");
  assert.equal(succeeded.length, 1);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].reason?.data?.code, "LIVE_MIRROR_LIMIT_REACHED");
  const active = f.rows("liveMirrorSessions").filter((row) => row.status !== "provider_failed");
  assert.equal(active.length, 2);
});

test("a retried release cannot make usage or the global counter negative", async () => {
  const f = fixture();
  const reservation = await liveMirror.reserveLiveMirrorSession._handler({ db: f.db }, { clerkId: "paid-sub" });
  for (let attempt = 0; attempt < 3; attempt++) {
    await liveMirror.finalizeLiveMirrorSession._handler(
      { db: f.db },
      { sessionId: reservation.sessionId, outcome: "provider_failed" },
    );
  }
  const status = await liveMirror.status._handler(f.queryContext("paid-sub"), {});
  assert.equal(status.usedSessions, 0);
  assert.equal(dailyAuthorizedTotal(f), 0);
});

test("an authorized session is never refunded by a late failure release", async () => {
  const f = fixture();
  stubFetch(okResponse);
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  const released = await liveMirror.finalizeLiveMirrorSession._handler(
    { db: f.db },
    { sessionId: result.sessionId, outcome: "provider_failed" },
  );
  assert.equal(released.released, false);
  assert.equal(f.rows("liveMirrorSessions")[0].status, "authorized");
  assert.equal(f.rows("systemCounters")[0].value, SESSION_SECONDS);
});

// ---------- Security ----------

test("25-29: caller-supplied identity, plan, period, usage, and model cannot change the grant", async () => {
  const f = fixture();
  stubFetch(okResponse);
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {
    clerkId: "free-sub",
    plan: "plus",
    periodStart: 1,
    periodEnd: 2,
    sessionSeconds: 99999,
    authorizedSeconds: 1,
    model: "evil-model",
  });
  assert.equal(result.model, "lucy-vton-latest");
  assert.equal(result.sessionSeconds, SESSION_SECONDS);
  assert.equal(result.monthlyAllowanceSessions, 2);
  assert.equal(result.remainingSessions, 1);
  const [call] = fetchCalls;
  assert.deepEqual(JSON.parse(call.body).allowedModels, ["lucy-vton-latest"]);
  assert.equal(JSON.parse(call.body).constraints.realtime.maxSessionDuration, SESSION_SECONDS);
});

test("30: no permanent key or minted token is returned or stored", async () => {
  const f = fixture();
  stubFetch(okResponse);
  const result = await liveMirror.authorizeLiveMirror._handler(f.actionContext("paid-sub"), {});
  assert.deepEqual(
    Object.keys(result).sort(),
    ["expiresIn", "model", "monthlyAllowanceSessions", "remainingSessions", "sessionId", "sessionSeconds", "token"],
  );
  assert.ok(!JSON.stringify(result).includes(SERVER_KEY));
  const stored = JSON.stringify({ sessions: f.rows("liveMirrorSessions"), counters: f.rows("systemCounters") });
  assert.ok(!stored.includes(SERVER_KEY));
  assert.ok(!stored.includes(CLIENT_TOKEN));
});

// ---------- Status ----------

test("40: free status is zero and never touches the provider", async () => {
  const f = fixture();
  stubFetch(okResponse);
  const status = await liveMirror.status._handler(f.queryContext("free-sub"), {});
  assert.deepEqual(status, {
    plan: "free",
    monthlyAllowanceSessions: 0,
    usedSessions: 0,
    remainingSessions: 0,
    sessionMaxSeconds: SESSION_SECONDS,
  });
  assert.equal(fetchCalls.length, 0);
  assert.equal(f.rows("liveMirrorSessions").length, 0);
});

test("41: pro and plus status reflect the ledger", async () => {
  const freeFixture = fixture();
  assert.equal((await liveMirror.status._handler(freeFixture.queryContext("free-sub"), {})).remainingSessions, 0);
  const proFixture = fixture();
  await addSession(proFixture, "paid");
  const pro = await liveMirror.status._handler(proFixture.queryContext("paid-sub"), {});
  assert.equal(pro.monthlyAllowanceSessions, 2);
  assert.equal(pro.usedSessions, 1);
  assert.equal(pro.remainingSessions, 1);
  assert.equal(pro.sessionMaxSeconds, SESSION_SECONDS);
  assert.equal(pro.periodEnd, periodEnd);
  const plusFixture = fixture({ plan: "plus", features: [...PLANS.plus.features] });
  const plus = await liveMirror.status._handler(plusFixture.queryContext("paid-sub"), {});
  assert.equal(plus.monthlyAllowanceSessions, 4);
  assert.equal(plus.remainingSessions, 4);
});

test("42: status query never mints a provider token", async () => {
  const f = fixture();
  stubFetch(okResponse);
  await addSession(f, "paid");
  const before = f.rows("liveMirrorSessions");
  await liveMirror.status._handler(f.queryContext("paid-sub"), {});
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(f.rows("liveMirrorSessions"), before);
  assert.equal(dailyAuthorizedTotal(f), 0);
});

test("paid status without a billing period fails closed", async () => {
  const f = fixture();
  await f.db.patch("paid", { planPeriodStart: undefined });
  await assert.rejects(
    liveMirror.status._handler(f.queryContext("paid-sub"), {}),
    errorCode("SUBSCRIPTION_REFRESH_REQUIRED"),
  );
});
