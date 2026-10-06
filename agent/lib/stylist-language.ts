import type { StylistDateRef, StylistIntent, StylistTurnInput } from "./stylist-plan";

/**
 * Step 7 Phase C5 — the deterministic raw-language front door.
 *
 * This module turns a normal user sentence into the narrow `StylistTurnInput` that C1 already
 * understands. It is pure: no clock, no randomness, no Convex, no model, no storage. The same text
 * always yields the same turn.
 *
 * It is deliberately NOT natural-language understanding. It recognises a bounded, explainable set of
 * cues and ignores everything else, so unsupported language degrades to `{ ok: false }` rather than a
 * guess. Three invariants matter:
 *
 * 1. No authority from text. A parsed turn can only carry the harmless fields of `StylistTurnInput`.
 *    Ids (garment, outfit, quote), identity, credits, approval and render-job values are not
 *    representable here, so text that looks like `outfit abc123` or `approved=true` cannot become
 *    trusted state. Referents are positional only; C1/C2 resolve them against real proposals.
 * 2. Unknown means unknown. Anything the cue set cannot map confidently returns `ok: false` with a
 *    `chat` turn, which the orchestrator answers without composing, quoting, rendering or saving.
 * 3. Constraints only from real vocabulary. Colours are read from a fixed lexicon mirroring the
 *    wardrobe; a word outside it is not promoted to trusted metadata.
 */

/** Colours the parser will promote into a plan colour constraint. Mirrors the wardrobe's tokens. */
export const KNOWN_COLOURS = [
  "white",
  "black",
  "grey",
  "navy",
  "indigo",
  "brown",
  "tan",
  "beige",
  "camel",
  "olive",
  "green",
  "red",
  "pink",
  "burgundy",
] as const;

export type KnownColour = (typeof KNOWN_COLOURS)[number];

const OCCASIONS = [
  "dinner",
  "work",
  "office",
  "wedding",
  "party",
  "interview",
  "brunch",
  "church",
  "graduation",
  "funeral",
  "gym",
] as const;

const WEEKDAYS: Readonly<Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const COUNT_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, couple: 2, few: 3 };
const OUTFIT_NOUNS = new Set(["outfit", "outfits", "look", "looks", "option", "options", "way", "ways"]);

/**
 * The order the parser tries families in. Earlier families win, which is what keeps a short follow-up
 * ("render that") from being swallowed by the broad recommendation matcher and what keeps a negated
 * action from ever becoming that action.
 */
export const PARSER_PRECEDENCE = ["negation", "gaps", "price", "save", "render", "refine", "recommend", "referent"] as const;

export type StylistParseReason = "empty" | "unsupported";

/**
 * A parse is either an actionable, normalised turn or a safe fallback. The fallback always carries a
 * `chat` turn and never touches a port.
 */
export type StylistParseResult =
  | { ok: true; raw: string; turn: StylistTurnInput }
  | { ok: false; raw: string; reason: StylistParseReason; turn: StylistTurnInput };

const NEGATED_ACTION =
  /\b(?:do(?:n'?t| not)|does(?:n'?t| not)|did(?:n'?t| not)|am not|is not|are not|not (?:asking|going|want|wanna|trying)|no need)\b[^.?!]*?\b(?:render|save|buy|start|generate|spend|purchase)\b/;
const CANCEL = /^(?:cancel|stop|nevermind|never mind|forget it|leave it)\b/;

const GAPS_CUE = /\b(?:what am i missing|what should i add|what do i need|what do i (?:lack|need)|wardrobe gaps?|gaps? in my wardrobe|missing from my wardrobe)\b/;
const PRICE_CUE = /\b(?:what will it cost|how much (?:will|would|does|do|to|is)|how many credits|how much are the credits|what'?s the (?:price|cost)|price|cost)\b/;
const SAVE_CUE = /\b(?:save|keep|bookmark)\b/;
const RENDER_CUE = /\brender\b|\bstart the (?:render|job)\b|\bmake (?:that|this|it) real\b|\bshow me what (?:that|this|it) looks like\b|\bsee what (?:that|this|it) looks like\b|\bgenerate (?:that|this|it)\b/;
const CONSTRUCTION_CUE = /\b(?:give me|show me|put together|build me|find me|i need|i want|what should i wear|outfit for|i'?m looking for|help me find)\b/;
const REFINE_CUE = /\b(?:warmer|warm it up|more warm|cooler|colder|less warm|more formal|more casual|less formal|too formal|too casual|smarter|dress (?:it )?up|dress (?:it )?down|more relaxed|adjust)\b/;

function fallback(raw: string, reason: StylistParseReason): StylistParseResult {
  return { ok: false, raw, reason, turn: { intent: "chat" } };
}

function actionable(raw: string, turn: StylistTurnInput): StylistParseResult {
  return { ok: true, raw, turn };
}

/** Tokenise to bare words, dropping punctuation but keeping hyphens (so `black-tie` stays one token). */
function tokensOf(lower: string): string[] {
  return lower
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9-]/g, ""))
    .filter((token) => token.length > 0);
}

function extractFormality(lower: string): "casual" | "smart-casual" | "formal" | null {
  if (/\bsmart[\s-]?casual\b/.test(lower)) return "smart-casual";
  if (/\bformal\b|black[\s-]?tie|dressy|evening wear/.test(lower)) return "formal";
  if (/\bcasual\b/.test(lower)) return "casual";
  return null;
}

function extractOccasion(lower: string): string | null {
  for (const occasion of OCCASIONS) {
    if (new RegExp(`\\b${occasion}\\b`).test(lower)) return occasion;
  }
  return null;
}

function extractWarmth(lower: string): number {
  if (/\b(?:warmer|warm it up|more warm)\b/.test(lower)) return 1;
  if (/\b(?:cooler|colder|less warm)\b/.test(lower)) return -1;
  return 0;
}

function extractCount(lower: string): number | null {
  const tokens = tokensOf(lower);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    const value = /^\d+$/.test(token) ? Number(token) : COUNT_WORDS[token];
    if (value === undefined) continue;
    for (let j = i + 1; j <= i + 3 && j < tokens.length; j += 1) {
      if (OUTFIT_NOUNS.has(tokens[j] as string)) return value;
    }
  }
  return null;
}

function extractReferent(lower: string): StylistTurnInput["referent"] | undefined {
  const ordinal = lower.match(/\b(?:the\s+)?(first|1st|second|2nd|third|3rd|last)\b/);
  if (ordinal) {
    const word = ordinal[1] as string;
    const position = word === "first" || word === "1st" ? 1 : word === "second" || word === "2nd" ? 2 : 3;
    return { kind: "ordinal", position };
  }
  return undefined;
}

function isCurrentReferent(lower: string): boolean {
  return /\b(?:that one|this one|that|this|it)\b/.test(lower);
}

function extractColours(lower: string): { include: string[]; avoid: string[] } {
  const colourText = lower.replace(/black[\s-]?tie/g, " ");
  const tokens = tokensOf(colourText);
  const include = new Set<string>();
  const avoid = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    const canonical = token === "gray" ? "grey" : token;
    if (!KNOWN_COLOURS.includes(canonical as (typeof KNOWN_COLOURS)[number])) continue;

    const window = tokens.slice(Math.max(0, i - 4), i);
    const isAvoided = window.some((word) => word === "no" || word === "not" || word === "dont" || word === "without" || word === "avoid" || word === "avoiding" || word === "never" || word === "skip" || word === "hate" || word === "don");
    if (isAvoided) avoid.add(canonical);
    else include.add(canonical);
  }

  return { include: [...include].sort(), avoid: [...avoid].sort() };
}

function extractPlace(text: string): string | null {
  const match = text.match(/\b(?:in|near|around|at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/);
  if (!match) return null;
  const place = (match[1] as string).trim();
  const first = (place.split(/\s+/)[0] as string).toLowerCase();
  if (WEEKDAYS[first] !== undefined) return null;
  if (["today", "tonight", "tomorrow", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].includes(first)) {
    return null;
  }
  return place;
}

function extractDate(lower: string): StylistDateRef | null {
  const iso = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return { kind: "absolute", date: iso[1] as string };
  if (/\bday after tomorrow\b/.test(lower)) return { kind: "relative", period: "dayAfterTomorrow" };
  if (/\btomorrow\b/.test(lower)) return { kind: "relative", period: "tomorrow" };
  if (/\btonight\b/.test(lower)) return { kind: "relative", period: "tonight" };
  if (/\btoday\b/.test(lower)) return { kind: "relative", period: "today" };
  if (/\bweekend\b/.test(lower)) return { kind: "relative", period: "weekend" };
  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return { kind: "weekday", weekday };
  }
  return null;
}

function withReferent(
  turn: StylistTurnInput,
  referent: StylistTurnInput["referent"],
): StylistTurnInput {
  if (referent) return { ...turn, referent };
  return { ...turn, referent: { kind: "current" } };
}

/**
 * Parse one raw utterance into a normalised C1 turn, or a safe fallback. Pure and total: it never
 * throws, reads no clock, touches no port, and carries no id, identity, cost or approval field.
 */
export function parseStylistText(raw: string): StylistParseResult {
  const source = typeof raw === "string" ? raw : "";
  const text = source.replace(/\s+/g, " ").trim();
  if (text.length === 0) return fallback("", "empty");

  const lower = text.toLowerCase();
  if (NEGATED_ACTION.test(lower) || CANCEL.test(lower)) return fallback(text, "unsupported");

  const { include, avoid } = extractColours(lower);
  const formality = extractFormality(lower);
  const occasion = extractOccasion(lower);
  const warmth = extractWarmth(lower);
  const count = extractCount(lower);
  const date = extractDate(lower);
  const place = extractPlace(text);
  const referent = extractReferent(lower);
  const construction = CONSTRUCTION_CUE.test(lower);

  if (GAPS_CUE.test(lower)) return actionable(text, { intent: "gaps" });

  if (PRICE_CUE.test(lower)) return actionable(text, withReferent({ intent: "price" }, referent));

  if (SAVE_CUE.test(lower)) return actionable(text, withReferent({ intent: "save" }, referent));

  if (RENDER_CUE.test(lower)) return actionable(text, withReferent({ intent: "render" }, referent));

  const colourRefine = include.length > 0 && !construction;
  const refinement = warmth !== 0 || REFINE_CUE.test(lower) || avoid.length > 0 || colourRefine;
  if (refinement && !construction) {
    const turn: StylistTurnInput = { intent: "refine" };
    if (warmth !== 0) turn.warmthShift = warmth;
    if (formality) turn.formality = formality;
    if (occasion) turn.occasion = occasion;
    if (include.length > 0) turn.colourFocus = include;
    if (avoid.length > 0) turn.avoidColours = avoid;
    if (date) turn.date = date;
    if (place) turn.place = place;
    if (referent) turn.referent = referent;
    return actionable(text, turn);
  }

  if (construction || occasion || formality || count !== null || include.length > 0 || avoid.length > 0 || place || date) {
    const turn: StylistTurnInput = { intent: "recommend", brief: text };
    if (formality) turn.formality = formality;
    if (occasion) turn.occasion = occasion;
    if (count !== null) turn.requestedCount = count;
    if (include.length > 0) turn.colourFocus = include;
    if (avoid.length > 0) turn.avoidColours = avoid;
    if (date) turn.date = date;
    if (place) turn.place = place;
    return actionable(text, turn);
  }

  if (referent) return actionable(text, { intent: "refine", referent });
  if (isCurrentReferent(lower)) return actionable(text, { intent: "refine", referent: { kind: "current" } });

  return fallback(text, "unsupported");
}

/** Convenience for callers that only need the intent, never the authority. */
export function parsedIntent(result: StylistParseResult): StylistIntent | "chat" {
  return (result.turn.intent ?? "chat") as StylistIntent | "chat";
}