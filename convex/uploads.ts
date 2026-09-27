import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { vJob, toJobView } from "./jobs";
import { assertOwner, requireOnboarded, requireUser } from "./lib/auth";
import { appError } from "./lib/errors";
import { listByUpload } from "./model/items";
import {
  confirmSelection as confirmSelectionDocs,
  createBatch as createBatchDocs,
  listBatch as listBatchDocs,
  startExtractionJob,
  toUploadView,
} from "./model/uploads";
import { bumpUsageCounter } from "./model/users";
import { LIMITS } from "./shared/credits";
import { vUploadView } from "./views";

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requireUser(ctx);
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * Registers a batch of uploaded photos: one `uploads` row + one ingest job per photo,
 * starts the ingest workflow for each, returns the ids so the UI can subscribe.
 * Enforces LIMITS.maxPhotosPerUpload and the detect-per-day counter.
 */
export const createBatch = mutation({
  args: {
    files: v.array(
      v.object({ storageId: v.id("_storage"), fileName: v.string(), mimeType: v.string(), sizeBytes: v.number() }),
    ),
  },
  returns: v.object({
    batchId: v.string(),
    uploads: v.array(v.object({ uploadId: v.id("uploads"), jobId: v.id("jobs") })),
  }),
  handler: async (ctx, { files }) => {
    const user = await requireOnboarded(ctx);
    await bumpUsageCounter(ctx, user._id, "detect", LIMITS.detectCallsPerDay, files.length);
    return createBatchDocs(ctx, user, files);
  },
});

/** Uploads in a batch with their live job, for the add-clothes tiles. */
export const listBatch = query({
  args: { batchId: v.string() },
  returns: v.array(v.object({ upload: vUploadView, job: v.union(vJob, v.null()) })),
  handler: async (ctx, { batchId }) => {
    const user = await requireUser(ctx);
    const uploads = await listBatchDocs(ctx, user._id, batchId);
    return Promise.all(
      uploads.map(async (upload) => {
        const job = upload.jobId ? await ctx.db.get(upload.jobId) : null;
        return { upload: await toUploadView(ctx, upload), job: job ? toJobView(job) : null };
      }),
    );
  },
});

export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({ upload: vUploadView, job: v.union(vJob, v.null()) })),
  handler: async (ctx, { limit }) => {
    const user = await requireUser(ctx);
    const uploads = await ctx.db
      .query("uploads")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(Math.min(limit ?? 20, 100));
    return Promise.all(
      uploads.map(async (upload) => {
        const job = upload.jobId ? await ctx.db.get(upload.jobId) : null;
        return { upload: await toUploadView(ctx, upload), job: job ? toJobView(job) : null };
      }),
    );
  },
});

/** Photos that completed their free scan and still need the owner's choice. */
export const needsReview = query({
  args: {},
  returns: v.array(v.object({ upload: vUploadView, job: v.union(vJob, v.null()) })),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const uploads = await ctx.db
      .query("uploads")
      .withIndex("by_user_status", (q) => q.eq("userId", user._id).eq("status", "awaiting_selection"))
      .order("desc")
      .take(100);
    return Promise.all(
      uploads.map(async (upload) => {
        const job = upload.jobId ? await ctx.db.get(upload.jobId) : null;
        return { upload: await toUploadView(ctx, upload), job: job ? toJobView(job) : null };
      }),
    );
  },
});

export const confirmSelection = mutation({
  args: { uploadId: v.id("uploads"), indices: v.array(v.number()) },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, { uploadId, indices }) => {
    const user = await requireOnboarded(ctx);
    return { jobId: await confirmSelectionDocs(ctx, user, uploadId, indices) };
  },
});

/** Re-runs extraction for this upload's `needsCredits` items when credits are available. */
export const resume = mutation({
  args: { uploadId: v.id("uploads") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, { uploadId }) => {
    const user = await requireOnboarded(ctx);
    const upload = assertOwner(await ctx.db.get(uploadId), user, "upload");
    if (upload.status === "extracting") throw appError("ITEM_BUSY", "Wait for this photo's current import to finish.");
    const pending = (await listByUpload(ctx, upload._id)).filter((item) => item.status === "needsCredits");
    if (pending.length === 0)
      throw appError("INVALID_INPUT", "Everything from this photo is already in your wardrobe.");
    const jobId = await startExtractionJob(
      ctx,
      user,
      pending.map((item) => item._id),
      upload._id,
    );
    return { jobId };
  },
});

/** Deletes the source photo. Items already extracted are kept. */
export const remove = mutation({
  args: { uploadId: v.id("uploads") },
  returns: v.null(),
  handler: async (ctx, { uploadId }) => {
    const user = await requireUser(ctx);
    const upload = assertOwner(await ctx.db.get(uploadId), user, "upload");
    if (["queued", "detecting", "extracting"].includes(upload.status)) {
      throw appError("ITEM_BUSY", "Wait for this photo's scan or import to finish before removing it.");
    }
    await ctx.storage.delete(upload.storageId);
    for (const item of await listByUpload(ctx, upload._id)) {
      await ctx.db.patch(item._id, { uploadId: undefined, updatedAt: Date.now() });
    }
    await ctx.db.delete("uploads", upload._id);
    return null;
  },
});
