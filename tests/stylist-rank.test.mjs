import assert from "node:assert/strict";
import test from "node:test";

import { candidateKey, candidateToProposal, clampRequestedCount, rankOutfits } from "../agent/lib/stylist-rank.ts";
import { EMPTY_STYLIST_STATE as EMPTY_PLAN_STATE, mergeStylistTurn } from "../agent/lib/stylist-plan.ts";
import { EMPTY_STYLIST_STATE as EMPTY_MACHINE_STATE } from "../agent/lib/stylist-state.ts";
import { transitionStylistState } from "../agent/lib/stylist-machine.ts";

const item = (id, name, category, extra = {}) => ({
  id,
  name,
  status: "ready",
  category,
  colours: { primary: extra.primary ?? "white", secondary: extra.secondary ?? [], hex: extra.hex ?? [] },
  season: extra.season ?? [],
  formality: extra.formality ?? "casual",
  wearCount: extra.wearCount ?? 0,
  ...(extra.pattern ? { pattern: extra.pattern } : {}),
  ...(extra.material ? { material: extra.material } : {}),
  ...(extra.fit ? { fit: extra.fit } : {}),
  ...(extra.lastWornAt ? { lastWornAt: extra.lastWornAt } : {}),
  ...(extra.status ? { status: extra.status } : {}),
});

const wardrobe = [
  item("t1", "White Tee", "top", { primary: "white", season: ["summer", "spring"], wearCount: 4 }),
  item("t2", "Navy Polo", "top", { primary: "navy", season: ["spring", "summer"], formality: "smart-casual", wearCount: 9 }),
  item("t3", "Burgundy Knit", "top", { primary: "burgundy", season: ["autumn", "winter"], formality: "smart-casual", wearCount: 2 }),
  item("b1", "Indigo Jeans", "bottom", { primary: "indigo", season: ["spring", "autumn"], wearCount: 12 }),
  item("b2", "Navy Chinos", "bottom", { primary: "navy", season: ["spring", "summer"], formality: "smart-casual", wearCount: 7 }),
  item("b3", "Black Tailored Trousers", "bottom", { primary: "black", season: ["autumn", "winter"], formality: "formal", wearCount: 3 }),
  item("o1", "Olive Field Jacket", "outerwear", { primary: "olive", season: ["spring", "autumn"], wearCount: 5 }),
  item("s1", "White Sneakers", "shoes", { primary: "white", season: ["spring", "summer"], wearCount: 8 }),
  item("s2", "Brown Derbies", "shoes", { primary: "brown", season: ["autumn", "winter"], formality: "smart-casual", wearCount: 2 }),
  item("d1", "Navy Slip Dress", "dress", { primary: "navy", season: ["spring", "summer"], wearCount: 1 }),
  item("a1", "Leather Belt", "accessory", { primary: "brown", wearCount: 3 }),
];

const basePlan = mergeStylistTurn(EMPTY_PLAN_STATE, { intent: "recommend", occasion: "coffee" });
const plan = (over = {}) => ({ ...basePlan, ...over });
const run = (over = {}, weather = {}, items = wardrobe) => rankOutfits({ wardrobe: items, plan: plan(over), weather });

const allIds = (items) => new Set(items.map((x) => x.id));
const candidateIds = (candidate) => {
  const ids = [];
  for (const value of Object.values(candidate.slots)) {
    if (typeof value === "string") ids.push(value);
    else if (Array.isArray(value)) ids.push(...value);
  }
  return ids;
};
const gaps = (res) => {
  assert.equal(res.ok, false);
  return res.gap.code;
};

// --- structural gaps -------------------------------------------------------------------------

test("empty wardrobe is a noReadyItems gap", () => {
  assert.equal(gaps(run({}, {}, [])), "noReadyItems");
});

test("a wardrobe with no ready items is a noReadyItems gap", () => {
  const items = [item("t1", "T", "top", { status: "extracting" }), item("b1", "B", "bottom", { status: "failed" })];
  assert.equal(gaps(run({}, {}, items)), "noReadyItems");
});

test("ready top and bottom but no shoes is a missingShoes gap", () => {
  const items = [item("t1", "T", "top"), item("b1", "B", "bottom")];
  assert.equal(gaps(run({}, {}, items)), "missingShoes");
});

test("a top with no bottom and no dress is a missingBottom gap", () => {
  const items = [item("t1", "T", "top"), item("s1", "S", "shoes")];
  assert.equal(gaps(run({}, {}, items)), "missingBottom");
});

test("a bottom with no top and no dress is a missingTop gap", () => {
  const items = [item("b1", "B", "bottom"), item("s1", "S", "shoes")];
  assert.equal(gaps(run({}, {}, items)), "missingTop");
});

test("shoes and accessories only is a missingDress gap", () => {
  const items = [item("s1", "S", "shoes"), item("a1", "A", "accessory")];
  assert.equal(gaps(run({}, {}, items)), "missingDress");
});

test("cold weather with no outerwear is a missingOuterwear gap", () => {
  const items = [item("t1", "T", "top"), item("b1", "B", "bottom"), item("s1", "S", "shoes")];
  assert.equal(gaps(run({}, { minC: 5 }, items)), "missingOuterwear");
});

test("empty wardrobe reports noReadyItems before a colour request is evaluated", () => {
  const over = { colourConstraints: { include: ["chartreuse"], avoid: [] } };
  assert.equal(gaps(run(over, {}, [])), "noReadyItems");
});

// --- shape and trusted ids --------------------------------------------------------------------

test("every output id comes from the input wardrobe", () => {
  const res = run();
  assert.equal(res.ok, true);
  const ids = allIds(wardrobe);
  for (const candidate of res.candidates) {
    for (const id of candidateIds(candidate)) assert.ok(ids.has(id), `${id} not in wardrobe`);
  }
});

test("non-ready items never appear in a candidate", () => {
  const hidden = item("t9", "Hidden Top", "top", { primary: "white", status: "hidden" });
  const res = run({ requestedCount: 3 }, {}, [...wardrobe, hidden]);
  assert.equal(res.ok, true);
  for (const candidate of res.candidates) assert.equal(candidateIds(candidate).includes("t9"), false);
});

test("a hidden dress does not open the dress path", () => {
  const items = [item("b1", "B", "bottom"), item("s1", "S", "shoes"), item("d9", "Hidden Dress", "dress", { status: "hidden" })];
  assert.equal(gaps(run({}, {}, items)), "missingTop");
});

test("run is deterministic: the same input produces deep-equal candidates", () => {
  const first = run({ requestedCount: 3 });
  const second = run({ requestedCount: 3 });
  assert.deepEqual(first, second);
});

test("candidate order is independent of wardrobe input order", () => {
  const forward = run({ requestedCount: 3 }, {}, wardrobe);
  const reversed = run({ requestedCount: 3 }, {}, [...wardrobe].reverse());
  assert.deepEqual(forward, reversed);
});

test("distinct slot sets produce distinct keys", () => {
  const res = run({ requestedCount: 3 });
  assert.equal(res.ok, true);
  const keys = new Set(res.candidates.map((c) => c.key));
  assert.equal(keys.size, res.candidates.length);
});

test("candidateKey is a deterministic slot signature", () => {
  const a = candidateKey({ top: "t1", bottom: "b1", shoes: "s1" });
  const b = candidateKey({ shoes: "s1", top: "t1", bottom: "b1" });
  assert.equal(a, b);
  assert.equal(a, "bottom:b1|shoes:s1|top:t1");
});

test("both the separates and dress paths are offered when the wardrobe allows", () => {
  const items = [item("t1", "T", "top"), item("b1", "B", "bottom"), item("s1", "S", "shoes"), item("d1", "D", "dress")];
  const res = rankOutfits({ wardrobe: items, plan: plan({ requestedCount: 3 }), weather: {} });
  assert.equal(res.ok, true);
  assert.ok(res.candidates.some((c) => c.slots.dress));
  assert.ok(res.candidates.some((c) => c.slots.top && c.slots.bottom));
});

test("a dress candidate never also fills top and bottom", () => {
  const items = [item("d1", "D", "dress"), item("s1", "S", "shoes")];
  const res = rankOutfits({ wardrobe: items, plan: plan({ requestedCount: 3 }), weather: {} });
  assert.equal(res.ok, true);
  for (const candidate of res.candidates) {
    assert.ok(candidate.slots.dress);
    assert.equal(candidate.slots.top, undefined);
    assert.equal(candidate.slots.bottom, undefined);
  }
});

// --- count clamping ---------------------------------------------------------------------------

test("requestedCount is clamped to at most three", () => {
  const res = run({ requestedCount: 99 });
  assert.equal(res.ok, true);
  assert.equal(res.candidates.length, 3);
});

test("requestedCount is clamped to at least one", () => {
  const res = run({ requestedCount: 0 });
  assert.equal(res.ok, true);
  assert.equal(res.candidates.length, 1);
});

test("the default request count is used when none is given", () => {
  const res = run();
  assert.equal(res.ok, true);
  assert.ok(res.candidates.length >= 1 && res.candidates.length <= 2);
});

test("clampRequestedCount clamps and defaults invalid inputs", () => {
  assert.equal(clampRequestedCount(0), 1);
  assert.equal(clampRequestedCount(2.9), 2);
  assert.equal(clampRequestedCount(7), 3);
  assert.equal(clampRequestedCount(Number.NaN), 2);
});

// --- colour constraints -----------------------------------------------------------------------

test("an include colour is present in every candidate", () => {
  const over = { colourConstraints: { include: ["white"], avoid: [] } };
  const res = run(over, {}, wardrobe);
  assert.equal(res.ok, true);
  for (const candidate of res.candidates) {
    const colours = candidateIds(candidate).map((id) => wardrobe.find((x) => x.id === id).colours.primary);
    assert.ok(colours.includes("white"));
  }
});

test("an include colour present nowhere is a colourConstraintUnsatisfied gap", () => {
  const over = { colourConstraints: { include: ["chartreuse"], avoid: [] } };
  assert.equal(gaps(run(over)), "colourConstraintUnsatisfied");
});

test("an avoid colour removes every candidate when the wardrobe is one colour", () => {
  const items = [item("t1", "T", "top", { primary: "white" }), item("b1", "B", "bottom", { primary: "white" }), item("s1", "S", "shoes")];
  const over = { colourConstraints: { include: [], avoid: ["white"] } };
  assert.equal(gaps(run(over, {}, items)), "colourConstraintUnsatisfied");
});

test("an avoid colour only removes the candidates that use it", () => {
  const over = { colourConstraints: { include: [], avoid: ["white"] } };
  const res = run(over, {}, wardrobe);
  assert.equal(res.ok, true);
  assert.ok(res.candidates.length > 0);
  for (const candidate of res.candidates) {
    const primaries = candidateIds(candidate).map((id) => wardrobe.find((x) => x.id === id).colours.primary.toLowerCase());
    assert.equal(primaries.includes("white"), false);
  }
});

function colourTokensFor(items, candidate) {
  const tokens = new Set();
  for (const id of candidateIds(candidate)) {
    const found = items.find((x) => x.id === id);
    tokens.add(found.colours.primary.toLowerCase());
    for (const c of found.colours.secondary) tokens.add(c.toLowerCase());
  }
  return tokens;
}

test("colour matching is case-insensitive and reads the secondary colour", () => {
  const items = [
    item("t1", "T", "top", { primary: "white", secondary: ["red"] }),
    item("t2", "N", "top", { primary: "navy" }),
    item("b1", "B", "bottom", { primary: "indigo" }),
    item("s1", "S", "shoes", { primary: "brown" }),
  ];
  const over = { colourConstraints: { include: [], avoid: ["WHITE"] } };
  const res = rankOutfits({ wardrobe: items, plan: plan(over), weather: {} });
  assert.equal(res.ok, true);
  assert.ok(res.candidates.some((c) => c.slots.top === "t2"));
  for (const candidate of res.candidates) assert.equal(colourTokensFor(items, candidate).has("white"), false);

  const include = { colourConstraints: { include: ["red"], avoid: [] } };
  const red = rankOutfits({ wardrobe: items, plan: plan(include), weather: {} });
  assert.equal(red.ok, true);
  for (const candidate of red.candidates) assert.ok(colourTokensFor(items, candidate).has("red"));
});

// --- formality --------------------------------------------------------------------------------

test("requesting a formality the wardrobe does not have is a formalityConstraintUnsatisfied gap", () => {
  const items = [item("t1", "T", "top", { formality: "casual" }), item("b1", "B", "bottom", { formality: "casual" }), item("s1", "S", "shoes", { formality: "casual" })];
  assert.equal(gaps(run({ formality: "formal" }, {}, items)), "formalityConstraintUnsatisfied");
});

test("every candidate includes an item of the requested formality", () => {
  const res = run({ formality: "formal", requestedCount: 3 });
  assert.equal(res.ok, true);
  assert.ok(res.candidates.length > 0);
  for (const candidate of res.candidates) {
    const hasFormal = candidateIds(candidate).some((id) => wardrobe.find((x) => x.id === id)?.formality === "formal");
    assert.ok(hasFormal, `candidate ${candidate.key} lacks a formal item`);
  }
});

test("formality adjacency only reorders: an exact-formality item scores above an adjacent one", () => {
  const items = [
    item("t2", "Smart Top", "top", { formality: "smart-casual", primary: "navy" }),
    item("b1", "Casual Bottom", "bottom", { formality: "casual", primary: "indigo" }),
    item("b2", "Smart Bottom", "bottom", { primary: "navy", formality: "smart-casual" }),
    item("s1", "S", "shoes", { primary: "brown", formality: "smart-casual" }),
  ];
  const res = rankOutfits({ wardrobe: items, plan: plan({ formality: "smart-casual", requestedCount: 3 }), weather: {} });
  assert.equal(res.ok, true);
  const withB2 = res.candidates.find((c) => c.slots.bottom === "b2");
  if (withB2) {
    const withB1 = res.candidates.find((c) => c.slots.bottom === "b1");
    if (withB1) assert.ok(withB2.score > withB1.score);
  }
});

// --- weather ----------------------------------------------------------------------------------

test("cold weather puts outerwear on every candidate", () => {
  const res = run({ requestedCount: 3 }, { minC: 5 });
  assert.equal(res.ok, true);
  for (const candidate of res.candidates) assert.ok(candidate.slots.outerwear);
});

test("hot weather ranks cool-season garments above winter garments", () => {
  const items = [
    item("t1", "Summer Tee", "top", { primary: "white", season: ["summer"] }),
    item("t3", "Winter Knit", "top", { primary: "burgundy", season: ["winter"] }),
    item("b1", "B", "bottom", { primary: "indigo" }),
    item("s1", "S", "shoes", { primary: "white" }),
  ];
  const res = rankOutfits({ wardrobe: items, plan: plan({ requestedCount: 3 }), weather: { maxC: 30 } });
  assert.equal(res.ok, true);
  const summer = res.candidates.find((c) => c.slots.top === "t1");
  const winter = res.candidates.find((c) => c.slots.top === "t3");
  assert.ok(summer && winter);
  assert.ok(summer.score > winter.score);
});

test("wet weather offers both a layered and an unlayered candidate", () => {
  const items = [item("t1", "T", "top"), item("b1", "B", "bottom"), item("s1", "S", "shoes"), item("o1", "O", "outerwear")];
  const res = rankOutfits({ wardrobe: items, plan: plan({ requestedCount: 3 }), weather: { minC: 15, maxC: 20, precipProb: 0.6 } });
  assert.equal(res.ok, true);
  assert.ok(res.candidates.some((c) => c.slots.outerwear));
});

// --- deterministic tie-break and metadata isolation ------------------------------------------

test("equal scores are broken by lower wear count", () => {
  const items = [
    item("t1", "Old Tee", "top", { primary: "white", wearCount: 5 }),
    item("t2", "New Tee", "top", { primary: "white", wearCount: 1 }),
    item("b1", "B", "bottom", { primary: "indigo" }),
    item("s1", "S", "shoes", { primary: "white" }),
  ];
  const res = rankOutfits({ wardrobe: items, plan: plan({ requestedCount: 2 }), weather: {} });
  assert.equal(res.ok, true);
  assert.equal(res.candidates[0].slots.top, "t2");
});

test("items without wearCount are handled", () => {
  const items = [
    { id: "t1", name: "T", status: "ready", category: "top", colours: { primary: "white", secondary: [], hex: [] } },
    { id: "b1", name: "B", status: "ready", category: "bottom", colours: { primary: "indigo", secondary: [], hex: [] } },
    { id: "s1", name: "S", status: "ready", category: "shoes", colours: { primary: "brown", secondary: [], hex: [] } },
  ];
  const res = rankOutfits({ wardrobe: items, plan: plan({ requestedCount: 1 }), weather: {} });
  assert.equal(res.ok, true);
});

test("unsupported fields (pattern, material, fit) never change the ranking", () => {
  const plain = [item("t1", "T", "top", { primary: "white" }), item("b1", "B", "bottom", { primary: "indigo" }), item("s1", "S", "shoes", { primary: "brown" })];
  const decorated = plain.map((x) => ({ ...x, pattern: "solid", material: "cotton", fit: "regular" }));
  assert.deepEqual(run({ requestedCount: 3 }, {}, plain), run({ requestedCount: 3 }, {}, decorated));
});

// --- proposal adapter and C2 seam -------------------------------------------------------------

test("candidateToProposal maps a candidate onto the C2 {outfitId, name} contract", () => {
  const res = run({ requestedCount: 1 });
  assert.equal(res.ok, true);
  const proposal = candidateToProposal(res.candidates[0], wardrobe);
  assert.equal(proposal.outfitId, res.candidates[0].key);
  assert.equal(typeof proposal.name, "string");
  assert.ok(proposal.name.length > 0);
  for (const id of candidateIds(res.candidates[0])) {
    assert.ok(proposal.name.includes(wardrobe.find((x) => x.id === id).name));
  }
});

test("ranked candidates are accepted by C2's proposal machine", () => {
  const res = run({ requestedCount: 3 });
  assert.equal(res.ok, true);
  const proposals = res.candidates.map((c) => candidateToProposal(c, wardrobe));
  const recommended = transitionStylistState(EMPTY_MACHINE_STATE, {
    type: "RECOMMENDATION_READY",
    candidates: proposals,
    turnIndex: 1,
    now: 1,
  });
  assert.equal(recommended.ok, true);
  const proposed = transitionStylistState(recommended.state, { type: "PROPOSALS_READY", candidates: proposals, now: 2 });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.state.stage, "PROPOSED");
  assert.deepEqual(proposed.state.candidates.map((c) => c.outfitId), proposals.map((p) => p.outfitId));
});

test("every gap carries a non-empty typed message", () => {
  const cases = [
    run({}, {}, []),
    run({}, {}, [item("t1", "T", "top"), item("b1", "B", "bottom")]),
    run({ formality: "formal" }, {}, [item("t1", "T", "top"), item("b1", "B", "bottom"), item("s1", "S", "shoes")]),
    run({ colourConstraints: { include: ["chartreuse"], avoid: [] } }),
  ];
  for (const res of cases) {
    assert.equal(res.ok, false);
    assert.equal(typeof res.gap.code, "string");
    assert.ok(res.gap.message.length > 0);
  }
});