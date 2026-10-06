import type { Formality } from "../../convex/shared/wardrobe";
import type { StylistPlan } from "./stylist-plan";

/**
 * Step 7 Phase C3 — the deterministic outfit ranker.
 *
 * Pure by construction: no Convex, no Eve, no model, no clock, no randomness, no storage. It takes
 * ready wardrobe items (the real `items` table subset), a C1 `StylistPlan` and already-fetched
 * weather facts, and returns a typed ranking or a typed gap. The same inputs always produce the
 * same candidates.
 *
 * Three contracts shape the module:
 *
 * 1. Trusted ids only. Every id in the output comes from the input wardrobe; the ranker never
 *    mints or invents one. `CandidateOutfit.key` is a deterministic slot signature (not a persisted
 *    row id), and `candidateToProposal` turns a candidate into the `{ outfitId, name }` shape C2's
 *    proposal contract consumes.
 * 2. Structural problems are typed gaps, expressed preferences are soft scores. A wardrobe that
 *    cannot yield a complete outfit returns `noReadyItems` / `missing*`; an impossible colour or
 *    formality request returns `colourConstraintUnsatisfied` / `formalityConstraintUnsatisfied`.
 *    Everything else (colour cohesion, formality adjacency, warm/cool season fit) only reorders.
 * 3. Metadata is real. Only fields the `items` table actually stores are read: `status`, `category`,
 *    `colours`, `season`, `formality`, `wearCount`. No pattern, fit or weather dimension is
 *    fabricated; a missing field simply contributes nothing.
 */

export type WardrobeItem = {
  id: string;
  name: string;
  status: "extracting" | "ready" | "failed" | "hidden" | "needsCredits";
  category: "top" | "bottom" | "outerwear" | "dress" | "shoes" | "accessory" | "bag" | "headwear";
  subcategory?: string;
  colours: { primary: string; secondary: readonly string[]; hex: readonly string[] };
  pattern?: string;
  material?: string;
  season?: readonly ("spring" | "summer" | "autumn" | "winter")[];
  formality?: Formality;
  fit?: "slim" | "regular" | "relaxed" | "oversized";
  wearCount?: number;
  lastWornAt?: number;
};

export type OutfitSlot = {
  outerwear?: string;
  top?: string;
  bottom?: string;
  dress?: string;
  shoes?: string;
  accessories?: readonly string[];
};

export type CandidateOutfit = {
  /** Deterministic signature derived only from the slots; C2 uses it as the proposal `outfitId`. */
  key: string;
  slots: OutfitSlot;
  score: number;
  facts: readonly string[];
};

export type RankGapCode =
  | "noReadyItems"
  | "missingTop"
  | "missingBottom"
  | "missingDress"
  | "missingShoes"
  | "missingOuterwear"
  | "colourConstraintUnsatisfied"
  | "formalityConstraintUnsatisfied";

export type RankGap = {
  code: RankGapCode;
  message: string;
};

export type RankResult =
  | { ok: true; candidates: readonly CandidateOutfit[] }
  | { ok: false; gap: RankGap };

export type WeatherFacts = {
  minC?: number;
  maxC?: number;
  precipProb?: number;
};

export type RankInput = {
  wardrobe: readonly WardrobeItem[];
  plan: StylistPlan;
  weather: WeatherFacts;
};

export const COLD_THRESHOLD_C = 12;
export const HOT_THRESHOLD_C = 24;
export const PRECIP_THRESHOLD = 0.4;

const MIN_OUTFITS = 1;
const MAX_OUTFITS = 3;
const DEFAULT_OUTFITS = 2;

/** Cross-product guard: a large wardrobe can pair thousands of ways, but only three are proposed. */
const MAX_CANDIDATES = 500;

const WARM_SEASONS = new Set(["autumn", "winter"]);
const COOL_SEASONS = new Set(["spring", "summer"]);

const FORMALITY_RANK: Record<Formality, number> = { casual: 0, "smart-casual": 1, formal: 2 };

export function readWeather(weather: WeatherFacts | undefined): { cold: boolean; hot: boolean; wet: boolean } {
  const w = weather ?? {};
  return {
    cold: typeof w.minC === "number" && w.minC <= COLD_THRESHOLD_C,
    hot: typeof w.maxC === "number" && w.maxC >= HOT_THRESHOLD_C,
    wet: typeof w.precipProb === "number" && w.precipProb >= PRECIP_THRESHOLD,
  };
}

export function clampRequestedCount(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_OUTFITS;
  return Math.min(MAX_OUTFITS, Math.max(MIN_OUTFITS, Math.trunc(value)));
}

function normaliseColour(value: string): string {
  return value.trim().toLowerCase();
}

function itemColours(item: WardrobeItem): readonly string[] {
  const tokens: string[] = [];
  const primary = normaliseColour(item.colours.primary);
  if (primary.length > 0) tokens.push(primary);
  for (const colour of item.colours.secondary) {
    const token = normaliseColour(colour);
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}

function matchesSeason(item: WardrobeItem, seasons: ReadonlySet<string>): boolean {
  return (item.season ?? []).some((season) => seasons.has(season));
}

function compareItems(a: WardrobeItem, b: WardrobeItem): number {
  const wear = (a.wearCount ?? 0) - (b.wearCount ?? 0);
  if (wear !== 0) return wear;
  return compareKey(a.id, b.id);
}

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formalityPoints(item: WardrobeItem, target: Formality | null): number {
  if (!target || !item.formality) return 0;
  const distance = Math.abs(FORMALITY_RANK[item.formality] - FORMALITY_RANK[target]);
  if (distance === 0) return 2;
  if (distance === 1) return 1;
  return -1;
}

export function candidateKey(slots: OutfitSlot): string {
  const parts: string[] = [];
  if (slots.bottom) parts.push(`bottom:${slots.bottom}`);
  if (slots.dress) parts.push(`dress:${slots.dress}`);
  if (slots.outerwear) parts.push(`outerwear:${slots.outerwear}`);
  if (slots.shoes) parts.push(`shoes:${slots.shoes}`);
  if (slots.top) parts.push(`top:${slots.top}`);
  if (slots.accessories && slots.accessories.length > 0) {
    parts.push(`accessories:${[...slots.accessories].sort(compareKey).join(",")}`);
  }
  return parts.join("|");
}

function makeSlots(base: OutfitSlot, outerwear: string | undefined): OutfitSlot {
  return outerwear ? { ...base, outerwear } : base;
}

function slotItems(slots: OutfitSlot, byId: ReadonlyMap<string, WardrobeItem>): WardrobeItem[] {
  const items: WardrobeItem[] = [];
  for (const id of [slots.top, slots.bottom, slots.dress, slots.outerwear, slots.shoes]) {
    if (!id) continue;
    const item = byId.get(id);
    if (item) items.push(item);
  }
  for (const id of slots.accessories ?? []) {
    const item = byId.get(id);
    if (item) items.push(item);
  }
  return items;
}

function factsFor(slots: OutfitSlot, byId: ReadonlyMap<string, WardrobeItem>): readonly string[] {
  const facts: string[] = [];
  for (const item of slotItems(slots, byId)) {
    const colour = item.colours.primary.trim().length > 0 ? item.colours.primary.trim() : "uncoloured";
    const formality = item.formality ?? "unstated";
    facts.push(`${item.category}: ${item.name} (${colour}, ${formality})`);
  }
  return facts;
}

function scoreCandidate(
  items: readonly WardrobeItem[],
  slots: OutfitSlot,
  plan: StylistPlan,
  weather: { cold: boolean; hot: boolean; wet: boolean },
  includeColours: ReadonlySet<string>,
): number {
  let score = 0;
  for (const item of items) score += formalityPoints(item, plan.formality);

  if (includeColours.size > 0) {
    const matched = new Set<string>();
    for (const item of items) {
      for (const colour of itemColours(item)) if (includeColours.has(colour)) matched.add(colour);
    }
    score += 3 * matched.size;
  }

  if (weather.cold) {
    if (slots.outerwear) score += 2;
    for (const item of items) if (matchesSeason(item, WARM_SEASONS)) score += 1;
  }
  if (weather.hot) {
    for (const item of items) if (matchesSeason(item, COOL_SEASONS)) score += 1;
  }
  if (weather.wet && slots.outerwear) score += 1;

  return score;
}

function gapMessage(code: RankGap["code"]): string {
  switch (code) {
    case "noReadyItems":
      return "No items in the wardrobe are ready to wear yet.";
    case "missingTop":
      return "No ready top is available, and there is no dress to build around.";
    case "missingBottom":
      return "No ready bottom is available, and there is no dress to build around.";
    case "missingDress":
      return "No ready top-and-bottom pair or dress is available.";
    case "missingShoes":
      return "No ready shoes are available.";
    case "missingOuterwear":
      return "It is cold but there is no ready outerwear to add.";
    case "colourConstraintUnsatisfied":
      return "No complete outfit can satisfy the requested colours.";
    case "formalityConstraintUnsatisfied":
      return "No complete outfit can include the requested formality.";
  }
}

function fail(code: RankGap["code"]): RankResult {
  return { ok: false, gap: { code, message: gapMessage(code) } };
}

/**
 * Rank the wardrobe against the plan. Returns at most `plan.requestedCount` (clamped to 1..3)
 * candidates, or the first structural gap that makes a complete outfit impossible.
 */
export function rankOutfits(input: {
  wardrobe: readonly WardrobeItem[];
  plan: StylistPlan;
  weather: WeatherFacts;
}): RankResult {
  const { wardrobe, plan } = input;
  const weather = readWeather(input.weather);

  const ready = wardrobe.filter((item) => item.status === "ready");
  if (ready.length === 0) return fail("noReadyItems");

  const pool = {
    top: [] as WardrobeItem[],
    bottom: [] as WardrobeItem[],
    outerwear: [] as WardrobeItem[],
    dress: [] as WardrobeItem[],
    shoes: [] as WardrobeItem[],
    accessory: [] as WardrobeItem[],
  };
  for (const item of ready) {
    if (item.category === "top") pool.top.push(item);
    else if (item.category === "bottom") pool.bottom.push(item);
    else if (item.category === "outerwear") pool.outerwear.push(item);
    else if (item.category === "dress") pool.dress.push(item);
    else if (item.category === "shoes") pool.shoes.push(item);
    else pool.accessory.push(item);
  }
  for (const key of Object.keys(pool) as (keyof typeof pool)[]) pool[key].sort(compareItems);

  const separates = pool.top.length > 0 && pool.bottom.length > 0;
  const dressPath = pool.dress.length > 0;
  if (!separates && !dressPath) {
    if (pool.top.length === 0 && pool.bottom.length === 0) return fail("missingDress");
    if (pool.top.length === 0) return fail("missingTop");
    return fail("missingBottom");
  }
  if (pool.shoes.length === 0) return fail("missingShoes");
  if (weather.cold && pool.outerwear.length === 0) return fail("missingOuterwear");

  const requestedFormality = plan.formality ?? null;
  if (requestedFormality && !ready.some((item) => item.formality === requestedFormality)) {
    return fail("formalityConstraintUnsatisfied");
  }

  const includeColours = new Set(plan.colourConstraints.include.map(normaliseColour).filter((c) => c.length > 0));
  const avoidColours = new Set(plan.colourConstraints.avoid.map(normaliseColour).filter((c) => c.length > 0));
  if (includeColours.size > 0) {
    const anyMatch = ready.some((item) => itemColours(item).some((colour) => includeColours.has(colour)));
    if (!anyMatch) return fail("colourConstraintUnsatisfied");
  }

  const outerwearOptions: (string | undefined)[] = weather.cold
    ? pool.outerwear.map((item) => item.id)
    : [undefined, ...(weather.wet ? pool.outerwear.map((item) => item.id) : [])];

  const combos: OutfitSlot[] = [];
  outer: for (const outerwear of outerwearOptions) {
    if (separates) {
      for (const top of pool.top) {
        for (const bottom of pool.bottom) {
          for (const shoes of pool.shoes) {
            combos.push(makeSlots({ top: top.id, bottom: bottom.id, shoes: shoes.id }, outerwear));
            if (combos.length >= MAX_CANDIDATES) break outer;
          }
        }
      }
    }
    if (dressPath) {
      for (const dress of pool.dress) {
        for (const shoes of pool.shoes) {
          combos.push(makeSlots({ dress: dress.id, shoes: shoes.id }, outerwear));
          if (combos.length >= MAX_CANDIDATES) break outer;
        }
      }
    }
  }

  const byId = new Map(ready.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const entries: { candidate: CandidateOutfit; wear: number }[] = [];

  for (const slots of combos) {
    const items = slotItems(slots, byId);
    if (avoidColours.size > 0 && items.some((item) => itemColours(item).some((colour) => avoidColours.has(colour)))) continue;
    if (includeColours.size > 0 && !items.some((item) => itemColours(item).some((colour) => includeColours.has(colour)))) continue;
    if (requestedFormality && !items.some((item) => item.formality === requestedFormality)) continue;

    const key = candidateKey(slots);
    if (seen.has(key)) continue;
    seen.add(key);

    const facts = factsFor(slots, byId);
    const score = scoreCandidate(items, slots, plan, weather, includeColours);
    entries.push({
      candidate: { key, slots, score, facts },
      wear: items.reduce((total, item) => total + (item.wearCount ?? 0), 0),
    });
  }

  if (entries.length === 0) {
    if (includeColours.size > 0 || avoidColours.size > 0) return fail("colourConstraintUnsatisfied");
    if (requestedFormality) return fail("formalityConstraintUnsatisfied");
    return fail("noReadyItems");
  }

  entries.sort(
    (a, b) =>
      b.candidate.score - a.candidate.score ||
      a.wear - b.wear ||
      compareKey(a.candidate.key, b.candidate.key),
  );

  const limit = clampRequestedCount(plan.requestedCount);
  return { ok: true, candidates: entries.slice(0, limit).map((entry) => entry.candidate) };
}

/**
 * Map a candidate onto C2's proposal contract. `outfitId` is the deterministic candidate key (never
 * a fabricated persisted row id) and `name` is the item names it was built from, in slot order.
 */
export function candidateToProposal(
  candidate: CandidateOutfit,
  wardrobe: readonly WardrobeItem[],
): { outfitId: string; name: string } {
  const byId = new Map(wardrobe.map((item) => [item.id, item]));
  const names: string[] = [];
  for (const item of slotItems(candidate.slots, byId)) names.push(item.name);
  return { outfitId: candidate.key, name: names.length > 0 ? names.join(" · ") : "Outfit" };
}