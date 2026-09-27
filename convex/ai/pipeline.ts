import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { appError } from "../lib/errors";
import { reserve } from "../model/credits";
import {
  countReady,
  insertDetectedItem,
  markItemFailed,
  markItemReady,
  readyItemsForEmbeddings,
  setItemEmbedding,
} from "../model/items";
import { addSteps, appendResult, getJob, setStep } from "../model/jobs";
import { layeredItems } from "../model/outfits";
import { markRenderDone, markRenderFailed, setRenderPrompt } from "../model/renders";
import { bumpDailyStats } from "../model/stats";
import { detectUsageToUsd, usageToUsd, LIMITS } from "../shared/credits";
import { INGEST_STEPS, RENDER_STEPS } from "../shared/jobs";
import {
  literals,
  vColours,
  vDetectedItem,
  vPrefs,
  vRenderQuality,
  vStepStatus,
  vTokenUsage,
} from "../shared/validators";
import { SLOTS } from "../shared/wardrobe";

/**
 * The transactional half of the AI pipeline: everything `workflows/*` and `ai/openai.ts` need to
 * read or write inside the Convex runtime. The actions stay stateless; every database effect of a
 * step lands here in one mutation so a retried action can never half-apply.
 */

const vStepMeta = v.record(v.string(), v.any());
const vSlot = literals(SLOTS);

export const vExtractTarget = v.object({ itemId: v.id("items"), stepKey: v.string() });
export const vRenderTarget = v.object({ renderId: v.id("renders"), stepKey: v.string() });

export type ExtractTarget = Infer<typeof vExtractTarget>;
export type RenderTarget = Infer<typeof vRenderTarget>;

/** Step keys for the dynamic steps. Kept next to each other so the workflow and the UI agree. */
export function extractStepKey(index: number): string {
  return `${INGEST_STEPS.extract}:${index}`;
}

export function renderStepKey(index: number): string {
  return `${RENDER_STEPS.render}:${index}`;
}

/** Marks the upload as being looked at and opens the detect step. */
export const beginIngest = internalMutation({
  args: { uploadId: v.id("uploads"), jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, { uploadId, jobId }): Promise<null> => {
    const job = await getJob(ctx, jobId);
    if (job.steps.some((step) => step.key === INGEST_STEPS.upload)) {
      await setStep(ctx, jobId, INGEST_STEPS.upload, { status: "done" });
    }
    await setStep(ctx, jobId, INGEST_STEPS.detect, { status: "running" });
    const upload = await ctx.db.get(uploadId);
    if (upload) await ctx.db.patch(uploadId, { status: "detecting" });
    return null;
  },
});

/** The stored photo behind an upload; the action reads the bytes itself so no public URL is needed. */
export const uploadPhoto = internalQuery({
  args: { uploadId: v.id("uploads") },
  returns: v.object({ storageId: v.id("_storage"), mimeType: v.string() }),
  handler: async (ctx, { uploadId }): Promise<{ storageId: Id<"_storage">; mimeType: string }> => {
    const upload = await ctx.db.get(uploadId);
    if (!upload) throw appError("NOT_FOUND", "That upload no longer exists.");
    return { storageId: upload.storageId, mimeType: upload.mimeType };
  },
});

/**
 * Turns a detection result into rows: reserves one credit per item, inserts the granted ones as
 * `extracting` and the rest as `needsCredits`, and declares one `extract:<n>` step per item we can
 * afford. Returns the work the workflow should now fan out over.
 */
export const recordDetection = internalMutation({
  args: { jobId: v.id("jobs"), uploadId: v.id("uploads"), items: v.array(vDetectedItem) },
  returns: v.object({
    found: v.number(),
    granted: v.number(),
    skipped: v.number(),
    toExtract: v.array(vExtractTarget),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ found: number; granted: number; skipped: number; toExtract: ExtractTarget[] }> => {
    const job = await getJob(ctx, args.jobId);
    const user = await ctx.db.get(job.userId);
    if (!user) throw appError("NOT_FOUND", "User not found for this job.");

    const detected = args.items.slice(0, LIMITS.maxItemsPerPhoto);
    const found = detected.length;

    const readyCount = await countReady(ctx, job.userId);
    if (readyCount + found > LIMITS.maxItemsPerUser) {
      throw appError(
        "WARDROBE_FULL",
        `Your wardrobe is full (${LIMITS.maxItemsPerUser} items). Delete a few before adding more.`,
        { limit: LIMITS.maxItemsPerUser, current: readyCount },
      );
    }

    const detectCostUsd = detectCostOf(job);
    const reservation = await reserve(ctx, user, found, args.jobId);
    const granted = reservation.granted;

    const toExtract: ExtractTarget[] = [];
    for (const [index, item] of detected.entries()) {
      const { bbox, ...attrs } = item;
      const willExtract = index < granted;
      const itemId = await insertDetectedItem(ctx, {
        userId: job.userId,
        uploadId: args.uploadId,
        attrs,
        bbox,
        status: willExtract ? "extracting" : "needsCredits",
      });
      if (willExtract) toExtract.push({ itemId, stepKey: extractStepKey(index) });
    }

    await addSteps(
      ctx,
      args.jobId,
      toExtract.map((target) => ({ key: target.stepKey, meta: { itemId: target.itemId } })),
    );
    await setStep(ctx, args.jobId, INGEST_STEPS.detect, { status: "done", meta: { found, costUsd: detectCostUsd } });
    if (detectCostUsd > 0) await bumpDailyStats(ctx, { cogsUsd: detectCostUsd });
    await setStep(ctx, args.jobId, INGEST_STEPS.reserve, {
      status: "done",
      meta:
        reservation.shortfall > 0
          ? { granted, shortfall: reservation.shortfall, reason: reservation.reason }
          : { granted },
    });

    const upload = await ctx.db.get(args.uploadId);
    if (upload) {
      await ctx.db.patch(args.uploadId, {
        detectedCount: found,
        status: granted > 0 ? "extracting" : upload.status,
      });
    }

    return { found, granted, skipped: found - granted, toExtract };
  },
});

/** Text-model tokens the detect action recorded on its step, priced as COGS when the step finishes. */
function detectCostOf(job: Doc<"jobs">): number {
  const meta = job.steps.find((step) => step.key === INGEST_STEPS.detect)?.meta;
  const inputTextTokens = typeof meta?.inputTextTokens === "number" ? meta.inputTextTokens : 0;
  const outputTokens = typeof meta?.outputTokens === "number" ? meta.outputTokens : 0;
  if (inputTextTokens === 0 && outputTokens === 0) return 0;
  return detectUsageToUsd({ inputTextTokens, inputImageTokens: 0, outputTokens });
}

/**
 * Opens the extract steps for a re-run (uploads.resume / items.reextract), which reserved the
 * credits before starting the workflow. Items that vanished or belong to someone else are dropped.
 */
export const beginExtractItems = internalMutation({
  args: { jobId: v.id("jobs"), itemIds: v.array(v.id("items")) },
  returns: v.array(vExtractTarget),
  handler: async (ctx, args): Promise<ExtractTarget[]> => {
    const job = await getJob(ctx, args.jobId);
    const targets: ExtractTarget[] = [];
    for (const itemId of args.itemIds) {
      const item = await ctx.db.get(itemId);
      if (!item || item.userId !== job.userId) continue;
      // A re-extract (item still `ready`, carrying `pendingJobId`) must stay visible in the wardrobe.
      if (item.status !== "ready") await ctx.db.patch(itemId, { status: "extracting", updatedAt: Date.now() });
      targets.push({ itemId, stepKey: extractStepKey(targets.length) });
    }
    await addSteps(
      ctx,
      args.jobId,
      targets.map((target) => ({ key: target.stepKey, meta: { itemId: target.itemId } })),
    );
    if (job.steps.some((step) => step.key === INGEST_STEPS.reserve)) {
      await setStep(ctx, args.jobId, INGEST_STEPS.reserve, {
        status: "done",
        meta: { granted: job.reservation.plan + job.reservation.pack },
      });
    }
    return targets;
  },
});

/** Everything `extractItem` needs: the source photo and the attributes that seed the embedding. */
export const extractContext = internalQuery({
  args: { itemId: v.id("items") },
  returns: v.object({
    userId: v.id("users"),
    name: v.string(),
    category: v.string(),
    subcategory: v.string(),
    material: v.string(),
    pattern: v.string(),
    description: v.string(),
    colours: vColours,
    photoStorageId: v.id("_storage"),
  }),
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) throw appError("NOT_FOUND", "That item no longer exists.");
    const upload = item.uploadId ? await ctx.db.get(item.uploadId) : null;
    if (!upload) throw appError("NOT_FOUND", "The source photo for this item is gone.");
    return {
      userId: item.userId,
      name: item.name,
      category: item.category,
      subcategory: item.subcategory,
      material: item.material,
      pattern: item.pattern,
      description: item.description,
      colours: item.colours,
      photoStorageId: upload.storageId,
    };
  },
});

/** Maps vector-search hits on `itemEmbeddings` back to items usable as a duplicate target. */
export const duplicateCandidates = internalQuery({
  args: { embeddingIds: v.array(v.id("itemEmbeddings")), itemId: v.id("items") },
  returns: v.array(v.id("items")),
  handler: async (ctx, args): Promise<Id<"items">[]> => readyItemsForEmbeddings(ctx, args.embeddingIds, args.itemId),
});

/** One transaction for a finished cutout: file, swatches, usage, embedding, duplicate flag, step. */
export const itemReady = internalMutation({
  args: {
    itemId: v.id("items"),
    jobId: v.id("jobs"),
    stepKey: v.string(),
    storageId: v.id("_storage"),
    hex: v.array(v.string()),
    usage: vTokenUsage,
    embedding: v.array(v.float64()),
    duplicateOfId: v.optional(v.id("items")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await markItemReady(ctx, args.itemId, { storageId: args.storageId, hex: args.hex, usage: args.usage });
    await setItemEmbedding(ctx, args.itemId, args.embedding, args.duplicateOfId);
    await appendResult(ctx, args.jobId, args.itemId);
    await setStep(ctx, args.jobId, args.stepKey, {
      status: "done",
      meta: { itemId: args.itemId, costUsd: usageToUsd(args.usage) },
    });
    return null;
  },
});

export const itemFailed = internalMutation({
  args: { itemId: v.id("items"), jobId: v.id("jobs"), stepKey: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await markItemFailed(ctx, args.itemId);
    await setStep(ctx, args.jobId, args.stepKey, {
      status: "failed",
      error: args.error,
      meta: { itemId: args.itemId },
    });
    return null;
  },
});

/** Credits were taken by renders.start; this only opens the per-image steps. */
export const beginRenders = internalMutation({
  args: { jobId: v.id("jobs"), renderIds: v.array(v.id("renders")) },
  returns: v.array(vRenderTarget),
  handler: async (ctx, args): Promise<RenderTarget[]> => {
    const job = await getJob(ctx, args.jobId);
    const targets: RenderTarget[] = [];
    for (const renderId of args.renderIds) {
      const render = await ctx.db.get(renderId);
      if (!render || render.userId !== job.userId) continue;
      targets.push({ renderId, stepKey: renderStepKey(targets.length) });
    }
    await addSteps(
      ctx,
      args.jobId,
      targets.map((target) => ({ key: target.stepKey, meta: { renderId: target.renderId } })),
    );
    await setStep(ctx, args.jobId, RENDER_STEPS.reserve, {
      status: "done",
      meta: { reserved: job.reservation.plan + job.reservation.pack },
    });
    return targets;
  },
});

/** Avatar, garments in layer order and the wearer's preferences for one try-on image. */
export const renderContext = internalQuery({
  args: { renderId: v.id("renders") },
  returns: v.object({
    userId: v.id("users"),
    quality: vRenderQuality,
    avatarStorageId: v.id("_storage"),
    garments: v.array(v.object({ itemId: v.id("items"), name: v.string(), slot: vSlot, storageId: v.id("_storage") })),
    prefs: vPrefs,
  }),
  handler: async (ctx, { renderId }) => {
    const render = await ctx.db.get(renderId);
    if (!render) throw appError("NOT_FOUND", "That render no longer exists.");
    const [avatar, outfit, user] = await Promise.all([
      ctx.db.get(render.avatarId),
      ctx.db.get(render.outfitId),
      ctx.db.get(render.userId),
    ]);
    if (!avatar) throw appError("NOT_FOUND", "That avatar no longer exists.");
    if (!outfit) throw appError("NOT_FOUND", "That outfit no longer exists.");
    if (!user) throw appError("NOT_FOUND", "User not found for this render.");

    const garments = [];
    for (const { slot, item } of await layeredItems(ctx, outfit.slots)) {
      const storageId = item.storageId;
      if (!storageId) continue;
      garments.push({ itemId: item._id, name: item.name, slot, storageId });
    }
    if (garments.length === 0) {
      throw appError("INVALID_INPUT", "None of this outfit's items have a cutout yet.");
    }

    return {
      userId: render.userId,
      quality: render.quality,
      avatarStorageId: avatar.storageId,
      garments,
      prefs: user.prefs,
    };
  },
});

export const renderDone = internalMutation({
  args: {
    renderId: v.id("renders"),
    jobId: v.id("jobs"),
    stepKey: v.string(),
    storageId: v.id("_storage"),
    prompt: v.string(),
    usage: vTokenUsage,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await setRenderPrompt(ctx, args.renderId, args.prompt);
    await markRenderDone(ctx, args.renderId, { storageId: args.storageId, usage: args.usage });
    await appendResult(ctx, args.jobId, args.renderId);
    await setStep(ctx, args.jobId, args.stepKey, {
      status: "done",
      meta: { renderId: args.renderId, costUsd: usageToUsd(args.usage) },
    });
    return null;
  },
});

export const renderFailed = internalMutation({
  args: { renderId: v.id("renders"), jobId: v.id("jobs"), stepKey: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await markRenderFailed(ctx, args.renderId, args.error);
    await setStep(ctx, args.jobId, args.stepKey, {
      status: "failed",
      error: args.error,
      meta: { renderId: args.renderId },
    });
    return null;
  },
});

/** Generic step writer for the actions, which report `running` before they call OpenAI. */
export const markStep = internalMutation({
  args: {
    jobId: v.id("jobs"),
    key: v.string(),
    status: vStepStatus,
    error: v.optional(v.string()),
    meta: v.optional(vStepMeta),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await setStep(ctx, args.jobId, args.key, { status: args.status, error: args.error, meta: args.meta });
    return null;
  },
});
