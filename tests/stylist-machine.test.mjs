import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_STYLIST_STATE, QUOTE_TTL_MS, quoteExpired, quoteIdentityMatches } from "../agent/lib/stylist-state.ts";
import { transitionStylistState } from "../agent/lib/stylist-machine.ts";

const mkQuote = (now) => ({
  outfitIds: ["o1"],
  perOutfit: [{ outfitId: "o1", credits: 10 }],
  quality: "standard",
  credits: 10,
  quotedAt: now,
  expiresAt: now + QUOTE_TTL_MS,
});

test("initial state is IDLE", () => {
  assert.equal(EMPTY_STYLIST_STATE.stage, "IDLE");
});

test("IDLE → recommended", () => {
  const res = transitionStylistState(EMPTY_STYLIST_STATE, {
    type: "RECOMMENDATION_READY",
    candidates: [{ outfitId: "o1", name: "A" }],
    turnIndex: 1,
    now: 1000,
  });
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.state.stage, "RECOMMENDED");
});

test("proposal requires validated candidate identity", () => {
  let s = transitionStylistState(EMPTY_STYLIST_STATE, { type: "RECOMMENDATION_READY", candidates: [{ outfitId: "o1", name: "A" }], turnIndex: 1, now: 1 });
  if (!s.ok) throw new Error("fail");
  const res = transitionStylistState(s.state, { type: "PROPOSALS_READY", candidates: [], now: 2 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "noProposal");
});
