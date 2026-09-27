import type { PaginationOptions, PaginationResult } from "convex/server";
import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertOwner } from "../lib/auth";
import { appError } from "../lib/errors";
import type { vOutfitSlots } from "../shared/validators";
import { LAYER_ORDER, SLOT_CATEGORIES, type Slot } from "../shared/wardrobe";
import type { ItemSummary, OutfitView } from "../views";
import { assertJobFinished } from "./jobs";

type Ctx = QueryCtx | MutationCtx;
export type OutfitSlots = Infer<typeof vOutfitSlots>;

/** How far back a card's cover render and render count look. */
const COVER_SCAN_LIMIT = 50;
const OUTFIT_SUMMARY_LIMIT = 200;
/** How many of the user's newest outfits the item page checks for a given item. */
const CONTAINING_SCAN_LIMIT = 500;

export function slotItemIds(slots: OutfitSlots): Id<"items">[] {
  const single = [slots.outerwear, slots.top, slots.bottom, slots.dress, slots.shoes].filter((id): id is Id<"items"> =>
    Boolean(id),
  );
  return [...single, ...slots.accessories];
}

export async function toItemSummary(ctx: Ctx, item: Doc<"items">): Promise<ItemSummary> {
  return {
    _id: item._id,
    name: item.name,
    category: item.category,
    url: item.storageId ? await ctx.storage.getUrl(item.storageId) : null,
  };
}

/** Loads every item in the slots (owned, not deleted). Missing items are dropped silently. */
export async function resolveSlotItems(ctx: Ctx, slots: OutfitSlots): Promise<Map<Id<"items">, Doc<"items">>> {
  const docs = await Promise.all(slotItemIds(slots).map((id) => ctx.db.get(id)));
  const map = new Map<Id<"items">, Doc<"items">>();
  for (const doc of docs) if (doc) map.set(doc._id, doc);
  return map;
}

/** Items in rendering layer order (inner → outer) with the slot they occupy. */
export async function layeredItems(ctx: Ctx, slots: OutfitSlots): Promise<Array<{ slot: Slot; item: Doc<"items"> }>> {
  const map = await resolveSlotItems(ctx, slots);
  const ordered: Array<{ slot: Slot; item: Doc<"items"> }> = [];
  for (const slot of LAYER_ORDER) {
    const ids = slot === "accessories" ? slots.accessories : slots[slot] ? [slots[slot] as Id<"items">] : [];
    for (const id of ids) {
      const item = map.get(id);
      if (item) ordered.push({ slot, item });
    }
  }
  return ordered;
}

/**
 * Throws INVALID_INPUT unless every id belongs to `user`, is ready, and matches its slot's categories.
 * Returns the human-readable problems instead when `collect` is true (used by the agent surface).
 */
export async function validateSlots(
  ctx: Ctx,
  user: Doc<"users">,
  slots: OutfitSlots,
  collect = false,
): Promise<string[]> {
  const problems: string[] = [];
  const map = await resolveSlotItems(ctx, slots);
  const check = (slot: Slot, id: Id<"items"> | undefined) => {
    if (!id) return;
    const item = map.get(id);
    if (!item || item.userId !== user._id) return problems.push(`${slot}: item ${id} is not in your wardrobe`);
    if (item.status !== "ready") return problems.push(`${slot}: "${item.name}" isn't ready to use`);
    if (!SLOT_CATEGORIES[slot].includes(item.category))
      return problems.push(`${slot}: "${item.name}" is a ${item.category}, not ${slot}`);
  };
  check("outerwear", slots.outerwear);
  check("top", slots.top);
  check("bottom", slots.bottom);
  check("dress", slots.dress);
  check("shoes", slots.shoes);
  for (const id of slots.accessories) check("accessories", id);
  if (slots.dress && (slots.top || slots.bottom)) problems.push("a dress replaces top and bottom");
  if (slotItemIds(slots).length === 0) problems.push("an outfit needs at least one item");
  if (problems.length > 0 && !collect) throw appError("INVALID_INPUT", problems[0], { problems });
  return problems;
}

export async function toOutfitView(ctx: Ctx, outfit: Doc<"outfits">): Promise<OutfitView> {
  const map = await resolveSlotItems(ctx, outfit.slots);
  const summary = async (id: Id<"items"> | undefined) => {
    const item = id ? map.get(id) : undefined;
    return item ? toItemSummary(ctx, item) : undefined;
  };
  // Bounded on purpose: the cover is the newest finished render and the badge count is a hint, not an
  // audit, so this reads the last COVER_SCAN_LIMIT renders of the outfit instead of collecting them all.
  const recent = await ctx.db
    .query("renders")
    .withIndex("by_outfit", (q) => q.eq("outfitId", outfit._id))
    .order("desc")
    .take(COVER_SCAN_LIMIT);
  const done = recent.filter((render) => render.status === "done");
  const cover = done.find((render) => render.storageId);
  return {
    _id: outfit._id,
    name: outfit.name,
    slots: outfit.slots,
    items: {
      outerwear: await summary(outfit.slots.outerwear),
      top: await summary(outfit.slots.top),
      bottom: await summary(outfit.slots.bottom),
      dress: await summary(outfit.slots.dress),
      shoes: await summary(outfit.slots.shoes),
      accessories: (await Promise.all(outfit.slots.accessories.map(summary))).filter((s): s is ItemSummary =>
        Boolean(s),
      ),
    },
    occasion: outfit.occasion,
    brief: outfit.brief,
    reasoning: outfit.reasoning,
    source: outfit.source,
    threadId: outfit.threadId,
    savedAt: outfit.savedAt,
    wornOn: outfit.wornOn,
    renderCount: done.length,
    coverUrl: cover?.storageId ? await ctx.storage.getUrl(cover.storageId) : null,
    createdAt: outfit.createdAt,
    updatedAt: outfit.updatedAt,
  };
}

/**
 * One page of the user's saved outfits, newest saved first. `savedAt` is unset on agent proposals and
 * undefined sorts below every number, so `.gt("savedAt", 0)` leaves them out of the range entirely.
 * `source` is applied to the page in memory — the read is already bounded by the index range, and the
 * alternative (`.filter` on the query) reads exactly the same documents.
 */
export async function listSavedPage(
  ctx: Ctx,
  userId: Id<"users">,
  paginationOpts: PaginationOptions,
  source?: Doc<"outfits">["source"],
): Promise<PaginationResult<Doc<"outfits">>> {
  const result = await ctx.db
    .query("outfits")
    .withIndex("by_user_savedAt", (q) => q.eq("userId", userId).gt("savedAt", 0))
    .order("desc")
    .paginate(paginationOpts);
  if (!source) return result;
  return { ...result, page: result.page.filter((outfit) => outfit.source === source) };
}

/** Names of the newest saved outfits, for select menus. Capped: a picker with 200 entries is already too long. */
export async function listSavedSummaries(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<Array<{ _id: Id<"outfits">; name: string }>> {
  const outfits = await ctx.db
    .query("outfits")
    .withIndex("by_user_savedAt", (q) => q.eq("userId", userId).gt("savedAt", 0))
    .order("desc")
    .take(OUTFIT_SUMMARY_LIMIT);
  return outfits.map((outfit) => ({ _id: outfit._id, name: outfit.name }));
}

export async function requireOutfit(ctx: Ctx, user: Doc<"users">, outfitId: Id<"outfits">): Promise<Doc<"outfits">> {
  return assertOwner(await ctx.db.get(outfitId), user, "outfit");
}

export async function createOutfit(
  ctx: MutationCtx,
  user: Doc<"users">,
  input: {
    name: string;
    slots: OutfitSlots;
    occasion?: string;
    brief?: string;
    reasoning?: string;
    source?: Doc<"outfits">["source"];
    threadId?: Id<"threads">;
  },
): Promise<Id<"outfits">> {
  const now = Date.now();
  const source = input.source ?? "manual";
  return ctx.db.insert("outfits", {
    userId: user._id,
    name: input.name.trim() || "Untitled outfit",
    slots: input.slots,
    occasion: input.occasion?.trim() ? input.occasion.trim() : undefined,
    brief: input.brief,
    reasoning: input.reasoning,
    source,
    threadId: input.threadId,
    // An outfit the user built is listed straight away; an agent proposal waits for `markOutfitSaved`.
    savedAt: source === "manual" ? now : undefined,
    wornOn: [],
    createdAt: now,
    updatedAt: now,
  });
}

/** `occasion: null` (or an empty string) clears the field; leaving the key out keeps whatever is there. */
export async function updateOutfit(
  ctx: MutationCtx,
  outfit: Doc<"outfits">,
  patch: { name?: string; slots?: OutfitSlots; occasion?: string | null },
): Promise<void> {
  await ctx.db.patch(outfit._id, {
    ...(patch.name !== undefined ? { name: patch.name.trim() || outfit.name } : {}),
    ...(patch.slots !== undefined ? { slots: patch.slots } : {}),
    ...(patch.occasion !== undefined ? { occasion: patch.occasion?.trim() ? patch.occasion.trim() : undefined } : {}),
    updatedAt: Date.now(),
  });
}

/** Deletes the outfit, every render of it and the render files. Proposals keep pointing at nothing by design. */
export async function removeOutfit(ctx: MutationCtx, outfit: Doc<"outfits">): Promise<void> {
  const renders = await ctx.db
    .query("renders")
    .withIndex("by_outfit", (q) => q.eq("outfitId", outfit._id))
    .collect();
  for (const jobId of new Set(renders.map((render) => render.jobId))) {
    await assertJobFinished(ctx, jobId);
  }
  for (const render of renders) {
    if (render.storageId) await ctx.storage.delete(render.storageId);
    await ctx.db.delete("renders", render._id);
  }
  await ctx.db.delete("outfits", outfit._id);
}

/** Records a wear on the outfit and on every item it uses. */
export async function markOutfitWorn(ctx: MutationCtx, outfit: Doc<"outfits">, wornAt: number): Promise<void> {
  await ctx.db.patch(outfit._id, { wornOn: [...outfit.wornOn, wornAt], updatedAt: Date.now() });
  const map = await resolveSlotItems(ctx, outfit.slots);
  for (const item of map.values()) {
    await ctx.db.patch(item._id, { wearCount: item.wearCount + 1, lastWornAt: wornAt, updatedAt: Date.now() });
  }
}

/** Strips deleted items out of every outfit that referenced them. */
export async function removeItemsFromOutfits(
  ctx: MutationCtx,
  userId: Id<"users">,
  itemIds: Id<"items">[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const removed = new Set<Id<"items">>(itemIds);
  const outfits = await ctx.db
    .query("outfits")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const outfit of outfits) {
    const slots = outfit.slots;
    const drop = (id: Id<"items"> | undefined) => (id && removed.has(id) ? undefined : id);
    const next: OutfitSlots = {
      outerwear: drop(slots.outerwear),
      top: drop(slots.top),
      bottom: drop(slots.bottom),
      dress: drop(slots.dress),
      shoes: drop(slots.shoes),
      accessories: slots.accessories.filter((id) => !removed.has(id)),
    };
    const changed =
      next.outerwear !== slots.outerwear ||
      next.top !== slots.top ||
      next.bottom !== slots.bottom ||
      next.dress !== slots.dress ||
      next.shoes !== slots.shoes ||
      next.accessories.length !== slots.accessories.length;
    if (changed) await ctx.db.patch(outfit._id, { slots: next, updatedAt: Date.now() });
  }
}

/**
 * Outfits whose slots reference an item, for the item detail screen. There is no index from item to
 * outfit, so this reads the user's newest outfits and matches in memory — bounded because the item
 * page subscribes to it.
 */
export async function listContainingItem(
  ctx: Ctx,
  userId: Id<"users">,
  itemId: Id<"items">,
): Promise<Doc<"outfits">[]> {
  const outfits = await ctx.db
    .query("outfits")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .take(CONTAINING_SCAN_LIMIT);
  return outfits.filter((outfit) => slotItemIds(outfit.slots).includes(itemId));
}

/** Lists an outfit in /outfits: manual outfits at creation, agent proposals when the user keeps them. Idempotent. */
export async function markOutfitSaved(
  ctx: MutationCtx,
  outfit: Doc<"outfits">,
  savedAt: number = Date.now(),
): Promise<void> {
  if (outfit.savedAt !== undefined) return;
  await ctx.db.patch(outfit._id, { savedAt, updatedAt: savedAt });
}
