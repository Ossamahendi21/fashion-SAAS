import { start } from "@convex-dev/workflow";
import type { Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertOwner } from "../lib/auth";
import { appError } from "../lib/errors";
import { CREDIT_COSTS, detectUsageToUsd, extractionCreditCost, LIMITS } from "../shared/credits";
import { INGEST_STEPS, isTerminalJobStatus } from "../shared/jobs";
import type { vDetectedItem } from "../shared/validators";
import { ACCEPTED_IMAGE_TYPES, MAX_UPLOAD_BYTES } from "../shared/wardrobe";
import type { UploadView } from "../views";
import { reserve, shortfallError } from "./credits";
import {
  addSteps,
  assertAffordable,
  assertBelowJobLimit,
  completeJob,
  createJob,
  getJob,
  setStep,
  setWorkflowId,
  type StepInput,
} from "./jobs";
import { insertDetectedItem, markItemPending } from "./items";
import { bumpDailyStats } from "./stats";

type Ctx = QueryCtx | MutationCtx;

export type UploadFileInput = { storageId: Id<"_storage">; fileName: string; mimeType: string; sizeBytes: number };

export async function toUploadView(ctx: Ctx, upload: Doc<"uploads">): Promise<UploadView> {
  return {
    _id: upload._id,
    batchId: upload.batchId,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    status: upload.status,
    detectedCount: upload.detectedCount,
    candidates: upload.candidates,
    selectedIndices: upload.selectedIndices,
    selectionConfirmedAt: upload.selectionConfirmedAt,
    jobId: upload.jobId,
    url: await ctx.storage.getUrl(upload.storageId),
    createdAt: upload.createdAt,
  };
}

/** Rejects the batch before any row is written: count, mime type and size all have hard caps. */
export function assertValidFiles(files: UploadFileInput[]): void {
  if (files.length === 0) throw appError("INVALID_INPUT", "Pick at least one photo.");
  if (files.length > LIMITS.maxPhotosPerUpload) {
    throw appError("INVALID_INPUT", `You can add up to ${LIMITS.maxPhotosPerUpload} photos at a time.`, {
      limit: LIMITS.maxPhotosPerUpload,
    });
  }
  const accepted = Object.keys(ACCEPTED_IMAGE_TYPES);
  for (const file of files) {
    if (!accepted.includes(file.mimeType)) {
      throw appError("INVALID_INPUT", `"${file.fileName}" isn't a supported image (${file.mimeType}).`, {
        accepted,
      });
    }
    if (file.sizeBytes <= 0 || file.sizeBytes > MAX_UPLOAD_BYTES) {
      throw appError("INVALID_INPUT", `"${file.fileName}" is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`, {
        maxBytes: MAX_UPLOAD_BYTES,
      });
    }
  }
}

/**
 * Cross-checks what the client claimed against the blob Convex actually stored, so a forged
 * `mimeType`/`sizeBytes` can never smuggle a huge file or a non-image into the pipeline.
 */
export async function assertStoredImage(ctx: Ctx, storageId: Id<"_storage">, fileName: string): Promise<void> {
  const metadata = await ctx.db.system.get("_storage", storageId);
  if (!metadata) throw appError("INVALID_INPUT", `"${fileName}" was not uploaded. Try again.`);
  const contentType = metadata.contentType ?? "";
  if (!Object.keys(ACCEPTED_IMAGE_TYPES).includes(contentType)) {
    throw appError("INVALID_INPUT", `"${fileName}" isn't a supported image (${contentType || "unknown type"}).`, {
      accepted: Object.keys(ACCEPTED_IMAGE_TYPES),
    });
  }
  if (metadata.size > MAX_UPLOAD_BYTES) {
    throw appError("INVALID_INPUT", `"${fileName}" is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`, {
      maxBytes: MAX_UPLOAD_BYTES,
    });
  }
}

export async function listBatch(ctx: Ctx, userId: Id<"users">, batchId: string): Promise<Doc<"uploads">[]> {
  const uploads = await ctx.db
    .query("uploads")
    .withIndex("by_batch", (q) => q.eq("batchId", batchId))
    .collect();
  return uploads.filter((upload) => upload.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Reserves credits for a set of already-detected items and starts the extraction workflow.
 * Shared by uploads.resume (a partial run continued when credits are available) and items.reextract.
 * Credits are taken up front so the caller fails fast instead of half-running.
 */
export async function startExtractionJob(
  ctx: MutationCtx,
  user: Doc<"users">,
  itemIds: Id<"items">[],
  uploadId?: Id<"uploads">,
): Promise<Id<"jobs">> {
  if (itemIds.length === 0) throw appError("INVALID_INPUT", "There's nothing left to extract here.");
  if (uploadId) {
    const upload = assertOwner(await ctx.db.get(uploadId), user, "upload");
    if (upload.status === "extracting") {
      throw appError("ITEM_BUSY", "Wait for this photo's current import to finish.");
    }
  }
  await assertBelowJobLimit(ctx, user._id);

  const needed = extractionCreditCost(itemIds.length);
  // Cap and quote are checked before anything is written, so a rejected request leaves no job behind.
  assertAffordable(user, needed);

  const steps: StepInput[] = [
    { key: INGEST_STEPS.reserve },
    ...itemIds.map((itemId, index) => ({ key: `${INGEST_STEPS.extract}:${index}`, meta: { itemId } })),
    { key: INGEST_STEPS.finalize },
  ];
  const jobId = await createJob(ctx, user, { type: "ingest", steps, uploadId });

  const result = await reserve(ctx, user, needed, jobId);
  // A shortfall here can only be a race with another job; throwing rolls the whole mutation back.
  if (result.granted < needed) throw shortfallError(result, needed);
  await setStep(ctx, jobId, INGEST_STEPS.reserve, { status: "done", meta: { credits: needed } });

  const now = Date.now();
  for (const itemId of itemIds) {
    const item = await ctx.db.get(itemId);
    if (!item) continue;
    // A re-extract keeps the item visible and usable; only a first extraction hides it behind `extracting`.
    if (item.status === "ready") await markItemPending(ctx, itemId, jobId);
    else await ctx.db.patch(itemId, { status: "extracting", pendingJobId: undefined, updatedAt: now });
  }

  const workflowId = await start(
    ctx,
    internal.workflows.ingest.extractItems,
    { jobId, itemIds },
    { onComplete: internal.workflows.ingest.onIngestComplete, context: { jobId } },
  );
  await setWorkflowId(ctx, jobId, workflowId);
  if (uploadId) await ctx.db.patch(uploadId, { status: "extracting", jobId });
  return jobId;
}

/**
 * Registers uploaded photos as one batch: an `uploads` row plus an ingest job + workflow per photo.
 * The running-job cap is checked once for the whole batch (a 20-photo drop is one user action).
 * Shared by uploads.createBatch and the dev smoke test.
 */
export async function createBatch(
  ctx: MutationCtx,
  user: Doc<"users">,
  files: UploadFileInput[],
): Promise<{ batchId: string; uploads: Array<{ uploadId: Id<"uploads">; jobId: Id<"jobs"> }> }> {
  assertValidFiles(files);
  for (const file of files) await assertStoredImage(ctx, file.storageId, file.fileName);
  // One check for the whole batch: every job below shares `batchId`, so the batch stays one unit.
  await assertBelowJobLimit(ctx, user._id);

  const batchId = crypto.randomUUID();
  const now = Date.now();
  const uploads: Array<{ uploadId: Id<"uploads">; jobId: Id<"jobs"> }> = [];

  for (const file of files) {
    const uploadId = await ctx.db.insert("uploads", {
      userId: user._id,
      batchId,
      storageId: file.storageId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      status: "queued",
      createdAt: now,
    });
    const jobId = await createJob(ctx, user, {
      type: "ingest",
      steps: [{ key: INGEST_STEPS.upload }, { key: INGEST_STEPS.detect }, { key: INGEST_STEPS.review }],
      uploadId,
      batchId,
    });
    await setStep(ctx, jobId, INGEST_STEPS.upload, { status: "done" });
    await ctx.db.patch(uploadId, { jobId });

    const workflowId = await start(
      ctx,
      internal.workflows.ingest.scanUpload,
      { uploadId, jobId },
      { onComplete: internal.workflows.ingest.onScanComplete, context: { jobId } },
    );
    await setWorkflowId(ctx, jobId, workflowId);
    uploads.push({ uploadId, jobId });
  }

  return { batchId, uploads };
}

/** Scanning finishes here. Candidates are review data, never wardrobe items or credit reservations. */
export async function recordCandidates(
  ctx: MutationCtx,
  { uploadId, jobId, items }: { uploadId: Id<"uploads">; jobId: Id<"jobs">; items: Infer<typeof vDetectedItem>[] },
): Promise<number> {
  const job = await getJob(ctx, jobId);
  const upload = await ctx.db.get(uploadId);
  if (!upload || upload.userId !== job.userId || job.uploadId !== uploadId) {
    throw appError("NOT_FOUND", "That upload no longer exists.");
  }
  // A replay or delayed callback must never reset a user's confirmed selection or count scan cost twice.
  if (upload.candidates !== undefined || isTerminalJobStatus(job.status)) return upload.detectedCount ?? 0;
  if (upload.jobId !== jobId) throw appError("CONFLICT", "This upload has a newer job.");
  const candidates = items.slice(0, LIMITS.maxItemsPerPhoto);
  const meta = job.steps.find((step) => step.key === INGEST_STEPS.detect)?.meta;
  const costUsd = detectUsageToUsd({
    inputTextTokens: typeof meta?.inputTextTokens === "number" ? meta.inputTextTokens : 0,
    inputImageTokens: 0,
    outputTokens: typeof meta?.outputTokens === "number" ? meta.outputTokens : 0,
  });
  await ctx.db.patch(uploadId, {
    candidates,
    detectedCount: candidates.length,
    status: candidates.length > 0 ? "awaiting_selection" : "done",
  });
  await setStep(ctx, jobId, INGEST_STEPS.detect, { status: "done", meta: { found: candidates.length, costUsd } });
  if (costUsd > 0) await bumpDailyStats(ctx, { cogsUsd: costUsd });
  await setStep(ctx, jobId, INGEST_STEPS.review, {
    status: candidates.length > 0 ? "done" : "skipped",
    label: candidates.length > 0 ? "Ready to review" : "No clothing found",
  });
  await completeJob(ctx, jobId, { status: "done" });
  return candidates.length;
}

/** Selection, credit reservation, item creation and workflow start commit as one Convex transaction. */
export async function confirmSelection(
  ctx: MutationCtx,
  user: Doc<"users">,
  uploadId: Id<"uploads">,
  indices: number[],
): Promise<Id<"jobs">> {
  const upload = assertOwner(await ctx.db.get(uploadId), user, "upload");
  const candidates = upload.candidates;
  if (
    !candidates ||
    indices.length === 0 ||
    indices.length > candidates.length ||
    new Set(indices).size !== indices.length ||
    indices.some((index) => !Number.isInteger(index) || index < 0 || index >= candidates.length)
  ) {
    throw appError("INVALID_INPUT", "Choose at least one valid item from this photo, without duplicates.");
  }
  const selectedIndices = [...indices].sort((a, b) => a - b);
  if (upload.selectionJobId) {
    if (JSON.stringify(upload.selectedIndices) === JSON.stringify(selectedIndices)) return upload.selectionJobId;
    throw appError("CONFLICT", "This photo's selection is already confirmed.");
  }
  if (upload.status !== "awaiting_selection") throw appError("CONFLICT", "This photo isn't ready for selection.");
  await assertBelowJobLimit(ctx, user._id);
  const existing = await ctx.db
    .query("items")
    .withIndex("by_user_status", (q) => q.eq("userId", user._id))
    .take(LIMITS.maxItemsPerUser + 1);
  if (existing.length + selectedIndices.length > LIMITS.maxItemsPerUser) {
    throw appError(
      "WARDROBE_FULL",
      `Your wardrobe is full (${LIMITS.maxItemsPerUser} items). Delete a few before adding more.`,
    );
  }
  const jobId = await createJob(ctx, user, {
    type: "ingest",
    uploadId,
    batchId: upload.batchId,
    steps: [{ key: INGEST_STEPS.reserve }],
  });
  const result = await reserve(ctx, user, extractionCreditCost(selectedIndices.length), jobId);
  const grantedCount = Math.floor(result.granted / CREDIT_COSTS.extractItem);
  const itemIds: Id<"items">[] = [];
  for (const [position, index] of selectedIndices.entries()) {
    const { bbox, ...attrs } = candidates[index];
    const itemId = await insertDetectedItem(ctx, {
      userId: user._id,
      uploadId,
      attrs,
      bbox,
      status: position < grantedCount ? "extracting" : "needsCredits",
    });
    if (position < grantedCount) itemIds.push(itemId);
  }
  await addSteps(ctx, jobId, [
    ...itemIds.map((itemId, index) => ({ key: `${INGEST_STEPS.extract}:${index}`, meta: { itemId } })),
    { key: INGEST_STEPS.finalize },
  ]);
  await setStep(ctx, jobId, INGEST_STEPS.reserve, {
    status: "done",
    meta: { granted: result.granted, shortfall: result.shortfall, ...(result.reason ? { reason: result.reason } : {}) },
  });
  await ctx.db.patch(uploadId, {
    selectedIndices,
    selectionConfirmedAt: Date.now(),
    selectionJobId: jobId,
    jobId,
    status: itemIds.length > 0 ? "extracting" : "partial",
  });
  if (itemIds.length > 0) {
    const workflowId = await start(
      ctx,
      internal.workflows.ingest.extractItems,
      { jobId, itemIds },
      {
        onComplete: internal.workflows.ingest.onIngestComplete,
        context: { jobId },
      },
    );
    await setWorkflowId(ctx, jobId, workflowId);
  } else {
    await setStep(ctx, jobId, INGEST_STEPS.finalize, {
      status: "done",
      meta: { extracted: 0, failed: 0, needsCredits: selectedIndices.length },
    });
    await completeJob(ctx, jobId, { status: "partial" });
  }
  return jobId;
}
