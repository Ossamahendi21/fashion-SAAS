import assert from "node:assert/strict";
import test from "node:test";

import { LIMITS } from "../convex/shared/credits.ts";
import { FORMALITY } from "../convex/shared/wardrobe.ts";
import {
  DEFAULT_OUTFITS_PER_REQUEST,
  EMPTY_STYLIST_STATE,
  MAX_OUTFITS_PER_REQUEST,
  MIN_OUTFITS_PER_REQUEST,
  RELATIVE_PERIODS,
  STYLIST_INTENTS,
  WARMTH_SHIFT_MAX,
  WARMTH_SHIFT_MIN,
  clampOutfitCount,
  isStylistDateRef,
  mergeStylistTurn,
  normaliseFormality,
  readFollowUpCommand,
  resolveReferent,
  weatherNeeded,
} from "../agent/lib/stylist-plan.ts";

const candidates = (count) => Array.from({ length: count }, (_unused, index) => ({ outfitId: `outfit_${index + 1}`, name: `Outfit ${index + 1}` }));

/** State as C2 would hand it over: the plan returned by the previous turn, plus its candidates. */
const afterTurns = (turns, threadCandidates = []) => {
  let state = EMPTY_STYLIST_STATE;
  for (const turn of turns) state = { turnIndex: state.plan?.turnIndex ?? 0, plan: mergeStylistTurn(state, turn), candidates: threadCandidates };
  return state;
};

const planFor = (turn, state = EMPTY_STYLIST_STATE) => mergeStylistTurn(state, turn);

test("a first recommendation asks for two outfits and needs no clarification", () => {
  const plan = planFor({ intent: "recommend", occasion: "casual coffee", formality: "casual" });
  assert.equal(plan.intent, "recommend");
  assert.equal(plan.requestedCount, DEFAULT_OUTFITS_PER_REQUEST);
  assert.equal(plan.turnIndex, 1);
  assert.equal(plan.clarification, null);
  assert.equal(plan.referent, null);
});

test("explicit outfit counts of one and three are honoured", () => {
  assert.equal(planFor({ intent: "recommend", formality: "formal", requestedCount: 1 }).requestedCount, 1);
  assert.equal(planFor({ intent: "recommend", formality: "formal", requestedCount: 3 }).requestedCount, 3);
});

test("four outfits clamps to the shared product maximum", () => {
  const plan = planFor({ intent: "recommend", occasion: "wedding", requestedCount: 4 });
  assert.equal(plan.requestedCount, MAX_OUTFITS_PER_REQUEST);
  assert.equal(MIN_OUTFITS_PER_REQUEST, 1);
  // The cap is one product-wide number, not a second one invented for the plan.
  assert.equal(MAX_OUTFITS_PER_REQUEST, LIMITS.maxOutfitsPerRenderRequest);
});

test("an unusable count falls back to the default instead of throwing or recursing", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -4]) {
    assert.equal(clampOutfitCount(bad), DEFAULT_OUTFITS_PER_REQUEST);
  }
  assert.equal(clampOutfitCount(undefined), DEFAULT_OUTFITS_PER_REQUEST);
  assert.equal(clampOutfitCount(null), DEFAULT_OUTFITS_PER_REQUEST);
  assert.equal(clampOutfitCount(0), DEFAULT_OUTFITS_PER_REQUEST);
});

test("a turn with no direction at all asks for the occasion (frozen case-07 shape)", () => {
  const plan = planFor({ intent: "recommend", date: { kind: "relative", period: "tomorrow" } });
  assert.deepEqual(plan.clarification, { required: true, field: "occasion", reason: "missingDirection" });
});

test("a bare relative date needs a place to count as direction, an absolute date does not", () => {
  const relativeNoPlace = planFor({ intent: "recommend", date: { kind: "relative", period: "tomorrow" } });
  assert.equal(relativeNoPlace.clarification?.reason, "missingDirection");

  const relativeWithPlace = planFor({ intent: "recommend", date: { kind: "relative", period: "tomorrow" }, place: "Brighton" });
  assert.equal(relativeWithPlace.clarification, null);

  const absoluteNoPlace = planFor({ intent: "recommend", date: { kind: "absolute", date: "2026-10-10" } });
  assert.equal(absoluteNoPlace.clarification, null);
});

test("colour focus alone, or candidates on the thread, are enough direction", () => {
  assert.equal(planFor({ intent: "recommend", colourFocus: ["navy", "white"] }).clarification, null);
  const state = { turnIndex: 1, plan: planFor({ intent: "recommend", occasion: "dinner" }), candidates: candidates(2) };
  assert.equal(planFor({ intent: "refine" }, state).clarification, null);
});

test("a follow-up preserves the known occasion, place and date", () => {
  const state = afterTurns([
    { intent: "recommend", occasion: "smart casual dinner", formality: "smart-casual", place: "Manchester", date: { kind: "absolute", date: "2026-10-10" } },
  ]);
  const followUp = planFor({ warmthShift: 1 }, state);
  assert.equal(followUp.occasion, "smart casual dinner");
  assert.equal(followUp.formality, "smart-casual");
  assert.equal(followUp.place, "Manchester");
  assert.deepEqual(followUp.date, { kind: "absolute", date: "2026-10-10" });
});

test("'make it warmer' accumulates and stays inside the bound", () => {
  let state = afterTurns([{ intent: "recommend", occasion: "trip to Berlin", date: { kind: "relative", period: "weekend" } }]);
  for (let index = 0; index < 3; index += 1) state = { turnIndex: state.plan.turnIndex, plan: planFor({ text: "make it warmer" }, state), candidates: [] };
  assert.equal(state.plan.warmthShift, WARMTH_SHIFT_MAX);
  assert.equal(state.plan.intent, "refine");
  assert.equal(state.plan.occasion, "trip to Berlin");
});

test("'make it cooler' moves the other way and is bounded below", () => {
  let state = afterTurns([{ intent: "recommend", occasion: "rooftop drinks" }]);
  for (let index = 0; index < 4; index += 1) state = { turnIndex: state.plan.turnIndex, plan: planFor({ text: "make it cooler" }, state), candidates: [] };
  assert.equal(state.plan.warmthShift, WARMTH_SHIFT_MIN);
});

test("an explicit later value overrides the earlier slot", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "coffee", place: "Leeds" }]);
  const plan = planFor({ occasion: "black-tie wedding", place: "York" }, state);
  assert.equal(plan.occasion, "black-tie wedding");
  assert.equal(plan.place, "York");
});

test("'the second one' resolves to the second candidate on the thread", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "dinner" }], candidates(3));
  const plan = planFor({ text: "the second one" }, state);
  assert.deepEqual(plan.referent, { position: 2, outfitId: "outfit_2" });
  assert.equal(plan.clarification, null);
});

test("an ordinal past the end asks which outfit, listing only real ordinals", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "dinner" }], candidates(2));
  const plan = planFor({ referent: { kind: "ordinal", position: 5 } }, state);
  assert.equal(plan.referent, null);
  assert.deepEqual(plan.clarification, {
    required: true,
    field: "referent",
    reason: "unknownReferent",
    options: ["first", "second"],
  });
});

test("'render that' resolves the only candidate and quotes nothing", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "dinner" }], candidates(1));
  const plan = planFor({ text: "render that" }, state);
  assert.equal(plan.intent, "render");
  assert.deepEqual(plan.referent, { position: 1, outfitId: "outfit_1" });
  assert.equal(plan.clarification, null);
  assert.deepEqual(Object.keys(plan).toSorted(), [
    "brief",
    "clarification",
    "colourConstraints",
    "date",
    "formality",
    "intent",
    "occasion",
    "place",
    "referent",
    "requestedCount",
    "turnIndex",
    "warmthShift",
    "weatherNeeded",
  ]);
});

test("'render that' with several candidates and no prior referent asks which one", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "dinner" }], candidates(3));
  const plan = planFor({ text: "render that" }, state);
  assert.equal(plan.intent, "render");
  assert.equal(plan.referent, null);
  assert.equal(plan.clarification?.reason, "unknownReferent");
});

test("'save this' keeps the referent and produces a plan, not a save", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "dinner" }], candidates(2));
  const chosen = { turnIndex: state.plan.turnIndex, plan: planFor({ text: "the second one" }, state), candidates: candidates(2) };
  const plan = planFor({ text: "save this" }, chosen);
  assert.equal(plan.intent, "save");
  assert.deepEqual(plan.referent, { position: 2, outfitId: "outfit_2" });
  assert.equal(plan.clarification, null);
});

test("'what will it cost' is a price intent that preserves the slots (frozen case-13)", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "beach holiday", place: "Barcelona" }], candidates(2));
  const plan = planFor({ text: "what will it cost" }, state);
  assert.equal(plan.intent, "price");
  assert.equal(plan.occasion, "beach holiday");
  assert.equal(plan.place, "Barcelona");
  assert.equal(plan.weatherNeeded, false);
});

test("the plan carries no garment id and only refers to outfits the thread already holds", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "dinner" }], candidates(2));
  const plan = planFor({ text: "the second one" }, state);
  const ids = new Set(state.candidates.map((candidate) => candidate.outfitId));
  assert.ok(ids.has(plan.referent.outfitId));
  // The only id anywhere in the plan is the referent, and it is one the thread already held.
  assert.doesNotMatch(JSON.stringify(plan), /itemId|item_id|garmentId|sku|itemPath|photoId/);
  const matches = Object.entries(plan)
    .filter(([, value]) => {
      if (value && typeof value === "object" && "outfitId" in value && typeof value.outfitId === "string") return value.outfitId.startsWith("outfit_");
      return false;
    })
    .map(([key]) => key);
  assert.deepEqual(matches, ["referent"]);
  assert.equal(resolveReferent({ kind: "ordinal", position: 99 }, state), null);
});

test("weather is needed only with an explicit place and date on a garment-choosing turn", () => {
  const recommend = planFor({ intent: "recommend", occasion: "commute", place: "Brighton", date: { kind: "absolute", date: "2026-10-10" } });
  assert.equal(recommend.weatherNeeded, true);
  assert.equal(weatherNeeded({ intent: "recommend", place: null, date: { kind: "absolute", date: "2026-10-10" } }), false);
  assert.equal(weatherNeeded({ intent: "recommend", place: "Brighton", date: null }), false);
  assert.equal(weatherNeeded({ intent: "render", place: "Brighton", date: { kind: "absolute", date: "2026-10-10" } }), false);
});

test("a follow-up turn with no place does not invent one from hidden context", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "long weekend in Brighton", place: "Brighton" }], candidates(2));
  const cleared = { turnIndex: state.plan.turnIndex, plan: null, candidates: candidates(2) };
  const plan = planFor({ text: "make it warmer" }, cleared);
  assert.equal(plan.place, null);
  assert.equal(plan.weatherNeeded, false);
});

test("colour constraints accumulate, dedupe and sort deterministically", () => {
  const first = afterTurns([{ intent: "recommend", occasion: "work", colourFocus: ["Navy", "white"], avoidColours: ["beige"] }]);
  const second = planFor({ colourFocus: ["navy", "grey"] }, first);
  assert.deepEqual(second.colourConstraints.include, ["grey", "navy", "white"]);
  assert.deepEqual(second.colourConstraints.avoid, ["beige"]);
});

test("identical input yields a deep-equal plan", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "dinner", place: "Oslo" }], candidates(2));
  assert.deepEqual(planFor({ text: "the second one" }, state), planFor({ text: "the second one" }, state));
});

test("merging never mutates the state it was given", () => {
  const state = afterTurns([{ intent: "recommend", occasion: "dinner" }], candidates(2));
  const snapshot = structuredClone(state);
  planFor({ text: "make it warmer" }, state);
  planFor({ text: "the second one" }, state);
  assert.deepEqual(state, snapshot);
});

test("formality is normalised against the wardrobe enum and anything else is dropped", () => {
  assert.deepEqual(FORMALITY.toSorted(), ["casual", "formal", "smart-casual"]);
  assert.equal(normaliseFormality("Smart Casual"), "smart-casual");
  assert.equal(normaliseFormality("FORMAL"), "formal");
  assert.equal(normaliseFormality("black tie"), null);
  assert.equal(planFor({ intent: "recommend", formality: "Smart Casual" }).formality, "smart-casual");
  assert.equal(planFor({ intent: "recommend", formality: "gown" }).formality, null);
});

test("date refs are validated and every relative period is accepted", () => {
  for (const period of RELATIVE_PERIODS) assert.equal(isStylistDateRef({ kind: "relative", period }), true);
  assert.equal(isStylistDateRef({ kind: "absolute", date: "2026-10-10" }), true);
  assert.equal(isStylistDateRef({ kind: "absolute", date: "10/10/2026" }), false);
  assert.equal(isStylistDateRef({ kind: "weekday", weekday: 6 }), true);
  assert.equal(isStylistDateRef({ kind: "weekday", weekday: 7 }), false);
  assert.equal(isStylistDateRef({ kind: "relative", period: "someday" }), false);
  assert.equal(planFor({ intent: "recommend", date: { kind: "absolute", date: "soon" } }).date, null);
});

test("turnIndex advances by one per merged turn and the intent enum is closed", () => {
  let state = EMPTY_STYLIST_STATE;
  for (let index = 1; index <= 3; index += 1) {
    const plan = mergeStylistTurn(state, { intent: "recommend", occasion: "dinner" });
    assert.equal(plan.turnIndex, index);
    state = { turnIndex: plan.turnIndex, plan, candidates: [] };
  }
  assert.deepEqual(STYLIST_INTENTS.toSorted(), ["chat", "gaps", "price", "recommend", "refine", "render", "save"]);
});

test("the narrow recogniser only claims the follow-ups it understands", () => {
  assert.deepEqual(readFollowUpCommand("Make it warmer."), { intent: "refine", warmthShift: 1 });
  assert.deepEqual(readFollowUpCommand("give me three outfits"), { intent: "recommend", requestedCount: 3 });
  assert.deepEqual(readFollowUpCommand("the last one"), { referent: { kind: "ordinal", position: 3 } });
  assert.equal(readFollowUpCommand("something completely different"), null);
  assert.equal(readFollowUpCommand(""), null);
});
