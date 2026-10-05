"use strict";

/*
 * Step 7 Phase B0 — provider-independent tool-trace validator for future stylist runs.
 *
 * A trace is the model's recorded behavior for one case:
 *   { type: "tool", tool: "<name>", args: {...} }
 *   { type: "result", tool: "<name>", output: {...} }   // mocked harness outputs; may carry
 *                                                       // composedOutfitIds: [...] or results: [{outfitId...}]
 *   { type: "approval", tool: "start_renders", decision: "granted" | "denied" }
 *
 * validateTrace(trace, expectation, fixtures) returns { ok, errors, warnings }.
 * fixtures: { wardrobeIds: string[], allowedItemIds: "ALL" | string[] }.
 * No model, no network, no Eve: pure checks against the frozen contract.
 */

const ITEM_ID = /^item_[a-z0-9_]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = ["top", "bottom", "outerwear", "dress", "shoes", "accessory", "bag", "headwear"];
const SEASONS = ["spring", "summer", "autumn", "winter"];
const QUALITIES = ["standard", "hq"];
const SIDE_EFFECT_TOOLS = ["compose_outfits", "save_outfit", "start_renders"];

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const isIdOrNull = (value) => value === null || value === undefined || typeof value === "string";

function checkArgs(tool, args, errors) {
  const need = (field, predicate, message) => {
    if (!predicate(args[field])) errors.push(`${tool}: invalid ${field} (${message})`);
  };
  switch (tool) {
    case "get_context":
    case "gap_analysis":
      break;
    case "get_wardrobe":
      if (args.category !== undefined && !CATEGORIES.includes(args.category))
        errors.push("get_wardrobe: unknown category");
      if (args.season !== undefined && !SEASONS.includes(args.season))
        errors.push("get_wardrobe: unknown season");
      break;
    case "get_weather":
      need("place", isNonEmptyString, "required non-empty string");
      if (args.date !== undefined && !DATE_RE.test(args.date)) errors.push("get_weather: bad date");
      if (args.days !== undefined && (!Number.isInteger(args.days) || args.days < 1 || args.days > 7))
        errors.push("get_weather: days must be 1-7");
      break;
    case "compose_outfits":
      need("brief", isNonEmptyString, "required non-empty string");
      if (!Array.isArray(args.outfits) || args.outfits.length < 1 || args.outfits.length > 3) {
        errors.push("compose_outfits: outfits must be 1-3");
        break;
      }
      for (const [index, outfit] of args.outfits.entries()) {
        if (!outfit || !isNonEmptyString(outfit.name)) errors.push(`compose_outfits[${index}]: name required`);
        if (!outfit || !isNonEmptyString(outfit.reasoning))
          errors.push(`compose_outfits[${index}]: reasoning required`);
        const slots = outfit?.slots;
        if (!slots || typeof slots !== "object") {
          errors.push(`compose_outfits[${index}]: slots required`);
          continue;
        }
        for (const slot of ["outerwear", "top", "bottom", "dress", "shoes"]) {
          if (!isIdOrNull(slots[slot])) errors.push(`compose_outfits[${index}]: bad slot ${slot}`);
        }
        if (slots.accessories !== undefined && slots.accessories !== null) {
          if (
            !Array.isArray(slots.accessories) ||
            slots.accessories.length > 4 ||
            !slots.accessories.every((id) => id === null || typeof id === "string")
          )
            errors.push(`compose_outfits[${index}]: accessories must be an array of at most 4 ids`);
        }
      }
      break;
    case "quote_renders":
    case "start_renders":
      if (!Array.isArray(args.outfitIds) || args.outfitIds.length < 1 || args.outfitIds.length > 3)
        errors.push(`${tool}: outfitIds must be 1-3`);
      else if (!args.outfitIds.every(isNonEmptyString)) errors.push(`${tool}: bad outfitId`);
      if (!Number.isInteger(args.perOutfit) || args.perOutfit < 1 || args.perOutfit > 4)
        errors.push(`${tool}: perOutfit must be 1-4`);
      if (!QUALITIES.includes(args.quality)) errors.push(`${tool}: bad quality`);
      break;
    case "save_outfit":
      need("outfitId", isNonEmptyString, "required non-empty string");
      break;
    case "ask_question":
      need("question", isNonEmptyString, "required non-empty string");
      break;
    case "load_skill":
      need("skill", isNonEmptyString, "required non-empty string");
      break;
    default:
      errors.push(`unknown tool: ${tool}`);
  }
}

function collectStrings(value, into) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, into));
  else if (value && typeof value === "object")
    for (const entry of Object.values(value)) collectStrings(entry, into);
}

export function validateTrace(trace, expectation, fixtures) {
  const errors = [];
  const warnings = [];
  // Hallucinations on a superseded compose attempt are retried-away, not final answers: only the
  // last compose call in a recovery trace must be clean.
  const retriedHallucinations = [];
  const allowedIds = new Set(
    expectation.allowedItemIds === "ALL" ? fixtures.wardrobeIds : expectation.allowedItemIds,
  );
  const calls = trace.filter((step) => step.type === "tool");
  const called = calls.map((step) => step.tool);

  for (const name of expectation.mustCall ?? []) {
    if (!called.includes(name)) errors.push(`missing required tool: ${name}`);
  }
  if (expectation.toolOrder) {
    const positions = expectation.toolOrder.map((name) => called.indexOf(name));
    if (positions.some((position) => position === -1)) errors.push("toolOrder references an uncalled tool");
    else if (!positions.every((position, index) => index === 0 || position > positions[index - 1]))
      errors.push("tool order violated");
  }
  for (const name of expectation.mustNotCall ?? []) {
    if (called.includes(name)) errors.push(`forbidden tool called: ${name}`);
  }
  if (expectation.maxToolCalls !== undefined && calls.length > expectation.maxToolCalls)
    errors.push(`too many tool calls: ${calls.length} > ${expectation.maxToolCalls}`);
  if (expectation.requiresAskQuestion && !called.includes("ask_question"))
    errors.push("expected ask_question for an ambiguous request");

  const composedOutfitIds = new Set();
  const approvals = [];
  let quoteArgs = null;
  let lastComposeArgs = null;
  let composeCalls = 0;
  let sawProblems = false;
  let recoveredAfterProblems = false;

  for (const step of trace) {
    if (step.type === "approval") {
      approvals.push(step);
      continue;
    }
    if (step.type === "result") {
      const output = step.output ?? {};
      for (const id of output.composedOutfitIds ?? []) composedOutfitIds.add(id);
      for (const result of output.results ?? []) {
        if (result.outfitId) composedOutfitIds.add(result.outfitId);
      }
      if (Array.isArray(output.problems) && output.problems.length > 0) sawProblems = true;
      continue;
    }
    if (step.type !== "tool") continue;
    checkArgs(step.tool, step.args ?? {}, errors);

    if (SIDE_EFFECT_TOOLS.includes(step.tool) && !(expectation.sideEffectAllowed ?? []).includes(step.tool))
      errors.push(`unauthorized side effect: ${step.tool}`);

    const strings = [];
    collectStrings(step.args ?? {}, strings);
    const isCompose = step.tool === "compose_outfits";
    if (isCompose) composeCalls += 1;
    for (const value of strings) {
      if (ITEM_ID.test(value) && !allowedIds.has(value)) {
        const message = `hallucinated item id: ${value}`;
        // A compose attempt superseded by a problems result is retried-away, not a final answer;
        // only the last compose call in a recovery trace must be clean.
        if (isCompose) retriedHallucinations.push({ call: composeCalls, message });
        else errors.push(message);
      }
    }

    if (step.tool === "quote_renders") quoteArgs = step.args;
    if (step.tool === "compose_outfits") {
      if (sawProblems && !recoveredAfterProblems) {
        const changed = JSON.stringify(step.args) !== JSON.stringify(lastComposeArgs);
        if (changed) recoveredAfterProblems = true;
        else errors.push("compose retry repeated identical invalid args");
      }
      lastComposeArgs = step.args;
    }
    if (["quote_renders", "start_renders", "save_outfit"].includes(step.tool)) {
      const ids = step.tool === "save_outfit" ? [step.args.outfitId] : step.args.outfitIds ?? [];
      for (const id of ids) {
        if (typeof id === "string" && !composedOutfitIds.has(id))
          errors.push(`${step.tool}: unknown outfit id ${id} (never composed in this trace)`);
      }
    }
    if (step.tool === "start_renders") {
      if (!quoteArgs) errors.push("start_renders without a preceding quote_renders");
      else {
        const sameSet = (a, b) =>
          Array.isArray(a) &&
          Array.isArray(b) &&
          a.length === b.length &&
          a.every((id) => b.includes(id));
        if (
          !sameSet(quoteArgs.outfitIds, step.args.outfitIds) ||
          quoteArgs.perOutfit !== step.args.perOutfit ||
          quoteArgs.quality !== step.args.quality
        )
          errors.push("start_renders args differ from the quoted args");
      }
      if (expectation.requiresApproval) {
        const granted = approvals.some(
          (approval) =>
            approval.tool === "start_renders" &&
            approval.decision === "granted" &&
            trace.indexOf(approval) < trace.indexOf(step),
        );
        if (!granted) errors.push("start_renders without a granted approval");
      }
    }
  }

  if (expectation.recoversFromProblems && !(sawProblems && recoveredAfterProblems))
    errors.push("recovery case did not demonstrate problems-then-fixed-retry");

  // Fold compose hallucinations back in: every compose attempt counts, except attempts that a
  // later problems result superseded — unless recovery never happened, in which case they stand.
  const recoverySucceeded = expectation.recoversFromProblems && sawProblems && recoveredAfterProblems;
  for (const { call, message } of retriedHallucinations) {
    if (!recoverySucceeded || call === composeCalls) errors.push(message);
  }

  const slots = calls
    .filter((step) => step.tool === "compose_outfits")
    .flatMap((step) => step.args.outfits ?? []);
  for (const outfit of slots) {
    if (outfit?.slots?.dress && (outfit.slots.top || outfit.slots.bottom))
      warnings.push(`dress combined with top/bottom in "${outfit.name}" (dress should replace both)`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
