import type { Formality } from "../../convex/shared/wardrobe";

/**
 * Step 7 Phase C1 — the deterministic stylist request layer.
 *
 * Everything in this module is pure: no Convex, no Eve, no weather service, no model, no storage,
 * no clock. It merges a normalised turn into the previous thread state and returns a `StylistPlan`
 * that C2 (orchestration) and C3 (ranking) can consume without ever asking where a garment id came
 * from.
 *
 * Three invariants shape the file:
 *
 * 1. No garment identity crosses this boundary. The plan carries no item ids at all, and a plan can
 *    only point at an outfit the thread already holds: `resolveReferent` copies `outfitId` out of
 *    `StylistThreadState.candidates`, so parsed turn text can never contribute one.
 * 2. Unknown means unknown. A referent that does not resolve, or a turn stating no direction at
 *    all, yields a typed `clarification` requirement rather than a guess.
 * 3. Same input, same output. No `Date.now()`, no randomness, no unordered iteration — colour lists
 *    are sorted so two identical turns produce deep-equal plans.
 *
 * Imports here are type-only by design. This module is loaded both by the eve bundler (which
 * resolves the repo's extensionless TypeScript paths) and directly by `tests/stylist-plan.test.mjs`
 * (Node ESM, which does not). A value import across those paths type-checks but throws
 * ERR_MODULE_NOT_FOUND at test time, so the few runtime tables this module needs are declared here
 * and pinned to their Convex sources by assertions in that test file.
 */

/** Mirrors `FORMALITY` in `convex/shared/wardrobe.ts`; `tests/stylist-plan.test.mjs` asserts equality. */
const FORMALITIES: readonly Formality[] = ["casual", "smart-casual", "formal"];

export const STYLIST_INTENTS = ["recommend", "refine", "render", "save", "price", "gaps", "chat"] as const;
export type StylistIntent = (typeof STYLIST_INTENTS)[number];

/**
 * The product never proposes more than three looks: `compose_outfits` caps its payload at three and
 * `LIMITS.maxOutfitsPerRenderRequest` is three for the same reason. One number, asserted equal to
 * the Convex limit by the test, so no competing limit can appear here.
 */
export const MIN_OUTFITS_PER_REQUEST = 1;
export const MAX_OUTFITS_PER_REQUEST = 3;

/** "Make it warmer" accumulates; the bound stops a thread drifting into July by turn five. */
export const WARMTH_SHIFT_MIN = -2;
export const WARMTH_SHIFT_MAX = 2;

/** Proposals per turn when the user has not asked for a number, per the stylist instructions. */
export const DEFAULT_OUTFITS_PER_REQUEST = 2;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Day-scoped language the plan can hold without resolving a calendar. */
export const RELATIVE_PERIODS = ["today", "tonight", "tomorrow", "dayAfterTomorrow", "weekend"] as const;
export type RelativePeriod = (typeof RELATIVE_PERIODS)[number];

/**
 * A date as the user expressed it. `absolute` is a real `YYYY-MM-DD`; `relative` and `weekday` stay
 * unscoped until C2 supplies a clock, which is what keeps this module time-independent.
 */
export type StylistDateRef =
  | { kind: "absolute"; date: string }
  | { kind: "relative"; period: RelativePeriod }
  | { kind: "weekday"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 };

/** Slots C2 may need to ask about. C1 itself only ever raises `occasion` and `referent`. */
export const CLARIFICATION_FIELDS = ["occasion", "formality", "place", "referent"] as const;
export type ClarificationField = (typeof CLARIFICATION_FIELDS)[number];

export const CLARIFICATION_REASONS = ["missingDirection", "unknownReferent"] as const;
export type ClarificationReason = (typeof CLARIFICATION_REASONS)[number];

/**
 * A clarification decision, not a question. C1 decides *that* one is needed; C2 owns the copy and
 * the tappable options a client renders.
 */
export type ClarificationRequirement = {
  required: true;
  field: ClarificationField;
  reason: ClarificationReason;
  /** Only set where the answer is a closed set derived from real state, never invented. */
  options?: readonly string[];
};

export type ColourConstraints = {
  include: readonly string[];
  avoid: readonly string[];
};

/** A wardrobe-validated outfit the thread already holds. Read-only input; C2 owns this list. */
export type StylistCandidate = {
  /** Server-issued outfit id from a validated thread proposal. C1 never mints one. */
  outfitId: string;
  name: string;
};

/**
 * A resolved referent. `outfitId` always comes from `StylistThreadState.candidates` via
 * `resolveReferent`, so a referent can only name a candidate that already exists.
 */
export type StylistReferent = {
  position: number;
  outfitId: string;
};

/** The stable plan every later phase consumes: serialisable, no functions, no garment ids. */
export type StylistPlan = {
  intent: StylistIntent;
  brief: string | null;
  occasion: string | null;
  formality: Formality | null;
  place: string | null;
  date: StylistDateRef | null;
  /** Always within `MIN_OUTFITS_PER_REQUEST..MAX_OUTFITS_PER_REQUEST`. */
  requestedCount: number;
  /** Always within `WARMTH_SHIFT_MIN..WARMTH_SHIFT_MAX`, accumulated since the first turn. */
  warmthShift: number;
  colourConstraints: ColourConstraints;
  referent: StylistReferent | null;
  weatherNeeded: boolean;
  clarification: ClarificationRequirement | null;
  turnIndex: number;
};

/**
 * The minimal previous-thread input: the last plan, the candidate list and a turn counter. Quote,
 * approval and pending-question state belong to C2's state machine, not here.
 */
export type StylistThreadState = {
  turnIndex: number;
  plan: StylistPlan | null;
  candidates: readonly StylistCandidate[];
};

/**
 * What a referent may ask for. Deliberately no id variant: ids never come from turn text.
 */
export type ReferentRequest = { kind: "current" } | { kind: "ordinal"; position: number };

/**
 * A normalised turn. C4/C5 produces this from language; C1 does no general natural-language
 * understanding of its own beyond the narrow `readFollowUpCommand` fallback below.
 */
export type StylistTurnInput = {
  intent?: StylistIntent;
  brief?: string | null;
  occasion?: string | null;
  formality?: Formality | string | null;
  place?: string | null;
  date?: StylistDateRef | null;
  requestedCount?: number;
  /** A relative nudge, merged into the accumulated `warmthShift`. */
  warmthShift?: number;
  colourFocus?: readonly string[];
  avoidColours?: readonly string[];
  referent?: ReferentRequest;
  /** Narrow fallback for obvious follow-ups; ignored when the structured fields are present. */
  text?: string;
};

export const EMPTY_STYLIST_STATE: StylistThreadState = { turnIndex: 0, plan: null, candidates: [] };

/** Intents that mean "act on an outfit already on the table", so they need a referent. */
const REFERENT_INTENTS: ReadonlySet<StylistIntent> = new Set<StylistIntent>(["render", "save", "price"]);

export function clampOutfitCount(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_OUTFITS_PER_REQUEST) return DEFAULT_OUTFITS_PER_REQUEST;
  return Math.min(MAX_OUTFITS_PER_REQUEST, Math.trunc(value));
}

export function clampWarmthShift(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(WARMTH_SHIFT_MAX, Math.max(WARMTH_SHIFT_MIN, Math.trunc(value)));
}

export function isStylistDateRef(value: unknown): value is StylistDateRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as { kind?: unknown; date?: unknown; period?: unknown; weekday?: unknown };
  if (ref.kind === "absolute") return typeof ref.date === "string" && ISO_DATE.test(ref.date);
  if (ref.kind === "relative") return isRelativePeriod(ref.period);
  if (ref.kind === "weekday") {
    return typeof ref.weekday === "number" && Number.isInteger(ref.weekday) && ref.weekday >= 0 && ref.weekday <= 6;
  }
  return false;
}

function isRelativePeriod(value: unknown): value is RelativePeriod {
  return typeof value === "string" && (RELATIVE_PERIODS as readonly string[]).includes(value);
}

/**
 * Accepts `"Smart Casual"`, `"casual"` and friends, and rejects anything outside the wardrobe's
 * formality enum rather than letting an unknown string reach C3.
 */
export function normaliseFormality(value: Formality | string | null | undefined): Formality | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return FORMALITIES.find((formality) => formality === candidate) ?? null;
}

function normaliseToken(value: string): string {
  return value.trim().toLowerCase();
}

function normaliseTokens(values: readonly string[] | undefined): readonly string[] {
  if (!values) return [];
  return [...new Set(values.map(normaliseToken).filter((value) => value.length > 0))].sort();
}

function nullableText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether orchestration needs a forecast: explicit place and date, on a turn that chooses garments.
 * A render, save or price turn does not change with the weather, and hidden page context never
 * supplies the place.
 */
export function weatherNeeded(plan: {
  intent: StylistIntent;
  place: string | null;
  date: StylistDateRef | null;
}): boolean {
  const choosesGarments = plan.intent === "recommend" || plan.intent === "refine";
  return choosesGarments && plan.place !== null && plan.date !== null;
}

const ORDINAL_WORDS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, last: 3 };
const COUNT_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

const ORDINAL_PATTERN = /^the (first|second|third|last) one$/;
const COUNT_PATTERN = /^(?:give me|show me|put together|i need)\s+(\d+|one|two|three|four|five)(?:\s+different)?\s+outfits?$/;
const COST_PATTERN = /^(?:what will it cost|how much is (?:it|that)|how much will (?:it|that) cost)$/;

/**
 * Recognises the handful of follow-ups the frozen cases depend on, and nothing else. This is
 * deliberately not natural-language understanding: an unrecognised utterance returns `null` so
 * C4/C5 supplies the structured turn instead. It never returns a garment or outfit id.
 */
export function readFollowUpCommand(text: string): StylistTurnInput | null {
  const utterance = normaliseToken(text).replace(/[.!?]+$/, "");
  if (utterance.length === 0) return null;

  switch (utterance) {
    case "make it warmer":
      return { intent: "refine", warmthShift: 1 };
    case "make it cooler":
    case "make it less warm":
      return { intent: "refine", warmthShift: -1 };
    case "render that":
    case "render it":
      return { intent: "render", referent: { kind: "current" } };
    case "save this":
    case "save that":
      return { intent: "save", referent: { kind: "current" } };
    case "what will it cost":
    case "how much is that":
      return { intent: "price", referent: { kind: "current" } };
    default:
      break;
  }

  const ordinal = utterance.match(ORDINAL_PATTERN);
  if (ordinal) {
    const position = ORDINAL_WORDS[ordinal[1] as string];
    return position === undefined ? null : { referent: { kind: "ordinal", position } };
  }

  const count = utterance.match(COUNT_PATTERN);
  if (count) {
    const parsed = COUNT_WORDS[count[1] as string] ?? Number(count[1]);
    return Number.isFinite(parsed) ? { intent: "recommend", requestedCount: parsed } : null;
  }

  return COST_PATTERN.test(utterance) ? { intent: "price", referent: { kind: "current" } } : null;
}

/**
 * Resolves a referent against prior candidates only. An ordinal past the end, or "that" with
 * nothing to point at, returns `null` so the caller raises a clarification instead of guessing.
 */
export function resolveReferent(
  request: ReferentRequest,
  state: Pick<StylistThreadState, "candidates" | "plan">,
): StylistReferent | null {
  const { candidates } = state;
  if (request.kind === "ordinal") {
    if (!Number.isInteger(request.position) || request.position < 1) return null;
    const candidate = candidates[request.position - 1];
    return candidate ? { position: request.position, outfitId: candidate.outfitId } : null;
  }

  const inherited = state.plan?.referent;
  if (inherited && candidates.some((candidate) => candidate.outfitId === inherited.outfitId)) return inherited;
  if (candidates.length === 1) return { position: 1, outfitId: candidates[0].outfitId };
  return null;
}

/**
 * A bare "tomorrow" with no place is not styling direction: without a place there is no forecast to
 * consult, and the day alone does not change which garment is right. A relative period anchored to
 * a place does count, as does any absolute date.
 */
function hasKnownDirection(merged: {
  occasion: string | null;
  formality: Formality | null;
  place: string | null;
  date: StylistDateRef | null;
  colourConstraints: ColourConstraints;
  candidates: readonly StylistCandidate[];
}): boolean {
  if (merged.occasion !== null || merged.formality !== null || merged.place !== null) return true;
  if (merged.colourConstraints.include.length > 0) return true;
  if (merged.candidates.length > 0) return true;
  return merged.date !== null && (merged.place !== null || merged.date.kind === "absolute");
}

function ordinalWord(position: number): string {
  return position === 1 ? "first" : position === 2 ? "second" : position === 3 ? "third" : `number ${position}`;
}

function unknownReferentClarification(candidates: readonly StylistCandidate[]): ClarificationRequirement {
  const options = candidates.length > 0 ? candidates.map((_candidate, index) => ordinalWord(index + 1)) : undefined;
  return {
    required: true,
    field: "referent",
    reason: "unknownReferent",
    ...(options ? { options } : {}),
  };
}

/**
 * Merges one normalised turn into the previous state. Pure and total: it never throws, never reads a
 * clock, and returns a `clarification` requirement for anything it cannot resolve.
 */
export function mergeStylistTurn(state: StylistThreadState, turn: StylistTurnInput): StylistPlan {
  const previous = state.plan;
  const recognised = readFollowUpCommand(turn.text ?? "");
  const merged: StylistTurnInput = { ...(recognised ?? {}), ...definedFields(turn) };

  const intent = merged.intent ?? (state.candidates.length > 0 ? "refine" : "recommend");
  const occasion = nullableText(merged.occasion) ?? previous?.occasion ?? null;
  const formality = normaliseFormality(merged.formality) ?? previous?.formality ?? null;
  const place = nullableText(merged.place) ?? previous?.place ?? null;
  const date = isStylistDateRef(merged.date) ? merged.date : (previous?.date ?? null);
  const brief = nullableText(merged.brief) ?? previous?.brief ?? null;
  const warmthShift = clampWarmthShift((previous?.warmthShift ?? 0) + (merged.warmthShift ?? 0));
  const requestedCount = clampOutfitCount(merged.requestedCount ?? previous?.requestedCount);
  const colourConstraints: ColourConstraints = {
    include: normaliseTokens([...(previous?.colourConstraints.include ?? []), ...(merged.colourFocus ?? [])]),
    avoid: normaliseTokens([...(previous?.colourConstraints.avoid ?? []), ...(merged.avoidColours ?? [])]),
  };

  // A referent-intent keeps the previous referent when the turn does not name one; every other
  // intent must ask for it explicitly, so a "recommend" can never silently carry "that one" forward.
  const referentRequest = merged.referent ?? (REFERENT_INTENTS.has(intent) ? asRequest(previous?.referent) : undefined);
  const referentRequested = referentRequest !== undefined;
  const referent = referentRequest ? resolveReferent(referentRequest, state) : null;

  let clarification: ClarificationRequirement | null = null;
  if (referentRequested && referent === null) {
    clarification = unknownReferentClarification(state.candidates);
  } else if (
    (intent === "recommend" || intent === "refine") &&
    !hasKnownDirection({ occasion, formality, place, date, colourConstraints, candidates: state.candidates })
  ) {
    clarification = { required: true, field: "occasion", reason: "missingDirection" };
  }

  const resolved: Omit<StylistPlan, "weatherNeeded"> = {
    intent,
    brief,
    occasion,
    formality,
    place,
    date,
    requestedCount,
    warmthShift,
    colourConstraints,
    referent,
    clarification,
    turnIndex: state.turnIndex + 1,
  };

  return { ...resolved, weatherNeeded: weatherNeeded(resolved) };
}

function asRequest(referent: StylistReferent | null | undefined): ReferentRequest | undefined {
  return referent ? { kind: "ordinal", position: referent.position } : undefined;
}

function definedFields(turn: StylistTurnInput): StylistTurnInput {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(turn)) {
    if (value !== undefined) out[key] = value;
  }
  return out as StylistTurnInput;
}
