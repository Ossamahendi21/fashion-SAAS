import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { dayKey } from "../shared/credits";

type Ctx = QueryCtx | MutationCtx;

export type DailyStatsCounters = Omit<Doc<"dailyStats">, "_id" | "_creationTime" | "dayKey">;
export type DailyStatsDelta = Partial<DailyStatsCounters>;

export const EMPTY_DAILY_STATS: DailyStatsCounters = {
  creditsSold: 0,
  creditsGranted: 0,
  creditsSpent: 0,
  creditsRefunded: 0,
  revenueUsd: 0,
  cogsUsd: 0,
  rendersDone: 0,
  itemsExtracted: 0,
  jobsFailed: 0,
  newUsers: 0,
};

const COUNTER_KEYS = Object.keys(EMPTY_DAILY_STATS) as Array<keyof DailyStatsCounters>;

/**
 * Adds `delta` to the aggregate row for the day of `now` (creating it on first write). Call it from the
 * same mutation that changes the underlying rows so the dashboard never drifts from the ledger.
 */
export async function bumpDailyStats(
  ctx: MutationCtx,
  delta: DailyStatsDelta,
  now: number = Date.now(),
): Promise<void> {
  const key = dayKey(now);
  const existing = await ctx.db
    .query("dailyStats")
    .withIndex("by_day", (q) => q.eq("dayKey", key))
    .unique();
  const base: DailyStatsCounters = existing ?? EMPTY_DAILY_STATS;
  const next: DailyStatsCounters = { ...EMPTY_DAILY_STATS };
  for (const counter of COUNTER_KEYS) next[counter] = base[counter] + (delta[counter] ?? 0);
  if (existing) await ctx.db.patch(existing._id, next);
  else await ctx.db.insert("dailyStats", { dayKey: key, ...next });
}

/** One row per day in the window (missing days are zero), oldest first. Bounded by `days`, never a scan. */
export async function readDailyStats(ctx: Ctx, days: number, now: number = Date.now()): Promise<DailyStatsCounters[]> {
  const rows: DailyStatsCounters[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = dayKey(now - offset * 24 * 60 * 60 * 1000);
    const row = await ctx.db
      .query("dailyStats")
      .withIndex("by_day", (q) => q.eq("dayKey", key))
      .unique();
    rows.push(row ?? EMPTY_DAILY_STATS);
  }
  return rows;
}

export function sumDailyStats(rows: DailyStatsCounters[]): DailyStatsCounters {
  const total: DailyStatsCounters = { ...EMPTY_DAILY_STATS };
  for (const row of rows) for (const counter of COUNTER_KEYS) total[counter] += row[counter];
  return total;
}

type SystemCounterKey = Doc<"systemCounters">["key"];

/** All-time counters use the empty day key; daily ones (the spend kill switch) use `dayKey(now)`. */
export async function bumpSystemCounter(
  ctx: MutationCtx,
  key: SystemCounterKey,
  delta: number,
  day: string = "",
): Promise<number> {
  const existing = await ctx.db
    .query("systemCounters")
    .withIndex("by_day_key", (q) => q.eq("dayKey", day).eq("key", key))
    .unique();
  const value = Math.max(0, (existing?.value ?? 0) + delta);
  if (existing) await ctx.db.patch(existing._id, { value });
  else await ctx.db.insert("systemCounters", { dayKey: day, key, value });
  return value;
}

export async function readSystemCounter(ctx: Ctx, key: SystemCounterKey, day: string = ""): Promise<number> {
  const existing = await ctx.db
    .query("systemCounters")
    .withIndex("by_day_key", (q) => q.eq("dayKey", day).eq("key", key))
    .unique();
  return existing?.value ?? 0;
}
