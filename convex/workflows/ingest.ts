import { vResultValidator, vWorkflowId, type WorkflowCtx } from "@convex-dev/workflow";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { refund } from "../model/credits";
import { listByUpload, markItemFailed } from "../model/items";
import { completeJob, getJob, setStep } from "../model/jobs";
import { recordCandidates as recordCandidateDocs } from "../model/uploads";
import { INGEST_STEPS, isTerminalJobStatus, type JobStatus } from "../shared/jobs";
import { vDetectedItem } from "../shared/validators";
import { workflow } from "./manager";

/**
 * New uploads stop after a free scan. Selection starts a separate extraction workflow.
 * ingestUpload remains unchanged so already-running legacy workflows can replay their original steps.
 */

export type IngestOutcome = { extracted: number; failed: number; skipped: number };

/**
 * Extractions in flight inside one ingest job. The workpool's parallelism is global, so a single
 * 12-item photo must not take the whole pool; the chunks are fixed-size, which keeps the handler
 * deterministic (the same `step.runAction` calls in the same order on every replay).
 */
const MAX_PARALLEL_EXTRACTIONS = 4;

const vIngestOutcome = v.object({ extracted: v.number(), failed: v.number(), skipped: v.number() });

type SettledStatus = Extract<JobStatus, "done" | "partial" | "failed" | "cancelled">;
type UploadStatus = Doc<"uploads">["status"];

export const scanUpload = workflow
  .define({ args: { uploadId: v.id("uploads"), jobId: v.id("jobs") }, returns: v.number() })
  .handler(async (step, args): Promise<number> => {
    await step.runMutation(internal.ai.pipeline.beginIngest, args);
    const detected = await step.runAction(internal.ai.openai.detectItems, args, { retry: true });
    return step.runMutation(internal.workflows.ingest.recordCandidates, { ...args, items: detected });
  });

export const recordCandidates = internalMutation({
  args: { uploadId: v.id("uploads"), jobId: v.id("jobs"), items: v.array(vDetectedItem) },
  returns: v.number(),
  handler: recordCandidateDocs,
});

export const onScanComplete = internalMutation({
  args: { workflowId: vWorkflowId, result: vResultValidator, context: v.object({ jobId: v.id("jobs") }) },
  returns: v.null(),
  handler: async (ctx, { result, context }): Promise<null> => {
    const job = await getJob(ctx, context.jobId);
    if (isTerminalJobStatus(job.status)) return null;
    if (result.kind === "success") return null;
    if (job.uploadId) {
      const upload = await ctx.db.get(job.uploadId);
      if (upload?.jobId === job._id) await ctx.db.patch(upload._id, { status: "failed" });
    }
    await completeJob(ctx, job._id, {
      status: result.kind === "canceled" ? "cancelled" : "failed",
      error: result.kind === "failed" ? result.error : "Scan cancelled.",
    });
    return null;
  },
});

export const ingestUpload = workflow
  .define({ args: { uploadId: v.id("uploads"), jobId: v.id("jobs") }, returns: vIngestOutcome })
  .handler(async (step, args): Promise<IngestOutcome> => {
    await step.runMutation(internal.ai.pipeline.beginIngest, { uploadId: args.uploadId, jobId: args.jobId });

    const detected = await step.runAction(
      internal.ai.openai.detectItems,
      { uploadId: args.uploadId, jobId: args.jobId },
      { retry: true },
    );

    await step.runAction(internal.subscriptions.refreshForJob, { jobId: args.jobId }, { retry: true });

    const plan = await step.runMutation(internal.ai.pipeline.recordDetection, {
      jobId: args.jobId,
      uploadId: args.uploadId,
      items: detected,
    });

    // The item and its step are marked failed by the action itself; onIngestComplete refunds.
    const results = await runExtractions(step, args.jobId, plan.toExtract);

    const extracted = results.filter(Boolean).length;
    return { extracted, failed: results.length - extracted, skipped: plan.skipped };
  });

/**
 * Extract (or re-extract) specific items that already exist as `needsCredits` / `ready` rows.
 * Used by uploads.resume and items.reextract, which reserve the credits (fail fast) before starting this;
 * the workflow itself only extracts, and onIngestComplete refunds whatever failed.
 */
export const extractItems = workflow
  .define({ args: { jobId: v.id("jobs"), itemIds: v.array(v.id("items")) }, returns: vIngestOutcome })
  .handler(async (step, args): Promise<IngestOutcome> => {
    const targets = await step.runMutation(internal.ai.pipeline.beginExtractItems, {
      jobId: args.jobId,
      itemIds: args.itemIds,
    });

    const results = await runExtractions(step, args.jobId, targets);

    const extracted = results.filter(Boolean).length;
    return {
      extracted,
      failed: results.length - extracted,
      skipped: args.itemIds.length - targets.length,
    };
  });

/** Runs the extractions `MAX_PARALLEL_EXTRACTIONS` at a time, in declaration order. */
async function runExtractions(
  step: WorkflowCtx,
  jobId: Id<"jobs">,
  targets: Array<{ itemId: Id<"items">; stepKey: string }>,
): Promise<boolean[]> {
  const results: boolean[] = [];
  for (let offset = 0; offset < targets.length; offset += MAX_PARALLEL_EXTRACTIONS) {
    const chunk = targets.slice(offset, offset + MAX_PARALLEL_EXTRACTIONS);
    const settled = await Promise.all(
      chunk.map(async ({ itemId, stepKey }) => {
        try {
          await step.runAction(internal.ai.openai.extractItem, { itemId, jobId, stepKey }, { retry: true });
          return true;
        } catch {
          return false;
        }
      }),
    );
    results.push(...settled);
  }
  return results;
}

/** Settles the job: refunds failed extractions, sets upload + job status (done / partial / failed). */
export const onIngestComplete = internalMutation({
  args: { workflowId: vWorkflowId, result: vResultValidator, context: v.object({ jobId: v.id("jobs") }) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const job = await getJob(ctx, args.context.jobId);
    if (isTerminalJobStatus(job.status)) return null;

    const steps = job.steps.filter((step) => step.key.startsWith(`${INGEST_STEPS.extract}:`));
    const extracted = steps.filter((step) => step.status === "done").length;
    const failed = steps.length - extracted;

    // Nothing may stay `extracting` once the job is over: a cancelled or crashed run would leave
    // invisible rows behind (they are neither in the wardrobe nor resumable). Mirrors render.ts.
    const outOfCredits = reserveShortfall(job) > 0;
    await settleStuckItems(ctx, job, outOfCredits ? "needsCredits" : "failed");

    // One credit was reserved per item we meant to extract; everything that didn't produce a cutout
    // goes back to the user. `refund` caps itself at what this job still owes.
    const unused = job.reservation.plan + job.reservation.pack - extracted;
    if (unused > 0) await refund(ctx, job, unused, "Extraction failed");

    const needsCredits = job.uploadId ? await countNeedsCredits(ctx, job.uploadId) : 0;
    const stepError = steps.find((step) => step.status === "failed")?.error;

    let status: SettledStatus;
    let error: string | undefined;
    if (args.result.kind === "canceled") {
      status = "cancelled";
      error = "Cancelled before every item was extracted.";
    } else if (args.result.kind === "failed") {
      status = "failed";
      error = args.result.error;
    } else if (steps.length > 0 && extracted === 0) {
      status = "failed";
      error = stepError ?? "Nothing could be extracted from this photo.";
    } else if (failed > 0 || needsCredits > 0) {
      status = "partial";
      error = failed > 0 ? stepError : undefined;
    } else {
      status = "done";
    }

    if (job.uploadId) {
      const upload = await ctx.db.get(job.uploadId);
      if (upload?.jobId === job._id) await ctx.db.patch(job.uploadId, { status: uploadStatus(status, extracted) });
    }

    if (job.steps.some((step) => step.key === INGEST_STEPS.finalize)) {
      await setStep(ctx, job._id, INGEST_STEPS.finalize, {
        status: "done",
        meta: { extracted, failed, needsCredits, refunded: Math.max(0, unused) },
      });
    }
    await completeJob(ctx, job._id, { status, error });
    return null;
  },
});

/** Credits the reserve step could not grant, so unfinished items are "waiting for credits", not broken. */
function reserveShortfall(job: Doc<"jobs">): number {
  const meta = job.steps.find((step) => step.key === INGEST_STEPS.reserve)?.meta;
  return typeof meta?.shortfall === "number" ? meta.shortfall : 0;
}

/**
 * Moves every item this job was extracting out of `extracting`. Items that already had a cutout
 * (a re-extract) keep it and stay `ready`; the rest become `failed` or `needsCredits`.
 */
async function settleStuckItems(ctx: MutationCtx, job: Doc<"jobs">, status: "failed" | "needsCredits"): Promise<void> {
  const fromSteps = job.steps
    .filter((step) => step.key.startsWith(`${INGEST_STEPS.extract}:`) && step.status !== "done")
    .map((step) => step.meta?.itemId)
    .filter((itemId): itemId is Id<"items"> => typeof itemId === "string");
  // Legacy jobs may have declared steps without item IDs. Only their current upload can supply
  // that fallback; a fully completed or superseded job must never settle another job's items.
  const extractSteps = job.steps.filter((step) => step.key.startsWith(`${INGEST_STEPS.extract}:`));
  const needsLegacyFallback =
    extractSteps.length === 0 ||
    extractSteps.some((step) => step.status !== "done" && typeof step.meta?.itemId !== "string");
  const currentUpload = job.uploadId ? await ctx.db.get(job.uploadId) : null;
  const fromUpload =
    job.uploadId && needsLegacyFallback && currentUpload?.jobId === job._id
      ? (await listByUpload(ctx, job.uploadId)).filter((item) => item.status === "extracting").map((item) => item._id)
      : [];

  for (const itemId of new Set([...fromSteps, ...fromUpload])) {
    const item = await ctx.db.get(itemId);
    if (!item) continue;
    if (item.status !== "extracting" && item.pendingJobId !== job._id) continue;
    await markItemFailed(ctx, itemId, status);
  }
}

function uploadStatus(status: SettledStatus, extracted: number): UploadStatus {
  if (status === "done") return "done";
  if (status === "partial") return "partial";
  return extracted > 0 ? "partial" : "failed";
}

/** Items detected but left unextracted because the user ran out of credits; a photo yields ≤ 12. */
async function countNeedsCredits(ctx: MutationCtx, uploadId: Id<"uploads">): Promise<number> {
  const items = await listByUpload(ctx, uploadId);
  return items.filter((item) => item.status === "needsCredits").length;
}
