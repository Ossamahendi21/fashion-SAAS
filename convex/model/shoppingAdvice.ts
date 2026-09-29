import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { detectUsageToUsd, LIMITS } from "../shared/credits";
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
/** Vector hits scanned per analysis; mapped down to owned ready items only. */
export const VECTOR_SEARCH_LIMIT = 8;
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
 * The candidate's embedding vector for similarity search, or null when it was never
 * embedded. Query-safe: the actual vector search runs in the action (Convex 1.45
 * exposes `vectorSearch` on actions only), and hit mapping stays in queries.
 */
export async function getCandidateVector(
  ctx: Ctx,
  candidateId: Id<"items">,
): Promise<number[] | null> {
  const row = await ctx.db
    .query("itemEmbeddings")
    .withIndex("by_item", (q) => q.eq("itemId", candidateId))
    .unique();
  return row && Array.isArray(row.embedding) && row.embedding.length > 0 ? [...row.embedding] : null;
}

/**
 * Maps vector-search hits back to the strongest similar OWNED ready items. Hits resolve
 * through the embedding rows (never trusted directly): foreign rows, unready items,
 * considering rows and the candidate itself are all dropped. A duplicateOfId already
 * pointing at an owned ready item leads the list as a certain match. Bounded to a few.
 */
export async function resolveSimilarOwned(
  ctx: Ctx,
  user: Doc<"users">,
  candidate: Doc<"items">,
  hits: Array<{ embeddingId: Id<"itemEmbeddings">; score: number }>,
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
  for (const hit of hits) {
    const embedding = await ctx.db.get(hit.embeddingId);
    if (!embedding || embedding.userId !== user._id || embedding.itemId === candidate._id) continue;
    const item = await ctx.db.get(embedding.itemId);
    if (!item || item.userId !== user._id || item.status !== "ready" || !isOwnedItem(item)) continue;
    if (found.some((entry) => entry.item._id === item._id)) continue;
    found.push({ item, similarity: Math.round(hit.score * 100) / 100, duplicate: false });
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
): { signals: AdviceSignal[]; label: AdviceLabel } {
  const signals: AdviceSignal[] = [];
  const strongSimilar = similar.find(
    (entry) => entry.duplicate || entry.similarity >= LIMITS.duplicateCosineThreshold,
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
 * Cache fingerprint: the candidate revision plus every owned revision plus the prefs
 * that shape the prose. Any wardrobe, candidate or taste change recomputes. The client
 * never supplies it. Short FNV-1a hex — a fingerprint, not a secret.
 */
export function adviceFingerprint(
  candidate: Doc<"items">,
  owned: Doc<"items">[],
  prefs: Doc<"users">["prefs"],
): string {
  const parts = [
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
