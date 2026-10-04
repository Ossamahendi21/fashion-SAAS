import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { detectUsageToUsd, LIMITS } from "../shared/credits";
import { EMBEDDING_GENERATION, LEGACY_EMBEDDING_GENERATION } from "../shared/embeddingText";
import {
  ADVICE_LABELS,
  type AdviceLabel,
  type AdviceSignalType,
} from "../shared/validators";
import { CATEGORY_LABELS, slotForCategory, type Category, type Slot } from "../shared/wardrobe";
import { isConsideringItem, isOwnedItem, listForUser, requireItem } from "./items";
import { toItemSummary } from "./outfits";
import { bumpDailyStats } from "./stats";
import { bumpUsageCounter } from "./users";

type Ctx = QueryCtx | MutationCtx;

/**
 * "Should I buy this?" decision support for one saved shopping candidate.
 *
 * Deterministic signals come first, computed from the user's ACTUAL owned wardrobe:
 * embedding similarity against owned ready items, slot-compatible matches, a bounded
 * outfit-combination estimate, and gap/duplication facts. One bounded text-AI call may
 * then turn those facts into prose. The model never decides ownership, never invents
 * items, and never says buy / don't buy.
 */

/** Similar owned items surfaced per analysis. Small by design: a decision aid, not a search page. */
export const MAX_SIMILAR_ITEMS = 3;
/** Matching owned thumbnails shown; the total count is reported separately. */
export const MAX_MATCHING_ITEMS = 8;
/** Fewer owned ready items than this and there is no wardrobe to judge fit against. */
export const MIN_OWNED_FOR_ADVICE = 3;
/**
 * Which stored vector generation shopping similarity reads. This is NOT a model provider: it only
 * selects stored vectors and a static index, so it can never cause an OpenAI API call.
 *
 * - "legacy": the pre-Phase-C behavior — `embedding` / `by_embedding`, pool 8, no rerank, the
 *   legacy 0.92 prose threshold. TEMPORARY migration default: existing users keep their existing
 *   similarity until the backfill is proven, then operators set `EMBEDDING_READ_GENERATION=bge`.
 * - "bge": local BGE — `embeddingBge` / `by_embeddingBge`, pool 16, same-category-first stable
 *   rerank, the B2 0.896396 prose threshold.
 */
export const READ_GENERATIONS = ["legacy", "bge"] as const;
export type EmbeddingReadGeneration = (typeof READ_GENERATIONS)[number];

/**
 * Resolves the read generation. Missing/empty means "legacy": during migration existing users keep
 * existing behavior, and a fresh deployment cannot silently depend on an unproven backfill.
 * Unsupported values fail closed before any vector work happens.
 */
export function embeddingReadGeneration(
  env: Record<string, string | undefined> = process.env,
): EmbeddingReadGeneration {
  const generation = env.EMBEDDING_READ_GENERATION;
  if (generation === undefined || generation === "") return "legacy";
  if (generation === "legacy" || generation === "bge") return generation;
  throw appError(
    "INVALID_INPUT",
    `EMBEDDING_READ_GENERATION "${generation}" is not supported; set it to "legacy" (stored OpenAI vectors) or "bge" (local BGE vectors).`,
  );
}

type ReadGenerationConfig = {
  /** Which stored field seeds the search. */
  vectorField: "embedding" | "embeddingBge";
  /** Static index for that field. Never taken from env. */
  indexName: "by_embedding" | "by_embeddingBge";
  /** Candidate pool mapped down to owned ready items. */
  searchLimit: number;
  /** BGE-only: same-category-first stable rerank before bounding. */
  rerank: boolean;
  /** Prose threshold: legacy 0.92 geometry vs B2 0.896396 BGE geometry. Never a duplicate gate. */
  proseThreshold: number;
  /** Fingerprint token so switching generations invalidates cached advice. */
  generationToken: string;
};

/**
 * The static per-generation reader contract. Index names and dimensions live here and in
 * `schema.ts`, never in env — the selector only picks a key.
 */
export function readGenerationConfig(generation: EmbeddingReadGeneration): ReadGenerationConfig {
  if (generation === "bge") {
    return {
      vectorField: "embeddingBge",
      indexName: "by_embeddingBge",
      searchLimit: VECTOR_SEARCH_LIMIT,
      rerank: true,
      proseThreshold: LIMITS.strongSimilarityThreshold,
      generationToken: EMBEDDING_GENERATION,
    };
  }
  if (generation === "legacy") {
    return {
      vectorField: "embedding",
      indexName: "by_embedding",
      searchLimit: LEGACY_VECTOR_SEARCH_LIMIT,
      rerank: false,
      proseThreshold: LIMITS.duplicateCosineThreshold,
      generationToken: LEGACY_EMBEDDING_GENERATION,
    };
  }
  // Unreachable through the typed selector, but a second fail-closed gate so no caller can ever
  // land on the wrong generation by passing something the type system did not see.
  throw appError(
    "INVALID_INPUT",
    `Unknown embedding read generation "${generation}"; expected "legacy" or "bge".`,
  );
}
/**
 * Vector hits scanned per BGE analysis, mapped down to owned ready items only.
 *
 * Step 7 Phase B2 (frozen 16-item corpus, raw cosine order): a pool of 8 already found every
 * expected neighbour, and pools 16 and 32 were identical to it — so 8 is the smallest safe pool.
 * 16 is used in production because a user's real wardrobe is far larger than the fixture corpus, and
 * the extra candidates cost one filtered index read. The rerank below takes the best 3 of whatever
 * comes back, so a wider pool can only help ranking quality.
 */
export const VECTOR_SEARCH_LIMIT = 16;
/**
 * The pre-Phase-C pool for legacy reads. Preserved exactly so `EMBEDDING_READ_GENERATION=legacy`
 * reproduces the behavior users had before migration.
 */
export const LEGACY_VECTOR_SEARCH_LIMIT = 8;
/** Outfit-combination display cap: estimates never pretend to count real outfits exactly. */
export const OUTFIT_COMBO_CAP = 25;
/** Per-group cap inside the combination product, so one deep slot cannot explode the estimate. */
const COMBO_GROUP_CAP = 5;
/** "Works with N pieces" needs at least this many matches to say so. */
const MANY_MATCHES_MIN = 5;
/** AI prose bounds: concise by contract, enforced again at the boundary. */
export const ADVICE_SUMMARY_MAX_CHARS = 400;
export const ADVICE_BULLET_MAX_CHARS = 200;
export const ADVICE_BULLETS_MAX = 3;

export const SMALL_WARDROBE_NOTE =
  "You need a few more owned wardrobe pieces before we can judge how well this fits your closet.";

/** Owned slots that can plausibly complement a candidate of each category. */
const COMPLEMENT_SLOTS: Record<Category, readonly Slot[]> = {
  top: ["bottom", "shoes", "outerwear", "accessories"],
  bottom: ["top", "shoes", "outerwear", "accessories"],
  dress: ["shoes", "outerwear", "accessories"],
  outerwear: ["top", "bottom", "dress", "shoes", "accessories"],
  shoes: ["top", "bottom", "dress", "outerwear", "accessories"],
  accessory: ["top", "bottom", "dress", "shoes", "outerwear"],
  bag: ["top", "bottom", "dress", "shoes", "outerwear"],
  headwear: ["top", "bottom", "dress", "shoes", "outerwear"],
};

/**
 * Required complement groups per candidate category; each group is an any-of slot list.
 * The estimate is the product of per-group owned counts — every required group filled
 * means at least that many distinct candidate-centred combinations.
 */
const REQUIRED_GROUPS: Record<Category, readonly (readonly Slot[])[]> = {
  top: [["bottom"], ["shoes"]],
  bottom: [["top"], ["shoes"]],
  dress: [["shoes"]],
  outerwear: [
    ["top", "dress"],
    ["bottom", "dress"],
    ["shoes"],
  ],
  shoes: [
    ["top", "dress"],
    ["bottom", "dress"],
  ],
  accessory: [
    ["top", "dress"],
    ["bottom", "dress"],
    ["shoes"],
  ],
  bag: [
    ["top", "dress"],
    ["bottom", "dress"],
    ["shoes"],
  ],
  headwear: [
    ["top", "dress"],
    ["bottom", "dress"],
    ["shoes"],
  ],
};

export type SimilarOwned = {
  item: Doc<"items">;
  /** Cosine similarity from the vector index, 0..1 rounded to 2dp. Never shown raw in UI. */
  similarity: number;
  /** True when the candidate's duplicate flag already points at this owned item. */
  duplicate: boolean;
};

export type AdviceSignal = { type: AdviceSignalType; message: string };

export type AdviceDeterministic = {
  similar: Array<{ itemId: Id<"items">; name: string; category: Category; similarity: number; duplicate: boolean }>;
  matchingIds: Id<"items">[];
  matchCount: number;
  estimatedCombinations: number;
  outfitDisplay: string;
  signals: AdviceSignal[];
  label: AdviceLabel;
};

export type AdviceText = { summary?: string; pros: string[]; considerations: string[] };

/**
 * Eligibility: the candidate must belong to the user, be ready, and still be a shopping
 * candidate. Missing/foreign ids are NOT_FOUND (via requireItem); owned items — including
 * legacy rows without the field — and unready items are INVALID_INPUT with safe copy.
 */
export async function requireAdviceCandidate(
  ctx: Ctx,
  user: Doc<"users">,
  itemId: Id<"items">,
): Promise<Doc<"items">> {
  const item = await requireItem(ctx, user, itemId);
  if (item.status !== "ready") {
    throw appError("INVALID_INPUT", "That item isn't ready for advice yet.");
  }
  if (!isConsideringItem(item)) {
    throw appError("INVALID_INPUT", "This item is already in your wardrobe.");
  }
  return item;
}

/** Owned ready items for one user, newest first — the only comparison pool advice ever uses. */
export async function listOwnedReady(ctx: Ctx, userId: Id<"users">): Promise<Doc<"items">[]> {
  return listForUser(ctx, userId, { status: "ready" });
}

/**
 * The candidate's stored vector for similarity search, or null when that generation was never
 * written. Reads exactly one generation's field — never mixes vector spaces: a BGE-only row under
 * legacy reads (or a not-yet-backfilled row under BGE reads) simply gets no similarity.
 */
export async function getCandidateVector(
  ctx: Ctx,
  candidateId: Id<"items">,
  generation: EmbeddingReadGeneration = embeddingReadGeneration(),
): Promise<number[] | null> {
  const row = await ctx.db
    .query("itemEmbeddings")
    .withIndex("by_item", (q) => q.eq("itemId", candidateId))
    .unique();
  const field = readGenerationConfig(generation).vectorField;
  const vector = row?.[field];
  return row && Array.isArray(vector) && vector.length > 0 ? [...vector] : null;
}

/**
 * Stable same-category-first rerank (Step 7 Phase B2).
 *
 * The candidate pool arrives in cosine order, but cosine alone puts a cross-category near-neighbour
 * ahead of a same-category one often enough to be wrong ("you own a similar coat" for a dress).
 * Measured on the frozen corpus with the BGE vectors: same-category-first lifted top-3 expected
 * recall from 23/27 to 25/27 and cut bad top-3 results from 7 to 5, at pool 8/16/32 alike.
 *
 * Two rules, no per-category heuristics:
 *   1. entries whose category equals the candidate's lead, the rest follow;
 *   2. inside each partition the incoming cosine order is preserved exactly (stable partition).
 * Input order is therefore the only tiebreak, so the result is deterministic for a given pool.
 */
export function rerankSimilarByCategory<T extends { item: { category: Category } }>(
  candidateCategory: Category,
  entries: T[],
): T[] {
  const sameCategory: T[] = [];
  const otherCategories: T[] = [];
  for (const entry of entries) {
    if (entry.item.category === candidateCategory) sameCategory.push(entry);
    else otherCategories.push(entry);
  }
  return [...sameCategory, ...otherCategories];
}

/**
 * Maps vector-search hits back to the strongest similar OWNED ready items. Hits resolve
 * through the embedding rows (never trusted directly): foreign rows, unready items,
 * considering rows and the candidate itself are all dropped. A duplicateOfId already
 * pointing at an owned ready item leads the list as a certain match — that flag is now
 * legacy/user-set only, since no text embedding assigns it. The remaining cosine hits are
 * reranked same-category-first, then bounded to a few.
 */
export async function resolveSimilarOwned(
  ctx: Ctx,
  user: Doc<"users">,
  candidate: Doc<"items">,
  hits: Array<{ embeddingId: Id<"itemEmbeddings">; score: number }>,
  generation: EmbeddingReadGeneration = embeddingReadGeneration(),
): Promise<SimilarOwned[]> {
  const found: SimilarOwned[] = [];
  if (candidate.duplicateOfId) {
    const dup = await ctx.db.get(candidate.duplicateOfId);
    if (
      dup &&
      dup._id !== candidate._id &&
      dup.userId === user._id &&
      dup.status === "ready" &&
      isOwnedItem(dup)
    ) {
      found.push({ item: dup, similarity: 1, duplicate: true });
    }
  }
  // Collect the whole surviving pool first, then rerank: truncating to MAX_SIMILAR_ITEMS before the
  // rerank would let a low-cosine same-category item lose its slot to a cross-category neighbour.
  // The same-category-first rerank is BGE-only: legacy reads reproduce the pre-Phase-C cosine order.
  const cosineOrdered: SimilarOwned[] = [];
  for (const hit of hits) {
    const embedding = await ctx.db.get(hit.embeddingId);
    if (!embedding || embedding.userId !== user._id || embedding.itemId === candidate._id) continue;
    const item = await ctx.db.get(embedding.itemId);
    if (!item || item.userId !== user._id || item.status !== "ready" || !isOwnedItem(item)) continue;
    if (found.some((entry) => entry.item._id === item._id)) continue;
    if (cosineOrdered.some((entry) => entry.item._id === item._id)) continue;
    cosineOrdered.push({ item, similarity: Math.round(hit.score * 100) / 100, duplicate: false });
  }
  const reranked = readGenerationConfig(generation).rerank
    ? rerankSimilarByCategory(candidate.category, cosineOrdered)
    : cosineOrdered;
  for (const entry of reranked) {
    found.push(entry);
    if (found.length >= MAX_SIMILAR_ITEMS) break;
  }
  return found.slice(0, MAX_SIMILAR_ITEMS);
}

/** Owned ready items whose slot can complement the candidate's category. */
export function matchingOwned(candidate: Doc<"items">, owned: Doc<"items">[]): Doc<"items">[] {
  const slots = COMPLEMENT_SLOTS[candidate.category];
  return owned.filter((item) => item._id !== candidate._id && slots.includes(slotForCategory(item.category)));
}

/** Bounded outfit-combination estimate from required complement groups. */
export function estimateCombinations(candidate: Doc<"items">, owned: Doc<"items">[]): number {
  const slotCount = new Map<Slot, number>();
  for (const item of owned) {
    if (item._id === candidate._id) continue;
    const slot = slotForCategory(item.category);
    slotCount.set(slot, (slotCount.get(slot) ?? 0) + 1);
  }
  let combos = 1;
  for (const group of REQUIRED_GROUPS[candidate.category]) {
    let count = 0;
    for (const slot of group) count += slotCount.get(slot) ?? 0;
    combos *= Math.min(count, COMBO_GROUP_CAP);
  }
  return Math.min(combos, OUTFIT_COMBO_CAP);
}

export function outfitDisplay(combos: number): string {
  if (combos <= 0) return "No complete outfit yet";
  if (combos >= OUTFIT_COMBO_CAP) return `${OUTFIT_COMBO_CAP}+ outfit possibilities`;
  return `${combos} outfit ${combos === 1 ? "possibility" : "possibilities"}`;
}

/**
 * Pure signal/label computation from the candidate, its owned wardrobe and its similar
 * items. No database, no AI — unit-testable facts only.
 */
export function buildSignals(
  candidate: Doc<"items">,
  owned: Doc<"items">[],
  similar: SimilarOwned[],
  matchCount: number,
  combos: number,
  generation: EmbeddingReadGeneration = embeddingReadGeneration(),
): { signals: AdviceSignal[]; label: AdviceLabel } {
  const signals: AdviceSignal[] = [];
  // The prose threshold is the ACTIVE read generation's geometry: legacy 0.92 vs B2 0.896396. It
  // does not and cannot flag a duplicate: a `duplicate: true` entry means a legacy flag or a user
  // decision (the one path that may still say "almost exactly"), never a cosine threshold decision.
  const proseThreshold = readGenerationConfig(generation).proseThreshold;
  const strongSimilar = similar.find(
    (entry) => entry.duplicate || entry.similarity >= proseThreshold,
  );
  if (strongSimilar) {
    signals.push({
      type: "similar_owned",
      message: strongSimilar.duplicate
        ? `Matches your ${strongSimilar.item.name} almost exactly`
        : `Very similar to your ${strongSimilar.item.name}`,
    });
  }
  if (matchCount >= MANY_MATCHES_MIN) {
    signals.push({ type: "many_matches", message: `Works with ${matchCount} pieces you own` });
  }
  const sameCategory = owned.filter(
    (item) => item._id !== candidate._id && item.category === candidate.category,
  ).length;
  const categoryGap = sameCategory === 0;
  if (categoryGap) {
    signals.push({
      type: "wardrobe_gap",
      message: `Fills a gap — no ${CATEGORY_LABELS[candidate.category].toLowerCase()} in your wardrobe yet`,
    });
  }
  const ownedPrimaries = new Set(
    owned
      .filter((item) => item._id !== candidate._id)
      .map((item) => item.colours.primary.trim().toLowerCase())
      .filter((colour) => colour.length > 0),
  );
  const primary = candidate.colours.primary.trim().toLowerCase();
  if (primary.length > 0 && !ownedPrimaries.has(primary)) {
    signals.push({
      type: "wardrobe_gap",
      message: `Adds ${candidate.colours.primary.trim()}, a colour missing from your wardrobe`,
    });
  }
  if (combos <= 0) {
    signals.push({ type: "limited_matches", message: "No complete outfit with your current pieces yet" });
  } else if (matchCount < 3) {
    signals.push({
      type: "limited_matches",
      message: `Only ${matchCount} matching ${matchCount === 1 ? "piece" : "pieces"} in your wardrobe`,
    });
  }
  let label: AdviceLabel;
  if (strongSimilar) label = "duplicate-heavy";
  else if (combos <= 0) label = "limited-match";
  else if (categoryGap) label = "wardrobe-gap";
  else if (combos >= 6 || matchCount >= MANY_MATCHES_MIN) label = "versatile";
  else label = "limited-match";
  if (!ADVICE_LABELS.includes(label)) label = "limited-match";
  return { signals, label };
}

/** Pure wardrobe-fit base: matches, combinations and display copy. No similarity, no AI. */
export function computeAdviceBase(
  candidate: Doc<"items">,
  owned: Doc<"items">[],
): { matchingIds: Id<"items">[]; matchCount: number; estimatedCombinations: number; outfitDisplay: string } {
  const matches = matchingOwned(candidate, owned);
  const combos = estimateCombinations(candidate, owned);
  return {
    matchingIds: matches.slice(0, MAX_MATCHING_ITEMS).map((item) => item._id),
    matchCount: matches.length,
    estimatedCombinations: combos,
    outfitDisplay: outfitDisplay(combos),
  };
}

/** Stable similar entries for the cache row (thumbnail URLs are re-resolved on read). */
export function stableSimilarEntries(similar: SimilarOwned[]): AdviceDeterministic["similar"] {
  return similar.map((entry) => ({
    itemId: entry.item._id,
    name: entry.item.name,
    category: entry.item.category,
    similarity: entry.similarity,
    duplicate: entry.duplicate,
  }));
}

/**
 * Cache fingerprint: the ACTIVE read generation, the candidate revision, every owned revision and
 * the prefs that shape the prose. Any wardrobe, candidate, taste or generation change recomputes.
 * The client never supplies it. Short FNV-1a hex — a fingerprint, not a secret.
 *
 * The generation token is why switching `EMBEDDING_READ_GENERATION` from legacy to bge makes every
 * previously cached row a mismatch on first read: no stale prose computed in the other vector space
 * is ever served.
 */
export function adviceFingerprint(
  candidate: Doc<"items">,
  owned: Doc<"items">[],
  prefs: Doc<"users">["prefs"],
  generation: EmbeddingReadGeneration = embeddingReadGeneration(),
): string {
  const parts = [
    readGenerationConfig(generation).generationToken,
    String(candidate.updatedAt),
    prefs.presentation,
    prefs.fit,
    ...owned.map((item) => `${item._id}:${item.updatedAt}`).sort(),
  ];
  let hash = 0x811c9dc5;
  const text = parts.join("|");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function readCachedAdvice(
  ctx: Ctx,
  userId: Id<"users">,
  itemId: Id<"items">,
): Promise<Doc<"shoppingAdvice"> | null> {
  return ctx.db
    .query("shoppingAdvice")
    .withIndex("by_user_item", (q) => q.eq("userId", userId).eq("itemId", itemId))
    .unique();
}

/**
 * Cache lifetime follows the candidate item: deleting (or buying) the item deletes its
 * analysis row. Single call site for every lifecycle hook — never duplicate this query.
 * Idempotent: a missing row is a no-op, so item deletion never fails for lack of cache.
 * Scoped by (userId, itemId), so one user's cleanup can never touch another user's rows.
 */
export async function deleteShoppingAdviceForItem(
  ctx: MutationCtx,
  userId: Id<"users">,
  itemId: Id<"items">,
): Promise<boolean> {
  const existing = await readCachedAdvice(ctx, userId, itemId);
  if (!existing) return false;
  await ctx.db.delete("shoppingAdvice", existing._id);
  return true;
}

/** Which path serves this request: fresh cache, deterministic-only, or a new AI analysis. */
export function planAdvicePath(
  cached: { fingerprint: string } | null,
  fingerprint: string,
  smallWardrobe: boolean,
): "cache" | "small" | "ai" {
  if (cached && cached.fingerprint === fingerprint) return "cache";
  if (smallWardrobe) return "small";
  return "ai";
}

/**
 * Boundary validation for model prose: only bounded text fields survive. Ids, counts,
 * prompts or anything else the model returns are dropped — the server never reads item
 * ids out of model output, so invented ids cannot influence the wardrobe.
 */
export function coerceAdviceText(raw: unknown): AdviceText {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown, max: number): string =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((entry) => text(entry, ADVICE_BULLET_MAX_CHARS)).filter((entry) => entry.length > 0)
      : [];
  const summary = text(record.summary, ADVICE_SUMMARY_MAX_CHARS);
  return {
    ...(summary.length > 0 ? { summary } : {}),
    pros: list(record.pros).slice(0, ADVICE_BULLETS_MAX),
    considerations: list(record.considerations).slice(0, ADVICE_BULLETS_MAX),
  };
}

/** One analysis costs one turn of the existing stylist daily cap. Throws RATE_LIMITED past it. */
export async function consumeAdviceTurn(ctx: MutationCtx, user: Doc<"users">): Promise<number> {
  return bumpUsageCounter(ctx, user._id, "stylist", LIMITS.stylistMessagesPerDay);
}

/** Text-COGS for the one advice call, recorded in the same mutation that caches the result. */
export async function recordAdviceCogs(
  ctx: MutationCtx,
  usage: { inputTextTokens: number; outputTokens: number },
): Promise<void> {
  if (usage.inputTextTokens <= 0 && usage.outputTokens <= 0) return;
  await bumpDailyStats(ctx, {
    cogsUsd: detectUsageToUsd({
      inputTextTokens: usage.inputTextTokens,
      inputImageTokens: 0,
      outputTokens: usage.outputTokens,
    }),
  });
}

export async function writeCachedAdvice(
  ctx: MutationCtx,
  user: Doc<"users">,
  itemId: Id<"items">,
  fingerprint: string,
  deterministic: AdviceDeterministic,
  text: AdviceText,
): Promise<void> {
  const now = Date.now();
  const existing = await readCachedAdvice(ctx, user._id, itemId);
  // Cache stores stable facts only — thumbnail URLs are re-resolved on every read.
  const row = {
    userId: user._id,
    itemId,
    fingerprint,
    label: deterministic.label,
    ...(text.summary ? { summary: text.summary } : {}),
    pros: text.pros,
    considerations: text.considerations,
    similar: deterministic.similar,
    matchCount: deterministic.matchCount,
    matchingIds: deterministic.matchingIds,
    estimatedCombinations: deterministic.estimatedCombinations,
    signals: deterministic.signals,
    updatedAt: now,
  };
  if (existing) {
    if (existing.userId !== user._id) throw appError("NOT_FOUND", "That analysis is gone.");
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("shoppingAdvice", { ...row, createdAt: now });
  }
}

/** Re-resolves cached ids to fresh summaries (current names, live thumbnail URLs). */
export async function resolveCachedSummaries(
  ctx: Ctx,
  cached: Doc<"shoppingAdvice">,
): Promise<{ similar: Array<{ itemId: Id<"items">; name: string; category: Category; similarity: number; duplicate: boolean; url: string | null }>; matching: Awaited<ReturnType<typeof toItemSummary>>[] }> {
  const similar: Array<{ itemId: Id<"items">; name: string; category: Category; similarity: number; duplicate: boolean; url: string | null }> = [];
  for (const entry of cached.similar) {
    const item = await ctx.db.get(entry.itemId);
    if (!item || item.status !== "ready" || !isOwnedItem(item)) continue;
    const summary = await toItemSummary(ctx, item);
    similar.push({
      itemId: summary._id,
      name: summary.name,
      category: summary.category,
      similarity: entry.similarity,
      duplicate: entry.duplicate,
      url: summary.url,
    });
  }
  const matching: Awaited<ReturnType<typeof toItemSummary>>[] = [];
  for (const id of cached.matchingIds) {
    const item = await ctx.db.get(id);
    if (!item || item.status !== "ready" || !isOwnedItem(item)) continue;
    matching.push(await toItemSummary(ctx, item));
  }
  return { similar, matching };
}
