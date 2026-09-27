import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import {
  createOutfit,
  listSavedPage,
  listSavedSummaries,
  markOutfitWorn,
  removeOutfit,
  requireOutfit,
  toOutfitView,
  updateOutfit,
  validateSlots,
} from "./model/outfits";
import { vOutfitSlots } from "./shared/validators";
import { vOutfitView, vPaginated } from "./views";

const vOutfitSource = v.union(v.literal("manual"), v.literal("agent"));

/** Saved outfits, newest saved first. Agent proposals stay out until the user saves them. */
export const list = query({
  args: { paginationOpts: paginationOptsValidator, source: v.optional(vOutfitSource) },
  returns: vPaginated(vOutfitView),
  handler: async (ctx, { paginationOpts, source }) => {
    const user = await requireUser(ctx);
    const result = await listSavedPage(ctx, user._id, paginationOpts, source);
    return { ...result, page: await Promise.all(result.page.map((outfit) => toOutfitView(ctx, outfit))) };
  },
});

/** Names only, for select menus and filters that must not subscribe to the whole list. */
export const listSummaries = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("outfits"), name: v.string() })),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return listSavedSummaries(ctx, user._id);
  },
});

/** Takes a raw string so a malformed or foreign id renders the not-found page instead of throwing. */
export const get = query({
  args: { outfitId: v.string() },
  returns: v.union(vOutfitView, v.null()),
  handler: async (ctx, { outfitId }) => {
    const user = await requireUser(ctx);
    const id = ctx.db.normalizeId("outfits", outfitId);
    if (!id) return null;
    const outfit = await ctx.db.get(id);
    if (!outfit || outfit.userId !== user._id) return null;
    return toOutfitView(ctx, outfit);
  },
});

/** Validates every slot id belongs to the user and matches the slot's categories (SLOT_CATEGORIES). */
export const create = mutation({
  args: { name: v.string(), slots: vOutfitSlots, occasion: v.optional(v.string()) },
  returns: v.id("outfits"),
  handler: async (ctx, { name, slots, occasion }) => {
    const user = await requireUser(ctx);
    await validateSlots(ctx, user, slots);
    return createOutfit(ctx, user, { name, slots, occasion });
  },
});

export const update = mutation({
  args: {
    outfitId: v.id("outfits"),
    patch: v.object({
      name: v.optional(v.string()),
      slots: v.optional(vOutfitSlots),
      /** `null` (or an empty string) clears the occasion; omitting the key leaves it alone. */
      occasion: v.optional(v.union(v.string(), v.null())),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { outfitId, patch }) => {
    const user = await requireUser(ctx);
    const outfit = await requireOutfit(ctx, user, outfitId);
    if (patch.slots) await validateSlots(ctx, user, patch.slots);
    await updateOutfit(ctx, outfit, patch);
    return null;
  },
});

/** Deletes the outfit and its renders (files included). */
export const remove = mutation({
  args: { outfitId: v.id("outfits") },
  returns: v.null(),
  handler: async (ctx, { outfitId }) => {
    const user = await requireUser(ctx);
    const outfit = await requireOutfit(ctx, user, outfitId);
    await removeOutfit(ctx, outfit);
    return null;
  },
});

/** Adds a worn date and bumps wearCount / lastWornAt on every item in the outfit. */
export const markWorn = mutation({
  args: { outfitId: v.id("outfits"), wornAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { outfitId, wornAt }) => {
    const user = await requireUser(ctx);
    const outfit = await requireOutfit(ctx, user, outfitId);
    await markOutfitWorn(ctx, outfit, wornAt ?? Date.now());
    return null;
  },
});
