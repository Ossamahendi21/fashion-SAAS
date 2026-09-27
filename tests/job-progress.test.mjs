import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@convex/shared/jobs")
      return nextResolve(new URL("../convex/shared/jobs.ts", import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
});
const { jobProgress, pendingRenderProgress, typicalDuration, uploadPercent } =
  await import("../src/components/common/job-progress.ts");

const step = (key, status, extra = {}) => ({ key, label: key, status, ...extra });
const job = (status, steps) => ({ status, steps, progress: 0.63 });
const renders = (...statuses) => statuses.map((status, index) => step(`render:${index}`, status));

test("queued work has no fabricated percentage or halfway-complete images", () => {
  const view = jobProgress(job("queued", [step("reserve", "pending"), ...renders("pending", "pending")]));
  assert.equal(view.title, "Queued");
  assert.equal(view.ready, 0);
  assert.equal(view.pending, 2);
  assert.equal(view.countLabel, "0 of 2 ready");
  assert.equal("percent" in view, false);
});

test("parallel images are counted by real outcomes rather than running-step weights", () => {
  const view = jobProgress(
    job("running", [step("reserve", "done"), ...renders("done", "running", "failed"), step("finalize", "pending")]),
  );
  assert.equal(view.title, "Creating your try-ons");
  assert.equal(view.countLabel, "1 of 3 ready · 1 failed");
  assert.deepEqual([view.ready, view.pending, view.failed, view.total], [1, 1, 1, 3]);
  assert.equal(view.phases.find((phase) => phase.key === "render").status, "running");
});

test("settled failed images show finalizing until the workflow settles refunds", () => {
  const view = jobProgress(
    job("running", [step("reserve", "done"), ...renders("failed", "failed", "failed"), step("finalize", "pending")]),
  );
  assert.equal(view.title, "Finishing up");
  assert.equal(view.terminal, false);
  assert.equal(view.phases.find((phase) => phase.key === "render").status, "failed");
  assert.equal(view.countLabel, "0 of 3 ready · 3 failed");
});

test("partial groups retain failed and skipped counts without a success checkmark", () => {
  const view = jobProgress(
    job("partial", [step("extract:0", "done"), step("extract:1", "failed"), step("extract:2", "skipped")]),
  );
  assert.equal(view.title, "Finished with some issues");
  assert.equal(view.countLabel, "1 of 3 ready · 1 failed · 1 skipped");
  assert.equal(view.phases[0].status, "partial");
  assert.equal(view.terminal, true);
});

test("failed or cancelled historical jobs never show stale running spinners", () => {
  for (const status of ["failed", "cancelled"]) {
    const view = jobProgress(
      job(status, [step("reserve", "done"), ...renders("running"), step("finalize", "pending")]),
    );
    assert.ok(view.phases.every((phase) => !["running", "pending"].includes(phase.status)));
    assert.equal(view.terminal, true);
  }
});

test("completed scans invite selection while completed renders say complete", () => {
  assert.equal(
    jobProgress(job("done", [step("detect", "done"), step("review", "done")])).title,
    "Ready to choose pieces",
  );
  assert.equal(jobProgress(job("done", [...renders("done", "done"), step("finalize", "done")])).title, "Complete");
});

test("dynamic steps appended after finalization appear in their real execution order", () => {
  const view = jobProgress(
    job("running", [step("reserve", "done"), step("finalize", "pending"), ...renders("running", "pending")]),
  );
  assert.deepEqual(
    view.phases.map((phase) => phase.key),
    ["reserve", "render", "finalize"],
  );
});

test("transient errors explicitly communicate an automatic retry", () => {
  const view = jobProgress(job("running", [step("render:0", "running", { error: "Temporary timeout" })]));
  assert.equal(view.title, "Retrying automatically");
  assert.equal(view.retrying, true);
  assert.equal(view.failed, 0);
  assert.equal(view.pending, 1);
});

test("historical duration guidance is rounded and missing or invalid samples do not make promises", () => {
  for (const invalid of [undefined, 0, -1, NaN, Infinity]) assert.equal(typicalDuration(invalid), null);
  assert.equal(typicalDuration(1), "about 15 sec");
  assert.equal(typicalDuration(49_345), "about 45 sec");
  assert.equal(typicalDuration(120_900), "about 2 min");
});

test("actual upload bytes cannot report completion before all bytes arrive", () => {
  assert.equal(uploadPercent(0.99999), 99);
  assert.equal(uploadPercent(1), 100);
  assert.equal(uploadPercent(2), 100);
  assert.equal(uploadPercent(-0.5), 0);
  assert.equal(uploadPercent(NaN), 0);
  assert.equal(uploadPercent(Infinity), 0);
  assert.equal(uploadPercent(0.452), 45);
});

test("a pending tile distinguishes its queued image from another image that is running", () => {
  const state = job("running", [
    step("render:0", "running", { meta: { renderId: "first" }, startedAt: 1000 }),
    step("render:1", "pending", { meta: { renderId: "second" } }),
  ]);
  assert.equal(pendingRenderProgress(state, "second").title, "Your try-on is queued");
  assert.equal(pendingRenderProgress(state, "second").running, false);
  assert.equal(pendingRenderProgress(state, "first").title, "Creating your try-on");
  assert.equal(pendingRenderProgress(state, "first").startedAt, 1000);
});

test("retry tile uses the attempt start time and unavailable data never claims active rendering", () => {
  const state = job("running", [
    step("render:0", "running", { meta: { renderId: "first" }, startedAt: 4000, error: "Temporary timeout" }),
  ]);
  assert.equal(pendingRenderProgress(state, "first").title, "Retrying your try-on");
  assert.equal(pendingRenderProgress(state, "first").startedAt, 4000);
  assert.equal(pendingRenderProgress(undefined, "first").running, false);
  assert.equal(pendingRenderProgress(job("queued", []), "first").title, "Your try-on is queued");
});

test("terminal job authority stops a stale pending render tile from spinning", () => {
  for (const status of ["done", "partial", "failed", "cancelled"]) {
    const state = job(status, [step("render:0", "running", { meta: { renderId: "first" }, startedAt: 4000 })]);
    const view = pendingRenderProgress(state, "first");
    assert.equal(view.running, false);
    assert.equal(view.settled, true);
    assert.equal(view.startedAt, undefined);
  }
});

test("a partly processed batch waiting for the next chunk does not claim it has never started", () => {
  const view = jobProgress(job("running", [step("extract:0", "done"), step("extract:1", "pending")]));
  assert.equal(view.title, "Waiting for remaining pieces");
  assert.equal(view.countLabel, "1 of 2 ready");
  assert.equal(jobProgress(job("running", renders("done", "pending"))).title, "Waiting for remaining images");
});

test("an empty completed scan does not invite selection of nonexistent pieces", () => {
  const view = jobProgress(job("done", [step("detect", "done", { meta: { found: 0 } }), step("review", "skipped")]));
  assert.equal(view.title, "No clothing found");
});

test("a retry in any parallel image is visible even when the first image is healthy", () => {
  const view = jobProgress(
    job("running", [step("render:0", "running"), step("render:1", "running", { error: "Temporary timeout" })]),
  );
  assert.equal(view.retrying, true);
  assert.equal(view.title, "Retrying automatically");
  assert.equal(view.failed, 0);
});
