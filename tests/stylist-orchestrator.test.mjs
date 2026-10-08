import assert from "node:assert/strict";
import test from "node:test";

import { runStylistTurn, turnNeedsApproval, StylistOrchestrationError } from "../agent/lib/stylist-orchestrator.ts";
import { QUOTE_TTL_MS } from "../agent/lib/stylist-state.ts";
import { EMPTY_STYLIST_STATE as EMPTY_MACHINE_STATE } from "../agent/lib/stylist-state.ts";

const item = (id, name, category, extra = {}) => ({
  id,
  name,
  status: "ready",
  category,
  colours: { primary: extra.primary ?? "white", secondary: extra.secondary ?? [], hex: [] },
  season: extra.season ?? [],
  formality: extra.formality ?? "casual",
  wearCount: extra.wearCount ?? 0,
});

const WARDROBE = [
  item("t1", "White Tee", "top", { primary: "white" }),
  item("t2", "Navy Polo", "top", { primary: "navy" }),
  item("b1", "Indigo Jeans", "bottom", { primary: "indigo" }),
  item("s1", "White Sneakers", "shoes", { primary: "white" }),
];

function makePorts(overrides = {}) {
  const calls = { compose: [], quote: [], start: [], save: [], weather: [] };
  const ports = {
    listReadyItems: async () => overrides.wardrobe ?? WARDROBE,
    fetchWeather: async (place, date) => {
      calls.weather.push({ place, date });
      return overrides.fetchWeather ? overrides.fetchWeather(place, date) : {};
    },
    composeOutfits: async (request) => {
      calls.compose.push(request);
      if (overrides.composeOutfits) return overrides.composeOutfits(request);
      return request.outfits.map((outfit, index) => ({
        outfitId: `outfit-${index + 1}`,
        name: outfit.name,
        problems: [],
      }));
    },
    quoteRenders: async (request) => {
      calls.quote.push(request);
      if (overrides.quoteRenders) return overrides.quoteRenders(request);
      return { credits: request.outfitIds.length, available: 10, shortfall: 0, canAfford: true, blockers: [] };
    },
    startRenders: async (request) => {
      calls.start.push(request);
      return { jobId: "job-1" };
    },
    saveOutfit: async (outfitId) => {
      calls.save.push(outfitId);
    },
    gapAnalysis: async () => overrides.gapAnalysis ?? { totalItems: 0, gaps: [] },
  };
  return { ports, calls };
}

async function recommendFirst(requestedCount, options = {}) {
  const { ports, calls } = makePorts(options);
  const result = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "dinner", requestedCount },
    now: 1_000,
    ports,
  });
  assert.equal(result.kind, "recommendation");
  return { result, ports, calls };
}

test("recommend persists real outfit ids through the compose port and then PROPOSED", async () => {
  const { result, calls } = await recommendFirst(2);

  assert.equal(result.state.stage, "PROPOSED");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.outfitId),
    ["outfit-1", "outfit-2"],
  );
  assert.equal(result.state.plan.intent, "recommend");
  assert.equal(result.state.candidates.length, 2);
  assert.equal(calls.compose[0].brief, "dinner");
  assert.equal(calls.compose[0].outfits.length, 2);
});

test("a price turn quotes the REAL persisted outfit id, never a candidate key", async () => {
  const { result, ports, calls } = await recommendFirst(2);

  const priced = await runStylistTurn({
    state: result.state,
    turn: { intent: "price", referent: { kind: "ordinal", position: 2 } },
    now: 2_000,
    ports,
    renderEnabled: true,
  });

  assert.equal(priced.kind, "quote");
  assert.equal(priced.state.stage, "QUOTED");
  assert.deepEqual(priced.quote.outfitIds, ["outfit-2"]);
  assert.deepEqual(calls.quote.at(-1).outfitIds, ["outfit-2"]);
  assert.ok(!priced.quote.outfitIds.some((id) => id.includes("|")));
});

test("render without approval stops at AWAITING_APPROVAL; with approval it starts the job", async () => {
  const { result, ports, calls } = await recommendFirst(1);
  const turn = { intent: "render", referent: { kind: "current" } };

  const gated = await runStylistTurn({
    state: result.state,
    turn,
    now: 2_000,
    ports,
    approved: false,
    renderEnabled: true,
  });
  assert.equal(gated.kind, "approvalRequired");
  assert.equal(gated.state.stage, "AWAITING_APPROVAL");
  assert.equal(calls.start.length, 0);

  const started = await runStylistTurn({
    state: result.state,
    turn,
    now: 3_000,
    ports,
    approved: true,
    renderEnabled: true,
  });
  assert.equal(started.kind, "renderStarted");
  assert.equal(started.state.stage, "RENDERING");
  assert.equal(started.jobId, "job-1");
  assert.deepEqual(calls.start.at(-1).outfitIds, ["outfit-1"]);
});

test("quote blockers short-circuit a render into renderBlocked without advancing the stage", async () => {
  const { result } = await recommendFirst(1);
  const { ports: blockedPorts } = makePorts({
    quoteRenders: () => ({ credits: 2, available: 0, shortfall: 2, canAfford: false, blockers: ["no avatar"] }),
  });

  const blocked = await runStylistTurn({
    state: result.state,
    turn: { intent: "render", referent: { kind: "current" } },
    now: 2_000,
    ports: blockedPorts,
    renderEnabled: true,
  });

  assert.equal(blocked.kind, "renderBlocked");
  assert.equal(blocked.state.stage, "PROPOSED");
  assert.deepEqual(blocked.blockers, ["no avatar"]);
});

test("save promotes a real persisted id and the machine reaches SAVED", async () => {
  const { result, ports, calls } = await recommendFirst(1);

  const saved = await runStylistTurn({
    state: result.state,
    turn: { intent: "save", referent: { kind: "current" } },
    now: 2_000,
    ports,
  });

  assert.equal(saved.kind, "saved");
  assert.equal(saved.state.stage, "SAVED");
  assert.deepEqual(calls.save, ["outfit-1"]);
  assert.equal(saved.state.savedOutfitId, "outfit-1");
});

test("refine reuses the thread and accumulates the warmth shift", async () => {
  const { result, ports } = await recommendFirst(1);

  const refined = await runStylistTurn({
    state: result.state,
    turn: { intent: "refine", warmthShift: 1 },
    now: 2_000,
    ports,
  });

  assert.equal(refined.kind, "recommendation");
  assert.equal(refined.plan.warmthShift, 1);
  assert.equal(refined.state.plan.warmthShift, 1);
});

test("a recommend with no direction at all asks for an occasion instead of guessing", async () => {
  const { ports } = makePorts();

  const clarified = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend" },
    now: 1_000,
    ports,
  });

  assert.equal(clarified.kind, "clarification");
  assert.equal(clarified.clarification.field, "occasion");
  assert.equal(clarified.clarification.reason, "missingDirection");
});

test("an empty wardrobe surfaces the ranker gap and leaves the machine untouched", async () => {
  const { ports } = makePorts({ wardrobe: [] });

  const gap = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "dinner" },
    now: 1_000,
    ports,
  });

  assert.equal(gap.kind, "gap");
  assert.equal(gap.gap.code, "noReadyItems");
  assert.equal(gap.state.stage, "IDLE");
});

test("when every composed outfit fails validation the turn is composeFailed", async () => {
  const { ports } = makePorts({
    composeOutfits: (request) =>
      request.outfits.map((outfit) => ({ outfitId: null, name: outfit.name, problems: ["bad item"] })),
  });

  const failed = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "dinner" },
    now: 1_000,
    ports,
  });

  assert.equal(failed.kind, "composeFailed");
  assert.deepEqual(failed.problems, ["bad item", "bad item"]);
});

test("gaps and chat are read-only turns", async () => {
  const { ports } = makePorts({ gapAnalysis: { totalItems: 5, gaps: ["no formal tops"] } });

  const gaps = await runStylistTurn({ state: EMPTY_MACHINE_STATE, turn: { intent: "gaps" }, now: 1_000, ports });
  assert.equal(gaps.kind, "gaps");
  assert.deepEqual(gaps.report.gaps, ["no formal tops"]);

  const chat = await runStylistTurn({ state: EMPTY_MACHINE_STATE, turn: { intent: "chat" }, now: 1_000, ports });
  assert.equal(chat.kind, "chat");
  assert.equal(chat.state.stage, "IDLE");
});

test("turnNeedsApproval is true only for a render that resolved a real referent", async () => {
  const { result } = await recommendFirst(1);

  assert.equal(turnNeedsApproval(EMPTY_MACHINE_STATE, { intent: "recommend", occasion: "x" }), false);
  assert.equal(turnNeedsApproval(EMPTY_MACHINE_STATE, { intent: "render", referent: { kind: "current" } }), false);
  assert.equal(turnNeedsApproval(result.state, { intent: "render", referent: { kind: "current" } }, true), true);
  assert.equal(turnNeedsApproval(result.state, { intent: "render", referent: { kind: "ordinal", position: 9 } }), false);
});

test("a render after the outfit is already saved raises instead of corrupting state", async () => {
  const { result, ports } = await recommendFirst(1);

  const saved = await runStylistTurn({
    state: result.state,
    turn: { intent: "save", referent: { kind: "current" } },
    now: 2_000,
    ports,
  });
  assert.equal(saved.kind, "saved");

  await assert.rejects(
    runStylistTurn({
      state: saved.state,
      turn: { intent: "render", referent: { kind: "current" } },
      now: 3_000,
      ports,
      renderEnabled: true,
    }),
    (error) => error instanceof StylistOrchestrationError && error.code === "outOfSequence",
  );
});

// ---------------------------------------------------------------------------
// Phase C4.1 safety coverage: identity, trusted ids, the approval gate, the
// quote TTL, determinism, weather injection and count/warmth clamping.
// ---------------------------------------------------------------------------

test("recommendation ids come only from the compose port, never a candidate key signature", async () => {
  const { result, calls } = await recommendFirst(2, {
    composeOutfits: (request) =>
      request.outfits.map((outfit, index) => ({ outfitId: `db${index + 1}`, name: outfit.name, problems: [] })),
  });

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.outfitId),
    ["db1", "db2"],
  );
  for (const candidate of result.candidates) {
    assert.ok(!candidate.outfitId.includes("|"), "a candidate key signature must never be surfaced as a persisted id");
  }
  assert.deepEqual(result.state.candidates, result.candidates);
  assert.equal(result.state.stage, "PROPOSED");
  assert.equal(result.state.turnIndex, 1);
  assert.equal(calls.compose.length, 1);
});

test("the compose payload carries display names and real slots, never a plan-only key field", async () => {
  const { calls } = await recommendFirst(2);
  const payload = calls.compose[0];
  assert.equal(payload.outfits.length, 2);
  const wardrobeIds = new Set(WARDROBE.map((entry) => entry.id));

  for (const outfit of payload.outfits) {
    assert.deepEqual(Object.keys(outfit).sort(), ["name", "reasoning", "slots"]);
    assert.ok(outfit.name.length > 0);
    assert.ok(outfit.reasoning.length > 0);
    for (const id of [outfit.slots.outerwear, outfit.slots.top, outfit.slots.bottom, outfit.slots.dress, outfit.slots.shoes]) {
      if (id) assert.ok(wardrobeIds.has(id), `slot id ${id} must be a real wardrobe id`);
    }
    for (const id of outfit.slots.accessories ?? []) assert.ok(wardrobeIds.has(id));
  }
});

test("price, save and render all follow the exact persisted id the compose port issued", async () => {
  const { result, ports, calls } = await recommendFirst(1, {
    composeOutfits: (request) => request.outfits.map((outfit) => ({ outfitId: "oA", name: outfit.name, problems: [] })),
  });

  const priced = await runStylistTurn({
    state: result.state,
    turn: { intent: "price", referent: { kind: "current" } },
    now: 2_000,
    ports,
    renderEnabled: true,
  });
  assert.deepEqual(priced.quote.outfitIds, ["oA"]);
  assert.equal(priced.plan.referent.outfitId, "oA");

  const saved = await runStylistTurn({
    state: result.state,
    turn: { intent: "save", referent: { kind: "current" } },
    now: 2_000,
    ports,
  });
  assert.equal(saved.outfitId, "oA");
  assert.deepEqual(calls.save, ["oA"]);

  const started = await runStylistTurn({
    state: result.state,
    turn: { intent: "render", referent: { kind: "current" } },
    now: 2_000,
    ports,
    approved: true,
    renderEnabled: true,
  });
  assert.equal(started.kind, "renderStarted");
  assert.deepEqual(calls.start.at(-1).outfitIds, ["oA"]);
});

test("turnNeedsApproval is false for every intent except a resolved render", async () => {
  const { result } = await recommendFirst(1);

  assert.equal(turnNeedsApproval(result.state, { intent: "price", referent: { kind: "current" } }), false);
  assert.equal(turnNeedsApproval(result.state, { intent: "save", referent: { kind: "current" } }), false);
  assert.equal(turnNeedsApproval(result.state, { intent: "refine", warmthShift: 1 }), false);
  assert.equal(turnNeedsApproval(result.state, { intent: "gaps" }), false);
  assert.equal(turnNeedsApproval(result.state, { intent: "chat" }), false);
  assert.equal(turnNeedsApproval(result.state, { intent: "render" }), false);
  assert.equal(turnNeedsApproval(result.state, { intent: "render", referent: { kind: "current" } }, true), true);
});

test("a price turn is never gated and stamps the quote TTL", async () => {
  const { result, ports } = await recommendFirst(1);

  const priced = await runStylistTurn({
    state: result.state,
    turn: { intent: "price", referent: { kind: "current" } },
    now: 2_000,
    ports,
    approved: false,
    renderEnabled: true,
  });

  assert.equal(priced.kind, "quote");
  assert.equal(priced.state.stage, "QUOTED");
  assert.equal(priced.quote.quotedAt, 2_000);
  assert.equal(priced.quote.expiresAt, 2_000 + QUOTE_TTL_MS);
});

test("a gated render quotes exactly once and spends nothing; resuming starts the job", async () => {
  const { result, ports, calls } = await recommendFirst(1);
  const turn = { intent: "render", referent: { kind: "current" } };

  const gated = await runStylistTurn({
    state: result.state,
    turn,
    now: 2_000,
    ports,
    approved: false,
    renderEnabled: true,
  });
  assert.equal(gated.kind, "approvalRequired");
  assert.equal(gated.state.stage, "AWAITING_APPROVAL");
  assert.equal(calls.quote.length, 1);
  assert.equal(calls.start.length, 0);

  const resumed = await runStylistTurn({
    state: gated.state,
    turn,
    now: 3_000,
    ports,
    approved: true,
    renderEnabled: true,
  });
  assert.equal(resumed.kind, "renderStarted");
  assert.equal(resumed.state.stage, "RENDERING");
  assert.equal(resumed.jobId, "job-1");
  assert.equal(calls.start.length, 1);
});

test("a render with no referent clarifies instead of quoting or spending", async () => {
  const { result, ports, calls } = await recommendFirst(1);

  const clarified = await runStylistTurn({ state: result.state, turn: { intent: "render" }, now: 2_000, ports });

  assert.equal(clarified.kind, "clarification");
  assert.equal(clarified.clarification.field, "referent");
  assert.equal(calls.quote.length, 0);
  assert.equal(calls.start.length, 0);
});

test("two identical turns are deterministic in both candidates and plan", async () => {
  const a = await recommendFirst(2);
  const b = await recommendFirst(2);

  assert.deepEqual(a.result.candidates, b.result.candidates);
  assert.deepEqual(a.result.plan, b.result.plan);
});

test("colour tokens are normalised, deduped and sorted regardless of input order", async () => {
  const { ports } = makePorts();

  const result = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "x", colourFocus: ["Red", "blue", "red"], avoidColours: ["Black", "black"] },
    now: 1_000,
    ports,
  });

  assert.deepEqual(result.plan.colourConstraints.include, ["blue", "red"]);
  assert.deepEqual(result.plan.colourConstraints.avoid, ["black"]);
});

test("an impossible colour constraint surfaces the ranker gap and leaves the machine IDLE", async () => {
  const { ports } = makePorts();

  const gap = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "x", colourFocus: ["purple"] },
    now: 1_000,
    ports,
  });

  assert.equal(gap.kind, "gap");
  assert.equal(gap.gap.code, "colourConstraintUnsatisfied");
  assert.equal(gap.state.stage, "IDLE");
});

test("weather is fetched once, with the resolved place, only when a garment turn needs it", async () => {
  const needsWeather = makePorts();
  await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "x", place: "Lisbon", date: { kind: "relative", period: "tomorrow" } },
    now: 1_000,
    ports: needsWeather.ports,
  });
  assert.equal(needsWeather.calls.weather.length, 1);
  assert.equal(needsWeather.calls.weather[0].place, "Lisbon");
  assert.deepEqual(needsWeather.calls.weather[0].date, { kind: "relative", period: "tomorrow" });

  const noPlace = makePorts();
  await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "x", date: { kind: "relative", period: "tomorrow" } },
    now: 1_000,
    ports: noPlace.ports,
  });
  assert.equal(noPlace.calls.weather.length, 0);
});

test("a price turn after a weather-aware recommendation never re-fetches the forecast", async () => {
  const { ports, calls } = makePorts();
  const recommended = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "x", place: "Lisbon", date: { kind: "relative", period: "tomorrow" } },
    now: 1_000,
    ports,
  });
  assert.equal(calls.weather.length, 1);

  await runStylistTurn({
    state: recommended.state,
    turn: { intent: "price", referent: { kind: "current" } },
    now: 2_000,
    ports,
  });
  assert.equal(calls.weather.length, 1);
});

test("a cold forecast reaches the ranker and raises the outerwear gap", async () => {
  const { ports } = makePorts({ fetchWeather: () => ({ minC: -3, maxC: 5 }) });

  const gap = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "x", place: "Oslo", date: { kind: "relative", period: "tomorrow" } },
    now: 1_000,
    ports,
  });

  assert.equal(gap.kind, "gap");
  assert.equal(gap.gap.code, "missingOuterwear");
});

test("an empty forecast never breaks a recommendation", async () => {
  const { ports } = makePorts({ fetchWeather: () => ({}) });

  const recommended = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "x", place: "Nowhere", date: { kind: "relative", period: "today" } },
    now: 1_000,
    ports,
  });

  assert.equal(recommended.kind, "recommendation");
});

test("warmth shift accumulates across refine turns but clamps to +2", async () => {
  const { result, ports } = await recommendFirst(1);
  let state = result.state;

  for (let index = 0; index < 3; index += 1) {
    const refined = await runStylistTurn({
      state,
      turn: { intent: "refine", warmthShift: 1 },
      now: 2_000 + index,
      ports,
    });
    state = refined.state;
  }

  assert.equal(state.plan.warmthShift, 2);
});

test("requestedCount clamps to three proposals and falls back to the default when zero", async () => {
  const wide = [
    item("t1", "White Tee", "top", { primary: "white" }),
    item("t2", "Navy Polo", "top", { primary: "navy" }),
    item("t3", "Olive Tee", "top", { primary: "olive" }),
    item("b1", "Indigo Jeans", "bottom", { primary: "indigo" }),
    item("b2", "Stone Chinos", "bottom", { primary: "stone" }),
    item("s1", "White Sneakers", "shoes", { primary: "white" }),
    item("s2", "Brown Boots", "shoes", { primary: "brown" }),
  ];

  const many = await recommendFirst(9, { wardrobe: wide });
  assert.equal(many.calls.compose[0].outfits.length, 3);

  const zero = await recommendFirst(0, { wardrobe: wide });
  assert.equal(zero.calls.compose[0].outfits.length, 2);
});

test("the plan carries no wardrobe item id, only candidate-derived referents", async () => {
  const { result } = await recommendFirst(2);
  const json = JSON.stringify(result.plan);
  for (const entry of WARDROBE) {
    assert.ok(!json.includes(`"${entry.id}"`), `the plan must never carry the wardrobe item id ${entry.id}`);
  }
});

test("a save before any recommendation clarifies for a referent", async () => {
  const { ports } = makePorts();

  const clarified = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "save", referent: { kind: "current" } },
    now: 1_000,
    ports,
  });

  assert.equal(clarified.kind, "clarification");
  assert.equal(clarified.clarification.field, "referent");
  assert.equal(clarified.clarification.reason, "unknownReferent");
});

test("an unrecognised utterance asks for direction instead of guessing an occasion", async () => {
  const { ports, calls } = makePorts();

  const clarified = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { text: "hello there" },
    now: 1_000,
    ports,
  });

  assert.equal(clarified.kind, "clarification");
  assert.equal(clarified.clarification.reason, "missingDirection");
  assert.equal(calls.compose.length, 0);
});

test("an ordinal past the end clarifies with the known options instead of quoting", async () => {
  const { result, ports, calls } = await recommendFirst(1);

  const clarified = await runStylistTurn({
    state: result.state,
    turn: { intent: "price", referent: { kind: "ordinal", position: 4 } },
    now: 2_000,
    ports,
  });

  assert.equal(clarified.kind, "clarification");
  assert.equal(clarified.clarification.field, "referent");
  assert.deepEqual(clarified.clarification.options, ["first"]);
  assert.equal(calls.quote.length, 0);
});

test("gaps reports the wardrobe total alongside the gap list", async () => {
  const { ports } = makePorts({ gapAnalysis: { totalItems: 5, gaps: ["no formal tops"] } });
  const result = await runStylistTurn({ state: EMPTY_MACHINE_STATE, turn: { intent: "gaps" }, now: 1_000, ports });

  assert.equal(result.kind, "gaps");
  assert.equal(result.report.totalItems, 5);
  assert.deepEqual(result.report.gaps, ["no formal tops"]);
});

test("chat touches no port and leaves the machine idle", async () => {
  const { ports, calls } = makePorts();
  const result = await runStylistTurn({ state: EMPTY_MACHINE_STATE, turn: { intent: "chat" }, now: 1_000, ports });

  assert.equal(result.kind, "chat");
  assert.equal(result.state.stage, "IDLE");
  assert.deepEqual([calls.compose.length, calls.quote.length, calls.start.length, calls.save.length, calls.weather.length], [0, 0, 0, 0, 0]);
});

test("candidate entries expose only outfitId and name, never an internal key", async () => {
  const { result } = await recommendFirst(2);
  for (const candidate of result.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ["name", "outfitId"]);
  }
  assert.deepEqual(result.state.plan, result.plan);
});

test("a compose failure leaves the machine untouched and returns every problem", async () => {
  const { ports } = makePorts({
    composeOutfits: (request) => request.outfits.map((outfit) => ({ outfitId: null, name: outfit.name, problems: ["no avatar"] })),
  });

  const failed = await runStylistTurn({
    state: EMPTY_MACHINE_STATE,
    turn: { intent: "recommend", occasion: "dinner" },
    now: 1_000,
    ports,
  });

  assert.equal(failed.kind, "composeFailed");
  assert.ok(failed.problems.length > 0);
  assert.equal(failed.state.stage, "IDLE");
});

test("a referent intent inherits the previous referent once one is resolved", async () => {
  const { result, ports } = await recommendFirst(1);
  const priced = await runStylistTurn({
    state: result.state,
    turn: { intent: "price", referent: { kind: "current" } },
    now: 2_000,
    ports,
    renderEnabled: true,
  });
  assert.notEqual(priced.plan.referent, null);
  assert.equal(priced.plan.referent.outfitId, "outfit-1");

  const saved = await runStylistTurn({ state: priced.state, turn: { intent: "save" }, now: 3_000, ports });
  assert.equal(saved.kind, "saved");
  assert.equal(saved.outfitId, "outfit-1");
});

test("a 'render that' follow-up resolves a referent and is gated by approval", async () => {
  const { result, ports, calls } = await recommendFirst(1);

  const gated = await runStylistTurn({
    state: result.state,
    turn: { text: "render that" },
    now: 2_000,
    ports,
    approved: false,
    renderEnabled: true,
  });

  assert.equal(gated.kind, "approvalRequired");
  assert.equal(gated.state.stage, "AWAITING_APPROVAL");
  assert.equal(calls.start.length, 0);
});

test("a bare 'make it warmer' follow-up becomes a refine with one warmth step", async () => {
  const { result, ports } = await recommendFirst(1);

  const refined = await runStylistTurn({ state: result.state, turn: { text: "make it warmer" }, now: 2_000, ports });

  assert.equal(refined.kind, "recommendation");
  assert.equal(refined.plan.intent, "refine");
  assert.equal(refined.plan.warmthShift, 1);
});

test("an unavailable (non-ready) garment is never proposed or persisted", async () => {
  const tuxedo = { ...item("x1", "Black Tuxedo", "top"), status: "processing" };
  const { result, calls } = await recommendFirst(1, { wardrobe: [...WARDROBE, tuxedo] });

  assert.equal(result.kind, "recommendation");
  assert.ok(!JSON.stringify(calls.compose).includes("x1"), "a non-ready garment must never reach proposal persistence");
  assert.ok(!result.candidates.some((candidate) => candidate.outfitId.includes("x1")));
});

test("a warmer refine invalidates the stored quote", async () => {
  const { result, ports } = await recommendFirst(1);
  const priced = await runStylistTurn({
    state: result.state,
    turn: { intent: "price", referent: { kind: "current" } },
    now: 2_000,
    ports,
    renderEnabled: true,
  });
  assert.equal(priced.state.stage, "QUOTED");
  assert.notEqual(priced.state.quote, null);

  const refined = await runStylistTurn({ state: priced.state, turn: { text: "make it warmer" }, now: 3_000, ports });
  assert.equal(refined.kind, "recommendation");
  assert.equal(refined.state.quote, null);
});

test("a warmer refine revokes a prior approval and its render start", async () => {
  const { result, ports } = await recommendFirst(1);
  const rendered = await runStylistTurn({
    state: result.state,
    turn: { intent: "render", referent: { kind: "current" } },
    now: 2_000,
    ports,
    approved: true,
    renderEnabled: true,
  });
  assert.equal(rendered.state.stage, "RENDERING");
  assert.equal(rendered.state.approved, true);

  const refined = await runStylistTurn({ state: rendered.state, turn: { text: "make it warmer" }, now: 3_000, ports });
  assert.equal(refined.state.approved, false);
  assert.equal(refined.state.quote, null);
});

test("the trusted quote credits become authoritative and the render uses the exact stored quality and perOutfit", async () => {
  const trustedCredits = 7;
  const { result, ports, calls } = await recommendFirst(1, {
    quoteRenders: () => ({ credits: trustedCredits, available: 100, shortfall: 0, canAfford: true, blockers: [] }),
  });

  const priced = await runStylistTurn({
    state: result.state,
    turn: { intent: "price", referent: { kind: "current" } },
    now: 2_000,
    ports,
    quality: "hq",
    perOutfit: 3,
    renderEnabled: true,
  });
  assert.equal(priced.quote.credits, trustedCredits);
  assert.equal(priced.quote.quality, "hq");
  assert.deepEqual(calls.quote.at(-1), { outfitIds: ["outfit-1"], perOutfit: 3, quality: "hq" });

  const renderPorts = makePorts();
  const started = await runStylistTurn({
    state: result.state,
    turn: { intent: "render", referent: { kind: "current" } },
    now: 2_000,
    ports: renderPorts.ports,
    quality: "hq",
    perOutfit: 3,
    approved: true,
    renderEnabled: true,
  });
  assert.equal(started.kind, "renderStarted");
  assert.deepEqual(renderPorts.calls.quote.at(-1), { outfitIds: ["outfit-1"], perOutfit: 3, quality: "hq" });
  assert.deepEqual(renderPorts.calls.start.at(-1), { outfitIds: ["outfit-1"], perOutfit: 3, quality: "hq" });
});

test("a transient trusted-read failure is not retried beyond a single attempt", async () => {
  const { ports } = makePorts();
  let reads = 0;
  const flaky = {
    ...ports,
    async listReadyItems() {
      reads += 1;
      if (reads === 1) throw new Error("transient wardrobe read");
      return WARDROBE;
    },
  };

  await assert.rejects(
    runStylistTurn({ state: EMPTY_MACHINE_STATE, turn: { intent: "recommend", occasion: "dinner" }, now: 1_000, ports: flaky }),
    /transient wardrobe read/,
  );
  assert.equal(reads, 1);
});

test("a permanent trusted-read failure produces an explicit safe outcome and no side effects", async () => {
  const { ports, calls } = makePorts();
  const failing = {
    ...ports,
    async listReadyItems() {
      throw new Error("wardrobe unavailable");
    },
  };

  await assert.rejects(
    runStylistTurn({ state: EMPTY_MACHINE_STATE, turn: { intent: "recommend", occasion: "dinner" }, now: 1_000, ports: failing }),
    /wardrobe unavailable/,
  );
  assert.deepEqual(
    [calls.compose.length, calls.quote.length, calls.start.length, calls.save.length],
    [0, 0, 0, 0],
  );
});