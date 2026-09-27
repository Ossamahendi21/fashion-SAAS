import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { getFunctionName } from "convex/server";
import OpenAI from "openai";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./manager" && context.parentURL?.endsWith("/convex/workflows/render.ts")) {
      const source = "export const workflow = {define: () => ({handler: fn => ({_handler: fn})})};";
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      for (const extension of [".ts", ".js"]) {
        const candidate = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
});

// Actual action, workflow body, completion callback, mutations and ledger; only external HTTP,
// durable scheduling and the Convex database transport are replaced with deterministic fixtures.
const { renderImage } = await import("../convex/ai/openai.ts");
const pipeline = await import("../convex/ai/pipeline.ts");
const { renderOutfits, onRenderComplete } = await import("../convex/workflows/render.ts");
const { setStep } = await import("../convex/model/jobs.ts");
const { removeRender } = await import("../convex/model/renders.ts");
const { regenerate } = await import("../convex/renders.ts");
const { removeOutfit } = await import("../convex/model/outfits.ts");
const { appError } = await import("../convex/lib/errors.ts");
const { dayKey } = await import("../convex/shared/credits.ts");

const apiError = (status) =>
  OpenAI.APIError.generate(status, { error: { message: "Image request rejected" } }, "", new Headers());

function fixture(count = 1) {
  const rows = new Map();
  let nextId = 0;
  const deletedFiles = [];
  const put = (table, id, data) => rows.set(id, { ...structuredClone(data), _id: id, $table: table });
  const tableRows = (table) => [...rows.values()].filter((row) => row.$table === table);
  put("users", "owner", {
    clerkId: "fixture-owner",
    onboardedAt: 1,
    planCredits: 0,
    packCredits: 25 - count,
    dailySpend: { dayKey: dayKey(), credits: count },
  });
  put("outfits", "outfit", { userId: "owner" });
  const renderIds = Array.from({ length: count }, (_, index) => `render-${index}`);
  put("jobs", "job", {
    userId: "owner",
    type: "render",
    status: "running",
    reservation: { plan: 0, pack: count },
    refunds: { plan: 0, pack: 0 },
    resultIds: [],
    progress: 0,
    steps: [
      { key: "reserve", status: "done" },
      ...renderIds.map((_renderId, index) => ({
        key: `render:${index}`,
        status: "pending",
      })),
      { key: "finalize", status: "pending" },
    ],
  });
  for (const id of renderIds) {
    put("renders", id, {
      userId: "owner",
      outfitId: "outfit",
      jobId: "job",
      status: "pending",
      creditsCharged: 1,
    });
  }
  const db = {
    async get(id) {
      return structuredClone(rows.get(id) ?? null);
    },
    async patch(id, patch) {
      assert.ok(rows.has(id));
      rows.set(id, { ...rows.get(id), ...structuredClone(patch) });
    },
    async delete(...args) {
      rows.delete(args.at(-1));
    },
    async insert(table, data) {
      const id = `${table}-${++nextId}`;
      put(table, id, data);
      return id;
    },
    query(table) {
      const filters = [];
      const selected = () => tableRows(table).filter((row) => filters.every(([key, value]) => row[key] === value));
      const query = {
        withIndex(_name, build) {
          const index = {
            eq(key, value) {
              filters.push([key, value]);
              return index;
            },
          };
          build(index);
          return query;
        },
        async collect() {
          return structuredClone(selected());
        },
        async first() {
          return structuredClone(selected()[0] ?? null);
        },
        async unique() {
          assert.ok(selected().length <= 1);
          return structuredClone(selected()[0] ?? null);
        },
      };
      return query;
    },
  };
  const ctx = {
    db,
    auth: {
      async getUserIdentity() {
        return { subject: "fixture-owner" };
      },
    },
    storage: {
      async delete(id) {
        deletedFiles.push(id);
      },
    },
    async runMutation(reference, args) {
      const [module, name] = getFunctionName(reference).split(":");
      assert.equal(module, "ai/pipeline");
      return pipeline[name]._handler(ctx, args);
    },
  };
  const attempt = (error, index = 0) =>
    renderImage._handler(
      {
        ...ctx,
        async runQuery() {
          throw error;
        },
      },
      { renderId: renderIds[index], jobId: "job", stepKey: `render:${index}` },
    );
  const settle = (result = { kind: "success", returnValue: null }) =>
    onRenderComplete._handler(ctx, {
      workflowId: "workflow-fixture",
      result,
      context: { jobId: "job" },
    });
  return { ctx, db, put, tableRows, deletedFiles, renderIds, attempt, settle };
}

for (const status of [400, 401, 403, 404, 422]) {
  test(`permanent HTTP ${status} settles without a thrown workflow retry`, async () => {
    const f = fixture();
    const result = await f.attempt(apiError(status));
    assert.match(result.error, new RegExp(String(status)));
    assert.equal((await f.db.get("render-0")).status, "failed");
    await f.settle();
    assert.equal((await f.db.get("job")).status, "failed");
    assert.equal((await f.db.get("owner")).packCredits, 25);
    assert.equal(f.tableRows("creditLedger").length, 1);
    await f.settle();
    assert.equal(f.tableRows("creditLedger").length, 1, "repeated completion cannot double-refund");
  });
}

for (const code of ["INVALID_INPUT", "NOT_FOUND"]) {
  test(`${code} image errors do not enter automatic retries`, async () => {
    const f = fixture();
    assert.deepEqual(await f.attempt(appError(code, "Choose a valid photo.")), { error: "Choose a valid photo." });
    assert.equal((await f.db.get("render-0")).status, "failed");
  });
}

for (const error of [apiError(408), apiError(409), apiError(429), apiError(503), new OpenAI.APIConnectionError({})]) {
  test(`transient ${error.status ?? "network"} keeps the render pending until retry exhaustion`, async () => {
    const f = fixture();
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(f.attempt(error), (caught) => caught === error);
      assert.equal((await f.db.get("render-0")).status, "pending");
      const step = (await f.db.get("job")).steps.find((step) => step.key === "render:0");
      assert.equal(step.status, "running");
      assert.equal(step.finishedAt, undefined);
      assert.equal((await f.db.get("owner")).packCredits, 24, "reservation stays held during retry");
    }
    const finalMessage = (await f.db.get("job")).steps.find((step) => step.key === "render:0").error;
    await f.settle();
    assert.equal((await f.db.get("render-0")).status, "failed");
    assert.equal((await f.db.get("job")).error, finalMessage, "the final job keeps the transient failure reason");
    assert.equal((await f.db.get("job")).steps.find((step) => step.key === "render:0").status, "failed");
    assert.equal((await f.db.get("owner")).packCredits, 25);
  });
}

test("parallel render workflow waits for remaining images and refunds only the failed one", async () => {
  const f = fixture(2);
  let finish;
  const remaining = new Promise((resolve) => (finish = resolve));
  let settled = false;
  const pending = renderOutfits
    ._handler(
      {
        runMutation: f.ctx.runMutation,
        async runAction(_reference, args, options) {
          assert.equal(options.retry, true);
          if (args.renderId === "render-0") return f.attempt(apiError(400));
          await remaining;
          await pipeline.renderDone._handler(f.ctx, {
            ...args,
            storageId: "finished-image",
            prompt: "Synthetic test prompt",
            usage: { inputTextTokens: 1, inputImageTokens: 1, outputTokens: 1 },
          });
          return null;
        },
      },
      { jobId: "job", renderIds: f.renderIds },
    )
    .then((result) => {
      settled = true;
      return result;
    });
  await nextTurn();
  assert.equal(settled, false);
  assert.equal((await f.db.get("owner")).packCredits, 23);
  finish();
  assert.deepEqual(await pending, { rendered: 1, failed: 1, skipped: 0 });
  await f.settle();
  assert.equal((await f.db.get("job")).status, "partial");
  assert.equal((await f.db.get("owner")).packCredits, 24);
  assert.equal(f.tableRows("creditLedger")[0].delta, 1);
});

test("restarting a previously failed step clears its completion timestamp", async () => {
  const f = fixture();
  await setStep(f.ctx, "job", "render:0", { status: "failed", error: "Old attempt" });
  assert.ok((await f.db.get("job")).steps[1].finishedAt);
  await setStep(f.ctx, "job", "render:0", { status: "running" });
  assert.equal((await f.db.get("job")).steps[1].finishedAt, undefined);
  assert.equal((await f.db.get("job")).steps[1].error, undefined);
});

test("render and outfit deletion cannot remove rows needed by an active job's refund", async () => {
  const f = fixture(2);
  await f.db.patch("render-0", { status: "failed" });
  await f.db.patch("render-1", { status: "done", storageId: "finished-image" });
  for (const id of f.renderIds) {
    await assert.rejects(removeRender(f.ctx, await f.db.get(id)), (error) => error.data?.code === "CONFLICT");
  }
  await assert.rejects(removeOutfit(f.ctx, await f.db.get("outfit")), (error) => error.data?.code === "CONFLICT");
  assert.equal(f.tableRows("renders").length, 2);
  assert.deepEqual(f.deletedFiles, []);
  await f.settle();
  assert.equal((await f.db.get("owner")).packCredits, 24);
  await removeOutfit(f.ctx, await f.db.get("outfit"));
  assert.equal(f.tableRows("renders").length, 0);
  assert.equal(await f.db.get("outfit"), null);
  assert.deepEqual(f.deletedFiles, ["finished-image"]);
});

test("retry cannot start a second charged job before the original job and refunds settle", async () => {
  const f = fixture();
  for (const status of ["pending", "failed", "done"]) {
    await f.db.patch("render-0", { status });
    await assert.rejects(
      regenerate._handler(f.ctx, { renderId: "render-0" }),
      (error) => error.data?.code === "CONFLICT" && error.data.message.includes("trying again"),
    );
    assert.equal(f.tableRows("jobs").length, 1);
    assert.equal(f.tableRows("renders").length, 1);
    assert.equal(f.tableRows("creditLedger").length, 0);
    assert.equal((await f.db.get("owner")).packCredits, 24);
  }
});
