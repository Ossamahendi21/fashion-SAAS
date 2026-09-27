import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/convex/model/credits.ts") && specifier === "../lib/env") {
      return {
        url: `data:text/javascript,${encodeURIComponent("export function envNumber(_key, fallback) { return fallback; }")}`,
        shortCircuit: true,
      };
    }
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

const { getBalance, grantPlan, grantSignupBonus, reconcileSubscription, reserve, refund } =
  await import("../convex/model/credits.ts");
const { dayKey, PLANS } = await import("../convex/shared/credits.ts");

const now = Date.parse("2026-09-17T12:00:00Z");
const periodStart = now - 60_000;
const periodEnd = now + 30 * 24 * 60 * 60 * 1000;

test.beforeEach(() => mock.method(Date, "now", () => now));
test.afterEach(() => mock.restoreAll());

function fixture(overrides = {}) {
  const tables = new Map();
  let nextId = 0;
  const rowsFor = (table) => {
    if (!tables.has(table)) tables.set(table, new Map());
    return tables.get(table);
  };
  const put = (table, id, fields) => rowsFor(table).set(id, structuredClone({ ...fields, _id: id }));
  const find = (id) => [...tables.values()].find((rows) => rows.has(id));
  put("users", "user", {
    clerkId: "clerk-credit-fixture",
    plan: "pro",
    planCredits: 7,
    packCredits: 62,
    features: [...PLANS.pro.features],
    planPeriodEnd: periodEnd,
    billingCheckedAt: now - 1000,
    dailySpend: { dayKey: dayKey(now), credits: 0 },
    ...overrides,
  });
  put("jobs", "job", { userId: "user", reservation: { plan: 0, pack: 0 }, refunds: { plan: 0, pack: 0 } });
  put("creditLedger", "legacy-purchase", {
    userId: "user",
    delta: 50,
    bucket: "pack",
    kind: "topup",
    ref: "stripe:legacy-checkout",
    balanceAfter: 50,
    createdAt: now - 60 * 24 * 60 * 60 * 1000,
  });
  const db = {
    async get(id) {
      return structuredClone(find(id)?.get(id) ?? null);
    },
    async patch(id, fields) {
      const rows = find(id);
      assert.ok(rows, `Missing fixture row: ${id}`);
      rows.set(id, { ...rows.get(id), ...structuredClone(fields) });
    },
    async insert(table, fields) {
      const id = `${table}-${++nextId}`;
      put(table, id, fields);
      return id;
    },
    query(table) {
      const filters = [];
      const selected = () =>
        [...rowsFor(table).values()].filter((row) => filters.every(([field, value]) => row[field] === value));
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
      };
      return query;
    },
  };
  return {
    ctx: { db },
    user: () => db.get("user"),
    job: () => db.get("job"),
    rows: (table) => structuredClone([...rowsFor(table).values()]),
  };
}

test("a Clerk billing-cycle grant resets only plan credits and preserves legacy purchase history", async () => {
  const f = fixture();
  const history = f.rows("creditLedger");
  const user = await f.user();
  assert.equal(await grantPlan(f.ctx, user, "pro", "clerk:renewal", periodEnd), true);
  const balance = getBalance(await f.user());
  assert.equal(balance.planCredits, PLANS.pro.monthlyCredits);
  assert.equal(balance.packCredits, 62);
  assert.equal(balance.total, PLANS.pro.monthlyCredits + 62);
  assert.deepEqual(f.rows("creditLedger").slice(0, history.length), history);
  assert.deepEqual(
    f
      .rows("creditLedger")
      .slice(history.length)
      .map(({ bucket, kind, delta }) => ({ bucket, kind, delta })),
    [
      { bucket: "plan", kind: "plan_reset", delta: -7 },
      { bucket: "plan", kind: "plan_grant", delta: PLANS.pro.monthlyCredits },
    ],
  );
  const appliedLedger = f.rows("creditLedger");
  assert.equal(await grantPlan(f.ctx, user, "pro", "clerk:renewal", periodEnd), false);
  assert.deepEqual(f.rows("creditLedger"), appliedLedger);
  assert.equal(f.rows("dailyStats")[0].creditsGranted, PLANS.pro.monthlyCredits);
});

test("welcome credits are granted once per identity and survive upgrading to a Clerk plan", async () => {
  const f = fixture({ plan: "free", planCredits: 0, packCredits: 0, features: [], planPeriodEnd: undefined });
  const user = await f.user();
  assert.equal(await grantSignupBonus(f.ctx, user), true);
  assert.equal(await grantSignupBonus(f.ctx, user), false);
  assert.equal(await grantSignupBonus(f.ctx, await f.user()), false);
  assert.equal(getBalance(await f.user()).total, PLANS.free.signupCredits);
  assert.equal(
    await reconcileSubscription(f.ctx, await f.user(), {
      readStartedAt: now,
      plan: "plus",
      features: [...PLANS.plus.features],
      periodStart,
      periodEnd,
    }),
    true,
  );
  assert.equal(getBalance(await f.user()).packCredits, PLANS.free.signupCredits);
  assert.equal(getBalance(await f.user()).planCredits, PLANS.plus.monthlyCredits);
  assert.equal(f.rows("creditLedger").filter((line) => line.kind === "signup_bonus").length, 1);
});

test("repeated Clerk reads of the same billing period do not replenish spent plan credits", async () => {
  const f = fixture();
  const snapshot = {
    readStartedAt: now,
    plan: "pro",
    features: [...PLANS.pro.features],
    periodStart,
    periodEnd,
  };
  await reconcileSubscription(f.ctx, await f.user(), snapshot);
  await reserve(f.ctx, await f.user(), 4, "job");
  const ledger = f.rows("creditLedger");
  assert.equal(await reconcileSubscription(f.ctx, await f.user(), { ...snapshot, readStartedAt: now + 1 }), false);
  assert.equal(getBalance(await f.user()).planCredits, PLANS.pro.monthlyCredits - 4);
  assert.equal(getBalance(await f.user()).packCredits, 62);
  assert.deepEqual(f.rows("creditLedger"), ledger);
});

test("expired subscriptions leave non-expiring credits available after Clerk confirms Free", async () => {
  const f = fixture({ planPeriodEnd: now - 1 });
  const expired = getBalance(await f.user());
  assert.equal(expired.plan, "free");
  assert.equal(expired.planCredits, 0);
  assert.equal(expired.packCredits, 62);
  assert.equal(expired.total, 62);
  await reconcileSubscription(f.ctx, await f.user(), { readStartedAt: now, plan: "free", features: [] });
  const result = await reserve(f.ctx, await f.user(), 4, "job");
  assert.equal(result.granted, 4);
  assert.deepEqual(result.reservation, { plan: 0, pack: 4 });
  assert.equal(getBalance(await f.user()).total, 58);
  assert.equal(f.rows("creditLedger").filter((line) => line.kind === "topup").length, 1);
});

test("stale Clerk reads cannot revoke a newer subscription or change credit balances", async () => {
  const f = fixture();
  await reconcileSubscription(f.ctx, await f.user(), {
    readStartedAt: now,
    plan: "plus",
    features: [...PLANS.plus.features],
    periodStart,
    periodEnd,
  });
  const before = await f.user();
  const ledger = f.rows("creditLedger");
  assert.equal(
    await reconcileSubscription(f.ctx, await f.user(), { readStartedAt: now - 1, plan: "free", features: [] }),
    false,
  );
  assert.deepEqual(await f.user(), before);
  assert.deepEqual(f.rows("creditLedger"), ledger);
});

test("reservations spend plan credits first and retries cannot charge either bucket twice", async () => {
  const f = fixture();
  const user = await f.user();
  const expected = { granted: 10, shortfall: 0, reservation: { plan: 7, pack: 3 } };
  assert.deepEqual(await reserve(f.ctx, user, 10, "job"), expected);
  assert.deepEqual(await reserve(f.ctx, user, 10, "job"), expected);
  assert.deepEqual(await reserve(f.ctx, await f.user(), 10, "job"), expected);
  assert.equal(getBalance(await f.user()).planCredits, 0);
  assert.equal(getBalance(await f.user()).packCredits, 59);
  assert.equal((await f.user()).dailySpend.credits, 10);
  assert.equal(f.rows("creditLedger").filter((line) => line.kind === "reserve").length, 2);
  assert.equal(f.rows("dailyStats")[0].creditsSpent, 10);
});

test("failed-job refunds restore non-expiring credits first and duplicate refunds do not mint credits", async () => {
  const f = fixture();
  await reserve(f.ctx, await f.user(), 10, "job");
  const job = await f.job();
  assert.equal(await refund(f.ctx, job, 2, "Failed image"), 2);
  assert.equal(getBalance(await f.user()).packCredits, 61);
  assert.equal(getBalance(await f.user()).planCredits, 0);
  assert.equal(await refund(f.ctx, job, 2, "Repeated delivery"), 0);
  assert.equal(await refund(f.ctx, await f.job(), 8, "Remaining failed images"), 8);
  assert.equal(await refund(f.ctx, await f.job(), 10, "Already settled"), 0);
  assert.equal(getBalance(await f.user()).packCredits, 62);
  assert.equal(getBalance(await f.user()).planCredits, 7);
  assert.equal((await f.user()).dailySpend.credits, 0);
  assert.deepEqual((await f.job()).refunds, { plan: 7, pack: 3 });
  assert.equal(f.rows("dailyStats")[0].creditsRefunded, 10);
  assert.equal(f.rows("systemCounters")[0].value, 0);
});
