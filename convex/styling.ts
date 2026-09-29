import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { getByClerkId } from "./model/users";
import { appError } from "./lib/errors";
import {
  consumeStylingTurn as consumeTurnDocs,
  getStylingContext as getStylingContextDocs,
  persistStylingSuggestions as persistStylingDocs,
  SMALL_WARDROBE_NOTE,
  stylingTooSmall,
  MAX_STYLING_SUGGESTIONS,
} from "./model/styling";
import { vItemSummary } from "./views";
import { vPrefs, vRawStylingSuggestion } from "./shared/validators";

export const vStylingSuggestionView = v.object({
  outfitId: v.id("outfits"),
  name: v.string(),
  reasoning: v.string(),
  items: v.array(vItemSummary),
});

export const vStylingResult = v.object({
  threadId: v.optional(v.id("threads")),
  suggestions: v.array(vStylingSuggestionView),
  note: v.optional(v.string()),
});

/**
 * Focused styling context for one item. Internal only: the public action passes the verified
 * Clerk id explicitly, and the item id comes from the caller's saved wardrobe item.
 */
export const stylingContext = internalQuery({
  args: { clerkId: v.string(), itemId: v.id("items") },
  returns: v.object({
    wardrobeCount: v.number(),
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
    prefs: vPrefs,
  }),
  handler: async (ctx, { clerkId, itemId }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    const context = await getStylingContextDocs(ctx, user, itemId);
    return { wardrobeCount: context.wardrobe.length, ...context };
  },
});

/** One styling request costs one turn of the existing stylist daily cap. */
export const consumeStylingTurn = internalMutation({
  args: { clerkId: v.string() },
  returns: v.number(),
  handler: async (ctx, { clerkId }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    return consumeTurnDocs(ctx, user);
  },
});

/** Validates raw suggestions and persists the valid ones as unsaved proposal outfits. */
export const persistStyling = internalMutation({
  args: {
    clerkId: v.string(),
    itemId: v.id("items"),
    suggestions: v.array(vRawStylingSuggestion),
    usage: v.optional(v.object({ inputTextTokens: v.number(), outputTokens: v.number() })),
  },
  returns: v.object({
    threadId: v.optional(v.id("threads")),
    suggestions: v.array(vStylingSuggestionView),
  }),
  handler: async (ctx, { clerkId, itemId, suggestions, usage }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    return persistStylingDocs(ctx, user, itemId, suggestions, usage);
  },
});

/**
 * Suggests outfits around one saved wardrobe item. Takes only the item id: identity, wardrobe,
 * preferences, and plan all come from the verified session server-side. Persists valid
 * suggestions as unsaved proposal outfits on a fresh thread (never floods saved outfits);
 * "Save outfit" happens later through the existing `threads.saveProposal` mutation.
 * Costs one stylist daily-cap turn; never touches Live Mirror.
 */
export const suggestOutfits = action({
  args: { itemId: v.id("items") },
  returns: vStylingResult,
  handler: async (ctx, { itemId }): Promise<Infer<typeof vStylingResult>> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("UNAUTHENTICATED", "Sign in to continue.");
    const context = await ctx.runQuery(internal.styling.stylingContext, {
      clerkId: identity.subject,
      itemId,
    });
    if (stylingTooSmall(context.wardrobe.length)) {
      return { suggestions: [], note: SMALL_WARDROBE_NOTE };
    }
    await ctx.runMutation(internal.styling.consumeStylingTurn, { clerkId: identity.subject });
    const { suggestions: raw, usage } = await ctx.runAction(internal.ai.openai.styleItemOutfits, {
      item: context.item,
      wardrobe: context.wardrobe,
      presentation: context.prefs.presentation,
      fit: context.prefs.fit,
      maxSuggestions: MAX_STYLING_SUGGESTIONS,
    });
    return ctx.runMutation(internal.styling.persistStyling, {
      clerkId: identity.subject,
      itemId,
      suggestions: raw,
      usage,
    });
  },
});
