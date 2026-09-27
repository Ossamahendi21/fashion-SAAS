import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOnboarded, requireUser } from "./lib/auth";
import { appError } from "./lib/errors";
import {
  hasAnyItem,
  listByUpload as listByUploadDocs,
  listForUser,
  markWorn as markItemWorn,
  removeItems,
  requireItem,
  searchForUser,
  setCategory as setItemCategory,
  setStatus as setItemStatus,
  toItemView,
  toItemViews,
  updateAttributes,
} from "./model/items";
import { listContainingItem, toOutfitView } from "./model/outfits";
import { startExtractionJob } from "./model/uploads";
import { vCategory, vItemAttributes, vItemStatus } from "./shared/validators";
import { vItemView, vOutfitView } from "./views";

/**
 * The user's items. Defaults to `ready`; pass `status` for hidden / needsCredits / failed views.
 * Personal wardrobes are small, so filtering by colour/season/text happens client-side on this list.
 */
export const list = query({
  args: { status: v.optional(vItemStatus), category: v.optional(vCategory) },
  returns: v.array(vItemView),
  handler: async (ctx, { status, category }) => {
    const user = await requireUser(ctx);
    return toItemViews(ctx, await listForUser(ctx, user._id, { status, category }));
  },
});

/** Full-text search over name, colours, category, material (search index `search_text`). */
export const search = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  returns: v.array(vItemView),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return toItemViews(ctx, await searchForUser(ctx, user._id, args.query, args.limit ?? 50));
  },
});

/** Every item of one upload, in any status, for the /add tiles. Ownership comes from the upload. */
export const listByUpload = query({
  args: { uploadId: v.id("uploads") },
  returns: v.array(vItemView),
  handler: async (ctx, { uploadId }) => {
    const user = await requireUser(ctx);
    const upload = await ctx.db.get(uploadId);
    if (!upload || upload.userId !== user._id) return [];
    return toItemViews(ctx, await listByUploadDocs(ctx, upload._id));
  },
});

/** Does the wardrobe hold anything at all (any status)? Cheap enough to drive an empty state. */
export const hasAny = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return hasAnyItem(ctx, user._id);
  },
});

/** A malformed, unknown or foreign id is "not found", never a validator error in the client. */
export const get = query({
  args: { itemId: v.string() },
  returns: v.union(
    v.object({
      item: vItemView,
      /** Outfits that include this item. */
      outfits: v.array(vOutfitView),
      /** Source photo, when it still exists. */
      sourceUrl: v.union(v.string(), v.null()),
      duplicateOf: v.union(vItemView, v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { itemId }) => {
    const user = await requireUser(ctx);
    const id = ctx.db.normalizeId("items", itemId);
    const item = id ? await ctx.db.get(id) : null;
    if (!item || item.userId !== user._id) return null;

    const outfits = await listContainingItem(ctx, user._id, item._id);
    const upload = item.uploadId ? await ctx.db.get(item.uploadId) : null;
    const duplicate = item.duplicateOfId ? await ctx.db.get(item.duplicateOfId) : null;
    return {
      item: await toItemView(ctx, item),
      outfits: await Promise.all(outfits.map((outfit) => toOutfitView(ctx, outfit))),
      sourceUrl: upload ? await ctx.storage.getUrl(upload.storageId) : null,
      duplicateOf: duplicate && duplicate.userId === user._id ? await toItemView(ctx, duplicate) : null,
    };
  },
});

/** Edit attributes. Recomputes `searchText`; leaves the cutout alone. */
export const update = mutation({
  args: {
    itemId: v.id("items"),
    patch: v.object({
      name: v.optional(v.string()),
      category: v.optional(vCategory),
      subcategory: v.optional(v.string()),
      colours: v.optional(vItemAttributes.fields.colours),
      pattern: v.optional(v.string()),
      material: v.optional(v.string()),
      season: v.optional(vItemAttributes.fields.season),
      formality: v.optional(vItemAttributes.fields.formality),
      fit: v.optional(vItemAttributes.fields.fit),
      brand: v.optional(v.string()),
      notes: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { itemId, patch }) => {
    const user = await requireUser(ctx);
    const item = await requireItem(ctx, user, itemId);
    await updateAttributes(ctx, item, patch);
    return null;
  },
});

/** Bulk hide / unhide. */
export const setStatus = mutation({
  args: { itemIds: v.array(v.id("items")), status: v.union(v.literal("hidden"), v.literal("ready")) },
  returns: v.null(),
  handler: async (ctx, { itemIds, status }) => {
    const user = await requireUser(ctx);
    await setItemStatus(ctx, user, itemIds, status);
    return null;
  },
});

export const setCategory = mutation({
  args: { itemIds: v.array(v.id("items")), category: vCategory },
  returns: v.null(),
  handler: async (ctx, { itemIds, category }) => {
    const user = await requireUser(ctx);
    await setItemCategory(ctx, user, itemIds, category);
    return null;
  },
});

/** Deletes items and their files; removes them from outfit slots. */
export const remove = mutation({
  args: { itemIds: v.array(v.id("items")) },
  returns: v.null(),
  handler: async (ctx, { itemIds }) => {
    const user = await requireUser(ctx);
    await removeItems(ctx, user, itemIds);
    return null;
  },
});

export const markWorn = mutation({
  args: { itemId: v.id("items") },
  returns: v.null(),
  handler: async (ctx, { itemId }) => {
    const user = await requireUser(ctx);
    const item = await requireItem(ctx, user, itemId);
    await markItemWorn(ctx, item, Date.now());
    return null;
  },
});

/** Re-extracts the cutout from the source photo (1 credit) in a new job. */
export const reextract = mutation({
  args: { itemId: v.id("items") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, { itemId }) => {
    const user = await requireOnboarded(ctx);
    const item = await requireItem(ctx, user, itemId);
    if (!item.uploadId || !(await ctx.db.get(item.uploadId))) {
      throw appError("INVALID_INPUT", "The original photo is gone, so this item can't be re-extracted.");
    }
    if (item.pendingJobId) {
      throw appError("ITEM_BUSY", "This item is already being re-extracted.", { jobId: item.pendingJobId });
    }
    const jobId = await startExtractionJob(ctx, user, [item._id], item.uploadId);
    return { jobId };
  },
});

/** Marks a flagged duplicate as a distinct item (clears duplicateOfId). */
export const dismissDuplicate = mutation({
  args: { itemId: v.id("items") },
  returns: v.null(),
  handler: async (ctx, { itemId }) => {
    const user = await requireUser(ctx);
    const item = await requireItem(ctx, user, itemId);
    await ctx.db.patch(item._id, { duplicateOfId: undefined, updatedAt: Date.now() });
    return null;
  },
});
