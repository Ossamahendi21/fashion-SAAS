import { start } from "@convex-dev/workflow";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertOwner } from "../lib/auth";
import { appError } from "../lib/errors";
import { LIMITS } from "../shared/credits";
import { INGEST_STEPS } from "../shared/jobs";
import { ACCEPTED_IMAGE_TYPES, MAX_UPLOAD_BYTES } from "../shared/wardrobe";
import { assertStoredImage } from "./uploads";
import { bumpUsageCounter } from "./users";
import { assertBelowJobLimit, createJob, setStep, setWorkflowId } from "./jobs";
import { isConsideringItem, isOwnedItem, listByUpload, toItemView } from "./items";
import type { ItemView } from "../views";

type Ctx = QueryCtx | MutationCtx;

/** Product title cap: a descriptive hint, never instructions. */
export const MAX_PRODUCT_TITLE_CHARS = 160;
/** File names follow the existing upload rules, with an explicit length cap. */
export const MAX_SHOPPING_FILE_NAME_CHARS = 128;
/** Source page URLs are provenance only; bounded and never fetched. */
export const MAX_SOURCE_PAGE_URL_CHARS = 2048;
/** Opaque client-generated idempotency keys: URL-safe characters only. */
const CLIENT_IMPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type ShoppingImportInput = {
  storageId: Id<"_storage">;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  productTitle?: string;
  sourcePageUrl?: string;
  clientImportId: string;
};

export type ShoppingImportState = "processing" | "ready" | "needs_credits" | "no_item" | "failed";

export type ShoppingImportStatus = {
  state: ShoppingImportState;
  uploadId: Id<"uploads">;
  jobId?: Id<"jobs">;
  itemId?: Id<"items">;
  itemName?: string;
  itemUrl?: string;
  duplicateOfId?: Id<"items">;
  /** Normalized ownership of the returned item, so clients render truthfully. */
  ownership?: "owned" | "considering";
};

export type SavedShoppingItem = {
  item: ItemView;
  sourceTitle?: string;
  sourcePageUrl?: string;
  createdAt: number;
};

/**
 * The product title is an UNTRUSTED descriptive hint for the targeted detector, never
 * instructions. Collapse whitespace (blocking newline smuggling) and cap the length.
 */
export function sanitizeProductTitle(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.replace(/\s+/g, " ").trim().slice(0, MAX_PRODUCT_TITLE_CHARS);
  return title.length > 0 ? title : undefined;
}

/**
 * Source page URLs are stored as provenance only and never fetched. Reject credentials,
 * fragments, non-http(s) schemes and obviously local/private hosts; anything else invalid
 * is dropped (not stored) rather than failing the whole save.
 */
export function sanitizeSourcePageUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOURCE_PAGE_URL_CHARS) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  if (
    host === "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":")
  ) {
    return undefined;
  }
  url.hash = "";
  const href = url.href;
  return href.length > 0 && href.length <= MAX_SOURCE_PAGE_URL_CHARS ? href : undefined;
}

/** Idempotency keys are opaque but must be bounded and URL-safe so they cannot smuggle meaning. */
export function sanitizeClientImportId(value: string): string {
  if (typeof value !== "string" || !CLIENT_IMPORT_ID_PATTERN.test(value)) {
    throw appError("INVALID_INPUT", "That save request was malformed. Try saving again.");
  }
  return value;
}

function assertShoppingFile(input: ShoppingImportInput): void {
  if (typeof input.fileName !== "string" || input.fileName.length === 0 || input.fileName.length > MAX_SHOPPING_FILE_NAME_CHARS) {
    throw appError("INVALID_INPUT", "That image has an unusable file name.");
  }
  if (!Object.keys(ACCEPTED_IMAGE_TYPES).includes(input.mimeType)) {
    throw appError("INVALID_INPUT", `"${input.fileName}" isn't a supported image (${input.mimeType}).`, {
      accepted: Object.keys(ACCEPTED_IMAGE_TYPES),
    });
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw appError(
      "INVALID_INPUT",
      `"${input.fileName}" is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`,
      { maxBytes: MAX_UPLOAD_BYTES },
    );
  }
}

/**
 * Registers one shopping import: idempotent per (authenticated user, clientImportId), verified
 * against the stored blob, then handed to the dedicated shopping workflow. Never touches Live
 * Mirror state. Uses requireUser (not requireOnboarded): cataloguing needs no avatar.
 */
export async function registerShoppingImport(
  ctx: MutationCtx,
  user: Doc<"users">,
  input: ShoppingImportInput,
): Promise<{ uploadId: Id<"uploads">; jobId: Id<"jobs">; deduped: boolean }> {
  const clientImportId = sanitizeClientImportId(input.clientImportId);
  const existing = await ctx.db
    .query("uploads")
    .withIndex("by_user_clientImportId", (q) => q.eq("userId", user._id).eq("clientImportId", clientImportId))
    .unique();
  if (existing?.jobId) return { uploadId: existing._id, jobId: existing.jobId, deduped: true };

  assertShoppingFile(input);
  // The stored blob is authoritative: client mime/size claims are checked, never trusted.
  await assertStoredImage(ctx, input.storageId, input.fileName);
  await assertBelowJobLimit(ctx, user._id);
  // Targeted detection uses the same free detect accounting as normal scans.
  await bumpUsageCounter(ctx, user._id, "detect", LIMITS.detectCallsPerDay, 1);

  const now = Date.now();
  const sourceTitle = sanitizeProductTitle(input.productTitle);
  const sourcePageUrl = sanitizeSourcePageUrl(input.sourcePageUrl);
  const uploadId = await ctx.db.insert("uploads", {
    userId: user._id,
    batchId: `shopping:${clientImportId}`,
    storageId: input.storageId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    status: "queued",
    createdAt: now,
    source: "shopping",
    ...(sourcePageUrl ? { sourcePageUrl } : {}),
    ...(sourceTitle ? { sourceTitle } : {}),
    clientImportId,
  });
  const jobId = await createJob(ctx, user, {
    type: "ingest",
    steps: [{ key: INGEST_STEPS.upload }, { key: INGEST_STEPS.detect }],
    uploadId,
  });
  await setStep(ctx, jobId, INGEST_STEPS.upload, { status: "done" });
  await ctx.db.patch(uploadId, { jobId });

  const workflowId = await start(
    ctx,
    internal.workflows.ingest.scanShoppingImport,
    { uploadId, jobId, productTitle: sourceTitle ?? "" },
    { onComplete: internal.workflows.ingest.onIngestComplete, context: { jobId } },
  );
  await setWorkflowId(ctx, jobId, workflowId);
  return { uploadId, jobId, deduped: false };
}

/**
 * Small product-focused status for the extension. Ownership is enforced; nothing provider-
 * internal (prompts, token usage, raw errors, other users' ids) ever leaves the server.
 */
export async function readShoppingImportStatus(
  ctx: Ctx,
  user: Doc<"users">,
  uploadId: Id<"uploads">,
): Promise<ShoppingImportStatus> {
  const upload = assertOwner(await ctx.db.get(uploadId), user, "import");
  const items = await listByUpload(ctx, upload._id);
  const ready = items.find((item) => item.status === "ready");
  if (ready) {
    const itemUrl = ready.storageId ? await ctx.storage.getUrl(ready.storageId) : null;
    return {
      state: "ready",
      uploadId: upload._id,
      ...(upload.jobId ? { jobId: upload.jobId } : {}),
      itemId: ready._id,
      itemName: ready.name,
      ...(itemUrl ? { itemUrl } : {}),
      ...(ready.duplicateOfId ? { duplicateOfId: ready.duplicateOfId } : {}),
      ownership: isOwnedItem(ready) ? ("owned" as const) : ("considering" as const),
    };
  }
  const needsCredits = items.find((item) => item.status === "needsCredits");
  if (needsCredits) {
    return {
      state: "needs_credits",
      uploadId: upload._id,
      ...(upload.jobId ? { jobId: upload.jobId } : {}),
      itemId: needsCredits._id,
      itemName: needsCredits.name,
      ownership: isOwnedItem(needsCredits) ? ("owned" as const) : ("considering" as const),
    };
  }
  if (upload.jobId) {
    const job = await ctx.db.get(upload.jobId);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      return { state: "failed", uploadId: upload._id, jobId: upload.jobId };
    }
  }
  if (upload.status === "done" && items.length === 0) {
    return { state: "no_item", uploadId: upload._id, ...(upload.jobId ? { jobId: upload.jobId } : {}) };
  }
  return { state: "processing", uploadId: upload._id, ...(upload.jobId ? { jobId: upload.jobId } : {}) };
}

/**
 * Saved shopping candidates: considering items with their provenance, newest first.
 * Ownership enforced (own rows only). Bounded by the wardrobe ceiling read, so no new index
 * is needed. The future Saved page reads this; the default wardrobe never sees these rows.
 */
export async function listSavedShoppingItems(
  ctx: Ctx,
  user: Doc<"users">,
): Promise<SavedShoppingItem[]> {
  const uploads = await ctx.db
    .query("uploads")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .order("desc")
    .take(LIMITS.maxItemsPerUser);
  const saved: SavedShoppingItem[] = [];
  for (const upload of uploads) {
    if (upload.source !== "shopping") continue;
    const items = await listByUpload(ctx, upload._id);
    for (const item of items) {
      if (!isConsideringItem(item)) continue;
      saved.push({
        item: await toItemView(ctx, item),
        ...(upload.sourceTitle ? { sourceTitle: upload.sourceTitle } : {}),
        ...(upload.sourcePageUrl ? { sourcePageUrl: upload.sourcePageUrl } : {}),
        createdAt: item.createdAt,
      });
    }
  }
  return saved.sort((a, b) => b.createdAt - a.createdAt);
}
