import type { Formality } from "../../convex/shared/wardrobe";

/** Mirrors C1's plan types so C2 stays pure. */
export type StylistIntent = "recommend" | "refine" | "render" | "save" | "price" | "gaps" | "chat";
export type RelativePeriod = "today" | "tonight" | "tomorrow" | "dayAfterTomorrow" | "weekend";
export type StylistDateRef =
  | { kind: "absolute"; date: string }
  | { kind: "relative"; period: RelativePeriod }
  | { kind: "weekday"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 };
export type ColourConstraints = { include: readonly string[]; avoid: readonly string[] };
export type StylistReferent = { position: number; outfitId: string };

export type StylistPlan = {
  intent: StylistIntent;
  brief: string | null;
  occasion: string | null;
  formality: Formality | null;
  place: string | null;
  date: StylistDateRef | null;
  requestedCount: number;
  warmthShift: number;
  colourConstraints: ColourConstraints;
  referent: StylistReferent | null;
  weatherNeeded: boolean;
  clarification: ClarificationRequirement | null;
  turnIndex: number;
};

export type ClarificationRequirement = {
  required: true;
  field: "occasion" | "formality" | "place" | "referent";
  reason: "missingDirection" | "unknownReferent";
  options?: readonly string[];
};

export const QUOTE_TTL_MS = 10 * 60 * 1000;

export type StylistCandidate = {
  outfitId: string;
  name: string;
};

export type QuotePerOutfit = {
  outfitId: string;
  credits: number;
};

export type StylistQuote = {
  outfitIds: readonly string[];
  perOutfit: readonly QuotePerOutfit[];
  quality: "standard" | "hq" | "pro";
  credits: number;
  quotedAt: number;
  expiresAt: number;
};

export type StylistThreadState = {
  version: 1;
  stage: StylistStage;
  turnIndex: number;
  plan: StylistPlan | null;
  candidates: readonly StylistCandidate[];
  selectedReferent: StylistReferent | null;
  quote: StylistQuote | null;
  approved: boolean;
  approvalRejectedAt: number | null;
  renderJobId: string | null;
  savedOutfitId: string | null;
  pendingQuestion: string | null;
  updatedAt: number;
};

export const STYLIST_STAGES = [
  "IDLE",
  "RECOMMENDED",
  "PROPOSED",
  "QUOTED",
  "AWAITING_APPROVAL",
  "RENDERING",
  "RENDERED",
  "SAVED",
  "BLOCKED",
] as const;

export type StylistStage = (typeof STYLIST_STAGES)[number];

export const EMPTY_STYLIST_STATE: StylistThreadState = {
  version: 1,
  stage: "IDLE",
  turnIndex: 0,
  plan: null,
  candidates: [],
  selectedReferent: null,
  quote: null,
  approved: false,
  approvalRejectedAt: null,
  renderJobId: null,
  savedOutfitId: null,
  pendingQuestion: null,
  updatedAt: 0,
};

export function quoteIdentityMatches(a: StylistQuote, b: StylistQuote): boolean {
  if (a.quality !== b.quality) return false;
  if (a.credits !== b.credits) return false;
  if (a.outfitIds.length !== b.outfitIds.length) return false;
  for (let i = 0; i < a.outfitIds.length; i++) if (a.outfitIds[i] !== b.outfitIds[i]) return false;
  if (a.perOutfit.length !== b.perOutfit.length) return false;
  for (let i = 0; i < a.perOutfit.length; i++) {
    if (a.perOutfit[i].outfitId !== b.perOutfit[i].outfitId) return false;
    if (a.perOutfit[i].credits !== b.perOutfit[i].credits) return false;
  }
  return true;
}

export function quoteExpired(quote: StylistQuote, now: number): boolean {
  return now >= quote.expiresAt;
}
