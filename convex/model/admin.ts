import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { optionalEnv } from "../lib/env";
import { appError } from "../lib/errors";
import { dayKey, UNIT_ECONOMICS } from "../shared/credits";
import { JOB_STATUSES, type JobStatus } from "../shared/jobs";
import { listByUpload } from "./items";
import { getJob } from "./jobs";
import { listByJob, startRenderJob } from "./renders";
import { readDailyStats, readSystemCounter, sumDailyStats } from "./stats";
import { startExtractionJob } from "./uploads";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many active jobs the dashboard is willing to count; beyond this the number is "500+". */
const ACTIVE_JOB_SCAN_LIMIT = 500;
/** Ledger lines the top-spender leaderboard reads before it admits to being truncated. */
const TOP_SPENDER_LEDGER_LIMIT = 5000;

export type AdminWindow = 1 | 7 | 30;

export type AdminOverview = {
  days: AdminWindow;
  users: number;
  newUsers: number;
  creditsSold: number;
  creditsGranted: number;
  creditsSpent: number;
  creditsRefunded: number;
  revenueUsd: number;
  cogsUsd: number;
  /** Fraction, not percent: 0.45 = 45%. */
  grossMargin: number;
  rendersDone: number;
  itemsExtracted: number;
  jobsFailed: number;
  jobsRunning: number;
  todayCreditsReserved: number;
  dailySpendCapUsd: number | null;
};

/**
 * Money in vs. money out, read from the per-day aggregates the credit, item and render mutations
 * keep up to date (`dailyStats`) plus two counters. Nothing here scans users, the ledger or items.
 */
export async function overview(ctx: QueryCtx, days: AdminWindow, now: number): Promise<AdminOverview> {
  const totals = sumDailyStats(await readDailyStats(ctx, days, now));
  const [users, todayCreditsReserved, jobsRunning] = await Promise.all([
    readSystemCounter(ctx, "users_total"),
    readSystemCounter(ctx, "credits_reserved", dayKey(now)),
    countActiveJobs(ctx),
  ]);

  const capRaw = optionalEnv("MAX_DAILY_SPEND_USD");
  const cap = capRaw === undefined ? Number.NaN : Number(capRaw);
  const revenueUsd = totals.revenueUsd;
  const cogsUsd = totals.cogsUsd;

  return {
    days,
    users,
    newUsers: totals.newUsers,
    creditsSold: totals.creditsSold,
    creditsGranted: totals.creditsGranted,
    creditsSpent: totals.creditsSpent,
    creditsRefunded: totals.creditsRefunded,
    revenueUsd: round2(revenueUsd),
    cogsUsd: round2(cogsUsd),
    grossMargin: revenueUsd > 0 ? round4((revenueUsd - cogsUsd) / revenueUsd) : 0,
    rendersDone: totals.rendersDone,
    itemsExtracted: totals.itemsExtracted,
    jobsFailed: totals.jobsFailed,
    jobsRunning,
    todayCreditsReserved,
    dailySpendCapUsd: Number.isFinite(cap) ? cap : null,
  };
}

/** Queued + running jobs across all users, bounded by ACTIVE_JOB_SCAN_LIMIT per status. */
export async function countActiveJobs(ctx: QueryCtx): Promise<number> {
  const active: readonly JobStatus[] = ["queued", "running"];
  const lists = await Promise.all(
    active.map((status) =>
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(ACTIVE_JOB_SCAN_LIMIT),
    ),
  );
  return lists.reduce((sum, list) => sum + list.length, 0);
}

export type AdminJobRow = { job: Doc<"jobs">; userEmail?: string; userName?: string };

export async function recentJobs(
  ctx: QueryCtx,
  filter: "failed" | "partial" | "running" | undefined,
  limit: number,
): Promise<AdminJobRow[]> {
  const statuses: readonly JobStatus[] =
    filter === "running" ? ["queued", "running"] : filter ? [filter] : JOB_STATUSES;
  const lists = await Promise.all(
    statuses.map((status) =>
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(limit),
    ),
  );
  const jobs = lists
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  const users = await hydrateUsers(
    ctx,
    jobs.map((job) => job.userId),
  );
  return jobs.map((job) => {
    const user = users.get(job.userId);
    return { job, userEmail: user?.email, userName: user?.name };
  });
}

export type TopSpender = {
  userId: Id<"users">;
  email?: string;
  name?: string;
  plan: string;
  creditsSpent: number;
  cogsUsd: number;
};

export type TopSpenders = { rows: TopSpender[]; truncated: boolean };

/**
 * Who spent the most in the window. This is the one admin read that still walks the ledger, so it
 * is capped: past TOP_SPENDER_LEDGER_LIMIT lines the ranking is reported as `truncated`.
 */
export async function topSpenders(ctx: QueryCtx, days: AdminWindow, limit: number, now: number): Promise<TopSpenders> {
  const since = now - days * DAY_MS;
  const ledger = await ctx.db
    .query("creditLedger")
    .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
    .take(TOP_SPENDER_LEDGER_LIMIT);

  const spent = new Map<Id<"users">, number>();
  for (const line of ledger) {
    if (line.kind !== "reserve") continue;
    spent.set(line.userId, (spent.get(line.userId) ?? 0) + -line.delta);
  }

  const ranked = [...spent.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const users = await hydrateUsers(
    ctx,
    ranked.map(([userId]) => userId),
  );
  const rows = ranked.map(([userId, creditsSpent]) => {
    const user = users.get(userId);
    return {
      userId,
      email: user?.email,
      name: user?.name,
      plan: user?.plan ?? "free",
      creditsSpent,
      // Per-user COGS would mean reading every render and item in the window; estimate it from the
      // measured cost per credit instead. Exact COGS lives in the window totals (`dailyStats`).
      cogsUsd: round2(creditsSpent * UNIT_ECONOMICS.cogsUsdPerCredit),
    };
  });
  return { rows, truncated: ledger.length >= TOP_SPENDER_LEDGER_LIMIT };
}

/**
 * Re-runs the failed half of a job for its owner. Credits come from THAT user's balance exactly as
 * if they had pressed Retry themselves (an ingest retry reserves one credit per item, a render
 * retry one per image); refund separately with `admin.refundJob` if that is not wanted.
 */
export async function retryJob(ctx: MutationCtx, jobId: Id<"jobs">): Promise<Id<"jobs">> {
  const job = await getJob(ctx, jobId);
  const user = await ctx.db.get(job.userId);
  if (!user) throw appError("NOT_FOUND", "The owner of that job no longer exists.");

  if (job.type === "ingest") {
    if (!job.uploadId) throw appError("INVALID_INPUT", "That job has no upload to retry.");
    const items = await listByUpload(ctx, job.uploadId);
    const retryable = items.filter((item) => item.status === "failed" || item.status === "needsCredits");
    if (retryable.length === 0) throw appError("INVALID_INPUT", "Nothing on that upload needs extracting.");
    return startExtractionJob(
      ctx,
      user,
      retryable.map((item) => item._id),
      job.uploadId,
    );
  }

  const renders = await listByJob(ctx, job._id);
  const failed = renders.filter((render) => render.status === "failed");
  const first = failed[0];
  if (!first) throw appError("INVALID_INPUT", "That job has no failed images to retry.");

  const perOutfit = new Map<Id<"outfits">, number>();
  for (const render of failed) perOutfit.set(render.outfitId, (perOutfit.get(render.outfitId) ?? 0) + 1);
  const count = Math.max(...perOutfit.values());

  const result = await startRenderJob(ctx, user, {
    outfitIds: [...perOutfit.keys()],
    avatarId: first.avatarId,
    count,
    quality: first.quality,
  });
  return result.jobId;
}

async function hydrateUsers(ctx: QueryCtx, userIds: Id<"users">[]): Promise<Map<Id<"users">, Doc<"users">>> {
  const unique = [...new Set(userIds)];
  const docs = await Promise.all(unique.map((userId) => ctx.db.get(userId)));
  const map = new Map<Id<"users">, Doc<"users">>();
  for (const doc of docs) if (doc) map.set(doc._id, doc);
  return map;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
