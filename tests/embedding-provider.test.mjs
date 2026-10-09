import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

const seam = await import("../convex/ai/embedding.ts");
const sharedText = await import("../convex/shared/embeddingText.ts");
const benchText = await import("../bench/embeddings/embedding-text.mjs");
const credits = await import("../convex/shared/credits.ts");
const adviceModel = await import("../convex/model/shoppingAdvice.ts");
const shopping = await import("../convex/shoppingAdvice.ts");
const backfill = await import("../convex/embeddingBackfill.ts");

const readSource = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const corpus = JSON.parse(readSource("../bench/embeddings/corpus.json"));
const unit384 = () => {
  const vector = new Array(384).fill(0);
  vector[0] = 1;
  return vector;
};
const fakeTransport =
  (status, payload = {}) =>
  async () => ({ status, json: async () => payload });
const fakeQueryCtx = (row) => ({
  db: {
    query: () => ({
      withIndex: () => ({
        unique: async () => row,
      }),
    }),
  },
});

test("all 16 frozen strings are byte-identical through the shared production builder", () => {
  assert.equal(benchText.DEMO_WARDROBE.length, 16);
  assert.equal(corpus.items.length, 16);
  for (const [index, entry] of benchText.DEMO_WARDROBE.entries()) {
    const production = sharedText.embeddingText(entry.attributes);
    assert.equal(production, benchText.embeddingText(entry.attributes));
    assert.equal(corpus.items[index].embeddingText, production);
  }
  assert.deepEqual(sharedText.EMBEDDING_FIELD_ORDER, [
    "name",
    "category",
    "subcategory",
    "colours.primary",
    "colours.secondary[]",
    "colours.hex[]",
    "pattern",
    "material",
    "description",
  ]);
  assert.equal(sharedText.EMBEDDING_SEPARATOR, " · ");
});

test("the provider seam fails closed with no implicit provider", () => {
  for (const env of [{}, { EMBEDDING_PROVIDER: "" }, { EMBEDDING_PROVIDER: "fallback" }]) {
    assert.throws(
      () => seam.embeddingProvider(env),
      (error) => error instanceof seam.EmbeddingError,
    );
  }
  assert.equal(seam.embeddingProvider({ EMBEDDING_PROVIDER: "local" }), "local");
  assert.equal(seam.embeddingProvider({ EMBEDDING_PROVIDER: "openai" }), "openai");
});

test("the read generation defaults to legacy and fails closed on anything else", () => {
  assert.equal(adviceModel.embeddingReadGeneration({}), "legacy");
  assert.equal(adviceModel.embeddingReadGeneration({ EMBEDDING_READ_GENERATION: "" }), "legacy");
  assert.equal(adviceModel.embeddingReadGeneration({ EMBEDDING_READ_GENERATION: "legacy" }), "legacy");
  assert.equal(adviceModel.embeddingReadGeneration({ EMBEDDING_READ_GENERATION: "bge" }), "bge");
  assert.throws(() => adviceModel.embeddingReadGeneration({ EMBEDDING_READ_GENERATION: "by_embeddingBge" }));
  assert.throws(() => adviceModel.embeddingReadGeneration({ EMBEDDING_READ_GENERATION: "OPENAI" }));
});

test("each read generation maps to a static field, index, pool, rerank flag and threshold", () => {
  assert.deepEqual(adviceModel.readGenerationConfig("legacy"), {
    vectorField: "embedding",
    indexName: "by_embedding",
    searchLimit: adviceModel.LEGACY_VECTOR_SEARCH_LIMIT,
    rerank: false,
    proseThreshold: credits.LIMITS.duplicateCosineThreshold,
    generationToken: "openai-1536-v1",
  });
  assert.equal(adviceModel.LEGACY_VECTOR_SEARCH_LIMIT, 8);
  assert.deepEqual(adviceModel.readGenerationConfig("bge"), {
    vectorField: "embeddingBge",
    indexName: "by_embeddingBge",
    searchLimit: adviceModel.VECTOR_SEARCH_LIMIT,
    rerank: true,
    proseThreshold: credits.LIMITS.strongSimilarityThreshold,
    generationToken: "bge-v1",
  });
});

test("local configuration fails closed without naming or exposing either secret", () => {
  assert.throws(
    () => seam.localEmbeddingConfig({ EMBEDDING_API_KEY: "k" }),
    (error) => error instanceof seam.EmbeddingError && error.message.includes("EMBEDDING_BASE_URL"),
  );
  assert.throws(
    () => seam.localEmbeddingConfig({ EMBEDDING_BASE_URL: "https://bge.invalid" }),
    (error) => error instanceof seam.EmbeddingError && error.message.includes("EMBEDDING_API_KEY"),
  );
});

test("a successful local embedding costs exactly $0 and returns a validated 384-d vector", async () => {
  const result = await seam.localEmbed(
    { text: "x" },
    { baseUrl: "https://bge.invalid", apiKey: "k", timeoutMs: 1000 },
    fakeTransport(200, { vector: unit384() }),
  );
  assert.equal(result.costUsd, 0);
  assert.equal(result.vector.length, 384);
});

test("a busy gateway is rate-limited and retryable; a failed gateway is transient and retryable", async () => {
  const config = { baseUrl: "https://bge.invalid", apiKey: "k", timeoutMs: 1000 };
  await assert.rejects(
    seam.localEmbed({ text: "x" }, config, fakeTransport(503, {})),
    (error) => error.kind === "rate-limited" && error.retryable === true,
  );
  await assert.rejects(
    seam.localEmbed({ text: "x" }, config, fakeTransport(500, {})),
    (error) => error.kind === "transient" && error.retryable === true,
  );
  await assert.rejects(
    seam.localEmbed({ text: "x" }, config, fakeTransport(401, {})),
    (error) => error.kind === "auth-config" && error.retryable === false,
  );
});

test("a local failure never invokes the OpenAI runner", async () => {
  let openaiCalled = false;
  await assert.rejects(
    seam.embedText(
      { text: "x" },
      {
        openai: async () => {
          openaiCalled = true;
          throw new Error("fallback must not run");
        },
        local: async () => {
          throw new seam.EmbeddingError("local", "transient", "gateway down");
        },
      },
      { EMBEDDING_PROVIDER: "local" },
    ),
    (error) => error instanceof seam.EmbeddingError && error.provider === "local",
  );
  assert.equal(openaiCalled, false);
});

test("an unsupported provider fails before either runner is consulted", async () => {
  const calls = [];
  await assert.rejects(
    seam.embedText(
      { text: "x" },
      {
        openai: async () => {
          calls.push("openai");
          return { vector: [], costUsd: 0, latencyMs: 0 };
        },
        local: async () => {
          calls.push("local");
          return { vector: [], costUsd: 0, latencyMs: 0 };
        },
      },
      { EMBEDDING_PROVIDER: "fallback" },
    ),
  );
  assert.deepEqual(calls, []);
});

test("dimensions are static facts: local rejects OpenAI width, OpenAI keeps 1536-d", () => {
  assert.equal(seam.EMBEDDING_MODELS.local.dimensions, 384);
  assert.equal(seam.EMBEDDING_MODELS.openai.dimensions, 1536);
  assert.throws(() => seam.validateEmbeddingVector("local", new Array(1536).fill(0)), /exactly 384/);
  const legacy = new Array(1536).fill(0);
  legacy[0] = 1;
  assert.equal(seam.validateEmbeddingVector("openai", legacy).length, 1536);
  assert.throws(
    () =>
      seam.validateEmbeddingVector(
        "local",
        unit384().map(() => 0.1),
      ),
    /L2 norm/,
  );
  // Audited: there is NO correct embedding price in usageToUsd (its textIn rate is the image-model
  // table; text-embedding-3-small lists at $0.02/M), so the legacy branch stays explicitly unpriced
  // exactly as before Phase C — and the final production path is local/$0 regardless.
  const openaiSource = readSource("../convex/ai/openai.ts");
  assert.ok(openaiSource.includes("return { vector, costUsd: 0, latencyMs: Date.now() - started };"));
  assert.ok(openaiSource.includes("would fabricate a 125x cost"));
  assert.ok(openaiSource.includes("dimensions: EMBEDDING_MODELS.openai.dimensions"));
});

test("the BGE reader uses pool 16, max 3, same-category-first order, and the B2 threshold", () => {
  assert.equal(adviceModel.VECTOR_SEARCH_LIMIT, 16);
  assert.equal(adviceModel.MAX_SIMILAR_ITEMS, 3);
  assert.equal(credits.LIMITS.strongSimilarityThreshold, 0.896396);
  assert.equal(credits.LIMITS.duplicateCosineThreshold, 0.92);
  const reranked = adviceModel.rerankSimilarByCategory("dress", [
    { item: { category: "shoes" }, name: "first" },
    { item: { category: "dress" }, name: "second" },
    { item: { category: "coat" }, name: "third" },
  ]);
  assert.deepEqual(
    reranked.map((entry) => entry.name),
    ["second", "first", "third"],
  );
  const shoppingSource = readSource("../convex/shoppingAdvice.ts");
  assert.ok(shoppingSource.includes('ctx.vectorSearch("itemEmbeddings", reader.indexName'));
  assert.ok(!shoppingSource.includes('"by_embeddingBge", {'), "no hardcoded BGE index at the search call");
  assert.ok(!shoppingSource.includes('"by_embedding", {'), "no hardcoded legacy index at the search call");
  assert.ok(
    shoppingSource.includes("readGeneration: generation"),
    "context and hit-mapping share the resolved generation",
  );
  const analyzeBody = shoppingSource.slice(shoppingSource.indexOf("export const analyze = action({"));
  assert.ok(
    analyzeBody.indexOf("embeddingReadGeneration()") < analyzeBody.indexOf("ctx.vectorSearch"),
    "an unsupported generation fails before any vector search runs",
  );
});

test("the cache fingerprint changes with wardrobe state and names the BGE generation", () => {
  const candidate = { _id: "candidate", updatedAt: 10 };
  const prefs = { presentation: "neutral", fit: "regular" };
  const owned = [{ _id: "owned", updatedAt: 20 }];
  const first = adviceModel.adviceFingerprint(candidate, owned, prefs);
  assert.equal(first, adviceModel.adviceFingerprint(candidate, owned, prefs));
  assert.notEqual(first, adviceModel.adviceFingerprint(candidate, [{ _id: "owned", updatedAt: 21 }], prefs));
  assert.ok(readSource("../convex/model/shoppingAdvice.ts").includes("EMBEDDING_GENERATION"));
});

test("candidate similarity reads one generation at a time and never mixes vector spaces", async () => {
  const bothRow = { embeddingBge: [0.5, 0.5], embedding: [0.1, 0.2] };
  const legacyVector = await adviceModel.getCandidateVector(fakeQueryCtx(bothRow), "candidate", "legacy");
  assert.deepEqual(legacyVector, [0.1, 0.2]);
  const bgeVector = await adviceModel.getCandidateVector(fakeQueryCtx(bothRow), "candidate", "bge");
  assert.deepEqual(bgeVector, [0.5, 0.5]);
  assert.notEqual(bgeVector, bothRow.embeddingBge);
  // A BGE-only row (new ingest during migration) has no legacy similarity result — accepted.
  assert.equal(
    await adviceModel.getCandidateVector(fakeQueryCtx({ embeddingBge: [0.5, 0.5] }), "candidate", "legacy"),
    null,
  );
  // A not-yet-backfilled row under BGE reads likewise has none.
  assert.equal(await adviceModel.getCandidateVector(fakeQueryCtx({ embedding: [0.1, 0.2] }), "candidate", "bge"), null);
  // Omitted generation means the env default, which is legacy during migration.
  assert.deepEqual(await adviceModel.getCandidateVector(fakeQueryCtx(bothRow), "candidate"), [0.1, 0.2]);
});

test("itemReady accepts optional BGE only and cannot receive a duplicate assignment", () => {
  const pipeline = readSource("../convex/ai/pipeline.ts");
  const start = pipeline.indexOf("export const itemReady = internalMutation({");
  const end = pipeline.indexOf("export const itemFailed = internalMutation({", start);
  const block = pipeline.slice(start, end);
  assert.ok(block.includes("embeddingBge: v.optional(v.array(v.float64()))"));
  assert.ok(block.includes("if (args.embeddingBge) await setItemEmbeddingBge"));
  assert.ok(!block.includes("duplicateOfId"));
  assert.ok(!block.includes("embedding: v.array"));
});

test("the backfill is key-guarded, bounded, retryable by id, and local-only", async () => {
  const prior = process.env.EMBEDDING_BACKFILL_KEY;
  process.env.EMBEDDING_BACKFILL_KEY = "test-backfill-key";
  try {
    await assert.rejects(
      backfill.runBackfill._handler({}, { backfillKey: "wrong" }),
      (error) => error?.data?.code === "FORBIDDEN",
    );
    await assert.rejects(
      backfill.runBackfill._handler({}, { backfillKey: "test-backfill-key", cursor: "x", retryItemIds: ["y"] }),
      (error) => error?.data?.code === "INVALID_INPUT",
    );
    await assert.rejects(
      backfill.runBackfill._handler({}, { backfillKey: "test-backfill-key", retryItemIds: new Array(65).fill("y") }),
      (error) => error?.data?.code === "INVALID_INPUT",
    );
  } finally {
    if (prior === undefined) delete process.env.EMBEDDING_BACKFILL_KEY;
    else process.env.EMBEDDING_BACKFILL_KEY = prior;
  }
  const source = readSource("../convex/embeddingBackfill.ts");
  assert.ok(source.includes("localEmbed({ text: row.text }"));
  assert.ok(!/(^|[^A-Za-z])embedText\(/.test(source), "the backfill never dispatches through the provider seam");
  assert.ok(source.includes("never reads `EMBEDDING_PROVIDER`"));
  assert.ok(source.includes("failedItemIds"));
  assert.ok(source.includes("retryItemIds"));
  assert.ok(source.includes("EMBEDDING_BACKFILL_KEY"));
  const schema = readSource("../convex/schema.ts");
  assert.ok(schema.includes('vectorField: "embeddingBge"'));
  assert.ok(schema.includes("dimensions: EMBEDDING_BGE_DIMENSIONS"));
  assert.ok(schema.includes('filterFields: ["userId"]'));
});

// ---------------------------------------------------------------------------------------------
// Migration state machine: STATE A (BGE writes / legacy reads) through STATE E (cache switch).
// ---------------------------------------------------------------------------------------------

const proseCandidate = {
  _id: "candidate",
  category: "dress",
  colours: { primary: "red", secondary: [] },
};
const proseOwned = [{ _id: "owned", category: "shoes", colours: { primary: "black", secondary: [] } }];
const proseSimilar = (similarity) => [
  { item: { _id: "owned", name: "Owned", category: "shoes" }, similarity, duplicate: false },
];

test("STATE A — migration: BGE-only writes while shopping reads legacy vectors", async () => {
  const calls = [];
  const result = await seam.embedText(
    { text: "x" },
    {
      openai: async () => {
        calls.push("openai");
        throw new Error("no paid call during migration");
      },
      local: async () => {
        calls.push("local");
        return { vector: unit384(), costUsd: 0, latencyMs: 1 };
      },
    },
    { EMBEDDING_PROVIDER: "local" },
  );
  assert.deepEqual(calls, ["local"]);
  assert.equal(result.vector.length, 384);
  assert.equal(result.costUsd, 0);
  // Configured local ingest writes BGE; absent configuration skips it instead of selecting paid AI.
  const openaiSource = readSource("../convex/ai/openai.ts");
  assert.ok(openaiSource.includes('optionalEnv("EMBEDDING_PROVIDER")'));
  assert.ok(openaiSource.includes("...(embeddingBge ? { embeddingBge } : {})"));
  // …while the reader stays on the legacy field/index until cutover.
  assert.equal(adviceModel.readGenerationConfig("legacy").vectorField, "embedding");
  assert.equal(adviceModel.readGenerationConfig("legacy").indexName, "by_embedding");
  const legacyVector = await adviceModel.getCandidateVector(
    fakeQueryCtx({ embedding: [0.1, 0.2], embeddingBge: [0.5, 0.5] }),
    "candidate",
    "legacy",
  );
  assert.deepEqual(legacyVector, [0.1, 0.2]);
});

test("STATE B — cutover: BGE reads with rerank, B2 threshold, and no duplicate assignment", async () => {
  const reader = adviceModel.readGenerationConfig("bge");
  assert.equal(reader.vectorField, "embeddingBge");
  assert.equal(reader.indexName, "by_embeddingBge");
  assert.equal(reader.searchLimit, 16);
  assert.equal(reader.rerank, true);
  assert.equal(reader.proseThreshold, 0.896396);
  const rows = {
    "emb-shoe": { userId: "u", itemId: "shoe" },
    "emb-dress": { userId: "u", itemId: "dress" },
    shoe: { _id: "shoe", userId: "u", status: "ready", category: "shoes", ownership: "owned" },
    dress: { _id: "dress", userId: "u", status: "ready", category: "dress", ownership: "owned" },
  };
  const ctx = { db: { get: async (id) => structuredClone(rows[id] ?? null) } };
  const user = { _id: "u" };
  const candidate = { _id: "candidate", category: "dress" };
  const hits = [
    { embeddingId: "emb-shoe", score: 0.99 },
    { embeddingId: "emb-dress", score: 0.9 },
  ];
  const cutover = await adviceModel.resolveSimilarOwned(ctx, user, candidate, hits, "bge");
  assert.deepEqual(
    cutover.map((entry) => entry.item._id),
    ["dress", "shoe"],
    "same-category-first rerank is active under bge",
  );
  const legacy = await adviceModel.resolveSimilarOwned(ctx, user, candidate, hits, "legacy");
  assert.deepEqual(
    legacy.map((entry) => entry.item._id),
    ["shoe", "dress"],
    "legacy reads keep pre-Phase-C cosine order",
  );
  for (const entry of [...cutover, ...legacy]) assert.equal(entry.duplicate, false);
  // The same 0.9 cosine is prose under BGE geometry but not under legacy geometry.
  const bgeSignals = adviceModel.buildSignals(proseCandidate, proseOwned, proseSimilar(0.9), 0, 0, "bge");
  assert.ok(bgeSignals.signals.some((signal) => signal.type === "similar_owned"));
  const legacySignals = adviceModel.buildSignals(proseCandidate, proseOwned, proseSimilar(0.9), 0, 0, "legacy");
  assert.ok(!legacySignals.signals.some((signal) => signal.type === "similar_owned"));
});

test("STATE C — missing or empty provider fails before any runner executes", async () => {
  for (const env of [{}, { EMBEDDING_PROVIDER: "" }]) {
    const calls = [];
    const spies = {
      openai: async () => {
        calls.push("openai");
        return { vector: [], costUsd: 0, latencyMs: 0 };
      },
      local: async () => {
        calls.push("local");
        return { vector: [], costUsd: 0, latencyMs: 0 };
      },
    };
    await assert.rejects(seam.embedText({ text: "x" }, spies, env));
    assert.deepEqual(calls, [], "no runner may execute without an explicit provider");
  }
});

test("STATE D — unsupported read generation fails closed with no vector search", async () => {
  assert.throws(() => adviceModel.readGenerationConfig("by_embeddingBge"));
  const calls = [];
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "owner-sub" }) },
    runQuery: async () => {
      calls.push("runQuery");
      throw new Error("must not run queries");
    },
    runMutation: async () => {
      calls.push("runMutation");
      throw new Error("must not mutate");
    },
    runAction: async () => {
      calls.push("runAction");
      throw new Error("must not run actions");
    },
    vectorSearch: async () => {
      calls.push("vectorSearch");
      return [];
    },
  };
  const prior = process.env.EMBEDDING_READ_GENERATION;
  process.env.EMBEDDING_READ_GENERATION = "by_embeddingBge";
  try {
    await assert.rejects(
      shopping.analyze._handler(ctx, { itemId: "candidate" }),
      (error) => error?.data?.code === "INVALID_INPUT",
    );
  } finally {
    if (prior === undefined) delete process.env.EMBEDDING_READ_GENERATION;
    else process.env.EMBEDDING_READ_GENERATION = prior;
  }
  assert.deepEqual(calls, [], "no query, mutation, action or vector search may run");
});

test("STATE E — switching read generation invalidates the advice cache", () => {
  const candidate = { _id: "candidate", updatedAt: 10 };
  const owned = [{ _id: "owned", updatedAt: 20 }];
  const prefs = { presentation: "neutral", fit: "regular" };
  const legacyPrint = adviceModel.adviceFingerprint(candidate, owned, prefs, "legacy");
  const bgePrint = adviceModel.adviceFingerprint(candidate, owned, prefs, "bge");
  assert.notEqual(legacyPrint, bgePrint, "legacy -> bge must change the fingerprint");
  assert.equal(legacyPrint, adviceModel.adviceFingerprint(candidate, owned, prefs, "legacy"));
  assert.equal(bgePrint, adviceModel.adviceFingerprint(candidate, owned, prefs, "bge"));
});
