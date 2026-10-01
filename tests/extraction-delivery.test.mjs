// Delivery wiring of the extraction seam: the dispatcher routes on EXTRACTION_PROVIDER and locks
// the 1024×1024 contract, provider failures never fail over, itemReady/markItemReady record honest
// COGS with or without SDK token usage, and the server-only env keys never reach the client.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const { ExtractionError, extractGarmentCutout } = await import("../convex/ai/extraction.ts");
const { itemReady } = await import("../convex/ai/pipeline.ts");
const { SERVER_ENV_KEYS } = await import("../convex/lib/env.ts");
const { usageToUsd } = await import("../convex/shared/credits.ts");

const sharp = (await import("sharp")).default;
const pngBytes = async ({ width = 64, height = 64, rgba = true } = {}) =>
  sharp({ create: { width, height, channels: rgba ? 4 : 3, background: rgba ? { r: 30, g: 60, b: 90, alpha: 1 } : { r: 30, g: 60, b: 90 } } })
    .png()
    .toBuffer();

const toU8 = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

const SOME_USAGE = { inputTextTokens: 1000, inputImageTokens: 8000, outputTokens: 4000 };

function dbFixture() {
  let rows = new Map();
  let nextId = 0;
  const put = (table, id, data) =>
    rows.set(id, { ...structuredClone(data), _id: id, _creationTime: nextId++, $table: table });
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
      const id = `${table}-${nextId++}`;
      put(table, id, fields);
      return id;
    },
    async delete(_table, id) {
      rows.delete(id);
    },
    query(table) {
      const filters = [];
      const selected = () =>
        tableRows(table).filter((row) => filters.every(([field, value]) => row[field] === value));
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
  const ctx = {
    db,
    storage: {
      async delete() {},
    },
    async runMutation() {
      throw new Error("itemReady must not schedule anything");
    },
    async runQuery() {
      throw new Error("itemReady must not query anywhere");
    },
  };
  const seedItem = (overrides = {}) =>
    put("items", "item1", {
      userId: "owner",
      name: "Denim Jacket",
      status: "extracting",
      storageId: "old-cutout",
      colours: { primary: "blue", secondary: [], hex: ["#123456"] },
      costUsd: 0,
      ...overrides,
    });
  const seedJob = () =>
    put("jobs", "job1", {
      userId: "owner",
      type: "ingest",
      status: "running",
      reservation: { plan: 0, pack: 0 },
      refunds: { plan: 0, pack: 0 },
      resultIds: [],
      progress: 0,
      createdAt: 1,
      updatedAt: 1,
      steps: [{ key: "extract:0", status: "running", startedAt: 1, label: "Extracting" }],
    });
  return { ctx, db, put, tableRows, seedItem, seedJob };
}

test("extractGarmentCutout routes EXTRACTION_PROVIDER=openai to the openai runner and keeps its usage", async () => {
  const called = [];
  const runners = {
    openai: async (request) => {
      called.push("openai");
      assert.ok(request.imageBytes.length > 0);
      return { bytes: toU8(await pngBytes({ width: 1024, height: 1024 })), usage: SOME_USAGE, background: "transparent", costUsd: usageToUsd(SOME_USAGE), latencyMs: 10 };
    },
    withoutbg: async () => {
      called.push("withoutbg");
      throw new Error("should not run");
    },
  };
  const result = await extractGarmentCutout({ imageBytes: toU8(await pngBytes()), imageName: "photo", prompt: "p" }, runners, {
    EXTRACTION_PROVIDER: "openai",
  });
  assert.deepEqual(called, ["openai"]);
  assert.equal(result.provider, "openai");
  assert.deepEqual(result.usage, SOME_USAGE);
  assert.equal(result.costUsd, usageToUsd(SOME_USAGE));
  assert.equal(result.width, 1024);
  assert.equal(result.height, 1024);
});

test("extractGarmentCutout routes EXTRACTION_PROVIDER=withoutbg to the withoutbg runner, normalizes to 1024×1024, and reports no usage", async () => {
  const called = [];
  const runners = {
    openai: async () => {
      called.push("openai");
      throw new Error("should not run");
    },
    withoutbg: async () => {
      called.push("withoutbg");
      return { bytes: toU8(await pngBytes({ width: 300, height: 200 })), background: "transparent", costUsd: 0.002, latencyMs: 9 };
    },
  };
  const result = await extractGarmentCutout({ imageBytes: toU8(await pngBytes()), imageName: "photo", prompt: "p" }, runners, {
    EXTRACTION_PROVIDER: "withoutbg",
  });
  assert.deepEqual(called, ["withoutbg"]);
  assert.equal(result.provider, "withoutbg");
  assert.equal("usage" in result, false);
  assert.equal(result.costUsd, 0.002);
  assert.equal(result.width, 1024, "the cutout contract is enforced for every provider");
  assert.equal(result.height, 1024);
});

test("a withoutBG failure never fails over to OpenAI", async () => {
  const transient = new ExtractionError("transient", "The withoutBG gateway failed (HTTP 502).", 502);
  const request = { imageBytes: toU8(await pngBytes()), imageName: "photo", prompt: "p" };
  let openaiCalled = false;
  const runners = {
    openai: async () => {
      openaiCalled = true;
      throw new Error("no failover allowed");
    },
    withoutbg: async () => {
      throw transient;
    },
  };
  await assert.rejects(
    () => extractGarmentCutout(request, runners, { EXTRACTION_PROVIDER: "withoutbg" }),
    (error) => error === transient,
  );
  assert.equal(openaiCalled, false);
});

test("itemReady with a provider cost (withoutbg) records COGS without faking token usage", async () => {
  const f = dbFixture();
  f.seedItem();
  f.seedJob();
  await itemReady._handler(f.ctx, {
    itemId: "item1",
    jobId: "job1",
    stepKey: "extract:0",
    storageId: "cutout-new",
    hex: ["#123456", "#8899aa"],
    costUsd: 0.002,
    embedding: [0.1, 0.2, 0.3],
    duplicateOfId: undefined,
  });
  const item = await f.db.get("item1");
  assert.equal(item.storageId, "cutout-new");
  assert.equal(item.status, "ready");
  assert.equal(item.usage, undefined);
  assert.equal(item.costUsd, 0.002);
  const stats = f.tableRows("dailyStats")[0];
  assert.equal(stats.itemsExtracted, 1);
  assert.equal(stats.cogsUsd, 0.002);
  const job = await f.db.get("job1");
  assert.equal(job.steps[0].meta.itemId, "item1");
  assert.equal(job.steps[0].meta.costUsd, 0.002);
  assert.equal(f.tableRows("creditLedger").length, 0, "extraction settlement never touches the credit ledger");
});

test("itemReady with token usage (the openai default) keeps the existing usage-to-COGS accounting", async () => {
  const f = dbFixture();
  f.seedItem();
  f.seedJob();
  await itemReady._handler(f.ctx, {
    itemId: "item1",
    jobId: "job1",
    stepKey: "extract:0",
    storageId: "cutout-new",
    hex: ["#123456"],
    usage: SOME_USAGE,
    embedding: [0.1, 0.2, 0.3],
    duplicateOfId: undefined,
  });
  const expected = usageToUsd(SOME_USAGE);
  const item = await f.db.get("item1");
  assert.deepEqual(item.usage, SOME_USAGE);
  assert.equal(item.costUsd, expected);
  assert.equal(f.tableRows("dailyStats")[0].cogsUsd, expected);
  assert.equal((await f.db.get("job1")).steps[0].meta.costUsd, expected);
});

test("the extraction env keys are typed server env keys", () => {
  for (const key of ["EXTRACTION_PROVIDER", "WITHOUTBG_BASE_URL", "WITHOUTBG_API_KEY", "WITHOUTBG_COST_USD_PER_IMAGE"]) {
    assert.ok(SERVER_ENV_KEYS.includes(key), `${key} must be a typed ServerEnvKey`);
  }
});

test("WITHOUTBG_* secrets never reach the client bundle", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = readFileSync(full, "utf8");
        for (const needle of ["WITHOUTBG_API_KEY", "WITHOUTBG_BASE_URL", "NEXT_PUBLIC_EXTRACTION_PROVIDER"]) {
          if (text.includes(needle)) offenders.push(`${full}: ${needle}`);
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], "client code must never reference the withoutBG secret or its env");
});

test("the extraction seam lives inside the single extractItem action; workflows never pick a provider", () => {
  const openai = readFileSync(fileURLToPath(new URL("../convex/ai/openai.ts", import.meta.url)), "utf8");
  assert.ok(openai.includes(`from "./extraction"`), "openai.ts must consume the seam");
  const ingest = readFileSync(fileURLToPath(new URL("../convex/workflows/ingest.ts", import.meta.url)), "utf8");
  assert.ok(ingest.includes("internal.ai.openai.extractItem"), "the workflow must still call the single extraction entry");
});