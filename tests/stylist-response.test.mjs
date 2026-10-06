import assert from "node:assert/strict";
import test from "node:test";

import {
  formatStylistResponse,
  responseOutcomeFromTurn,
} from "../agent/lib/stylist-response.ts";

/**
 * Step 7 Phase C5 — the safe response formatter.
 *
 * It speaks only from the trusted outcome it is handed. These tests pin that every branch is total
 * and deterministic, that numbers appear only when a real quote supplied them, that proposal prose
 * reads names and never ids, and that no branch can claim a step the state did not prove (started,
 * approved, saved).
 */

// --- chat and clarifications ------------------------------------------------------------------

test("chat asks for direction", () => {
  assert.match(formatStylistResponse({ kind: "chat" }), /new look|tweak|price/);
});

test("a clarification names the field it is asking about", () => {
  assert.match(formatStylistResponse({ kind: "clarification", field: "occasion" }), /occasion/i);
  assert.match(formatStylistResponse({ kind: "clarification", field: "referent" }), /which look/i);
  assert.match(formatStylistResponse({ kind: "clarification", field: "place" }), /where will you be/i);
  assert.match(formatStylistResponse({ kind: "clarification", field: "formality" }), /formal/i);
});

test("an unknown clarification field still yields a safe sentence", () => {
  const text = formatStylistResponse({ kind: "clarification", field: "mystery" });
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
});

// --- recommendations --------------------------------------------------------------------------

test("no candidates yields a safe apology, not an empty list", () => {
  assert.match(formatStylistResponse({ kind: "recommendation", candidates: [] }), /couldn't put a look together/i);
});

test("one candidate is named in the singular", () => {
  const text = formatStylistResponse({
    kind: "recommendation",
    candidates: [{ outfitId: "outfit-1", name: "Rainy Friday" }],
  });
  assert.match(text, /Rainy Friday/);
  assert.match(text, /your look/i);
});

test("several candidates are named in the plural", () => {
  const text = formatStylistResponse({
    kind: "recommendation",
    candidates: [
      { outfitId: "outfit-1", name: "Rainy Friday" },
      { outfitId: "outfit-2", name: "Winter Dinner" },
    ],
  });
  assert.match(text, /Rainy Friday/);
  assert.match(text, /Winter Dinner/);
  assert.match(text, /2 looks/);
});

test("recommendation prose reads names and never the outfit id", () => {
  const text = formatStylistResponse({
    kind: "recommendation",
    candidates: [{ outfitId: "secret-outfit-id", name: "Sunday Brunch" }],
  });
  assert.ok(!text.includes("secret-outfit-id"));
});

// --- gaps -------------------------------------------------------------------------------------

test("a known gap code maps to fixed safe copy", () => {
  assert.match(formatStylistResponse({ kind: "gap", code: "missingOuterwear" }), /outerwear/i);
  assert.match(formatStylistResponse({ kind: "gap", code: "noReadyItems" }), /ready to wear/i);
});

test("an unknown gap code falls back to generic safe copy", () => {
  const text = formatStylistResponse({ kind: "gap", code: "someUnmappedCode" });
  assert.match(text, /complete look/i);
  assert.ok(!text.includes("someUnmappedCode"));
});

test("an empty gap report says the wardrobe looks covered", () => {
  assert.match(formatStylistResponse({ kind: "gaps", totalItems: 12, gaps: [] }), /well covered/i);
});

test("a gap report lists the gaps it was given", () => {
  const text = formatStylistResponse({ kind: "gaps", totalItems: 3, gaps: ["shoes", "outerwear"] });
  assert.match(text, /shoes/);
  assert.match(text, /outerwear/);
});

// --- quote and approval -----------------------------------------------------------------------

test("an affordable quote states the cost and the balance, never a shortfall", () => {
  const text = formatStylistResponse({
    kind: "quote",
    credits: 3,
    available: 10,
    shortfall: 0,
    canAfford: true,
  });
  assert.match(text, /3 credits/);
  assert.match(text, /10/);
  assert.ok(!/short/i.test(text));
});

test("an unaffordable quote states the shortfall it was given", () => {
  const text = formatStylistResponse({
    kind: "quote",
    credits: 5,
    available: 2,
    shortfall: 3,
    canAfford: false,
  });
  assert.match(text, /5 credits/);
  assert.match(text, /3 credits short/);
});

test("approvalRequired asks for the human and quotes the trusted cost", () => {
  const text = formatStylistResponse({ kind: "approvalRequired", credits: 4 });
  assert.match(text, /4 credits/);
  assert.match(text, /approve/i);
});

// --- render outcomes --------------------------------------------------------------------------

test("a blocked render names the blockers", () => {
  const text = formatStylistResponse({ kind: "renderBlocked", blockers: ["no avatar"] });
  assert.match(text, /no avatar/);
});

test("a started render claims start but never approval or cost", () => {
  const text = formatStylistResponse({ kind: "renderStarted" });
  assert.match(text, /under way/i);
  assert.ok(!/approv/i.test(text));
  assert.ok(!/\d+ credits/i.test(text));
});

test("saved and readFailed are total and specific", () => {
  assert.match(formatStylistResponse({ kind: "saved" }), /saved/i);
  assert.match(formatStylistResponse({ kind: "readFailed" }), /couldn't reach/i);
});

// --- determinism and the trusted projection ---------------------------------------------------

test("the same outcome always formats to the same string", () => {
  const outcome = { kind: "recommendation", candidates: [{ outfitId: "o1", name: "A" }] };
  assert.equal(formatStylistResponse(outcome), formatStylistResponse(outcome));
});

test("no outcome branch ever mentions weather", () => {
  const outcomes = [
    { kind: "chat" },
    { kind: "recommendation", candidates: [{ outfitId: "o1", name: "A" }] },
    { kind: "quote", credits: 1, available: 1, shortfall: 0, canAfford: true },
    { kind: "renderStarted" },
  ];
  for (const outcome of outcomes) {
    assert.ok(!/weather|forecast|rain/i.test(formatStylistResponse(outcome)));
  }
});

test("responseOutcomeFromTurn projects a C4 quote without inventing fields", () => {
  const outcome = responseOutcomeFromTurn({
    kind: "quote",
    quote: { credits: 2 },
    credits: 2,
    available: 8,
    shortfall: 0,
    canAfford: true,
  });
  assert.deepEqual(outcome, { kind: "quote", credits: 2, available: 8, shortfall: 0, canAfford: true });
});

test("responseOutcomeFromTurn projects a C4 render start and a save", () => {
  assert.equal(responseOutcomeFromTurn({ kind: "renderStarted", jobId: "job-1" }).kind, "renderStarted");
  assert.equal(responseOutcomeFromTurn({ kind: "saved", outfitId: "outfit-1" }).kind, "saved");
});

test("responseOutcomeFromTurn reads the approval cost from the trusted quote", () => {
  const outcome = responseOutcomeFromTurn({ kind: "approvalRequired", quote: { credits: 7 } });
  assert.deepEqual(outcome, { kind: "approvalRequired", credits: 7 });
});