import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { assertOwner, requireUser } from "./lib/auth";
import { listActive as listActiveJobs, readStepEstimates } from "./model/jobs";
import { vJobStatus, vJobStep, vJobType, vReservation } from "./shared/validators";

export const vJob = v.object({
  _id: v.id("jobs"),
  type: vJobType,
  status: vJobStatus,
  steps: v.array(vJobStep),
  progress: v.number(),
  reservation: vReservation,
  refunds: vReservation,
  uploadId: v.optional(v.id("uploads")),
  outfitIds: v.optional(v.array(v.id("outfits"))),
  resultIds: v.array(v.string()),
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
});

export function toJobView(job: Doc<"jobs">) {
  return {
    _id: job._id,
    type: job.type,
    status: job.status,
    steps: job.steps,
    progress: job.progress,
    reservation: job.reservation,
    refunds: job.refunds,
    uploadId: job.uploadId,
    outfitIds: job.outfitIds,
    resultIds: job.resultIds,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

export const get = query({
  args: { jobId: v.id("jobs") },
  returns: v.union(vJob, v.null()),
  handler: async (ctx, { jobId }) => {
    const user = await requireUser(ctx);
    const job = await ctx.db.get(jobId);
    if (!job) return null;
    return toJobView(assertOwner(job, user, "job"));
  },
});

export const listActive = query({
  args: {},
  returns: v.array(vJob),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const jobs = await listActiveJobs(ctx, user._id);
    return jobs.map(toJobView);
  },
});

/**
 * Running average duration (ms) per step prefix — "detect", "extract", "render". The job stepper
 * turns it into "about N s left"; an unknown prefix simply has no estimate.
 */
export const stepEstimates = query({
  args: {},
  returns: v.record(v.string(), v.number()),
  handler: async (ctx) => {
    await requireUser(ctx);
    return readStepEstimates(ctx);
  },
});

export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(vJob),
  handler: async (ctx, { limit }) => {
    const user = await requireUser(ctx);
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(Math.min(limit ?? 20, 100));
    return jobs.map(toJobView);
  },
});
