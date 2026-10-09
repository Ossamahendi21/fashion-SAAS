"use node";

import { v, type Infer } from "convex/values";
import OpenAI, { toFile } from "openai";
import type { ImageEditParamsNonStreaming, ImagesResponse } from "openai/resources/images";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { envNumber, optionalEnv, requireEnv } from "../lib/env";
import { appError, isAppError } from "../lib/errors";
import { usageToUsd, type TokenUsage } from "../shared/credits";
import { embeddingText } from "../shared/embeddingText";
import { INGEST_STEPS } from "../shared/jobs";
import { vDetectedItem, vRawStylingSuggestion, type RawStylingSuggestion } from "../shared/validators";
import { type Slot } from "../shared/wardrobe";
import { dominantHex } from "./colours";
import { deterministicDetectedItem } from "./deterministic_detection";
import {
  embedText,
  EMBEDDING_MODELS,
  localEmbed,
  localEmbeddingConfig,
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingRunners,
} from "./embedding";
import {
  extractGarmentCutout,
  ExtractionError,
  type ExtractionRunners,
  florenceSamExtract,
  withoutBgExtract,
} from "./extraction";
import { normalizeImageInput } from "./image_input";
import { compositeOutfitImage } from "./composite";
import { renderOutfitImage } from "./rendering";
import {
  coerceAdviceResponse,
  coerceStylingResponse,
  extractionNoun,
  extractionPrompt,
  groundingPhrase,
  renderPrompt,
  shoppingAdviceSummary,
  stylingSuggestions,
  type StylingWardrobeItem,
} from "./prompts";

/**
 * Every OpenAI call the app makes. Actions only: they read and write through `ai/pipeline.ts` so a
 * retried attempt can never leave a half-written item or render behind.
 *
 * Measured at quality "medium": ≈$0.031 per extraction, ≈$0.030 per render, 30–50 s each.
 * `gpt-image-2` rejects `input_fidelity` — it is never sent. `background: "transparent"` is a
 * preview flag on that model, so a 4xx from it is retried once as `opaque`.
 */

const DETECT_MODEL = "gpt-5-mini";
const IMAGE_MODEL = "gpt-image-2";
const EMBED_MODEL = "text-embedding-3-small";

/** The images endpoint accepts at most 16 reference images: the avatar plus 15 garments. */
const MAX_REFERENCE_IMAGES = 16;
/** Long enough for a slow render, short enough to fail inside the action's own budget. */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ERROR_CHARS = 240;

export type DetectedItem = Infer<typeof vDetectedItem>;

let cached: OpenAI | null = null;

/** One client per container. `maxRetries: 0` — retries are the workflow's job, and they are visible. */
function openai(): OpenAI {
  if (!cached) {
    const directKey = optionalEnv("OPENAI_API_KEY");
    cached = new OpenAI({
      apiKey: directKey ?? requireEnv("AI_GATEWAY_API_KEY"),
      ...(directKey ? {} : { baseURL: "https://ai-gateway.vercel.sh/v1" }),
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });
  }
  return cached;
}

function modelId(model: string): string {
  return optionalEnv("OPENAI_API_KEY") ? model : `openai/${model}`;
}

/** Zero-provider scan for one isolated garment photo. */
export const detectItems = internalAction({
  args: { uploadId: v.id("uploads"), jobId: v.id("jobs") },
  returns: v.array(vDetectedItem),
  handler: async (ctx, args): Promise<DetectedItem[]> => {
    try {
      const photo = await ctx.runQuery(internal.ai.pipeline.uploadPhoto, { uploadId: args.uploadId });
      const blob = await ctx.storage.get(photo.storageId);
      if (!blob) throw appError("NOT_FOUND", "The uploaded photo is gone.");
      const normalized = await normalizeImageInput(blob, "photo");
      const items = [deterministicDetectedItem(photo.fileName, dominantHex(normalized, 6))];
      await ctx.runMutation(internal.ai.pipeline.markStep, {
        jobId: args.jobId,
        key: INGEST_STEPS.detect,
        status: "running",
        meta: {
          provider: "deterministic",
          inputTextTokens: 0,
          outputTokens: 0,
        },
      });
      return items;
    } catch (error) {
      await ctx.runMutation(internal.ai.pipeline.markStep, {
        jobId: args.jobId,
        key: INGEST_STEPS.detect,
        status: "failed",
        error: errorText(error),
      });
      throw error;
    }
  },
});

/** Zero-provider shopping scan, hard-capped to one full-frame item. */
export const detectShoppingItem = internalAction({
  args: { uploadId: v.id("uploads"), jobId: v.id("jobs"), productTitle: v.string() },
  returns: v.array(vDetectedItem),
  handler: async (ctx, args): Promise<DetectedItem[]> => {
    try {
      const photo = await ctx.runQuery(internal.ai.pipeline.uploadPhoto, { uploadId: args.uploadId });
      const blob = await ctx.storage.get(photo.storageId);
      if (!blob) throw appError("NOT_FOUND", "The uploaded photo is gone.");
      const normalized = await normalizeImageInput(blob, "photo");
      const items = [deterministicDetectedItem(`${args.productTitle} ${photo.fileName}`, dominantHex(normalized, 6))];
      await ctx.runMutation(internal.ai.pipeline.markStep, {
        jobId: args.jobId,
        key: INGEST_STEPS.detect,
        status: "running",
        meta: {
          provider: "deterministic",
          inputTextTokens: 0,
          outputTokens: 0,
        },
      });
      return items;
    } catch (error) {
      await ctx.runMutation(internal.ai.pipeline.markStep, {
        jobId: args.jobId,
        key: INGEST_STEPS.detect,
        status: "failed",
        error: errorText(error),
      });
      throw error;
    }
  },
});

/**
 * gpt-5-mini builds outfit suggestions around one saved wardrobe item. Text-only (no images),
 * so it stays in the cheap detect-tier model. Failures surface as safe copy; malformed model
 * output never reaches the caller.
 */
export const styleItemOutfits = internalAction({
  args: {
    item: v.object({
      id: v.string(),
      name: v.string(),
      category: v.string(),
      subcategory: v.string(),
      colours: v.array(v.string()),
      pattern: v.string(),
      material: v.string(),
      season: v.array(v.string()),
      formality: v.string(),
    }),
    wardrobe: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        category: v.string(),
        subcategory: v.string(),
        colours: v.array(v.string()),
        pattern: v.string(),
        material: v.string(),
        season: v.array(v.string()),
        formality: v.string(),
      }),
    ),
    presentation: v.string(),
    fit: v.string(),
    maxSuggestions: v.number(),
  },
  returns: v.object({
    suggestions: v.array(vRawStylingSuggestion),
    usage: v.object({ inputTextTokens: v.number(), outputTokens: v.number() }),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    suggestions: RawStylingSuggestion[];
    usage: { inputTextTokens: number; outputTokens: number };
  }> => {
    try {
      const wardrobe: StylingWardrobeItem[] = args.wardrobe;
      const { instructions, schema } = stylingSuggestions({
        item: { ...args.item },
        wardrobe,
        presentation: args.presentation,
        fit: args.fit,
        maxSuggestions: args.maxSuggestions,
      });
      const response = await openai().responses.create({
        model: modelId(DETECT_MODEL),
        input: [{ role: "user", content: [{ type: "input_text", text: instructions }] }],
        text: { format: { type: "json_schema", name: "styling_suggestions", schema, strict: true } },
      });
      return {
        suggestions: coerceStylingResponse(response.output_text, args.maxSuggestions),
        usage: {
          inputTextTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        },
      };
    } catch (error) {
      if (isAppError(error)) throw error;
      throw appError("UPSTREAM_FAILED", "Styling is temporarily unavailable. Please try again.");
    }
  },
});

/**
 * gpt-5-mini turns server-derived advice facts into a concise purchase-decision summary.
 * Text-only (no images). The model receives structured facts — never item ids, never
 * prompts, never page content — and returns bounded prose; malformed output degrades to
 * deterministic-only advice instead of failing.
 */
export const summarizeShoppingAdvice = internalAction({
  args: {
    candidate: v.object({
      name: v.string(),
      category: v.string(),
      subcategory: v.string(),
      colours: v.array(v.string()),
      pattern: v.string(),
      material: v.string(),
      season: v.array(v.string()),
      formality: v.string(),
    }),
    similar: v.array(
      v.object({
        name: v.string(),
        category: v.string(),
        band: v.union(v.literal("very similar"), v.literal("similar")),
      }),
    ),
    matchCount: v.number(),
    outfitDisplay: v.string(),
    signals: v.array(v.string()),
    label: v.string(),
    presentation: v.string(),
    fit: v.string(),
  },
  returns: v.object({
    summary: v.string(),
    pros: v.array(v.string()),
    considerations: v.array(v.string()),
    usage: v.object({ inputTextTokens: v.number(), outputTokens: v.number() }),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    summary: string;
    pros: string[];
    considerations: string[];
    usage: { inputTextTokens: number; outputTokens: number };
  }> => {
    try {
      const { instructions, schema } = shoppingAdviceSummary({
        candidate: { ...args.candidate },
        similar: args.similar.map((entry) => ({ ...entry })),
        matchCount: args.matchCount,
        outfitDisplay: args.outfitDisplay,
        signals: [...args.signals],
        label: args.label,
        presentation: args.presentation,
        fit: args.fit,
      });
      const response = await openai().responses.create({
        model: modelId(DETECT_MODEL),
        input: [{ role: "user", content: [{ type: "input_text", text: instructions }] }],
        text: { format: { type: "json_schema", name: "shopping_advice", schema, strict: true } },
      });
      return {
        ...coerceAdviceResponse(response.output_text),
        usage: {
          inputTextTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        },
      };
    } catch (error) {
      if (isAppError(error)) throw error;
      throw appError("UPSTREAM_FAILED", "Advice is temporarily unavailable. Please try again.");
    }
  },
});
/**
 * One item: cut it out of its source photo through the extraction seam, store the PNG, read its
 * swatches and embed it through the embedding seam. The seam dispatches on EXTRACTION_PROVIDER
 * (default original-image preservation, with florencesam available when configured); there is no failover.
 *
 * Step 7 Phase C: the vector comes from the explicit `EMBEDDING_PROVIDER` selection (`local` BGE,
 * $0) and is written to `embeddingBge`. This action deliberately does NOT search the vector index any more: text
 * embeddings cannot tell two physical garments apart (Phase B1 duplicate AUC 0.8407, zero-recall at
 * zero false positives), so the old `vectorSearch → cosine threshold → duplicateOfId` chain is
 * retired here. A new item keeps `duplicateOfId` undefined; existing flags stay until a user
 * dismisses them.
 */
export const extractItem = internalAction({
  args: { itemId: v.id("items"), jobId: v.id("jobs"), stepKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await ctx.runMutation(internal.ai.pipeline.markStep, {
      jobId: args.jobId,
      key: args.stepKey,
      status: "running",
    });
    try {
      const item = await ctx.runQuery(internal.ai.pipeline.extractContext, { itemId: args.itemId });
      const photo = await ctx.storage.get(item.photoStorageId);
      if (!photo) throw appError("NOT_FOUND", "The source photo for this item is gone.");

      const cutout = await extractGarmentCutout(
        {
          imageBytes: await normalizeImageInput(photo, "photo"),
          imageName: "photo",
          prompt: extractionPrompt(item.description),
          noun: extractionNoun({ category: item.category, subcategory: item.subcategory }),
        },
        extractionRunners(),
      );
      const storageId = await ctx.storage.store(pngBlob(cutout.bytes));
      const hex = dominantHex(cutout.bytes, 3);

      // `markItemReady` merges this hex into the item's colours, so building the text here from
      // `{ ...item.colours, hex }` is the same string the backfill reconstructs from persisted data.
      const embeddingBge = optionalEnv("EMBEDDING_PROVIDER")
        ? (await embedText({ text: embeddingText({ ...item, colours: { ...item.colours, hex } }) }, embeddingRunners()))
            .vector
        : undefined;

      await ctx.runMutation(internal.ai.pipeline.itemReady, {
        itemId: args.itemId,
        jobId: args.jobId,
        stepKey: args.stepKey,
        storageId,
        hex,
        usage: cutout.usage,
        costUsd: cutout.costUsd,
        ...(embeddingBge ? { embeddingBge } : {}),
      });
      return null;
    } catch (error) {
      await ctx.runMutation(internal.ai.pipeline.itemFailed, {
        itemId: args.itemId,
        jobId: args.jobId,
        stepKey: args.stepKey,
        error: errorText(error),
      });
      throw error;
    }
  },
});

/**
 * The provider implementations behind the seam. The legacy `gpt-image-2` branch keeps its
 * transparent-then-opaque retry and bills from real SDK usage; withoutBG bills a fixed
 * operator-set cost because a self-hosted gateway has no token accounting to quote; the
 * original and florencesam branches report $0 external spend. No branch ever calls
 * another branch: there is no paid fallback.
 */
function extractionRunners(): ExtractionRunners {
  return {
    openai: async (request) => {
      const started = Date.now();
      const { response, background } = await editWithTransparency({
        image: await toFile(request.imageBytes, request.imageName, { type: "image/png" }),
        prompt: request.prompt,
        size: "1024x1024",
        quality: "medium",
      });
      const { bytes, usage } = decodeImage(response);
      return { bytes, usage, background, costUsd: usageToUsd(usage), latencyMs: Date.now() - started };
    },
    withoutbg: async (request) => {
      const cut = await withoutBgExtract(
        { bytes: request.imageBytes, prompt: request.prompt },
        {
          baseUrl: requireEnv("WITHOUTBG_BASE_URL"),
          apiKey: requireEnv("WITHOUTBG_API_KEY"),
          costUsdPerImage: envNumber("WITHOUTBG_COST_USD_PER_IMAGE", 0.001),
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      );
      return { bytes: cut.bytes, background: cut.background, costUsd: cut.costUsd, latencyMs: cut.latencyMs };
    },
    florencesam: async (request) => {
      if (!request.noun.trim()) {
        throw new ExtractionError("invalid-input", "Florence+SAM2 extraction needs a garment noun.");
      }
      const cut = await florenceSamExtract(
        { bytes: request.imageBytes, prompt: groundingPhrase(request.noun) },
        {
          baseUrl: requireEnv("FLORENCESAM_BASE_URL"),
          apiKey: requireEnv("FLORENCESAM_API_KEY"),
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      );
      return { bytes: cut.bytes, background: cut.background, costUsd: cut.costUsd, latencyMs: cut.latencyMs };
    },
  };
}

/** One try-on image: the avatar plus every garment cutout as references, one prompt. */
export const renderImage = internalAction({
  args: { renderId: v.id("renders"), jobId: v.id("jobs"), stepKey: v.string() },
  returns: v.union(v.null(), v.object({ error: v.string() })),
  handler: async (ctx, args): Promise<null | { error: string }> => {
    await ctx.runMutation(internal.ai.pipeline.markStep, {
      jobId: args.jobId,
      key: args.stepKey,
      status: "running",
      meta: { renderId: args.renderId },
    });
    let prompt = "";
    try {
      const context = await ctx.runQuery(internal.ai.pipeline.renderContext, { renderId: args.renderId });
      const avatar = await ctx.storage.get(context.avatarStorageId);
      if (!avatar) throw appError("NOT_FOUND", "That avatar photo is gone.");

      const garments = context.garments.slice(0, MAX_REFERENCE_IMAGES - 1);
      const blobs = await Promise.all(garments.map((garment) => ctx.storage.get(garment.storageId)));
      const wearable = garments.filter((_, index) => blobs[index] !== null);
      if (wearable.length === 0) throw appError("NOT_FOUND", "None of this outfit's cutouts are available.");

      const person = { bytes: await normalizeImageInput(avatar, "profile photo"), name: "person" };
      // Decode one reference at a time to bound memory for large photos and layered outfits.
      const garmentRefs: Array<{ bytes: Uint8Array; name: string; slot: Slot }> = [];
      for (const [index, blob] of blobs.entries()) {
        if (blob) {
          garmentRefs.push({
            bytes: await normalizeImageInput(blob, `garment-${index + 1}`),
            name: `garment-${index + 1}`,
            slot: garments[index].slot,
          });
        }
      }

      prompt = renderPrompt({
        garments: wearable.map((garment) => ({ name: garment.name, slot: garment.slot })),
        presentation: context.prefs.presentation,
        fit: context.prefs.fit,
        hasOuterwear: wearable.some((garment) => garment.slot === "outerwear"),
        missingSlots: missingSlots(wearable.map((garment) => garment.slot)),
      });

      const result = await renderOutfitImage(
        { person, garments: garmentRefs, prompt, quality: context.quality },
        { composite: compositeOutfitImage },
      );
      const storageId = await ctx.storage.store(pngBlob(result.bytes));

      await ctx.runMutation(internal.ai.pipeline.renderDone, {
        renderId: args.renderId,
        jobId: args.jobId,
        stepKey: args.stepKey,
        storageId,
        prompt,
        usage: result.usage,
        costUsd: result.costUsd,
      });
      return null;
    } catch (error) {
      const message = errorText(error);
      if (isPermanentRenderError(error)) {
        await ctx.runMutation(internal.ai.pipeline.renderFailed, {
          renderId: args.renderId,
          jobId: args.jobId,
          stepKey: args.stepKey,
          error: message,
        });
        // A settled result stops Workpool retrying rejected images or invalid requests.
        return { error: message };
      }
      await ctx.runMutation(internal.ai.pipeline.markStep, {
        jobId: args.jobId,
        key: args.stepKey,
        status: "running",
        error: message,
      });
      throw error;
    }
  },
});

function isPermanentRenderError(error: unknown): boolean {
  if (isAppError(error)) return error.data.code !== "UPSTREAM_FAILED" && error.data.code !== "RATE_LIMITED";
  if (!(error instanceof OpenAI.APIError) || error.status === undefined) return false;
  return error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status);
}

type EditRequest = {
  image: ImageEditParamsNonStreaming["image"];
  prompt: string;
  size: "1024x1024" | "1024x1536";
  quality: "medium" | "high";
  background?: "transparent" | "opaque";
};

async function editImage(request: EditRequest): Promise<ImagesResponse> {
  // `input_fidelity` is rejected by gpt-image-2 — do not add it here.
  const params: ImageEditParamsNonStreaming = {
    model: modelId(IMAGE_MODEL),
    image: request.image,
    prompt: request.prompt,
    size: request.size,
    quality: request.quality,
    output_format: "png",
  };
  if (request.background) params.background = request.background;
  return openai().images.edit(params);
}

/**
 * Transparent backgrounds are a preview flag on gpt-image-2: when the account or snapshot doesn't
 * have it the request 4xxs, so redo the same edit opaque rather than failing the item. Only that
 * error is retried — a content-policy or bad-image 400 must not buy a second paid attempt.
 * Returns which background the response actually carries so extraction cost stays honest.
 */
async function editWithTransparency(
  request: Omit<EditRequest, "background">,
): Promise<{ response: ImagesResponse; background: "transparent" | "opaque" }> {
  try {
    return { response: await editImage({ ...request, background: "transparent" }), background: "transparent" };
  } catch (error) {
    if (!isBackgroundParamError(error)) throw error;
    return { response: await editImage({ ...request, background: "opaque" }), background: "opaque" };
  }
}

/** True only when the 4xx is about the `background` parameter itself. */
function isBackgroundParamError(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) return false;
  if (typeof error.status !== "number" || error.status < 400 || error.status >= 500) return false;
  if (error.param === "background") return true;
  const message = error.message.toLowerCase();
  return message.includes("background") || message.includes("transparent");
}

function decodeImage(response: ImagesResponse): { bytes: Uint8Array<ArrayBuffer>; usage: TokenUsage } {
  const encoded = response.data?.[0]?.b64_json;
  if (!encoded) throw appError("UPSTREAM_FAILED", "The image model returned no image.");
  const decoded = Buffer.from(encoded, "base64");
  // Copy into a plain ArrayBuffer-backed view: a Node Buffer can sit on a SharedArrayBuffer, which
  // neither `Blob` nor `ctx.storage.store` accepts.
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return { bytes, usage: imageUsage(response.usage) };
}

function pngBlob(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes], { type: "image/png" });
}

function imageUsage(usage: ImagesResponse["usage"]): TokenUsage {
  return {
    inputTextTokens: usage?.input_tokens_details?.text_tokens ?? 0,
    inputImageTokens: usage?.input_tokens_details?.image_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

/**
 * The legacy OpenAI embedding branch of the `ai/embedding.ts` seam. It exists so the rollback lever
 * (`EMBEDDING_PROVIDER=openai`) keeps working against the historical 1536-d vector space and so the
 * seam's no-fallback contract has a real counterpart to test against. Nothing calls this unless the
 * operator names `openai` explicitly; there is no automatic fallback to it from a local failure.
 */
async function openaiEmbed({ text }: EmbedRequest): Promise<EmbedResult> {
  const started = Date.now();
  const response = await openai().embeddings.create({
    model: modelId(EMBED_MODEL),
    input: text,
    dimensions: EMBEDDING_MODELS.openai.dimensions,
  });
  const vector = response.data[0]?.embedding;
  if (!vector) throw appError("UPSTREAM_FAILED", "Could not embed this item.");
  // Explicitly unpriced, matching pre-Phase-C behavior: the legacy path never carried an embedding
  // COGS line, and `usageToUsd` has NO embedding price in it — its textIn/textOut rates are the
  // image-model table, while text-embedding-3-small lists at $0.02/M. Pricing prompt_tokens through
  // it would fabricate a 125x cost. The final production path is local/$0 regardless.
  return { vector, costUsd: 0, latencyMs: Date.now() - started };
}

/**
 * The two branches of the embedding seam, wired here because this is the file that owns the OpenAI
 * SDK. `localEmbed` is the production path: one HTTP round trip to the self-hosted gateway, $0.
 */
export function embeddingRunners(): EmbeddingRunners {
  return {
    openai: openaiEmbed,
    local: (request) => localEmbed(request, localEmbeddingConfig()),
  };
}

/** Core slots the outfit leaves empty, so the prompt can tell the model what to improvise. */
function missingSlots(slots: Slot[]): Slot[] {
  const present = new Set(slots);
  const missing: Slot[] = [];
  if (!present.has("dress")) {
    if (!present.has("top")) missing.push("top");
    if (!present.has("bottom")) missing.push("bottom");
  }
  if (!present.has("shoes")) missing.push("shoes");
  return missing;
}

/** A short, human-readable reason for the job stepper — never a stack trace. */
function errorText(error: unknown): string {
  if (isAppError(error)) return error.data.message.slice(0, MAX_ERROR_CHARS);
  if (error instanceof OpenAI.APIError) {
    return `OpenAI ${error.status ?? "error"}: ${error.message}`.slice(0, MAX_ERROR_CHARS);
  }
  if (error instanceof Error) return error.message.slice(0, MAX_ERROR_CHARS);
  return String(error).slice(0, MAX_ERROR_CHARS);
}
