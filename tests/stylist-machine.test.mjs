import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_STYLIST_STATE,
  QUOTE_TTL_MS,
  STYLIST_STAGES,
  quoteExpired,
  quoteIdentityMatches,
} from "../agent/lib/stylist-state.ts";
import { transitionStylistState } from "../agent/lib/stylist-machine.ts";

const cand = (n = 2) => Array.from({ length: n }, (_, i) => ({ outfitId: `o${i + 1}`, name: `Outfit ${i + 1}` }));
const mkQuote = (now, ids = ["o1", "o2"], credits = 10, quality = "standard") => ({
  outfitIds: ids,
  perOutfit: ids.map((outfitId) => ({ outfitId, credits })),
  quality,
  credits,
  quotedAt: now,
  expiresAt: now + QUOTE_TTL_MS,
});

const ok = (res) => {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
  return res.state;
};
const err = (res) => {
  if (res.ok) throw new Error("expected an error result");
  return res.error.code;
};

function driveTo(stage, now = 100) {
  let s = ok(transitionStylistState(EMPTY_STYLIST_STATE, { type: "RECOMMENDATION_READY", candidates: cand(2), turnIndex: 1, now }));
  if (stage === "RECOMMENDED") return s;
  s = ok(transitionStylistState(s, { type: "PROPOSALS_READY", candidates: cand(2), now }));
  if (stage === "PROPOSED") return s;
  s = ok(transitionStylistState(s, { type: "QUOTE_READY", quote: mkQuote(now, ["o1", "o2"]), now }));
  if (stage === "QUOTED") return s;
  s = ok(transitionStylistState(s, { type: "APPROVAL_REQUESTED", now }));
  if (stage === "AWAITING_APPROVAL") return s;
  s = ok(transitionStylistState(s, { type: "APPROVED", now }));
  if (stage === "APPROVED") return s;
  return ok(transitionStylistState(s, { type: "RENDER_STARTED", renderJobId: "j1", now }));
}

// --- state and helpers ------------------------------------------------------------------------

test("initial state is IDLE", () => {
  assert.equal(EMPTY_STYLIST_STATE.stage, "IDLE");
});

test("STYLIST_STAGES lists every reachable stage once", () => {
  assert.deepEqual(new Set(STYLIST_STAGES).size, STYLIST_STAGES.length);
  for (const stage of ["IDLE", "RECOMMENDED", "PROPOSED", "QUOTED", "AWAITING_APPROVAL", "RENDERING", "RENDERED", "SAVED", "BLOCKED"]) {
    assert.ok(STYLIST_STAGES.includes(stage));
  }
});

test("quoteExpired is inclusive at the expiry boundary", () => {
  const q = mkQuote(0);
  assert.equal(quoteExpired(q, QUOTE_TTL_MS - 1), false);
  assert.equal(quoteExpired(q, QUOTE_TTL_MS), true);
});

test("quoteIdentityMatches compares quality, credits, ids and lines", () => {
  const a = mkQuote(1, ["o1", "o2"]);
  assert.equal(quoteIdentityMatches(a, mkQuote(2, ["o1", "o2"])), true);
  assert.equal(quoteIdentityMatches(a, mkQuote(1, ["o1", "o3"])), false);
  assert.equal(quoteIdentityMatches(a, { ...a, credits: 11 }), false);
  assert.equal(quoteIdentityMatches(a, { ...a, quality: "hq" }), false);
});

// --- recommendation ---------------------------------------------------------------------------

test("IDLE transitions to RECOMMENDED", () => {
  const res = transitionStylistState(EMPTY_STYLIST_STATE, { type: "RECOMMENDATION_READY", candidates: cand(1), turnIndex: 1, now: 1000 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "RECOMMENDED");
    assert.equal(res.state.turnIndex, 1);
    assert.equal(res.state.updatedAt, 1000);
  }
});

test("a new recommendation resets quote, approval and render fields", () => {
  const quote = driveTo("AWAITING_APPROVAL");
  assert.equal(quote.quote !== null, true);
  const res = transitionStylistState(quote, { type: "RECOMMENDATION_READY", candidates: cand(1), turnIndex: 2, now: 200 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "RECOMMENDED");
    assert.equal(res.state.quote, null);
    assert.equal(res.state.approved, false);
    assert.equal(res.state.renderJobId, null);
  }
});

test("candidates are copied, not aliased", () => {
  const input = cand(2);
  const res = transitionStylistState(EMPTY_STYLIST_STATE, { type: "RECOMMENDATION_READY", candidates: input, turnIndex: 1, now: 1 });
  assert.ok(res.ok);
  input[0].outfitId = "mutated";
  if (res.ok) assert.equal(res.state.candidates[0].outfitId, "o1");
});

// --- proposals --------------------------------------------------------------------------------

test("RECOMMENDED transitions to PROPOSED", () => {
  const rec = driveTo("RECOMMENDED");
  const res = transitionStylistState(rec, { type: "PROPOSALS_READY", candidates: cand(2), now: 5 });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.state.stage, "PROPOSED");
});

test("empty proposals are rejected with noProposal", () => {
  const rec = driveTo("RECOMMENDED");
  const res = transitionStylistState(rec, { type: "PROPOSALS_READY", candidates: [], now: 5 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "noProposal");
});

test("proposals from IDLE are out of sequence", () => {
  const res = transitionStylistState(EMPTY_STYLIST_STATE, { type: "PROPOSALS_READY", candidates: cand(1), now: 1 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "outOfSequence");
});

test("proposals clear a previous quote and approval", () => {
  const quoted = driveTo("QUOTED");
  const res = transitionStylistState(quoted, { type: "PROPOSALS_READY", candidates: cand(1), now: 9 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.quote, null);
    assert.equal(res.state.approved, false);
    assert.equal(res.state.selectedReferent, null);
  }
});

// --- quotes -----------------------------------------------------------------------------------

test("PROPOSED transitions to QUOTED", () => {
  const prop = driveTo("PROPOSED");
  const res = transitionStylistState(prop, { type: "QUOTE_READY", quote: { outfitIds: ["o1"], perOutfit: [{ outfitId: "o1", credits: 10 }], quality: "standard", credits: 10, quotedAt: 4, expiresAt: 4 + QUOTE_TTL_MS }, now: 4 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "QUOTED");
    assert.equal(res.state.approved, false);
  }
});

test("a quote from RECOMMENDED is out of sequence", () => {
  const rec = driveTo("RECOMMENDED");
  const res = transitionStylistState(rec, { type: "QUOTE_READY", quote: { outfitIds: ["o1"], perOutfit: [{ outfitId: "o1", credits: 10 }], quality: "standard", credits: 10, quotedAt: 1, expiresAt: 1 + QUOTE_TTL_MS }, now: 1 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "outOfSequence");
});

test("a quote for an unknown outfit is rejected", () => {
  const prop = driveTo("PROPOSED");
  const res = transitionStylistState(prop, { type: "QUOTE_READY", quote: { outfitIds: ["oX"], perOutfit: [{ outfitId: "oX", credits: 10 }], quality: "standard", credits: 10, quotedAt: 1, expiresAt: 1 + QUOTE_TTL_MS }, now: 1 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "unknownOutfit");
});

test("a quote with more outfit entries than proposals is rejected", () => {
  const prop = driveTo("PROPOSED");
  const res = transitionStylistState(prop, { type: "QUOTE_READY", quote: { outfitIds: ["o1", "o1", "o2"], perOutfit: [], quality: "standard", credits: 30, quotedAt: 1, expiresAt: 1 + QUOTE_TTL_MS }, now: 1 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "maxOutfits");
});

test("QUOTE_FAILED keeps PROPOSED with no quote", () => {
  const prop = driveTo("PROPOSED");
  const res = transitionStylistState(prop, { type: "QUOTE_FAILED", now: 3 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "PROPOSED");
    assert.equal(res.state.quote, null);
  }
});

test("QUOTE_FAILED from QUOTED is out of sequence", () => {
  const quoted = driveTo("QUOTED");
  const res = transitionStylistState(quoted, { type: "QUOTE_FAILED", now: 3 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "outOfSequence");
});

test("QUOTE_EXPIRED with no quote is a noQuote error", () => {
  const prop = driveTo("PROPOSED");
  const res = transitionStylistState(prop, { type: "QUOTE_EXPIRED", now: 5 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "noQuote");
});

test("QUOTE_EXPIRED before the deadline keeps the quote", () => {
  const quoted = driveTo("QUOTED", 100);
  const res = transitionStylistState(quoted, { type: "QUOTE_EXPIRED", now: 200 });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.state.quote !== null, true);
});

test("QUOTE_EXPIRED after the deadline drops the quote and returns AWAITING_APPROVAL to PROPOSED", () => {
  const awaiting = driveTo("AWAITING_APPROVAL", 100);
  const res = transitionStylistState(awaiting, { type: "QUOTE_EXPIRED", now: 100 + QUOTE_TTL_MS + 1 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.quote, null);
    assert.equal(res.state.stage, "PROPOSED");
  }
});

// --- approval ---------------------------------------------------------------------------------

test("QUOTED transitions to AWAITING_APPROVAL", () => {
  const quoted = driveTo("QUOTED");
  const res = transitionStylistState(quoted, { type: "APPROVAL_REQUESTED", now: 6 });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.state.stage, "AWAITING_APPROVAL");
});

test("APPROVAL_REQUESTED without a quote is out of sequence", () => {
  const prop = driveTo("PROPOSED");
  const res = transitionStylistState(prop, { type: "APPROVAL_REQUESTED", now: 6 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "outOfSequence");
});

test("APPROVED sets the approved flag", () => {
  const awaiting = driveTo("AWAITING_APPROVAL");
  const res = transitionStylistState(awaiting, { type: "APPROVED", now: 7 });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.state.approved, true);
});

test("APPROVED with an expired quote is quoteStale", () => {
  const awaiting = driveTo("AWAITING_APPROVAL", 100);
  const res = transitionStylistState(awaiting, { type: "APPROVED", now: 100 + QUOTE_TTL_MS + 1 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "quoteStale");
});

test("APPROVED outside AWAITING_APPROVAL is out of sequence", () => {
  const quoted = driveTo("QUOTED");
  const res = transitionStylistState(quoted, { type: "APPROVED", now: 7 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "outOfSequence");
});

test("REJECTED returns to PROPOSED and records the rejection", () => {
  const awaiting = driveTo("AWAITING_APPROVAL");
  const res = transitionStylistState(awaiting, { type: "REJECTED", now: 8 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "PROPOSED");
    assert.equal(res.state.approved, false);
    assert.equal(res.state.approvalRejectedAt, 8);
    assert.equal(res.state.quote, null);
  }
});

// --- render -----------------------------------------------------------------------------------

test("RENDER_STARTED before approval is notApproved", () => {
  const quoted = driveTo("QUOTED");
  const res = transitionStylistState(quoted, { type: "RENDER_STARTED", renderJobId: "j1", now: 9 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "notApproved");
});

test("RENDER_STARTED after approval enters RENDERING", () => {
  let s = driveTo("AWAITING_APPROVAL");
  s = ok(transitionStylistState(s, { type: "APPROVED", now: 9 }));
  const res = transitionStylistState(s, { type: "RENDER_STARTED", renderJobId: "j1", now: 10 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "RENDERING");
    assert.equal(res.state.renderJobId, "j1");
  }
});

test("RENDER_COMPLETED finishes the render", () => {
  const rendering = driveTo("RENDERING");
  const res = transitionStylistState(rendering, { type: "RENDER_COMPLETED", renderJobId: "j1", now: 11 });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.state.stage, "RENDERED");
});

test("RENDER_COMPLETED for the wrong job is out of sequence", () => {
  const rendering = driveTo("RENDERING");
  const res = transitionStylistState(rendering, { type: "RENDER_COMPLETED", renderJobId: "j9", now: 11 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "outOfSequence");
});

test("RENDER_COMPLETED outside RENDERING is out of sequence", () => {
  const prop = driveTo("PROPOSED");
  const res = transitionStylistState(prop, { type: "RENDER_COMPLETED", renderJobId: "j1", now: 11 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "outOfSequence");
});

test("RENDER_FAILED blocks and clears the quote and approval", () => {
  const rendering = driveTo("RENDERING");
  const res = transitionStylistState(rendering, { type: "RENDER_FAILED", now: 12 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "BLOCKED");
    assert.equal(res.state.quote, null);
    assert.equal(res.state.approved, false);
    assert.equal(res.state.renderJobId, null);
  }
});

test("rendering can be retried from BLOCKED after a fresh approval flow", () => {
  const rendering = driveTo("RENDERING");
  const blocked = ok(transitionStylistState(rendering, { type: "RENDER_FAILED", now: 12 }));
  // A fresh recommendation is always available (BLOCKED is not terminal for the machine).
  const res = transitionStylistState(blocked, { type: "RECOMMENDATION_READY", candidates: cand(1), turnIndex: 2, now: 13 });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.state.stage, "RECOMMENDED");
});

// --- save -------------------------------------------------------------------------------------

test("a rendered outfit can be saved", () => {
  const rendered = driveTo("RENDERING");
  const done = ok(transitionStylistState(rendered, { type: "RENDER_COMPLETED", renderJobId: "j1", now: 11 }));
  const res = transitionStylistState(done, { type: "OUTFIT_SAVED", outfitId: "o1", now: 12 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "SAVED");
    assert.equal(res.state.savedOutfitId, "o1");
  }
});

test("saving an unknown outfit is rejected", () => {
  const rendered = driveTo("RENDERING");
  const done = ok(transitionStylistState(rendered, { type: "RENDER_COMPLETED", renderJobId: "j1", now: 11 }));
  const res = transitionStylistState(done, { type: "OUTFIT_SAVED", outfitId: "oX", now: 12 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "unknownOutfit");
});

test("saving from IDLE is out of sequence", () => {
  const res = transitionStylistState(EMPTY_STYLIST_STATE, { type: "OUTFIT_SAVED", outfitId: "o1", now: 1 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "outOfSequence");
});

// --- reset, clarification, plan changes ------------------------------------------------------

test("RESET_RECOMMENDATION returns a clean state", () => {
  const awaiting = driveTo("AWAITING_APPROVAL");
  const res = transitionStylistState(awaiting, { type: "RESET_RECOMMENDATION", now: 20 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "IDLE");
    assert.equal(res.state.candidates.length, 0);
    assert.equal(res.state.quote, null);
  }
});

test("CLARIFICATION_REQUIRED sets a pending question", () => {
  const res = transitionStylistState(EMPTY_STYLIST_STATE, { type: "CLARIFICATION_REQUIRED", now: 2 });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.state.pendingQuestion, "clarify");
});

test("PLAN_CHANGED with new candidates clears the quote and drops a stale referent", () => {
  const quoted = driveTo("QUOTED");
  const withReferent = { ...quoted, selectedReferent: { position: 1, outfitId: "o2" } };
  const res = transitionStylistState(withReferent, { type: "PLAN_CHANGED", candidates: cand(1), selectedReferent: { position: 1, outfitId: "o2" }, now: 30 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "PROPOSED");
    assert.equal(res.state.quote, null);
    assert.equal(res.state.selectedReferent, null);
  }
});

test("PLAN_CHANGED with unchanged candidates keeps a valid referent", () => {
  const recommended = driveTo("RECOMMENDED");
  const withReferent = { ...recommended, selectedReferent: { position: 1, outfitId: "o2" } };
  const res = transitionStylistState(withReferent, { type: "PLAN_CHANGED", candidates: cand(2), selectedReferent: { position: 1, outfitId: "o2" }, now: 30 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "RECOMMENDED");
    assert.equal(res.state.selectedReferent?.outfitId, "o2");
  }
});

test("PLAN_CHANGED with no candidates does not fabricate a PROPOSED stage", () => {
  const recommended = driveTo("RECOMMENDED");
  const res = transitionStylistState(recommended, { type: "PLAN_CHANGED", candidates: [], selectedReferent: null, now: 30 });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.state.stage, "RECOMMENDED");
});

test("PRICE_ONLY is a no-op that only touches updatedAt", () => {
  const quoted = driveTo("QUOTED");
  const res = transitionStylistState(quoted, { type: "PRICE_ONLY", now: 40 });
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state.stage, "QUOTED");
    assert.equal(res.state.updatedAt, 40);
  }
});

test("RENDER_INTENT keeps a matching referent and drops a mismatched one", () => {
  const recommended = driveTo("RECOMMENDED");
  const kept = transitionStylistState(recommended, { type: "RENDER_INTENT", selectedReferent: { position: 0, outfitId: "o1" }, now: 50 });
  assert.ok(kept.ok);
  if (kept.ok) assert.equal(kept.state.selectedReferent?.outfitId, "o1");
  const dropped = transitionStylistState(recommended, { type: "RENDER_INTENT", selectedReferent: { position: 4, outfitId: "oX" }, now: 51 });
  assert.ok(dropped.ok);
  if (dropped.ok) assert.equal(dropped.state.selectedReferent, null);
});

test("the input state object is never mutated", () => {
  const rec = driveTo("RECOMMENDED");
  const snapshot = JSON.stringify(rec);
  transitionStylistState(rec, { type: "PROPOSALS_READY", candidates: cand(1), now: 99 });
  assert.equal(JSON.stringify(rec), snapshot);
});

// --- session/state serialization (C4 final gate) ----------------------------------------------

test("EMPTY_STYLIST_STATE is the neutral, JSON-serializable initial state", () => {
  assert.equal(EMPTY_STYLIST_STATE.stage, "IDLE");
  assert.deepEqual(EMPTY_STYLIST_STATE.candidates, []);
  assert.equal(EMPTY_STYLIST_STATE.quote, null);
  assert.equal(EMPTY_STYLIST_STATE.approved, false);
  assert.equal(EMPTY_STYLIST_STATE.renderJobId, null);
  assert.deepEqual(JSON.parse(JSON.stringify(EMPTY_STYLIST_STATE)), EMPTY_STYLIST_STATE);
});

test("a driven C2 state round-trips through JSON with stage, quote and approval intact", () => {
  const approved = ok(transitionStylistState(driveTo("AWAITING_APPROVAL", 100), { type: "APPROVED", now: 150 }));
  const roundTripped = JSON.parse(JSON.stringify(approved));

  assert.deepEqual(roundTripped, approved);
  assert.equal(roundTripped.stage, "AWAITING_APPROVAL");
  assert.equal(roundTripped.approved, true);
  assert.equal(roundTripped.quote.credits, 10);
  assert.equal(roundTripped.quote.outfitIds.length, 2);
});