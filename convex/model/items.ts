import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertOwner } from "../lib/auth";
import { appError } from "../lib/errors";
import { EMBEDDING_BGE_DIMENSIONS } from "../schema";
import { LIMITS, usageToUsd, type TokenUsage } from "../shared/credits";
import { vItemAttributes } from "../shared/validators";
import { CATEGORY_LABELS, ITEM_STATUSES, type Category } from "../shared/wardrobe";
import type { ItemView } from "../views";
import { removeItemsFromOutfits } from "./outfits";
import { deleteShoppingAdviceForItem } from "./shoppingAdvice";
import { bumpDailyStats } from "./stats";

type Ctx = QueryCtx | MutationCtx;
export type ItemAttributes = Infer<typeof vItemAttributes>;

/**
 * Ownership single source of truth. Processing status (ready/extracting/…) and ownership
 * (owned/considering) are independent dimensions; rows predating the field read as owned so
 * existing wardrobes never disappear.
 */
export function isOwnedItem(item: { ownership?: Doc<"items">["ownership"] }): boolean {
  return item.ownership !== "considering";
}

export function isConsideringItem(item: { ownership?: Doc<"items">["ownership"] }): boolean {
  return item.ownership === "considering";
}

/** What full-text search matches on. Recomputed whenever attributes change. */
export function buildSearchText(attrs: ItemAttributes): string {
  return [
    attrs.name,
    attrs.subcategory,
    CATEGORY_LABELS[attrs.category],
    attrs.category,
    attrs.colours.primary,
    ...attrs.colours.secondary,
    attrs.pattern,
    attrs.material,
    ...attrs.season,
    attrs.formality,
    attrs.fit ?? "",
    attrs.brand ?? "",
    attrs.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function attributesOf(item: Doc<"items">): ItemAttributes {
  return {
    name: item.name,
    category: item.category,
    subcategory: item.subcategory,
    colours: item.colours,
    pattern: item.pattern,
    material: item.material,
    season: item.season,
    formality: item.formality,
    fit: item.fit,
    brand: item.brand,
    description: item.description,
  };
}

export async function toItemView(ctx: Ctx, item: Doc<"items">): Promise<ItemView> {
  const url = item.storageId ? await ctx.storage.getUrl(item.storageId) : null;
  return {
    _id: item._id,
    name: item.name,
    category: item.category,
    subcategory: item.subcategory,
    colours: item.colours,
    pattern: item.pattern,
    material: item.material,
    season: item.season,
    formality: item.formality,
    fit: item.fit,
    brand: item.brand,
    notes: item.notes,
    description: item.description,
    status: item.status,
    wearCount: item.wearCount,
    lastWornAt: item.lastWornAt,
    duplicateOfId: item.duplicateOfId,
    uploadId: item.uploadId,
    ownership: isOwnedItem(item) ? "owned" : "considering",
    url,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function toItemViews(ctx: Ctx, items: Doc<"items">[]): Promise<ItemView[]> {
  return Promise.all(items.map((item) => toItemView(ctx, item)));
}

/** Insert a detected-but-not-yet-extracted item. Status is `extracting` or `needsCredits`. */
export async function insertDetectedItem(
  ctx: MutationCtx,
  input: {
    userId: Id<"users">;
    uploadId: Id<"uploads">;
    attrs: ItemAttributes;
    bbox?: number[];
    status: Extract<Doc<"items">["status"], "extracting" | "needsCredits">;
    /** Shopping imports pass "considering"; normal uploads omit it (owned by default). */
    ownership?: Doc<"items">["ownership"];
  },
): Promise<Id<"items">> {
  const now = Date.now();
  return ctx.db.insert("items", {
    userId: input.userId,
    uploadId: input.uploadId,
    sourceBbox: input.bbox,
    ...input.attrs,
    searchText: buildSearchText(input.attrs),
    status: input.status,
    ...(input.ownership ? { ownership: input.ownership } : {}),
    wearCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * A finished cutout. On a re-extract the item was never taken out of `ready`, so the old blobs are
 * deleted here (once the new ones are stored) and `pendingJobId` is cleared.
 */
export async function markItemReady(
  ctx: MutationCtx,
  itemId: Id<"items">,
  result: {
    storageId: Id<"_storage">;
    thumbStorageId?: Id<"_storage">;
    hex?: string[];
    usage?: TokenUsage;
    /** Provider-specific COGS for providers without SDK token accounting (self-hosted withoutBG). */
    costUsd?: number;
  },
): Promise<void> {
  const item = await ctx.db.get(itemId);
  if (!item) return;
  const usageUsd = result.usage ? usageToUsd(result.usage) : 0;
  const costUsd = result.costUsd ?? (result.usage ? usageUsd : item.costUsd);
  await ctx.db.patch(itemId, {
    storageId: result.storageId,
    thumbStorageId: result.thumbStorageId,
    colours: result.hex ? { ...item.colours, hex: result.hex } : item.colours,
    usage: result.usage,
    costUsd,
    status: "ready",
    pendingJobId: undefined,
    updatedAt: Date.now(),
  });
  if (item.storageId && item.storageId !== result.storageId) await deleteFile(ctx, item.storageId);
  if (item.thumbStorageId && item.thumbStorageId !== result.thumbStorageId) {
    await deleteFile(ctx, item.thumbStorageId);
  }
  await bumpDailyStats(ctx, { itemsExtracted: 1, cogsUsd: costUsd });
}

/**
 * A failed extraction. An item that still has its previous cutout (a re-extract) stays `ready` and
 * only loses `pendingJobId`; an item that never had one becomes `failed` (or `needsCredits`).
 */
export async function markItemFailed(
  ctx: MutationCtx,
  itemId: Id<"items">,
  status: Extract<Doc<"items">["status"], "failed" | "needsCredits"> = "failed",
): Promise<void> {
  const item = await ctx.db.get(itemId);
  if (!item) return;
  // Only a re-extract keeps its status: it never left `ready`, and its old cutout is still there.
  const keepsCutout = item.status === "ready" && item.storageId !== undefined;
  await ctx.db.patch(itemId, {
    status: keepsCutout ? item.status : status,
    pendingJobId: undefined,
    updatedAt: Date.now(),
  });
}

/** Re-extract: the item stays visible and usable while a job rewrites its cutout. */
export async function markItemPending(ctx: MutationCtx, itemId: Id<"items">, jobId: Id<"jobs">): Promise<void> {
  await ctx.db.patch(itemId, { pendingJobId: jobId, updatedAt: Date.now() });
}

/**
 * The purchase/lifecycle transition: a ready considering item joins the owned wardrobe.
 * Idempotent for already-owned items. No extraction, no embedding call, no credit charge,
 * no provider call — the cutout, embedding and provenance all stay exactly as they are.
 */
export async function markItemOwned(ctx: MutationCtx, user: Doc<"users">, itemId: Id<"items">): Promise<boolean> {
  const item = await requireItem(ctx, user, itemId);
  if (item.status !== "ready") {
    throw appError("INVALID_INPUT", "Only ready items can join your wardrobe.");
  }
  // A bought candidate is no longer eligible for "Should I buy this?": its analysis
  // row dies with the transition. No provider call, no credits, no embedding change.
  await deleteShoppingAdviceForItem(ctx, user._id, item._id);
  if (isOwnedItem(item)) return false;
  await ctx.db.patch(item._id, { ownership: "owned", updatedAt: Date.now() });
  return true;
}

/**
 * LEGACY OpenAI embedding writer (1536-d). Retained unchanged as the rollback/reference path for the
 * historical vector space. Production ingest no longer calls it: Step 7 Phase C embeds through
 * `setItemEmbeddingBge` and writes no OpenAI vector, because dual-writing would cost money.
 *
 * Note the `duplicateOfId` parameter below. It is the OLD cosine-threshold duplicate assignment, and
 * it is kept only so a rollback to the legacy path stays byte-for-byte reproducible. The current
 * product decision is that no text embedding assigns `duplicateOfId` (see `setItemEmbeddingBge`).
 */
export async function setItemEmbedding(
  ctx: MutationCtx,
  itemId: Id<"items">,
  embedding: number[],
  duplicateOfId?: Id<"items">,
): Promise<void> {
  const item = await ctx.db.get(itemId);
  if (!item) return;
  const existing = await ctx.db
    .query("itemEmbeddings")
    .withIndex("by_item", (q) => q.eq("itemId", itemId))
    .unique();
  if (existing) await ctx.db.patch(existing._id, { embedding, userId: item.userId });
  else await ctx.db.insert("itemEmbeddings", { itemId, userId: item.userId, embedding });
  await ctx.db.patch(itemId, { duplicateOfId, updatedAt: Date.now() });
}

/**
 * The Step 7 Phase C writer: one 384-d local BGE vector, nothing else.
 *
 * Deliberately separate from `setItemEmbedding` because that function mutates `duplicateOfId` from a
 * cosine threshold. This one:
 *   - asserts the width before touching the database, so a wrong-width vector can never land in
 *     `by_embeddingBge`;
 *   - patches `embeddingBge` only. It never writes the legacy `embedding`, so legacy vectors and
 *     `by_embedding` stay exactly as they are and the rollback path keeps working;
 *   - never reads or writes `duplicateOfId`. Existing user-dismissed and legacy flags are left alone,
 *     and a newly ingested item keeps `duplicateOfId` undefined by construction;
 *   - is idempotent: re-running it replaces the same field with the same vector.
 */
export async function setItemEmbeddingBge(
  ctx: MutationCtx,
  itemId: Id<"items">,
  embeddingBge: number[],
): Promise<void> {
  if (embeddingBge.length !== EMBEDDING_BGE_DIMENSIONS) {
    throw new Error(
      `Refusing to write a ${embeddingBge.length}-dimension vector to embeddingBge; expected exactly ${EMBEDDING_BGE_DIMENSIONS}.`,
    );
  }
  const item = await ctx.db.get(itemId);
  if (!item) return;
  const existing = await ctx.db
    .query("itemEmbeddings")
    .withIndex("by_item", (q) => q.eq("itemId", itemId))
    .unique();
  if (existing) await ctx.db.patch(existing._id, { embeddingBge, userId: item.userId });
  else await ctx.db.insert("itemEmbeddings", { itemId, userId: item.userId, embeddingBge });
}

export async function deleteItemEmbedding(ctx: MutationCtx, itemId: Id<"items">): Promise<void> {
  const existing = await ctx.db
    .query("itemEmbeddings")
    .withIndex("by_item", (q) => q.eq("itemId", itemId))
    .unique();
  if (existing) await ctx.db.delete("itemEmbeddings", existing._id);
}

/** Maps vector-search hits on `itemEmbeddings` back to items that can actually be a duplicate target. */
export async function readyItemsForEmbeddings(
  ctx: Ctx,
  embeddingIds: Id<"itemEmbeddings">[],
  exclude: Id<"items">,
): Promise<Id<"items">[]> {
  const rows = await Promise.all(embeddingIds.map((embeddingId) => ctx.db.get(embeddingId)));
  const items = await Promise.all(
    rows.map((row) => (row && row.itemId !== exclude ? ctx.db.get(row.itemId) : Promise.resolve(null))),
  );
  const ready = items.filter((item): item is Doc<"items"> => item !== null && item.status === "ready");
  // Owned duplicates first: for a shopping candidate, "you already own something similar" is the
  // useful answer; a considering-considering match must not hide it.
  return [...ready.filter(isOwnedItem), ...ready.filter(isConsideringItem)].map((item) => item._id);
}

async function deleteFile(ctx: MutationCtx, storageId: Id<"_storage">): Promise<void> {
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // The blob may already be gone (a retried step, a manual cleanup); the item patch still stands.
  }
}

export async function updateAttributes(
  ctx: MutationCtx,
  item: Doc<"items">,
  patch: Partial<ItemAttributes> & { notes?: string },
): Promise<void> {
  const { notes, ...rest } = patch;
  // Explicit allowlist: unknown keys (notably ownership) can never sneak in, even if a
  // validator ever loosens. Ownership changes only through markItemOwned.
  const attrPatch: Partial<ItemAttributes> = {};
  for (const key of Object.keys(vItemAttributes.fields) as (keyof ItemAttributes)[]) {
    if (rest[key] !== undefined) {
      (attrPatch as Record<string, unknown>)[key] = rest[key];
    }
  }
  const attrs = { ...attributesOf(item), ...attrPatch };
  await ctx.db.patch(item._id, {
    ...attrPatch,
    ...(notes !== undefined ? { notes } : {}),
    searchText: buildSearchText(attrs),
    updatedAt: Date.now(),
  });
}

export async function listByStatus(
  ctx: Ctx,
  userId: Id<"users">,
  status: Doc<"items">["status"],
): Promise<Doc<"items">[]> {
  return ctx.db
    .query("items")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
    .order("desc")
    .take(LIMITS.maxItemsPerUser);
}

/** True as soon as the user has one item in any status — five indexed `first()`s, never a scan. */
export async function hasAnyItem(ctx: Ctx, userId: Id<"users">): Promise<boolean> {
  for (const status of ITEM_STATUSES) {
    const first = await ctx.db
      .query("items")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
      .first();
    if (first) return true;
  }
  return false;
}

/** Ready items, counted up to the wardrobe ceiling (one more tells us the ceiling is already passed). */
export async function countReady(ctx: Ctx, userId: Id<"users">): Promise<number> {
  const items = await ctx.db
    .query("items")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "ready"))
    .take(LIMITS.maxItemsPerUser + 1);
  return items.length;
}

export async function requireItem(ctx: Ctx, user: Doc<"users">, itemId: Id<"items">): Promise<Doc<"items">> {
  return assertOwner(await ctx.db.get(itemId), user, "item");
}

/** Wardrobe listing: newest first, `ready` unless another status is asked for. */
export async function listForUser(
  ctx: Ctx,
  userId: Id<"users">,
  filters: { status?: Doc<"items">["status"]; category?: Category; ownership?: "owned" | "considering" | "all" } = {},
): Promise<Doc<"items">[]> {
  const status = filters.status ?? "ready";
  const category = filters.category;
  // The default wardrobe experience contains OWNED items only; considering candidates are
  // visible through the saved-shopping query. Pass ownership explicitly to override.
  const ownership = filters.ownership ?? "owned";
  const ownedOnly = (rows: Doc<"items">[]) =>
    ownership === "all" ? rows : rows.filter((row) => (ownership === "owned" ? isOwnedItem(row) : isConsideringItem(row)));
  // Bounded by LIMITS.maxItemsPerUser: the wardrobe has a hard ceiling, so one page is the whole list.
  const items = category
    ? (
        await ctx.db
          .query("items")
          .withIndex("by_user_category", (q) => q.eq("userId", userId).eq("category", category))
          .order("desc")
          .take(LIMITS.maxItemsPerUser)
      ).filter((item) => item.status === status)
    : await ctx.db
        .query("items")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
        .order("desc")
        .take(LIMITS.maxItemsPerUser);
  return ownedOnly(items).sort((a, b) => b.createdAt - a.createdAt);
}

export async function searchForUser(ctx: Ctx, userId: Id<"users">, text: string, limit = 50): Promise<Doc<"items">[]> {
  const term = text.trim();
  if (!term) return [];
  // Consistent with the default wardrobe: owned items only, so a candidate never poses as owned.
  return (
    await ctx.db
      .query("items")
      .withSearchIndex("search_text", (q) => q.search("searchText", term.toLowerCase()).eq("userId", userId))
      .take(Math.min(Math.max(limit, 1), 100))
  ).filter(isOwnedItem);
}

export async function listByUpload(ctx: Ctx, uploadId: Id<"uploads">): Promise<Doc<"items">[]> {
  // One photo yields at most LIMITS.maxItemsPerPhoto items, plus re-runs; the take is a safety belt.
  return ctx.db
    .query("items")
    .withIndex("by_upload", (q) => q.eq("uploadId", uploadId))
    .take(LIMITS.maxItemsPerPhoto * 4);
}

export async function setStatus(
  ctx: MutationCtx,
  user: Doc<"users">,
  itemIds: Id<"items">[],
  status: Extract<Doc<"items">["status"], "hidden" | "ready">,
): Promise<void> {
  for (const itemId of itemIds) {
    const item = await requireItem(ctx, user, itemId);
    await ctx.db.patch(item._id, { status, updatedAt: Date.now() });
  }
}

export async function setCategory(
  ctx: MutationCtx,
  user: Doc<"users">,
  itemIds: Id<"items">[],
  category: Category,
): Promise<void> {
  for (const itemId of itemIds) {
    const item = await requireItem(ctx, user, itemId);
    await updateAttributes(ctx, item, { category });
  }
}

export async function markWorn(ctx: MutationCtx, item: Doc<"items">, wornAt: number): Promise<void> {
  await ctx.db.patch(item._id, { wearCount: item.wearCount + 1, lastWornAt: wornAt, updatedAt: Date.now() });
}

/** Deletes items with their cutout files and unhooks them from every outfit slot that used them. */
export async function removeItems(ctx: MutationCtx, user: Doc<"users">, itemIds: Id<"items">[]): Promise<void> {
  const items = await Promise.all(itemIds.map((itemId) => requireItem(ctx, user, itemId)));
  for (const item of items) {
    if (item.storageId) await deleteFile(ctx, item.storageId);
    if (item.thumbStorageId) await deleteFile(ctx, item.thumbStorageId);
    await deleteItemEmbedding(ctx, item._id);
    // The advice cache follows the candidate: no orphan rows accumulate from
    // save → analyze → delete cycles. Missing cache is a no-op by contract.
    await deleteShoppingAdviceForItem(ctx, user._id, item._id);
    await ctx.db.delete("items", item._id);
  }
  await removeItemsFromOutfits(
    ctx,
    user._id,
    items.map((item) => item._id),
  );
}
