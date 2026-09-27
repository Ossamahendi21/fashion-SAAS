import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { vQuote } from "./credits";
import { requireServiceUser } from "./lib/auth";
import { appError } from "./lib/errors";
import { listForUser as listAvatars } from "./model/avatars";
import { getBalance, hasCurrentFeature } from "./model/credits";
import { countRunningUnits } from "./model/jobs";
import { listForUser as listItems } from "./model/items";
import {
  createOutfit,
  markOutfitSaved,
  requireOutfit,
  resolveSlotItems,
  toItemSummary,
  validateSlots,
} from "./model/outfits";
import { startRenderJob } from "./model/renders";
import {
  addProposal,
  bindSession as bindThreadSession,
  canAccessSession,
  requireThread,
  resolveByEveSession,
} from "./model/threads";
import { bumpUsageCounter } from "./model/users";
import { LIMITS, renderCreditCost } from "./shared/credits";
import { vCategory, vFormality, vOutfitSlots, vPrefs, vRenderQuality, vSeason } from "./shared/validators";
import { CATEGORIES, CATEGORY_LABELS, FORMALITY, SEASONS, type Category, type Season } from "./shared/wardrobe";
import { vBalance } from "./users";
import { vItemSummary, type ItemSummary } from "./views";

/**
 * Service surface for the eve stylist. Every function takes `serviceKey` (AGENT_SERVICE_KEY) and
 * the Clerk user id the agent acts for; `requireServiceUser` verifies both. Nothing here is
 * callable from the browser without the key, and every read/write is scoped to that user.
 */
const vService = { serviceKey: v.string(), clerkUserId: v.string() };

/** Compact wardrobe for the model's context window. */
export const vWardrobeItem = v.object({
  id: v.id("items"),
  name: v.string(),
  category: vCategory,
  subcategory: v.string(),
  colours: v.array(v.string()),
  pattern: v.string(),
  material: v.string(),
  season: v.array(vSeason),
  formality: v.string(),
  wearCount: v.number(),
  lastWornAt: v.optional(v.number()),
});

export const getWardrobe = query({
  args: { ...vService, category: v.optional(vCategory), season: v.optional(vSeason) },
  returns: v.array(vWardrobeItem),
  handler: async (ctx, { serviceKey, clerkUserId, category, season }) => {
    const user = await requireServiceUser(ctx, { serviceKey, clerkUserId });
    const items = await listItems(ctx, user._id, { status: "ready", category });
    return items
      .filter((item) => !season || item.season.includes(season))
      .map((item) => ({
        id: item._id,
        name: item.name,
        category: item.category,
        subcategory: item.subcategory,
        colours: [item.colours.primary, ...item.colours.secondary].filter(Boolean),
        pattern: item.pattern,
        material: item.material,
        season: item.season,
        formality: item.formality,
        wearCount: item.wearCount,
        lastWornAt: item.lastWornAt,
      }));
  },
});

export const getContext = query({
  args: vService,
  returns: v.object({ name: v.optional(v.string()), prefs: vPrefs, balance: vBalance, avatarCount: v.number() }),
  handler: async (ctx, args) => {
    const user = await requireServiceUser(ctx, args);
    const avatars = await listAvatars(ctx, user._id);
    return { name: user.name, prefs: user.prefs, balance: getBalance(user), avatarCount: avatars.length };
  },
});

export const vGapAnalysis = v.object({
  totalItems: v.number(),
  byCategory: v.array(v.object({ category: vCategory, label: v.string(), count: v.number() })),
  bySeason: v.array(v.object({ season: vSeason, count: v.number(), outerwearCount: v.number() })),
  byFormality: v.array(v.object({ formality: vFormality, count: v.number() })),
  colours: v.array(v.object({ colour: v.string(), count: v.number() })),
  gaps: v.array(v.string()),
});

/** A colour has to cover this much of the wardrobe before it counts as a one-note palette. */
const COLOUR_DOMINANCE = 0.6;
/** Colours reported back to the model; enough to describe a palette, short enough to read. */
const COLOUR_SPREAD_SIZE = 8;

/**
 * What the wardrobe cannot dress, so the stylist can say "you have nothing formal" instead of
 * inventing a blazer. One bounded read of the user's ready items; everything else is arithmetic.
 */
export const gapAnalysis = query({
  args: vService,
  returns: vGapAnalysis,
  handler: async (ctx, args) => {
    const user = await requireServiceUser(ctx, args);
    const items = await readyItems(ctx, user._id);
    return summariseGaps(items);
  },
});

/** `by_user_status` capped at the wardrobe ceiling, so this query stays inside Convex's read limits. */
async function readyItems(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"items">[]> {
  return ctx.db
    .query("items")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "ready"))
    .take(LIMITS.maxItemsPerUser);
}

function summariseGaps(items: Doc<"items">[]): Infer<typeof vGapAnalysis> {
  const byCategory = CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    count: items.filter((item) => item.category === category).length,
  }));
  const bySeason = SEASONS.map((season) => {
    const inSeason = items.filter((item) => item.season.includes(season));
    return {
      season,
      count: inSeason.length,
      outerwearCount: inSeason.filter((item) => item.category === "outerwear").length,
    };
  });
  const byFormality = FORMALITY.map((formality) => ({
    formality,
    count: items.filter((item) => item.formality === formality).length,
  }));

  const colourCounts = new Map<string, number>();
  for (const item of items) {
    const colour = item.colours.primary.trim().toLowerCase();
    if (colour.length === 0) continue;
    colourCounts.set(colour, (colourCounts.get(colour) ?? 0) + 1);
  }
  const colours = [...colourCounts.entries()]
    .map(([colour, count]) => ({ colour, count }))
    .sort((a, b) => b.count - a.count || a.colour.localeCompare(b.colour))
    .slice(0, COLOUR_SPREAD_SIZE);

  return {
    totalItems: items.length,
    byCategory,
    bySeason,
    byFormality,
    colours,
    gaps: describeGaps(items.length, byCategory, bySeason, byFormality, colours),
  };
}

function describeGaps(
  total: number,
  byCategory: { category: Category; count: number }[],
  bySeason: { season: Season; count: number; outerwearCount: number }[],
  byFormality: { formality: string; count: number }[],
  colours: { colour: string; count: number }[],
): string[] {
  if (total === 0) return ["the wardrobe is empty — nothing has been added yet"];

  const gaps: string[] = [];
  const countOf = (category: Category) => byCategory.find((row) => row.category === category)?.count ?? 0;

  // A dress covers the top + bottom slots on its own, so only flag those when there is no dress either.
  const hasDress = countOf("dress") > 0;
  if (countOf("shoes") === 0) gaps.push("no shoes");
  if (countOf("top") === 0 && !hasDress) gaps.push("no tops");
  if (countOf("bottom") === 0 && !hasDress) gaps.push("no bottoms");
  if (countOf("outerwear") === 0) gaps.push("no outerwear");
  if (countOf("accessory") + countOf("bag") + countOf("headwear") === 0) gaps.push("no accessories");

  for (const season of bySeason) {
    if (season.count === 0) gaps.push(`nothing for ${season.season}`);
    else if (season.outerwearCount === 0 && (season.season === "winter" || season.season === "autumn")) {
      gaps.push(`no outerwear for ${season.season}`);
    }
  }

  for (const row of byFormality) {
    if (row.count === 0) gaps.push(row.formality === "formal" ? "nothing formal" : `nothing ${row.formality}`);
  }

  const dominant = colours[0];
  if (dominant && total >= 4 && dominant.count / total >= COLOUR_DOMINANCE) {
    gaps.push(`almost everything is ${dominant.colour} — there is no contrast colour to build around`);
  } else if (colours.length === 1 && total >= 2) {
    gaps.push(`every item is ${colours[0].colour}`);
  }

  return gaps;
}

export const assertThreadAccess = query({
  args: { ...vService, threadId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { serviceKey, clerkUserId, threadId }) => {
    const user = await requireServiceUser(ctx, { serviceKey, clerkUserId });
    const id = ctx.db.normalizeId("threads", threadId);
    const thread = id ? await ctx.db.get(id) : null;
    return thread !== null && thread.userId === user._id;
  },
});

export const assertSessionAccess = query({
  args: { ...vService, eveSessionId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { serviceKey, clerkUserId, eveSessionId }) => {
    const user = await requireServiceUser(ctx, { serviceKey, clerkUserId });
    return canAccessSession(ctx, user, eveSessionId);
  },
});

export const bindSession = mutation({
  args: { ...vService, threadId: v.id("threads"), eveSessionId: v.string() },
  returns: v.id("threads"),
  handler: async (ctx, { serviceKey, clerkUserId, threadId, eveSessionId }) => {
    const user = await requireServiceUser(ctx, { serviceKey, clerkUserId });
    return bindThreadSession(ctx, user, threadId, eveSessionId);
  },
});

/** Resolves the verified browser thread, including when the first tool races the HTTP response. */
export const resolveThread = mutation({
  args: { ...vService, eveSessionId: v.string(), threadId: v.id("threads") },
  returns: v.id("threads"),
  handler: async (ctx, { serviceKey, clerkUserId, eveSessionId, threadId }) => {
    const user = await requireServiceUser(ctx, { serviceKey, clerkUserId });
    return resolveByEveSession(ctx, user, eveSessionId, threadId);
  },
});

/**
 * Validates the model's picks (ownership, one item per slot, slot/category match) and stores them
 * as `outfits` with source "agent" plus a `proposals` row. Invalid outfits come back with `problems`.
 */
export const composeOutfits = mutation({
  args: {
    ...vService,
    threadId: v.id("threads"),
    brief: v.string(),
    outfits: v.array(
      v.object({ name: v.string(), slots: vOutfitSlots, reasoning: v.string(), occasion: v.optional(v.string()) }),
    ),
  },
  returns: v.array(
    v.object({
      outfitId: v.union(v.id("outfits"), v.null()),
      name: v.string(),
      items: v.array(vItemSummary),
      problems: v.array(v.string()),
    }),
  ),
  handler: async (ctx, { serviceKey, clerkUserId, threadId, brief, outfits }) => {
    const user = await requireServiceUser(ctx, { serviceKey, clerkUserId });
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.userId !== user._id) {
      return outfits.map((outfit) => ({
        outfitId: null,
        name: outfit.name,
        items: [] as ItemSummary[],
        problems: ["that conversation doesn't exist"],
      }));
    }

    const results: Array<{ outfitId: Id<"outfits"> | null; name: string; items: ItemSummary[]; problems: string[] }> =
      [];
    for (const candidate of outfits) {
      // Resolve items (and sign one storage URL each) only for picks that are actually valid.
      const problems = await validateSlots(ctx, user, candidate.slots, true);
      if (problems.length > 0) {
        results.push({ outfitId: null, name: candidate.name, items: [], problems });
        continue;
      }
      const map = await resolveSlotItems(ctx, candidate.slots);
      const items = await Promise.all([...map.values()].map((item) => toItemSummary(ctx, item)));
      const outfitId = await createOutfit(ctx, user, {
        name: candidate.name,
        slots: candidate.slots,
        occasion: candidate.occasion,
        brief,
        reasoning: candidate.reasoning,
        source: "agent",
        threadId: thread._id,
      });
      await addProposal(ctx, user, thread._id, outfitId);
      await ctx.db.patch(thread._id, { lastMessageAt: Date.now() });
      results.push({ outfitId, name: candidate.name, items, problems: [] });
    }
    return results;
  },
});

/**
 * The quote plus every reason `renders.start` would refuse this request, so the approval card is
 * never shown for a spend that cannot land. `blockers` is ordered: the policy denies with the first.
 */
export const vRenderQuote = v.object({ ...vQuote.fields, blockers: v.array(v.string()) });

export const quoteRenders = query({
  args: { ...vService, outfitIds: v.array(v.id("outfits")), perOutfit: v.number(), quality: vRenderQuality },
  returns: vRenderQuote,
  handler: async (ctx, { serviceKey, clerkUserId, outfitIds, perOutfit, quality }) => {
    const user = await requireServiceUser(ctx, { serviceKey, clerkUserId });
    const distinctOutfits = [...new Set(outfitIds)];
    if (!Number.isSafeInteger(perOutfit) || perOutfit < 1 || perOutfit > LIMITS.maxRendersPerRequest) {
      throw appError("INVALID_INPUT", `Choose between 1 and ${LIMITS.maxRendersPerRequest} images per outfit.`);
    }
    if (distinctOutfits.length === 0 || distinctOutfits.length > LIMITS.maxOutfitsPerRenderRequest) {
      throw appError("INVALID_INPUT", `Choose between 1 and ${LIMITS.maxOutfitsPerRenderRequest} outfits.`);
    }
    for (const outfitId of distinctOutfits) {
      const outfit = await requireOutfit(ctx, user, outfitId);
      await validateSlots(ctx, user, outfit.slots);
    }
    const { total, dailyRemaining } = getBalance(user);
    const credits = renderCreditCost(quality, perOutfit, distinctOutfits.length);
    const available = Math.min(total, dailyRemaining);
    const shortfall = Math.max(0, credits - available);

    const blockers: string[] = [];
    const avatars = await listAvatars(ctx, user._id);
    if (avatars.length === 0) {
      blockers.push("There is no avatar to dress yet — ask them to add one in Settings before rendering.");
    }
    if (quality === "hq" && !hasCurrentFeature(user, "hq_renders")) {
      blockers.push("HQ renders are part of the Plus plan. Offer standard quality instead.");
    }
    const running = await countRunningUnits(ctx, user._id);
    if (running >= LIMITS.maxRunningJobsPerUser) {
      blockers.push(`They already have ${running} jobs running. Wait for one to finish before rendering.`);
    }
    if (shortfall > 0) {
      blockers.push(
        `That would cost ${credits} credits and only ${available} are available today (short by ${shortfall}). ` +
          "Offer fewer images or standard quality instead of HQ.",
      );
    }

    return { credits, available, shortfall, canAfford: shortfall === 0, blockers };
  },
});

/** Same rules as renders.start, attaches the job to the thread's proposals. */
export const startRenders = mutation({
  args: {
    ...vService,
    threadId: v.id("threads"),
    outfitIds: v.array(v.id("outfits")),
    perOutfit: v.number(),
    quality: vRenderQuality,
  },
  returns: v.object({ jobId: v.id("jobs"), renderIds: v.array(v.id("renders")) }),
  handler: async (ctx, { serviceKey, clerkUserId, threadId, outfitIds, perOutfit, quality }) => {
    const user = await requireServiceUser(ctx, { serviceKey, clerkUserId });
    const thread = await requireThread(ctx, user, threadId);
    return startRenderJob(ctx, user, {
      outfitIds,
      count: perOutfit,
      quality,
      threadId: thread._id,
    });
  },
});

/** Promotes an agent proposal to a saved outfit (source stays "agent", but it now shows in /outfits). */
export const saveOutfit = mutation({
  args: { ...vService, outfitId: v.id("outfits"), name: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { serviceKey, clerkUserId, outfitId, name }) => {
    const user = await requireServiceUser(ctx, { serviceKey, clerkUserId });
    const outfit = await requireOutfit(ctx, user, outfitId);
    const trimmed = name?.trim();
    if (trimmed && trimmed !== outfit.name) {
      await ctx.db.patch(outfit._id, { name: trimmed, updatedAt: Date.now() });
    }
    await markOutfitSaved(ctx, outfit);
    return null;
  },
});

/** Bumps the stylist message counter; throws RATE_LIMITED past LIMITS.stylistMessagesPerDay. */
export const recordMessage = mutation({
  args: vService,
  returns: v.object({ remainingToday: v.number() }),
  handler: async (ctx, args) => {
    const user = await requireServiceUser(ctx, args);
    const remainingToday = await bumpUsageCounter(ctx, user._id, "stylist", LIMITS.stylistMessagesPerDay);
    return { remainingToday };
  },
});
