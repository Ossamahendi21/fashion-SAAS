import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { LIMITS, detectUsageToUsd } from "../shared/credits";
import type { RawStylingSuggestion } from "../shared/validators";
import type { ItemSummary } from "../views";
import type { StylingWardrobeItem } from "../ai/prompts";
import { listForUser, requireItem } from "./items";
import {
  createOutfit,
  resolveSlotItems,
  slotItemIds,
  toItemSummary,
  validateSlots,
  type OutfitSlots,
} from "./outfits";
import { bumpDailyStats } from "./stats";
import { addProposal, createThread } from "./threads";
import { bumpUsageCounter } from "./users";

/** V1 suggestion cap: one click produces a small set, never unbounded generation. */
export const MAX_STYLING_SUGGESTIONS = 3;
/** Minimum other ready items for the model to have something to work with. */
export const MIN_OTHER_READY_ITEMS = 1;

export const SMALL_WARDROBE_NOTE =
  "We saved this item, but you need a few more wardrobe pieces before we can build complete outfits around it.";

export type StylingContext = {
  item: StylingWardrobeItem;
  wardrobe: StylingWardrobeItem[];
  prefs: Doc<"users">["prefs"];
};

export type PersistedSuggestion = {
  outfitId: Id<"outfits">;
  name: string;
  reasoning: string;
  items: ItemSummary[];
};

function toWardrobeItem(item: Doc<"items">): StylingWardrobeItem {
  return {
    id: item._id,
    name: item.name,
    category: item.category,
    subcategory: item.subcategory,
    colours: [item.colours.primary, ...item.colours.secondary].filter((colour) => colour.length > 0),
    pattern: item.pattern,
    material: item.material,
    season: [...item.season],
    formality: item.formality,
  };
}

/**
 * Loads everything the stylist needs for one item, derived server-side from the authenticated
 * user. Throws NOT_FOUND for missing/foreign items and INVALID_INPUT for items that are not
 * ready to style.
 */
export async function getStylingContext(
  ctx: QueryCtx,
  user: Doc<"users">,
  itemId: Id<"items">,
): Promise<StylingContext> {
  const item = await requireItem(ctx, user, itemId);
  if (item.status !== "ready") {
    throw appError("INVALID_INPUT", "That item isn't ready to style yet.");
  }
  const wardrobe = (await listForUser(ctx, user._id, { status: "ready" })).filter(
    (row) => row._id !== item._id,
  );
  return { item: toWardrobeItem(item), wardrobe: wardrobe.map(toWardrobeItem), prefs: user.prefs };
}

/** True when there is nothing worth spending an AI call on. */
export function stylingTooSmall(otherReadyCount: number): boolean {
  return otherReadyCount < MIN_OTHER_READY_ITEMS;
}

/**
 * One styling request costs one turn of the existing stylist daily cap — the same rule the
 * conversational stylist lives under. Throws RATE_LIMITED past the cap.
 */
export async function consumeStylingTurn(ctx: MutationCtx, user: Doc<"users">): Promise<number> {
  return bumpUsageCounter(ctx, user._id, "stylist", LIMITS.stylistMessagesPerDay);
}

/**
 * Validates raw model suggestions against the database and persists the valid ones as
 * unsaved agent outfits on a fresh thread with proposal rows — the exact preview semantics
 * the stylist UI already understands. Every persisted outfit is re-checked to contain the
 * selected item; anything else is dropped, never repaired. Re-verifies the item itself, so
 * an item deleted mid-flow fails NOT_FOUND instead of building an outfit without it.
 */
export async function persistStylingSuggestions(
  ctx: MutationCtx,
  user: Doc<"users">,
  itemId: Id<"items">,
  raw: RawStylingSuggestion[],
  usage?: { inputTextTokens: number; outputTokens: number },
): Promise<{ threadId?: Id<"threads">; suggestions: PersistedSuggestion[] }> {
  const item = await requireItem(ctx, user, itemId);
  if (item.status !== "ready") {
    throw appError("INVALID_INPUT", "That item isn't ready to style yet.");
  }

  const valid: Array<{ name: string; reasoning: string; slots: OutfitSlots }> = [];
  for (const candidate of raw.slice(0, MAX_STYLING_SUGGESTIONS)) {
    // String ids from the model are untrusted until the database confirms them; the cast is
    // safe because validateSlots + the selected-item check below reject anything foreign.
    // Accessories default to empty so a sparse suggestion cannot crash slot iteration.
    const slots = { ...candidate.slots, accessories: candidate.slots.accessories ?? [] } as unknown as OutfitSlots;
    const problems = await validateSlots(ctx, user, slots, true);
    const ids = new Set(slotItemIds(slots));
    if (!ids.has(item._id)) problems.push(`"${item.name}" must appear in every suggestion`);
    if (problems.length === 0) valid.push({ name: candidate.name, reasoning: candidate.reasoning, slots });
  }
  if (valid.length === 0) return { suggestions: [] };

  const threadId = await createThread(ctx, user, { title: `Styling ${item.name}` });
  const suggestions: PersistedSuggestion[] = [];
  for (const suggestion of valid) {
    const outfitId = await createOutfit(ctx, user, {
      name: suggestion.name,
      slots: suggestion.slots,
      brief: `Outfits built around ${item.name}.`,
      reasoning: suggestion.reasoning,
      source: "agent",
      threadId,
    });
    await addProposal(ctx, user, threadId, outfitId);
    const map = await resolveSlotItems(ctx, suggestion.slots);
    const items = await Promise.all([...map.values()].map((row) => toItemSummary(ctx, row)));
    suggestions.push({ outfitId, name: suggestion.name, reasoning: suggestion.reasoning, items });
  }
  if (usage && (usage.inputTextTokens > 0 || usage.outputTokens > 0)) {
    await bumpDailyStats(ctx, {
      cogsUsd: detectUsageToUsd({ inputTextTokens: usage.inputTextTokens, inputImageTokens: 0, outputTokens: usage.outputTokens }),
    });
  }
  return { threadId, suggestions };
}
