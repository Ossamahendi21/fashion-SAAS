import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { defaultMessageReducer } from "eve/client";
import { shouldSubmitComposer } from "../src/components/stylist/composer-keyboard.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../convex/shared/wardrobe") {
      return nextResolve(new URL("../convex/shared/wardrobe.ts", import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const {
  activityState,
  activityGroupState,
  activityRetry,
  groupActivityParts,
  isActiveActivityMessage,
  summarizeActivity,
} = await import("../src/components/stylist/tool-activity-state.ts");

const tool = (id, name = "get_wardrobe", state = "output-available", extra = {}) => ({
  type: "dynamic-tool",
  toolCallId: id,
  toolName: name,
  state,
  input: {},
  output: { count: 2 },
  ...extra,
});
const text = (text) => ({ type: "text", text });
const assistant = (id, parts) => ({ id, role: "assistant", parts });
const projected = (...parts) => parts.map((part) => ({ part }));

function replay() {
  const reducer = defaultMessageReducer();
  let data = reducer.initial();
  return {
    event(type, values = {}) {
      data = reducer.reduce(data, { type, data: { turnId: "turn", stepIndex: 0, ...values } });
      return data.messages[0]?.parts.find((part) => part.type === "dynamic-tool");
    },
    get messages() {
      return data.messages;
    },
  };
}

const action = { callId: "call", kind: "tool-call", toolName: "get_wardrobe", input: { category: "top" } };
const result = { callId: "call", kind: "tool-result", toolName: "get_wardrobe", output: { count: 2 } };

test("real Eve stream updates one activity from preparing to partial to finished without stale running copy", () => {
  const stream = replay();
  const preparing = stream.event("action.input.appended", {
    callId: "call",
    toolName: "get_wardrobe",
    inputTextDelta: '{"category":',
  });
  assert.equal(activityState(preparing, true), "running");
  const running = stream.event("actions.requested", { actions: [action] });
  assert.equal(activityState(running, true), "running");
  const partial = stream.event("action.partial", { result });
  assert.equal(partial.partial, true);
  assert.equal(activityState(partial, true), "running");
  assert.doesNotMatch(summarizeActivity([partial], true)[0].detail, /pieces found/);
  const done = stream.event("action.result", { result, status: "completed" });
  assert.equal(activityState(done, true), "done", "another concurrent call does not keep this one spinning");
  assert.equal(stream.messages[0].parts.filter((part) => part.type === "dynamic-tool").length, 1);
  assert.deepEqual(
    summarizeActivity([done], false).map(({ label, detail }) => ({ label, detail })),
    [{ label: "Wardrobe checked", detail: "Tops · 2 pieces found" }],
  );
});

test("real failed and denied Eve results remain distinct and never print upstream error details", () => {
  const failedStream = replay();
  failedStream.event("actions.requested", { actions: [action] });
  const failure = failedStream.event("action.result", {
    result,
    status: "failed",
    error: { code: "NETWORK", message: 'SECRET upstream JSON {"token":"secret"}' },
  });
  assert.equal(activityState(failure, false), "error");
  const summary = summarizeActivity([failure], false)[0];
  assert.match(summary.label, /Couldn’t/);
  assert.doesNotMatch(JSON.stringify(summary), /SECRET|token|upstream/);
  const deniedStream = replay();
  deniedStream.event("actions.requested", { actions: [action] });
  const denied = deniedStream.event("action.result", {
    result,
    status: "failed",
    error: { code: "TOOL_EXECUTION_DENIED", message: "Not approved" },
  });
  assert.equal(activityState(denied, false), "cancelled");
  assert.equal(activityRetry([denied]), null, "a declined action is not offered as an error retry");
});

test("cancelled or disconnected incomplete calls pause, and a new turn never reanimates old activity", () => {
  const stream = replay();
  const pending = stream.event("actions.requested", { actions: [action] });
  stream.event("turn.cancelled");
  assert.equal(activityState(pending, false), "paused");
  assert.match(summarizeActivity([pending], false)[0].label, /No result received/);
  const history = [
    assistant("old", [pending]),
    { id: "new-user", role: "user", parts: [text("A new request")] },
    assistant("new", [tool("next", "get_weather", "input-available")]),
  ];
  assert.equal(isActiveActivityMessage(history, 0, true), false);
  assert.equal(isActiveActivityMessage(history, 2, true), true);
  assert.equal(isActiveActivityMessage(history, 2, false), false);
});

test("six wardrobe searches collapse into one safe category summary without double-counting pieces", () => {
  const calls = ["top", "bottom", "outerwear", "shoes", "accessory", "bag"].map((category, index) =>
    tool(`call-${index}`, "get_wardrobe", "output-available", {
      input: { category },
      output: { count: 2, items: [{ id: "same-item" }] },
    }),
  );
  const rows = summarizeActivity(calls, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 6);
  assert.equal(rows[0].state, "done");
  assert.match(rows[0].detail, /6 searches/);
  assert.match(rows[0].detail, /Tops, Bottoms, Outerwear, Shoes, Accessories, Bags/);
  assert.doesNotMatch(rows[0].detail, /12 pieces|same-item/);
  const mixed = summarizeActivity(
    [
      ...calls,
      tool("failed", "get_wardrobe", "output-error"),
      tool("still-running", "get_wardrobe", "input-available"),
    ],
    true,
  )[0];
  assert.equal(mixed.state, "running");
  assert.match(mixed.detail, /1 failed/);
});

test("prose, approvals, questions, final proposal cards and final render cards keep their order", () => {
  const approval = tool("approval", "start_renders", "approval-requested");
  const question = tool("question", "ask_question", "approval-requested");
  const proposal = tool("proposal", "compose_outfits");
  const render = tool("render", "start_renders");
  const source = projected(
    tool("wardrobe"),
    { type: "step-start" },
    tool("weather", "get_weather"),
    text("Here is a look."),
    approval,
    question,
    proposal,
    render,
  );
  const original = structuredClone(source);
  const grouped = groupActivityParts(source);
  assert.deepEqual(
    grouped.map((group) => group.kind),
    ["activity", "part", "part", "part", "part", "part"],
  );
  assert.equal(grouped[0].tools.length, 2);
  assert.deepEqual(
    grouped.slice(1).map((group) => group.value.part),
    [text("Here is a look."), approval, question, proposal, render],
  );
  assert.deepEqual(source, original, "display grouping must not rewrite persisted messages");
  const partialCard = groupActivityParts(
    projected(tool("partial", "compose_outfits", "output-available", { partial: true })),
  );
  assert.equal(partialCard[0].kind, "activity", "preliminary output cannot mount a finished outfit card");
  const followup = { part: text("It’s running."), renderJobIds: ["job"] };
  assert.equal(groupActivityParts([followup])[0].value, followup, "live render completion follow-ups are retained");
});

test("unknown tool names, arbitrary JSON and invalid counts cannot leak into activity copy", () => {
  const malicious = tool("id", 'unknown_{"password":"secret"}', "output-error", {
    input: { category: "<script>bad</script>" },
    errorText: "SQL token secret",
  });
  const view = summarizeActivity([malicious], false)[0];
  assert.equal(view.label, "This step didn’t finish");
  assert.doesNotMatch(view.label + view.detail, /secret|script|SQL|password/);
  for (const value of [-1, Infinity, "99", {}, null]) {
    const row = summarizeActivity(
      [
        tool("wardrobe", "get_wardrobe", "output-available", {
          input: { category: "SECRET" },
          output: { count: value },
        }),
      ],
      false,
    )[0];
    assert.equal(row.detail, "");
  }
  assert.equal(summarizeActivity([tool("skill", "eve:load-skill")], false)[0].label, "Styling guidance reviewed");
});

test("retry is an explicit new request, and a failed mutation asks to inspect state before trying again", () => {
  assert.equal(activityRetry([tool("ok")]), null);
  const read = activityRetry([tool("read", "get_wardrobe", "output-error")]);
  assert.equal(read.label, "Ask to retry");
  assert.match(read.message, /retry the checks/);
  const write = activityRetry([tool("write", "start_renders", "output-error")]);
  assert.equal(write.label, "Check what happened");
  assert.match(write.message, /check what completed before trying again/);
  assert.match(write.message, /approval/);
});

test("credit quotes remain estimates rather than permanent pending approvals", () => {
  const quote = summarizeActivity(
    [tool("quote", "quote_renders", "output-available", { output: { credits: 3, blockers: [] } })],
    false,
  )[0];
  assert.equal(quote.detail, "3 credits · Estimate only");
  assert.doesNotMatch(quote.detail, /Awaiting|approved|spent/);
});

test("group status preserves pending answers and mixed cancellations instead of claiming Done", () => {
  const pending = tool("approval", "quote_renders", "approval-requested");
  const rows = summarizeActivity([pending, tool("finished", "get_context")], false);
  assert.equal(rows[0].state, "waiting");
  assert.equal(activityGroupState(rows.map((row) => row.state)), "waiting");
  assert.equal(activityGroupState(["done", "cancelled"]), "cancelled");
  assert.equal(activityGroupState(["done", "paused"]), "paused");
  assert.equal(activityGroupState(["done", "done"]), "done");
  assert.equal(activityGroupState(["waiting", "error"]), "error");
  assert.equal(activityGroupState(["waiting", "running"]), "running");
  assert.equal(activityGroupState([]), "paused");
  const grouped = groupActivityParts(projected(pending, tool("finished", "get_context")));
  assert.equal(grouped[0].kind, "part", "pending approval tools continue to use their interactive cards");
});

test("mobile Return and IME confirmation never accidentally send, while keyboard shortcuts do", () => {
  const key = { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false };
  assert.equal(shouldSubmitComposer(key, false), true);
  assert.equal(shouldSubmitComposer(key, true), false);
  assert.equal(shouldSubmitComposer({ ...key, ctrlKey: true }, true), true);
  assert.equal(shouldSubmitComposer({ ...key, metaKey: true }, true), true);
  for (const changes of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { key: "a" }]) {
    assert.equal(shouldSubmitComposer({ ...key, ...changes }, false), false);
    assert.equal(shouldSubmitComposer({ ...key, ...changes }, true), false);
  }
});
