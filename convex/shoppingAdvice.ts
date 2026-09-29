import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { getByClerkId } from "./model/users";
import { appError } from "./lib/errors";
import {
  adviceFingerprint,
  buildSignals,
  coerceAdviceText,
  computeAdviceBase,
  consumeAdviceTurn as consumeTurnDocs,
  getCandidateVector,
  listOwnedReady,
  MIN_OWNED_FOR_ADVICE,
  outfitDisplay,
  readCachedAdvice,
  recordAdviceCogs,
  requireAdviceCandidate,
  resolveCachedSummaries,
  resolveSimilarOwned,
  SMALL_WARDROBE_NOTE,
  stableSimilarEntries,
  VECTOR_SEARCH_LIMIT,
  writeCachedAdvice,
} from "./model/shoppingAdvice";
import { toItemSummary } from "./model/outfits";
import { LIMITS } from "./shared/credits";
import {
  vAdviceLabel,
  vAdviceSignalType,
  vCategory,
  type AdviceLabel,
  type AdviceSignalType,
} from "./shared/validators";
import type { Category } from "./shared/wardrobe";
import { vItemSummary } from "./views";

type SimilarView = {
  itemId: Id<"items">;
  name: string;
  category: Category;
  url: string | null;
  similarity: number;
  duplicate: boolean;
};

type SignalView = { type: AdviceSignalType; message: string };

export const vAdviceSimilarItem = v.object({
  itemId: v.id("items"),
  name: v.string(),
  category: vCategory,
  url: v.union(v.string(), v.null()),
  similarity: v.number(),
  duplicate: v.boolean(),
});

export const vAdviceSignal = v.object({ type: vAdviceSignalType, message: v.string() });

/**
 * Compact, safe decision support for one saved candidate. No vectors, no prompts, no
 * provider ids, no usage, no secrets — only names, bounded counts, factual signals and
 * bounded prose. Thumbnail URLs are live signed URLs, never cached.
 */
export const vShoppingAdvice = v.object({
  candidate: v.object({ itemId: v.id("items"), name: v.string() }),
  similarOwnedItems: v.array(vAdviceSimilarItem),
  matchingOwnedItems: v.array(vItemSummary),
  matchCount: v.number(),
  outfitPotential: v.object({ estimatedCombinations: v.number(), display: v.string() }),
  label: vAdviceLabel,
  signals: v.array(vAdviceSignal),
  summary: v.optional(v.string()),
  pros: v.array(v.string()),
  considerations: v.array(v.string()),
  note: v.optional(v.string()),
  smallWardrobe: v.boolean(),
  cached: v.boolean(),
});

/** Stable similar entry as cached (no URL) for the persist boundary. */
const vCachedSimilar = v.object({
  itemId: v.id("items"),
  name: v.string(),
  category: vCategory,
  similarity: v.number(),
  duplicate: v.boolean(),
});

const vCandidateFacts = v.object({
  name: v.string(),
  category: v.string(),
  subcategory: v.string(),
  colours: v.array(v.string()),
  pattern: v.string(),
  material: v.string(),
  season: v.array(v.string()),
  formality: v.string(),
});

/**
 * Everything the action needs, derived server-side from the authenticated user: the
 * eligible candidate, owned-only deterministic signals with live thumbnail URLs, the
 * AI facts, the fingerprint, and whether the cache already holds this exact analysis.
 * Throws UNAUTHENTICATED / NOT_FOUND / INVALID_INPUT exactly like the model contract.
 */
export const adviceContext = internalQuery({
  args: { clerkId: v.string(), itemId: v.id("items") },
  returns: v.object({
    candidate: v.object({ itemId: v.id("items"), name: v.string() }),
    candidateFacts: vCandidateFacts,
    /** The candidate's embedding vector for the action's similarity search, if embedded. */
    candidateVector: v.union(v.array(v.float64()), v.null()),
    /** Server-derived owner id for the action's vector-search filter. Never client input. */
    ownerId: v.id("users"),
    matching: v.array(vItemSummary),
    matchingIds: v.array(v.id("items")),
    matchCount: v.number(),
    estimatedCombinations: v.number(),
    outfitDisplay: v.string(),
    ownedCount: v.number(),
    smallWardrobe: v.boolean(),
    fingerprint: v.string(),
    cacheHit: v.boolean(),
    /** Taste context for the prose only; identity and plan never travel to the model. */
    presentation: v.string(),
    fit: v.string(),
    /** Similarity-free signals/label: matches, combos and gaps need no vectors. */
    baseSignals: v.array(vAdviceSignal),
    baseSignalMessages: v.array(v.string()),
    baseLabel: vAdviceLabel,
  }),
  handler: async (ctx, { clerkId, itemId }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    const candidate = await requireAdviceCandidate(ctx, user, itemId);
    const owned = await listOwnedReady(ctx, user._id);
    const base = computeAdviceBase(candidate, owned);
    const { signals: baseSignals, label: baseLabel } = buildSignals(candidate, owned, [], base.matchCount, base.estimatedCombinations);
    const smallWardrobe = owned.length < MIN_OWNED_FOR_ADVICE;
    const fingerprint = adviceFingerprint(candidate, owned, user.prefs);
    const cached = await readCachedAdvice(ctx, user._id, candidate._id);
    const matching = [];
    for (const id of base.matchingIds) {
      const item = await ctx.db.get(id);
      if (!item) continue;
      matching.push(await toItemSummary(ctx, item));
    }
    return {
      candidate: { itemId: candidate._id, name: candidate.name },
      candidateFacts: {
        name: candidate.name,
        category: candidate.category,
        subcategory: candidate.subcategory,
        colours: [candidate.colours.primary, ...candidate.colours.secondary],
        pattern: candidate.pattern,
        material: candidate.material,
        season: [...candidate.season],
        formality: candidate.formality,
      },
      candidateVector: await getCandidateVector(ctx, candidate._id),
      ownerId: user._id,
      matching,
      matchingIds: base.matchingIds,
      matchCount: base.matchCount,
      estimatedCombinations: base.estimatedCombinations,
      outfitDisplay: base.outfitDisplay,
      ownedCount: owned.length,
      smallWardrobe,
      fingerprint,
      cacheHit: cached !== null && cached.fingerprint === fingerprint,
      presentation: user.prefs.presentation,
      fit: user.prefs.fit,
      baseSignals,
      baseSignalMessages: baseSignals.map((signal) => signal.message),
      baseLabel,
    };
  },
});

/**
 * Similarity resolution in query context: maps the action's vector-search hits to owned
 * ready items (foreign, unready, considering and self hits all dropped), pins a flagged
 * owned duplicate first, and finishes the signals/label that depend on similarity.
 */
export const adviceSimilar = internalQuery({
  args: {
    clerkId: v.string(),
    itemId: v.id("items"),
    hits: v.array(v.object({ embeddingId: v.id("itemEmbeddings"), score: v.number() })),
  },
  returns: v.object({
    similar: v.array(vAdviceSimilarItem),
    stableSimilar: v.array(vCachedSimilar),
    signals: v.array(vAdviceSignal),
    signalMessages: v.array(v.string()),
    label: vAdviceLabel,
  }),
  handler: async (ctx, { clerkId, itemId, hits }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    const candidate = await requireAdviceCandidate(ctx, user, itemId);
    const owned = await listOwnedReady(ctx, user._id);
    const similar = await resolveSimilarOwned(ctx, user, candidate, hits);
    const base = computeAdviceBase(candidate, owned);
    const { signals, label } = buildSignals(candidate, owned, similar, base.matchCount, base.estimatedCombinations);
    const viewed = [];
    for (const entry of similar) {
      const summary = await toItemSummary(ctx, entry.item);
      viewed.push({
        itemId: summary._id,
        name: summary.name,
        category: summary.category,
        url: summary.url,
        similarity: entry.similarity,
        duplicate: entry.duplicate,
      });
    }
    return {
      similar: viewed,
      stableSimilar: stableSimilarEntries(similar),
      signals,
      signalMessages: signals.map((signal) => signal.message),
      label,
    };
  },
});

/** One analysis costs one turn of the existing stylist daily cap. */
export const consumeAdviceTurn = internalMutation({
  args: { clerkId: v.string() },
  returns: v.number(),
  handler: async (ctx, { clerkId }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    return consumeTurnDocs(ctx, user);
  },
});

/**
 * Validates model prose at the boundary (bounded text only — ids can never pass through),
 * caches the full analysis under the fingerprint, and records text COGS in the same
 * mutation. Re-checks eligibility so a candidate bought mid-flow never caches garbage.
 */
export const persistAdvice = internalMutation({
  args: {
    clerkId: v.string(),
    itemId: v.id("items"),
    fingerprint: v.string(),
    label: vAdviceLabel,
    similar: v.array(vCachedSimilar),
    matchCount: v.number(),
    matchingIds: v.array(v.id("items")),
    estimatedCombinations: v.number(),
    outfitDisplay: v.string(),
    signals: v.array(vAdviceSignal),
    summary: v.optional(v.string()),
    pros: v.array(v.string()),
    considerations: v.array(v.string()),
    usage: v.optional(v.object({ inputTextTokens: v.number(), outputTokens: v.number() })),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const user = await getByClerkId(ctx, args.clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    const candidate = await requireAdviceCandidate(ctx, user, args.itemId);
    if (candidate.updatedAt !== undefined && adviceFingerprint(candidate, await listOwnedReady(ctx, user._id), user.prefs) !== args.fingerprint) {
      throw appError("INVALID_INPUT", "Your wardrobe changed while analyzing. Try again.");
    }
    const text = coerceAdviceText({ summary: args.summary, pros: args.pros, considerations: args.considerations });
    await writeCachedAdvice(
      ctx,
      user,
      args.itemId,
      args.fingerprint,
      {
        similar: args.similar,
        matchingIds: args.matchingIds,
        matchCount: args.matchCount,
        estimatedCombinations: args.estimatedCombinations,
        outfitDisplay: args.outfitDisplay,
        signals: args.signals,
        label: args.label,
      },
      text,
    );
    if (args.usage) await recordAdviceCogs(ctx, args.usage);
    return null;
  },
});

/** Serves one cached analysis with freshly resolved thumbnails. Never serves across users. */
export const adviceView = internalQuery({
  args: { clerkId: v.string(), itemId: v.id("items") },
  returns: vShoppingAdvice,
  handler: async (ctx, { clerkId, itemId }): Promise<Infer<typeof vShoppingAdvice>> => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    const candidate = await requireAdviceCandidate(ctx, user, itemId);
    const cached = await readCachedAdvice(ctx, user._id, candidate._id);
    if (!cached) throw appError("NOT_FOUND", "That analysis is gone.");
    const { similar, matching } = await resolveCachedSummaries(ctx, cached);
    const owned = await listOwnedReady(ctx, user._id);
    return {
      candidate: { itemId: candidate._id, name: candidate.name },
      similarOwnedItems: similar.map((entry) => ({
        itemId: entry.itemId,
        name: entry.name,
        category: entry.category,
        url: entry.url,
        similarity: entry.similarity,
        duplicate: entry.duplicate,
      })),
      matchingOwnedItems: matching,
      matchCount: cached.matchCount,
      outfitPotential: {
        estimatedCombinations: cached.estimatedCombinations,
        display: outfitDisplay(cached.estimatedCombinations),
      },
      label: cached.label,
      signals: cached.signals,
      ...(cached.summary ? { summary: cached.summary } : {}),
      pros: cached.pros,
      considerations: cached.considerations,
      smallWardrobe: owned.length < MIN_OWNED_FOR_ADVICE,
      cached: true,
    };
  },
});

/**
 * "Should I buy this?" for one saved candidate. Takes only the item id: identity, the
 * candidate, the owned wardrobe, signals, fingerprint and prose all resolve server-side.
 * Analysis only — never marks owned, never re-uploads, never touches Live Mirror, never
 * generates images, never spends image credits. A fresh cache hit returns without any AI
 * call, rate-limit turn or COGS; a tiny wardrobe returns a deterministic note without AI.
 */
export const analyze = action({
  args: { itemId: v.id("items") },
  returns: vShoppingAdvice,
  handler: async (ctx, { itemId }): Promise<Infer<typeof vShoppingAdvice>> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("UNAUTHENTICATED", "Sign in to continue.");
    const context = await ctx.runQuery(internal.shoppingAdvice.adviceContext, {
      clerkId: identity.subject,
      itemId,
    });
    if (context.cacheHit) {
      const view = await ctx.runQuery(internal.shoppingAdvice.adviceView, {
        clerkId: identity.subject,
        itemId,
      });
      return { ...view, cached: true };
    }
    // Similarity resolves in the action: the candidate's embedding row seeds one
    // user-scoped vector search, and a query maps the hits back to owned ready items.
    // No vector, no similarity — the rest of the analysis still stands on its own.
    let similar: SimilarView[] = [];
    let stableSimilar: Array<Omit<SimilarView, "url">> = [];
    let signals: SignalView[] = context.baseSignals;
    let signalMessages: string[] = context.baseSignalMessages;
    let label: AdviceLabel = context.baseLabel;
    if (context.candidateVector) {
      const hits = await ctx.vectorSearch("itemEmbeddings", "by_embedding", {
        vector: context.candidateVector,
        limit: VECTOR_SEARCH_LIMIT,
        filter: (q) => q.eq("userId", context.ownerId),
      });
      const resolved = await ctx.runQuery(internal.shoppingAdvice.adviceSimilar, {
        clerkId: identity.subject,
        itemId,
        hits: hits.map((hit) => ({ embeddingId: hit._id, score: hit._score })),
      });
      similar = resolved.similar;
      stableSimilar = resolved.stableSimilar;
      signals = resolved.signals;
      signalMessages = resolved.signalMessages;
      label = resolved.label;
    }
    if (context.smallWardrobe) {
      return {
        candidate: context.candidate,
        similarOwnedItems: similar,
        matchingOwnedItems: context.matching,
        matchCount: context.matchCount,
        outfitPotential: { estimatedCombinations: context.estimatedCombinations, display: context.outfitDisplay },
        label,
        signals,
        pros: [],
        considerations: [],
        note: SMALL_WARDROBE_NOTE,
        smallWardrobe: true,
        cached: false,
      };
    }
    await ctx.runMutation(internal.shoppingAdvice.consumeAdviceTurn, { clerkId: identity.subject });
    const advice = await ctx.runAction(internal.ai.openai.summarizeShoppingAdvice, {
      candidate: context.candidateFacts,
      similar: similar.map((entry) => ({
        name: entry.name,
        category: entry.category,
        band:
          entry.duplicate || entry.similarity >= LIMITS.duplicateCosineThreshold
            ? ("very similar" as const)
            : ("similar" as const),
      })),
      matchCount: context.matchCount,
      outfitDisplay: context.outfitDisplay,
      signals: signalMessages,
      label,
      presentation: context.presentation,
      fit: context.fit,
    });
    const text = coerceAdviceText({ summary: advice.summary, pros: advice.pros, considerations: advice.considerations });
    await ctx.runMutation(internal.shoppingAdvice.persistAdvice, {
      clerkId: identity.subject,
      itemId,
      fingerprint: context.fingerprint,
      label,
      similar: stableSimilar,
      matchCount: context.matchCount,
      matchingIds: context.matchingIds,
      estimatedCombinations: context.estimatedCombinations,
      outfitDisplay: context.outfitDisplay,
      signals,
      ...(text.summary ? { summary: text.summary } : {}),
      pros: text.pros,
      considerations: text.considerations,
      usage: advice.usage,
    });
    const view = await ctx.runQuery(internal.shoppingAdvice.adviceView, {
      clerkId: identity.subject,
      itemId,
    });
    return { ...view, cached: false };
  },
});
