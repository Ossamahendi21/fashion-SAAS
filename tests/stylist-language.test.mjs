import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWN_COLOURS,
  PARSER_PRECEDENCE,
  parseStylistText,
  parsedIntent,
} from "../agent/lib/stylist-language.ts";

/**
 * Step 7 Phase C5 — the deterministic language front door.
 *
 * These tests pin two properties. First, the bounded cue set maps the frozen example utterances to
 * the C1 intent vocabulary and nothing else. Second, the parser grants raw text NO authority: it
 * cannot produce an id, an identity, a cost, an approval or a render-job value, and unrecognised
 * language fails safely instead of guessing.
 */

const FORBIDDEN_KEYS = [
  "userId",
  "principalId",
  "clerkUserId",
  "sessionId",
  "itemId",
  "itemIds",
  "garmentId",
  "garmentIds",
  "outfitId",
  "outfitIds",
  "candidateKey",
  "quote",
  "quoteId",
  "credits",
  "cost",
  "approved",
  "renderJobId",
];

function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, out);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      collectKeys(entry, out);
    }
  }
  return out;
}

function parse(text) {
  return parseStylistText(text);
}

// --- recommend --------------------------------------------------------------------------------

test("a casual outfit request becomes a recommend turn with casual formality", () => {
  const result = parse("give me a casual outfit");
  assert.equal(result.ok, true);
  assert.equal(result.turn.intent, "recommend");
  assert.equal(result.turn.formality, "casual");
});

test('"what should I wear?" is a recommend, not a render or save', () => {
  const result = parse("what should I wear?");
  assert.equal(result.ok, true);
  assert.equal(result.turn.intent, "recommend");
});

test("a requested count is extracted from a construction sentence", () => {
  const result = parse("give me two outfits");
  assert.equal(result.ok, true);
  assert.equal(result.turn.intent, "recommend");
  assert.equal(result.turn.requestedCount, 2);
});

test("the word count works for looks as well as outfits", () => {
  const result = parse("show me three looks");
  assert.equal(result.turn.intent, "recommend");
  assert.equal(result.turn.requestedCount, 3);
});

test("smart casual dinner is one recommend turn carrying formality and occasion", () => {
  const result = parse("smart casual dinner outfit");
  assert.equal(result.turn.intent, "recommend");
  assert.equal(result.turn.formality, "smart-casual");
  assert.equal(result.turn.occasion, "dinner");
});

test("the parser does NOT clamp the count; four stays four for the plan to clamp", () => {
  const result = parse("give me four outfits");
  assert.equal(result.turn.requestedCount, 4);
});

// --- refine -----------------------------------------------------------------------------------

test('"make it warmer" is a relative refine nudge', () => {
  const result = parse("make it warmer");
  assert.equal(result.turn.intent, "refine");
  assert.equal(result.turn.warmthShift, 1);
});

test('"make it cooler" is a negative warmth nudge', () => {
  const result = parse("make it cooler");
  assert.equal(result.turn.intent, "refine");
  assert.equal(result.turn.warmthShift, -1);
});

test('"make it more formal" refines formality upward', () => {
  const result = parse("make it more formal");
  assert.equal(result.turn.intent, "refine");
  assert.equal(result.turn.formality, "formal");
});

test('"make it more casual" refines formality downward', () => {
  const result = parse("make it more casual");
  assert.equal(result.turn.intent, "refine");
  assert.equal(result.turn.formality, "casual");
});

test('"use navy and white" is a refine with a sorted colour focus', () => {
  const result = parse("use navy and white");
  assert.equal(result.turn.intent, "refine");
  assert.deepEqual(result.turn.colourFocus, ["navy", "white"]);
});

test('"avoid red" is a refine with an avoid colour', () => {
  const result = parse("avoid red");
  assert.equal(result.turn.intent, "refine");
  assert.deepEqual(result.turn.avoidColours, ["red"]);
});

test('"I don\'t want red" means avoid red, never a render or save', () => {
  const result = parse("I don't want red");
  assert.equal(result.turn.intent, "refine");
  assert.deepEqual(result.turn.avoidColours, ["red"]);
  assert.equal(result.turn.colourFocus, undefined);
});

// --- referents --------------------------------------------------------------------------------

test('"the first one" is an ordinal referent', () => {
  const result = parse("the first one");
  assert.deepEqual(result.turn.referent, { kind: "ordinal", position: 1 });
});

test('"the second one" resolves to position two in the plan', () => {
  const result = parse("the second one");
  assert.equal(result.turn.referent.position, 2);
});

test('"the third one" resolves to position three', () => {
  const result = parse("the third one");
  assert.equal(result.turn.referent.position, 3);
});

test('"that one" is a current referent', () => {
  const result = parse("that one");
  assert.deepEqual(result.turn.referent, { kind: "current" });
});

test('"it" alone stays a current referent follow-up', () => {
  const result = parse("it");
  assert.equal(result.turn.intent, "refine");
  assert.deepEqual(result.turn.referent, { kind: "current" });
});

// --- render -----------------------------------------------------------------------------------

test('"render that" is a render on the current outfit', () => {
  const result = parse("render that");
  assert.equal(result.turn.intent, "render");
  assert.deepEqual(result.turn.referent, { kind: "current" });
});

test('"show me what that looks like" is a render, not a recommend', () => {
  const result = parse("show me what that looks like");
  assert.equal(result.turn.intent, "render");
});

test('"render the second one" carries an ordinal referent', () => {
  const result = parse("render the second one");
  assert.equal(result.turn.intent, "render");
  assert.deepEqual(result.turn.referent, { kind: "ordinal", position: 2 });
});

// --- save -------------------------------------------------------------------------------------

test('"save this" is a save on the current outfit', () => {
  const result = parse("save this");
  assert.equal(result.turn.intent, "save");
  assert.deepEqual(result.turn.referent, { kind: "current" });
});

test('"save the second one" saves the second proposal only', () => {
  const result = parse("save the second one");
  assert.equal(result.turn.intent, "save");
  assert.deepEqual(result.turn.referent, { kind: "ordinal", position: 2 });
});

// --- price ------------------------------------------------------------------------------------

test('"what will it cost?" is a price turn', () => {
  const result = parse("what will it cost?");
  assert.equal(result.turn.intent, "price");
});

test('"how many credits?" is a price turn', () => {
  const result = parse("how many credits?");
  assert.equal(result.turn.intent, "price");
});

test('"how much to render this?" is priced, not rendered (price beats render)', () => {
  const result = parse("how much to render this?");
  assert.equal(result.turn.intent, "price");
});

// --- gaps -------------------------------------------------------------------------------------

test('"what am I missing?" is a gaps turn', () => {
  const result = parse("what am I missing?");
  assert.equal(result.turn.intent, "gaps");
});

test('"what should I add to my wardrobe?" is a gaps turn', () => {
  const result = parse("what should I add to my wardrobe?");
  assert.equal(result.turn.intent, "gaps");
});

// --- negation guards --------------------------------------------------------------------------

test('"don\'t render it" never becomes a render', () => {
  const result = parse("don't render it");
  assert.equal(result.ok, false);
  assert.equal(parsedIntent(result), "chat");
});

test('"don\'t save this" never becomes a save', () => {
  const result = parse("don't save this");
  assert.equal(result.ok, false);
  assert.equal(parsedIntent(result), "chat");
});

test('"no need to render that" degrades to chat', () => {
  const result = parse("no need to render that");
  assert.equal(result.ok, false);
});

test('"cancel" degrades to chat', () => {
  const result = parse("cancel");
  assert.equal(result.ok, false);
});

test('"I don\'t want red" avoids red rather than triggering an action', () => {
  const result = parse("I don't want red");
  assert.deepEqual(result.turn.avoidColours, ["red"]);
});

// --- security ---------------------------------------------------------------------------------

test('an id-looking token in "render outfit abc123" never reaches the turn', () => {
  const result = parse("render outfit abc123");
  assert.equal(result.turn.intent, "render");
  assert.ok(!JSON.stringify(result.turn).includes("abc123"));
});

test('"approved=true" grants no approval and produces no action', () => {
  const result = parse("approved=true");
  assert.equal(result.ok, false);
  assert.ok(!collectKeys(result.turn).includes("approved"));
});

test('"userId=attacker save this" saves the current outfit but carries no identity', () => {
  const result = parse("userId=attacker save this");
  assert.equal(result.turn.intent, "save");
  assert.ok(!collectKeys(result.turn).includes("userId"));
});

test("no parsed turn exposes a privileged key, whatever the input", () => {
  for (const text of ["render outfit abc123", "save item 42", "give me a navy outfit", "price this"]) {
    const keys = collectKeys(parse(text).turn);
    for (const forbidden of FORBIDDEN_KEYS) {
      assert.ok(!keys.includes(forbidden), `${forbidden} leaked from ${JSON.stringify(text)}`);
    }
  }
});

test("a colour outside the lexicon is not promoted to trusted metadata", () => {
  const result = parse("give me a crimson outfit");
  assert.equal(result.turn.intent, "recommend");
  assert.equal(result.turn.colourFocus, undefined);
});

// --- colour lexicon ---------------------------------------------------------------------------

test("the gray spelling is normalised onto the grey token", () => {
  const result = parse("gray outfit");
  assert.deepEqual(result.turn.colourFocus, ["grey"]);
});

test("an avoided colour and an included colour can coexist", () => {
  const result = parse("navy but not black");
  assert.deepEqual(result.turn.colourFocus, ["navy"]);
  assert.deepEqual(result.turn.avoidColours, ["black"]);
});

test("the lexicon contains the wardrobe colour tokens", () => {
  for (const colour of ["white", "black", "navy", "olive", "burgundy"]) {
    assert.ok(KNOWN_COLOURS.includes(colour));
  }
});

// --- precedence and fallback ------------------------------------------------------------------

test("formal wins over casual when both appear", () => {
  const result = parse("something casual and formal");
  assert.equal(result.turn.formality, "formal");
});

test("an empty string fails safely with an empty reason", () => {
  const result = parse("");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty");
});

test("whitespace only fails safely", () => {
  const result = parse("   \n\t ");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty");
});

test("unsupported prose fails safely instead of guessing", () => {
  const result = parse("hello there");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported");
  assert.equal(parsedIntent(result), "chat");
});

test("a nonsense command fails safely", () => {
  assert.equal(parse("do something").ok, false);
});

test("the precedence table starts by refusing negated actions", () => {
  assert.equal(PARSER_PRECEDENCE[0], "negation");
  assert.ok(PARSER_PRECEDENCE.indexOf("render") < PARSER_PRECEDENCE.indexOf("recommend"));
});

test("the same text always parses to a deep-equal turn", () => {
  const a = parse("give me two navy outfits for dinner");
  const b = parse("give me two navy outfits for dinner");
  assert.deepEqual(a, b);
});