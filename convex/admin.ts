import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { toJobView, vJob } from "./jobs";
import { requireAdmin } from "./lib/auth";
import { appError } from "./lib/errors";
import {
  overview as adminOverview,
  recentJobs as adminRecentJobs,
  retryJob as adminRetryJob,
  topSpenders as adminTopSpenders,
} from "./model/admin";
import { adminAdjust, refund } from "./model/credits";
import { getJob } from "./model/jobs";

export const vWindow = v.union(v.literal(1), v.literal(7), v.literal(30));

/** Money in vs. money out for the window, all from the ledger and stored token costs. */
export const overview = query({
  args: { days: vWindow },
  returns: v.object({
    days: vWindow,
    users: v.number(),
    newUsers: v.number(),
    creditsSold: v.number(),
    creditsGranted: v.number(),
    creditsSpent: v.number(),
    creditsRefunded: v.number(),
    revenueUsd: v.number(),
    cogsUsd: v.number(),
    /** Fraction, not percent: 0.45 = 45%. */
    grossMargin: v.number(),
    rendersDone: v.number(),
    itemsExtracted: v.number(),
    jobsFailed: v.number(),
    jobsRunning: v.number(),
    todayCreditsReserved: v.number(),
    dailySpendCapUsd: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, { days }) => {
    await requireAdmin(ctx);
    return adminOverview(ctx, days, Date.now());
  },
});

export const recentJobs = query({
  args: {
    status: v.optional(v.union(v.literal("failed"), v.literal("partial"), v.literal("running"))),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.object({ job: vJob, userEmail: v.optional(v.string()), userName: v.optional(v.string()) })),
  handler: async (ctx, { status, limit }) => {
    await requireAdmin(ctx);
    const rows = await adminRecentJobs(ctx, status, Math.min(limit ?? 25, 100));
    return rows.map((row) => ({ job: toJobView(row.job), userEmail: row.userEmail, userName: row.userName }));
  },
});

/** `truncated` means the ledger window was longer than the read cap, so the ranking is a sample. */
export const topSpenders = query({
  args: { days: vWindow, limit: v.optional(v.number()) },
  returns: v.object({
    rows: v.array(
      v.object({
        userId: v.id("users"),
        email: v.optional(v.string()),
        name: v.optional(v.string()),
        plan: v.string(),
        creditsSpent: v.number(),
        cogsUsd: v.number(),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { days, limit }) => {
    await requireAdmin(ctx);
    return adminTopSpenders(ctx, days, Math.min(limit ?? 10, 50), Date.now());
  },
});

/**
 * Re-runs what failed on a job: an ingest job re-extracts its upload's `failed` / `needsCredits`
 * items, a render job re-queues its failed images. Credits are reserved from THAT user's balance,
 * exactly as if they had retried it themselves — refund with `refundJob` if that isn't intended.
 */
export const retryJob = mutation({
  args: { jobId: v.id("jobs") },
  returns: v.id("jobs"),
  handler: async (ctx, { jobId }) => {
    await requireAdmin(ctx);
    return adminRetryJob(ctx, jobId);
  },
});

/** Refunds whatever is still refundable on a job (or `amount` of it) with an audit note. */
export const refundJob = mutation({
  args: { jobId: v.id("jobs"), amount: v.optional(v.number()), note: v.string() },
  returns: v.object({ refunded: v.number() }),
  handler: async (ctx, { jobId, amount, note }) => {
    const admin = await requireAdmin(ctx);
    const job = await getJob(ctx, jobId);
    const outstanding = job.reservation.plan + job.reservation.pack - (job.refunds.plan + job.refunds.pack);
    const requested = amount === undefined ? outstanding : Math.min(Math.trunc(amount), outstanding);
    if (requested <= 0) return { refunded: 0 };
    const refunded = await refund(ctx, job, requested, `${note} (admin ${admin.email ?? admin.clerkId})`);
    return { refunded };
  },
});

/** Manual credit adjustment for support cases. */
export const adjustCredits = mutation({
  args: {
    userId: v.id("users"),
    delta: v.number(),
    bucket: v.union(v.literal("plan"), v.literal("pack")),
    note: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { userId, delta, bucket, note }) => {
    const admin = await requireAdmin(ctx);
    const target = await ctx.db.get(userId);
    if (!target) throw appError("NOT_FOUND", "That user doesn't exist.");
    await adminAdjust(
      ctx,
      target,
      Math.trunc(delta),
      bucket,
      `admin:${Date.now()}:${userId}`,
      `${note} (admin ${admin.email ?? admin.clerkId})`,
    );
    return null;
  },
});
