import assert from "node:assert/strict";
import test from "node:test";

// tsx wraps this CommonJS-shaped module in an interop layer, so the tool can sit at
// `default` (native ESM) or `default.default` (tsx). Unwrap whichever carries the schema.
const stylistTurnModule = await import("../agent/lib/stylist-turn.ts");
const stylistTurn = stylistTurnModule.default.inputSchema
  ? stylistTurnModule.default
  : stylistTurnModule.default.default;

/**
 * Step 7 Phase C4.1 — the `stylist_turn` privileged-field boundary.
 *
 * The tool's `inputSchema` is a plain `z.object`, so unknown keys are stripped before the
 * orchestrator ever sees them. These tests parse a hostile payload and assert that none of the
 * caller/model-supplied privileged fields survive into the trusted input. Rejection is not
 * required (Zod's strip default is safe here); the property under test is that the fields are
 * discarded and never reach orchestration.
 */
const PRIVILEGED_TOP_LEVEL = [
  "userId",
  "principalId",
  "clerkUserId",
  "sessionId",
  "outfitId",
  "outfitIds",
  "garmentIds",
  "itemIds",
  "candidateKey",
  "credits",
  "cost",
  "quote",
  "quoteId",
  "approved",
  "renderJobId",
];

test("stylist_turn strips privileged fields supplied at the top level", () => {
  const parsed = stylistTurn.inputSchema.parse({
    turn: { intent: "render", referent: { kind: "current" } },
    userId: "attacker",
    outfitId: "stolen-outfit",
    outfitIds: ["stolen-outfit"],
    candidateKey: "top|bottom|shoes",
    credits: 9_999,
    cost: 0,
    approved: true,
    renderJobId: "job-attacker",
    quote: { credits: 0 },
    quoteId: "q-attacker",
  });

  for (const key of PRIVILEGED_TOP_LEVEL) {
    assert.ok(!(key in parsed), `top-level ${key} must be stripped`);
  }
  assert.deepEqual(parsed.turn, { intent: "render", referent: { kind: "current" } });
});

test("stylist_turn strips privileged fields smuggled inside the turn object", () => {
  const parsed = stylistTurn.inputSchema.parse({
    turn: {
      intent: "recommend",
      occasion: "dinner",
      userId: "attacker",
      outfitId: "stolen-outfit",
      candidateKey: "stolen-key",
      credits: 5,
      approved: true,
      renderJobId: "job-attacker",
    },
  });

  assert.deepEqual(parsed.turn, { intent: "recommend", occasion: "dinner" });
});

test("stylist_turn exposes only validated quality and perOutfit as caller knobs", () => {
  const parsed = stylistTurn.inputSchema.parse({ turn: { intent: "render" }, quality: "hq", perOutfit: 3 });
  assert.equal(parsed.quality, "hq");
  assert.equal(parsed.perOutfit, 3);

  assert.throws(() => stylistTurn.inputSchema.parse({ turn: { intent: "render" }, quality: "ultra" }));
  assert.throws(() => stylistTurn.inputSchema.parse({ turn: { intent: "render" }, perOutfit: 9 }));
});