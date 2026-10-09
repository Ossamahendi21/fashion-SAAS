// Render provider seam: deterministic local composition only, fail-closed selection, and honest
// $0 settlement. No network calls anywhere in this file.
// No network calls anywhere in this file.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
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

globalThis.Convex = {
  async asyncSyscall(operation, args) {
    assert.equal(operation, "1.0/createFunctionHandle");
    return JSON.stringify(`handle:${JSON.parse(args).name}`);
  },
};

const { renderOutfitImage, renderProvider } = await import("../convex/ai/rendering.ts");
const { markRenderDone, renderFailureMessage } = await import("../convex/model/renders.ts");
const { renderDone } = await import("../convex/ai/pipeline.ts");
const { usageToUsd } = await import("../convex/shared/credits.ts");

const SOME_USAGE = { inputTextTokens: 1000, inputImageTokens: 8000, outputTokens: 4000 };

const request = () => ({
  person: { bytes: new Uint8Array([1, 2, 3]), name: "person" },
  garments: [{ bytes: new Uint8Array([4, 5]), name: "garment-1", slot: "top" }],
  prompt: "Dress the person.",
  quality: "standard",
});

function dbFixture() {
  const rows = new Map();
  const put = (table, id, data) => rows.set(id, { ...structuredClone(data), _id: id, $table: table });
  const tableRows = (table) => [...rows.values()].filter((row) => row.$table === table);
  const db = {
    async get(id) {
      return structuredClone(rows.get(id) ?? null);
    },
    async patch(id, fields) {
      assert.ok(rows.has(id));
      rows.set(id, { ...rows.get(id), ...structuredClone(fields) });
    },
    async insert(table, fields) {
      const id = `${table}-${rows.size}`;
      put(table, id, fields);
      return id;
    },
    async delete(_table, id) {
      rows.delete(id);
    },
    query(table) {
      const filters = [];
      const selected = () => tableRows(table).filter((row) => filters.every(([field, value]) => row[field] === value));
      const query = {
        withIndex(_name, build) {
          const index = {
            eq(field, value) {
              filters.push([field, value]);
              return index;
            },
          };
          build(index);
          return query;
        },
        async unique() {
          assert.ok(selected().length <= 1);
          return structuredClone(selected()[0] ?? null);
        },
        async collect() {
          return structuredClone(selected());
        },
        async take(limit) {
          return structuredClone(selected().slice(0, limit));
        },
      };
      return query;
    },
  };
  const ctx = { db };
  put("renders", "render1", { userId: "owner", status: "pending" });
  put("jobs", "job1", {
    userId: "owner",
    status: "running",
    steps: [
      { key: "render:0", status: "running", meta: { renderId: "render1" } },
      { key: "finalize", status: "pending" },
    ],
    resultIds: [],
    reservation: { plan: 0, pack: 0 },
    refunds: { plan: 0, pack: 0 },
  });
  return { ctx, db, tableRows };
}

test("render provider defaults to the zero-cost deterministic composer", () => {
  assert.equal(renderProvider({}), "composite");
});

test("only the local compositor is allowed", () => {
  assert.equal(renderProvider({ RENDER_PROVIDER: "composite" }), "composite");
  assert.throws(() => renderProvider({ RENDER_PROVIDER: "openai" }), /not supported/);
});

test("an unknown RENDER_PROVIDER fails closed with a clear message", () => {
  assert.throws(() => renderProvider({ RENDER_PROVIDER: "ideogram" }), /not supported/);
  assert.throws(() => renderProvider({ RENDER_PROVIDER: "" }), /not supported/);
});

test("render failures never expose provider configuration details to the UI", () => {
  assert.equal(
    renderFailureMessage("Missing environment variable AI_GATEWAY_API_KEY."),
    "This try-on couldn't be completed. Please try again.",
  );
  assert.equal(renderFailureMessage(undefined), undefined);
});

test("default dispatch invokes the composite runner exactly once", async () => {
  const calls = [];
  const runners = {
    composite: async (seen) => {
      calls.push(seen);
      return { bytes: new Uint8Array([9]), costUsd: 0, latencyMs: 11 };
    },
  };
  const input = request();
  const result = await renderOutfitImage(input, runners, {});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], input);
  assert.equal(result.provider, "composite");
  assert.equal(result.usage, undefined);
  assert.equal(result.costUsd, 0);
  assert.equal(result.latencyMs, 11);
});

test("a composite runner failure propagates unchanged", async () => {
  const sentinel = new Error("gateway down");
  const runners = {
    composite: async () => {
      throw sentinel;
    },
  };
  await assert.rejects(
    () => renderOutfitImage(request(), runners, {}),
    (error) => error === sentinel,
  );
});

test("markRenderDone with OpenAI usage records usage and token-derived COGS", async () => {
  const f = dbFixture();
  await markRenderDone(f.ctx, "render1", { storageId: "blob", usage: SOME_USAGE });
  const render = await f.db.get("render1");
  assert.equal(render.status, "done");
  assert.deepEqual(render.usage, SOME_USAGE);
  assert.equal(render.costUsd, usageToUsd(SOME_USAGE));
  const stats = f.tableRows("dailyStats")[0];
  assert.equal(stats.rendersDone, 1);
  assert.equal(stats.cogsUsd, usageToUsd(SOME_USAGE));
});

test("markRenderDone with usage absent and costUsd 0 records $0 without fabricating usage", async () => {
  const f = dbFixture();
  await markRenderDone(f.ctx, "render1", { storageId: "blob", costUsd: 0 });
  const render = await f.db.get("render1");
  assert.equal(render.status, "done");
  assert.equal(render.usage, undefined);
  assert.equal(render.costUsd, 0);
  const stats = f.tableRows("dailyStats")[0];
  assert.equal(stats.rendersDone, 1);
  assert.equal(stats.cogsUsd, 0);
});

test("markRenderDone with usage absent and a positive explicit cost records it verbatim", async () => {
  const f = dbFixture();
  await markRenderDone(f.ctx, "render1", { storageId: "blob", costUsd: 0.05 });
  const render = await f.db.get("render1");
  assert.equal(render.status, "done");
  assert.equal(render.usage, undefined);
  assert.equal(render.costUsd, 0.05);
  assert.equal(f.tableRows("dailyStats")[0].cogsUsd, 0.05);
});

test("markRenderDone with usage absent and costUsd absent fails closed", async () => {
  const f = dbFixture();
  await assert.rejects(markRenderDone(f.ctx, "render1", { storageId: "blob" }), (error) =>
    /usage or an explicit costUsd/.test(error.message),
  );
  const render = await f.db.get("render1");
  assert.equal(render.status, "pending", "the invalid case must not mark the render done");
  assert.equal(render.usage, undefined);
  assert.equal(render.costUsd, undefined);
  assert.equal(f.tableRows("dailyStats").length, 0, "no COGS or completion may be recorded");
});

test("renderDone settles a usage-absent $0 result with zero step cost", async () => {
  const f = dbFixture();
  await renderDone._handler(f.ctx, {
    renderId: "render1",
    jobId: "job1",
    stepKey: "render:0",
    storageId: "blob",
    prompt: "p",
    costUsd: 0,
  });
  const render = await f.db.get("render1");
  assert.equal(render.status, "done");
  assert.equal(render.usage, undefined);
  assert.equal(render.costUsd, 0);
  const job = await f.db.get("job1");
  assert.equal(job.steps.find((step) => step.key === "render:0").status, "done");
  assert.equal(job.steps.find((step) => step.key === "render:0").meta.costUsd, 0);
  assert.deepEqual(job.resultIds, ["render1"]);
});

test("renderDone with OpenAI usage keeps the existing usage-to-COGS accounting", async () => {
  const f = dbFixture();
  await renderDone._handler(f.ctx, {
    renderId: "render1",
    jobId: "job1",
    stepKey: "render:0",
    storageId: "blob",
    prompt: "p",
    usage: SOME_USAGE,
  });
  const render = await f.db.get("render1");
  assert.deepEqual(render.usage, SOME_USAGE);
  assert.equal(render.costUsd, usageToUsd(SOME_USAGE));
  const job = await f.db.get("job1");
  assert.equal(job.steps.find((step) => step.key === "render:0").meta.costUsd, usageToUsd(SOME_USAGE));
});
