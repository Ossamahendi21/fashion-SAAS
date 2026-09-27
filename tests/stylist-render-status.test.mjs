import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/format")
      return nextResolve(new URL("../src/lib/format.ts", import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
});

const { projectRenderFollowups } = await import("../src/components/stylist/render-transcript.ts");
const { renderJobStatus } = await import("../src/components/stylist/render-job-status.ts");

const text = (value) => ({ type: "text", text: value });
const assistant = (id, ...parts) => ({ id, role: "assistant", parts });
const user = (id, value) => ({ id, role: "user", parts: [text(value)] });
const tool = (name, output, state = "output-available") => ({
  type: "dynamic-tool",
  toolName: name,
  toolCallId: `${name}-${output?.jobId ?? "test"}`,
  state,
  output,
});
const launch = (id) => tool("start_renders", { jobId: id, status: "started" });

function visibleTranscript(messages, jobs) {
  return projectRenderFollowups(messages)
    .flatMap(({ parts }) =>
      parts.flatMap(({ part, renderJobIds }) => {
        if (renderJobIds)
          return renderJobIds.map((id) => {
            const status = renderJobStatus(jobs[id]);
            return `${status.title}. ${status.detail}`;
          });
        return part.type === "text" ? [part.text] : [];
      }),
    )
    .join("\n");
}

test("a persisted launch reply changes from progress to Done without rewriting history or running the agent", () => {
  const messages = [
    user("u1", "Try on the navy outfit"),
    assistant("a1", text("One image costs 1 credit."), launch("job-1")),
    assistant("a2", text("It's running — the image will appear above.")),
  ];
  const original = structuredClone(messages);
  const running = visibleTranscript(messages, { "job-1": { status: "running", resultIds: [] } });
  assert.match(running, /Creating your try-on/);
  const done = visibleTranscript(messages, { "job-1": { status: "done", resultIds: ["image-1"] } });
  assert.match(done, /Done\. 1 image ready\./);
  assert.doesNotMatch(done, /running|will appear|Creating/);
  assert.match(done, /One image costs 1 credit/);
  assert.deepEqual(messages, original, "replay and persisted conversation remain untouched");
});

test("streamed text parts show one live notice and never retain a stale fragment", () => {
  const messages = [assistant("a1", launch("job-1"), text("It's running"), text(" — just a moment."))];
  const result = visibleTranscript(messages, { "job-1": { status: "done", resultIds: ["r1", "r2"] } });
  assert.equal(result, "Done. 2 images ready.");
});

test("two launched jobs remain independently truthful when only one is done", () => {
  const messages = [assistant("a1", launch("job-1"), launch("job-2"), text("Both running."))];
  const output = visibleTranscript(messages, {
    "job-1": { status: "done", resultIds: ["r1"] },
    "job-2": { status: "running", resultIds: [] },
  });
  assert.match(output, /Done\. 1 image ready/);
  assert.match(output, /Creating your try-on/);
  assert.doesNotMatch(output, /Both running/);
});

test("a different tool, failed launch, approval, or user turn preserves its own prose", () => {
  const messages = [
    assistant("a1", launch("job-1"), text("It's running.")),
    assistant("a2", tool("save_outfit", { saved: true }), text("Saved your outfit.")),
    user("u2", "Why these colours?"),
    assistant("a3", text("Navy and white keep it simple.")),
    assistant("a4", tool("start_renders", undefined, "output-error"), text("The request failed.")),
    assistant("a5", tool("start_renders", undefined, "approval-requested"), text("Please approve 1 credit.")),
  ];
  const result = visibleTranscript(messages, { "job-1": { status: "done", resultIds: ["r1"] } });
  for (const phrase of [
    "Saved your outfit.",
    "Why these colours?",
    "Navy and white keep it simple.",
    "The request failed.",
    "Please approve 1 credit.",
  ]) {
    assert.ok(result.includes(phrase), phrase);
  }
  assert.doesNotMatch(result, /It's running/);
});

test("malformed tool output never suppresses a reply or creates a job subscription", () => {
  for (const output of [null, {}, { jobId: " " }, { jobId: 42 }]) {
    const messages = [assistant("a1", tool("start_renders", output), text("No job was created."))];
    assert.equal(visibleTranscript(messages, {}), "No job was created.");
  }
});

test("all terminal outcomes stop running copy and partial failures cannot announce success", () => {
  const states = [
    ["done", ["r1"], "Done", "1 image ready."],
    ["partial", ["r1"], "Partly complete", "Some images could not be created."],
    ["failed", [], "Try-on failed", "The job could not finish."],
    ["failed", ["r1"], "Try-on failed", "1 image ready."],
    ["cancelled", [], "Cancelled", "This try-on was cancelled."],
    ["cancelled", ["r1"], "Cancelled", "The remaining images were cancelled."],
  ];
  for (const [status, resultIds, title, detail] of states) {
    const view = renderJobStatus({ status, resultIds });
    assert.equal(view.title, title);
    assert.equal(view.running, false);
    assert.ok(view.detail.includes(detail));
    assert.doesNotMatch(view.detail, /still being|will appear|will start/);
  }
});
