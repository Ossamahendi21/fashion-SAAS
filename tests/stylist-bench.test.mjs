// Step 7 Stylist Phase B0: frozen benchmark fixtures must mirror the real stylist contract and
// stay provider-independent. No model, no network, no Eve, no OpenAI — JSON + trace-validator only.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateTrace } from "../bench/stylist/validate-trace.mjs";

const root = new URL("../bench/stylist/", import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const contract = readJson("tool-contract.json");
const wardrobe = readJson("wardrobe.json");
const contexts = readJson("contexts.json");
const caseFiles = readdirSync(new URL("cases/", root))
  .filter((file) => file.endsWith(".json"))
  .sort();
const cases = caseFiles.map((file) => readJson(`cases/${file}`));
const wardrobeIds = new Set(wardrobe.items.map((item) => item.id));
const activeTools = new Set(contract.tools.map((tool) => tool.name));
const DISABLED_TOOLS = [
  "bash",
  "web_search",
  "web_fetch",
  "read_file",
  "write_file",
  "todo",
  "task_cancel",
  "agent",
];
const SIDE_EFFECT_TOOLS = ["compose_outfits", "save_outfit", "start_renders"];

const caseItemIds = (expect) =>
  expect.allowedItemIds === "ALL" ? [...wardrobeIds] : expect.allowedItemIds;
const fixtures = { wardrobeIds: [...wardrobeIds] };

const MOCK_REF = /^(wardrobe:(all|empty|filter:[a-z]+)|context:(prefs|weather|quoteStandard|quoteBlocked))$/;
const resolveMock = (ref) => {
  const [kind, name, extra] = ref.split(":");
  if (kind === "wardrobe") {
    if (name === "all") return wardrobe.items;
    if (name === "empty") return [];
    return wardrobe.items.filter((item) => item.category === extra);
  }
  return contexts[name];
};

// ---------------------------------------------------------------------------------------------
// Fixture integrity.
// ---------------------------------------------------------------------------------------------

test("exactly the 18 frozen cases exist with stable unique sorted ids", () => {
  assert.equal(caseFiles.length, 18);
  assert.deepEqual(
    cases.map((entry) => entry.id),
    Array.from({ length: 18 }, (_, index) => `case-${String(index + 1).padStart(2, "0")}`),
  );
});

test("the tool contract lists exactly the 10 active tools, mirrored from source", () => {
  assert.deepEqual([...activeTools].sort(), [
    "ask_question",
    "compose_outfits",
    "gap_analysis",
    "get_context",
    "get_wardrobe",
    "get_weather",
    "load_skill",
    "quote_renders",
    "save_outfit",
    "start_renders",
  ]);
  const toolsDir = fileURLToPath(new URL("../agent/tools/", import.meta.url));
  for (const file of readdirSync(toolsDir).filter((entry) => entry.endsWith(".ts"))) {
    const source = readFileSync(`${toolsDir}/${file}`, "utf8");
    const name = file.replace(/\.ts$/, "");
    if (name === "ask_question" || name === "load_skill") {
      assert.ok(
        source.includes('from "eve/tools/'),
        `${name} must be an eve built-in re-export, not a local tool definition`,
      );
      continue;
    }
    if (activeTools.has(name)) {
      assert.ok(source.includes("defineTool("), `${name} must define a tool`);
      assert.ok(!source.includes("disableTool()"), `${name} must not be disabled`);
    } else {
      assert.ok(source.includes("disableTool()"), `${name} is not in the contract so it must be disabled`);
    }
  }
  for (const tool of contract.tools) {
    assert.equal(typeof tool.sideEffect, "boolean", `${tool.name} sideEffect explicit`);
    assert.equal(typeof tool.approvalRequired, "boolean", `${tool.name} approvalRequired explicit`);
  }
  assert.ok(
    contract.tools.find((tool) => tool.name === "start_renders").approvalRequired,
    "start_renders requires approval",
  );
  assert.ok(
    !contract.tools.find((tool) => tool.name === "quote_renders").sideEffect,
    "quote_renders is read-only",
  );
});

test("every case references only real active tools and real wardrobe ids", () => {
  for (const entry of cases) {
    for (const name of [...(entry.expect.mustCall ?? []), ...(entry.expect.mustNotCall ?? [])]) {
      assert.ok(activeTools.has(name), `${entry.id} references active tool ${name}`);
      assert.ok(!DISABLED_TOOLS.includes(name), `${entry.id} must not reference disabled ${name}`);
    }
    for (const id of caseItemIds(entry.expect)) {
      assert.ok(wardrobeIds.has(id), `${entry.id} references frozen wardrobe id ${id}`);
    }
    for (const turn of entry.turns) {
      for (const value of Object.values(turn.toolResult?.output ?? {})) {
        for (const id of [value.outfitId, ...(value.composedOutfitIds ?? [])].filter(Boolean)) {
          assert.match(id, /^(outfit|item)_/, `${entry.id} history ids stay in fixture namespace`);
        }
      }
    }
  }
});

test("every mock tool-result reference resolves to frozen data", () => {
  const check = (node, where) => {
    if (typeof node === "string" && /^(wardrobe|context):/.test(node)) {
      assert.match(node, MOCK_REF, `${where}: mock reference ${node} must resolve`);
      assert.ok(resolveMock(node) !== undefined, `${where}: ${node} resolves`);
    } else if (Array.isArray(node)) node.forEach((child, index) => check(child, `${where}[${index}]`));
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) check(child, `${where}.${key}`);
    }
  };
  for (const entry of cases) check(entry.mockToolResults, `${entry.id}.mockToolResults`);
  assert.equal(resolveMock("wardrobe:filter:shoes").length, 3);
  assert.equal(resolveMock("wardrobe:empty").length, 0);
});

test("render sequencing expectations are internally valid", () => {
  for (const entry of cases) {
    const must = new Set(entry.expect.mustCall ?? []);
    const forbidden = new Set(entry.expect.mustNotCall ?? []);
    const allowed = new Set(entry.expect.sideEffectAllowed ?? []);
    if (must.has("start_renders")) {
      assert.ok(must.has("quote_renders"), `${entry.id}: start requires quote in mustCall`);
      assert.equal(entry.expect.requiresApproval, true, `${entry.id}: start requires approval`);
      assert.ok(allowed.has("start_renders"), `${entry.id}: start must be an allowed side effect`);
    }
    for (const tool of SIDE_EFFECT_TOOLS) {
      if (must.has(tool)) assert.ok(allowed.has(tool), `${entry.id}: ${tool} must be explicit in sideEffectAllowed`);
    }
    if (forbidden.has("start_renders")) {
      assert.equal(entry.expect.requiresApproval ?? false, false, `${entry.id}: no approval expected without start`);
    }
  }
});

test("no scores, results, model names, timestamps or random ids exist in fixtures", () => {
  const outDir = new URL(".out/", root);
  let outEmpty = true;
  try {
    outEmpty = readdirSync(outDir).length === 0;
  } catch {
    outEmpty = true;
  }
  assert.ok(outEmpty, ".out/ must hold no committed model outputs");
  const forbidden = /qwen|llama|phi-4|gemma|gpt-|openai|score|accuracy|pass_rate/i;
  const scan = [contract, wardrobe, contexts, ...cases];
  for (const [index, node] of scan.entries()) {
    assert.ok(!forbidden.test(JSON.stringify(node)), `fixture ${index} is provider/model neutral`);
  }
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|createdAt|updatedAt|timestamp/i;
  for (const [index, node] of scan.entries()) {
    assert.ok(!uuid.test(JSON.stringify(node)), `fixture ${index} has no timestamps or random ids`);
  }
});

test("fixtures are byte-stable under canonical JSON round-trip", () => {
  const files = ["tool-contract.json", "wardrobe.json", "contexts.json", "rubric.json", "context-sizes.json"];
  for (const file of files) {
    const raw = readFileSync(new URL(file, root), "utf8");
    assert.equal(JSON.stringify(JSON.parse(raw)), JSON.stringify(JSON.parse(JSON.stringify(JSON.parse(raw)))));
    assert.ok(raw.endsWith("}\n") || raw.endsWith("}"), `${file} is one canonical document`);
  }
  for (const file of caseFiles) {
    const raw = readFileSync(new URL(`cases/${file}`, root), "utf8");
    assert.equal(JSON.parse(raw).id, file.replace(/\.json$/, ""));
  }
});

// ---------------------------------------------------------------------------------------------
// Trace validator self-tests: the gate must catch real violations and pass clean runs.
// ---------------------------------------------------------------------------------------------

const validCompose = {
  type: "tool",
  tool: "compose_outfits",
  args: {
    brief: "Casual weekend",
    outfits: [
      {
        name: "Navy weekend",
        slots: {
          top: "item_top_navy_02",
          bottom: "item_bottom_indigo_01",
          shoes: "item_shoes_white_01",
          outerwear: null,
          dress: null,
          accessories: [],
        },
        reasoning: "Navy and white tonal pairing, no layer needed.",
      },
    ],
  },
};
const composedResult = {
  type: "result",
  tool: "compose_outfits",
  output: { saved: 1, composedOutfitIds: ["outfit_01"] },
};

test("validator passes a clean grounded trace", () => {
  const trace = [
    { type: "tool", tool: "get_wardrobe", args: {} },
    validCompose,
    composedResult,
  ];
  const result = validateTrace(
    trace,
    {
      mustCall: ["get_wardrobe", "compose_outfits"],
      mustNotCall: ["start_renders"],
      allowedItemIds: "ALL",
      maxToolCalls: 4,
      sideEffectAllowed: ["compose_outfits"],
    },
    fixtures,
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("validator catches hallucinated ids, bad schema and over-limit composes", () => {
  const badCompose = structuredClone(validCompose);
  badCompose.args.outfits[0].slots.top = "item_top_gold_99";
  badCompose.args.outfits.push(badCompose.args.outfits[0], badCompose.args.outfits[0], badCompose.args.outfits[0]);
  const result = validateTrace(
    [{ type: "tool", tool: "compose_outfits", args: badCompose.args }],
    { mustCall: ["compose_outfits"], allowedItemIds: "ALL", sideEffectAllowed: ["compose_outfits"] },
    fixtures,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("hallucinated item id")));
  assert.ok(result.errors.some((error) => error.includes("1-3")));
});

test("validator enforces quote-before-start with identical args plus granted approval", () => {
  const quote = {
    type: "tool",
    tool: "quote_renders",
    args: { outfitIds: ["outfit_01"], perOutfit: 1, quality: "standard" },
  };
  const start = {
    type: "tool",
    tool: "start_renders",
    args: { outfitIds: ["outfit_01"], perOutfit: 1, quality: "standard" },
  };
  const base = {
    allowedItemIds: "ALL",
    sideEffectAllowed: ["start_renders"],
    requiresApproval: true,
  };
  const noQuote = validateTrace([composedResult, start], { ...base }, fixtures);
  assert.ok(!noQuote.ok && noQuote.errors.some((error) => error.includes("preceding quote")));
  const noApproval = validateTrace([composedResult, quote, start], { ...base }, fixtures);
  assert.ok(!noApproval.ok && noApproval.errors.some((error) => error.includes("granted approval")));
  const changedArgs = validateTrace(
    [composedResult, quote, { ...start, args: { ...start.args, perOutfit: 2 } }],
    { ...base },
    fixtures,
  );
  assert.ok(!changedArgs.ok && changedArgs.errors.some((error) => error.includes("differ from the quoted")));
  const clean = validateTrace(
    [composedResult, quote, { type: "approval", tool: "start_renders", decision: "granted" }, start],
    { ...base },
    fixtures,
  );
  assert.deepEqual(clean.errors, []);
});

test("validator enforces known outfit ids and problems-then-fixed recovery", () => {
  const unknownOutfit = validateTrace(
    [
      {
        type: "tool",
        tool: "save_outfit",
        args: { outfitId: "outfit_99", name: "Ghost" },
      },
    ],
    { mustCall: ["save_outfit"], allowedItemIds: "ALL", sideEffectAllowed: ["save_outfit"] },
    fixtures,
  );
  assert.ok(!unknownOutfit.ok && unknownOutfit.errors.some((error) => error.includes("never composed")));

  const first = structuredClone(validCompose);
  first.args.outfits[0].slots.top = "item_top_gold_99";
  const recovery = validateTrace(
    [
      first,
      { type: "result", tool: "compose_outfits", output: { saved: 0, problems: ["bad id"], composedOutfitIds: [] } },
      validCompose,
      composedResult,
    ],
    {
      mustCall: ["compose_outfits"],
      allowedItemIds: "ALL",
      sideEffectAllowed: ["compose_outfits"],
      recoversFromProblems: true,
    },
    fixtures,
  );
  assert.deepEqual(recovery.errors, []);
  const noRetry = validateTrace(
    [first, { type: "result", tool: "compose_outfits", output: { saved: 0, problems: ["bad id"] } }],
    {
      mustCall: ["compose_outfits"],
      allowedItemIds: "ALL",
      sideEffectAllowed: ["compose_outfits"],
      recoversFromProblems: true,
    },
    fixtures,
  );
  assert.ok(!noRetry.ok);
});

test("validator rejects disabled and unknown tools", () => {
  const result = validateTrace(
    [{ type: "tool", tool: "web_search", args: { query: "x" } }],
    { mustCall: [], allowedItemIds: "ALL" },
    fixtures,
  );
  assert.ok(!result.ok && result.errors.some((error) => error.includes("unknown tool")));
});
