import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getFunctionName } from "convex/server";

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

// Keep real model, credit ledger, public auth wrappers and workflow callbacks. Only Convex's
// database transport/scheduler are in memory; no detector, image action or external service runs.
globalThis.Convex = {
  async asyncSyscall(operation, args) {
    assert.equal(operation, "1.0/createFunctionHandle");
    return JSON.stringify(`handle:${JSON.parse(args).name}`);
  },
};

const uploads = await import("../convex/uploads.ts");
const { recordCandidates, createBatch, startExtractionJob } = await import("../convex/model/uploads.ts");
const { setStep } = await import("../convex/model/jobs.ts");
const { onIngestComplete, onScanComplete } = await import("../convex/workflows/ingest.ts");
const { LIMITS, dayKey } = await import("../convex/shared/credits.ts");

const candidate = (name, category = "top") => ({
  name,
  category,
  subcategory: "shirt",
  colours: { primary: "blue", secondary: [], hex: ["#123456"] },
  pattern: "solid",
  material: "cotton",
  season: ["summer"],
  formality: "casual",
  description: `Synthetic ${name}`,
  bbox: [0.1, 0.1, 0.8, 0.8],
});
const sixPieces = [
  candidate("Shirt"),
  candidate("Jacket", "outerwear"),
  candidate("Jeans", "bottom"),
  candidate("Trainers", "shoes"),
  candidate("Bag", "accessory"),
  candidate("Hat", "accessory"),
];
const errorCode = (code) => (error) => error.data?.code === code;

function fixture({ balance = 10, detecting = false, userFields = {} } = {}) {
  let rows = new Map();
  let nextId = 0;
  let scheduled = [];
  let queue = Promise.resolve();
  const put = (table, id, data) =>
    rows.set(id, { ...structuredClone(data), _id: id, _creationTime: nextId++, $table: table });
  put("users", "owner", {
    clerkId: "owner-sub",
    plan: "free",
    planCredits: 0,
    packCredits: balance,
    dailySpend: { dayKey: dayKey(), credits: 0 },
    features: [],
    onboardedAt: 1,
    ...userFields,
  });
  put("users", "foreign", { clerkId: "foreign-sub", onboardedAt: 1 });
  put("uploads", "photo", {
    userId: "owner",
    batchId: "batch",
    storageId: "source",
    fileName: "photo.webp",
    mimeType: "image/webp",
    sizeBytes: 100,
    createdAt: 1,
    jobId: "scan",
    status: detecting ? "detecting" : "awaiting_selection",
    ...(detecting ? {} : { candidates: sixPieces, detectedCount: sixPieces.length }),
  });
  put("jobs", "scan", {
    userId: "owner",
    uploadId: "photo",
    batchId: "batch",
    type: "ingest",
    status: detecting ? "running" : "done",
    reservation: { plan: 0, pack: 0 },
    refunds: { plan: 0, pack: 0 },
    resultIds: [],
    progress: detecting ? 0.5 : 1,
    createdAt: 1,
    updatedAt: 1,
    steps: [
      { key: "upload", status: "done" },
      { key: "detect", status: detecting ? "running" : "done", meta: { inputTextTokens: 100, outputTokens: 200 } },
      { key: "review", status: detecting ? "pending" : "done" },
    ],
  });
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
    async delete(...args) {
      rows.delete(args.at(-1));
    },
    system: {
      async get(_table, id) {
        assert.equal(id, "source");
        return { contentType: "image/webp", size: 100 };
      },
    },
    query(table) {
      const filters = [];
      let descending = false;
      const selected = () =>
        tableRows(table)
          .filter((row) => filters.every(([field, value]) => row[field] === value))
          .sort((a, b) => (descending ? -1 : 1) * (a._creationTime - b._creationTime));
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
        order(direction) {
          descending = direction === "desc";
          return query;
        },
        async collect() {
          return structuredClone(selected());
        },
        async take(limit) {
          return structuredClone(selected().slice(0, limit));
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
  const context = (subject = "owner-sub") => ({
    db,
    auth: {
      async getUserIdentity() {
        return subject ? { subject } : null;
      },
    },
    storage: {
      async getUrl(id) {
        return `https://storage.invalid/${id}`;
      },
      async delete() {},
    },
    async runMutation(reference, args) {
      scheduled.push({ name: getFunctionName(reference), args });
      return `workflow-${scheduled.length}`;
    },
  });
  // Serial commit + rollback models Convex mutation isolation, including two requests dispatched together.
  const transaction = (fn) => {
    const result = queue.then(async () => {
      const snapshot = structuredClone(rows),
        work = structuredClone(scheduled);
      try {
        return await fn();
      } catch (error) {
        rows = snapshot;
        scheduled = work;
        throw error;
      }
    });
    queue = result.catch(() => {});
    return result;
  };
  return {
    ctx: context(),
    context,
    db,
    put,
    tableRows,
    transaction,
    scheduled: () => scheduled,
    select: (indices, subject = "owner-sub") =>
      transaction(() => uploads.confirmSelection._handler(context(subject), { uploadId: "photo", indices })),
  };
}

test("new uploads schedule only the free scan workflow, with no extraction/reservation step", async () => {
  const f = fixture();
  const user = await f.db.get("owner");
  const result = await f.transaction(() =>
    createBatch(f.ctx, user, [{ storageId: "source", fileName: "new.webp", mimeType: "image/webp", sizeBytes: 100 }]),
  );
  assert.equal(f.scheduled()[0].name, "workflows/ingest:scanUpload");
  assert.deepEqual(
    (await f.db.get(result.uploads[0].jobId)).steps.map((step) => step.key),
    ["upload", "detect", "review"],
  );
  assert.equal(f.tableRows("creditLedger").length, 0);
  assert.equal(f.tableRows("items").length, 0);
});

test("free detection stores six review candidates, finishes the job, and has no credit/item side effects", async () => {
  const f = fixture({ detecting: true });
  const found = await recordCandidates(f.ctx, { uploadId: "photo", jobId: "scan", items: sixPieces });
  assert.equal(found, 6);
  assert.equal((await f.db.get("photo")).status, "awaiting_selection");
  assert.equal((await f.db.get("scan")).status, "done");
  assert.equal((await f.db.get("owner")).packCredits, 10);
  assert.equal(f.tableRows("items").length, 0);
  assert.equal(f.tableRows("creditLedger").length, 0);
  assert.equal(f.scheduled().length, 0);
  const stats = structuredClone(f.tableRows("dailyStats"));
  await recordCandidates(f.ctx, { uploadId: "photo", jobId: "scan", items: sixPieces });
  assert.deepEqual(f.tableRows("dailyStats"), stats, "replayed detection does not double-count COGS");
});

test("selecting only the jacket out of six charges one credit and creates exactly one item/target", async () => {
  const f = fixture();
  const { jobId } = await f.select([1]);
  assert.equal((await f.db.get("owner")).packCredits, 9);
  assert.deepEqual(
    f.tableRows("items").map((row) => [row.name, row.status]),
    [["Jacket", "extracting"]],
  );
  assert.deepEqual(
    f.tableRows("creditLedger").map((row) => row.delta),
    [-1],
  );
  assert.equal(f.scheduled().length, 1);
  assert.equal(f.scheduled()[0].name, "workflows/ingest:extractItems");
  assert.equal(f.scheduled()[0].args.args.itemIds.length, 1);
  assert.equal((await f.db.get("photo")).jobId, jobId);
  assert.deepEqual((await f.db.get("photo")).selectedIndices, [1]);
  assert.deepEqual(
    (await f.db.get(jobId)).steps.map((step) => step.key),
    ["reserve", "extract:0", "finalize"],
  );
  assert.deepEqual(await uploads.needsReview._handler(f.ctx, {}), []);
});

test("concurrent/reordered confirmations commit once; a different selection conflicts without another charge", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.select([4, 1]), f.select([1, 4])]);
  assert.deepEqual(a, b);
  assert.equal(f.tableRows("items").length, 2);
  assert.equal(f.scheduled().length, 1);
  assert.equal((await f.db.get("owner")).packCredits, 8);
  assert.equal(f.tableRows("creditLedger").length, 1);
  await assert.rejects(f.select([2]), errorCode("CONFLICT"));
  assert.equal((await f.db.get("owner")).packCredits, 8);
  const racing = fixture();
  const results = await Promise.allSettled([racing.select([1]), racing.select([2])]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(racing.tableRows("items").length, 1);
  assert.equal((await racing.db.get("owner")).packCredits, 9);
});

test("unauthenticated/foreign callers and invalid indices cannot read review photos or start work", async () => {
  const f = fixture();
  await assert.rejects(f.select([1], null), errorCode("UNAUTHENTICATED"));
  await assert.rejects(f.select([1], "foreign-sub"), errorCode("NOT_FOUND"));
  await assert.rejects(uploads.needsReview._handler(f.context(null), {}), errorCode("UNAUTHENTICATED"));
  assert.deepEqual(await uploads.needsReview._handler(f.context("foreign-sub"), {}), []);
  assert.equal((await uploads.needsReview._handler(f.ctx, {}))[0].upload.candidates.length, 6);
  for (const indices of [[], [1, 1], [-1], [6], [0.5], [NaN], [Infinity]]) {
    await assert.rejects(f.select(indices), errorCode("INVALID_INPUT"));
  }
  assert.equal(f.tableRows("items").length, 0);
  assert.equal(f.tableRows("creditLedger").length, 0);
  assert.equal(f.scheduled().length, 0);
});

test("zero credits saves only selected pending items and ends the job; later resume uses those same items", async () => {
  const f = fixture({ balance: 0 });
  const original = await f.select([1, 3]);
  assert.equal((await f.db.get(original.jobId)).status, "partial");
  assert.equal((await f.db.get("photo")).status, "partial");
  assert.equal(f.scheduled().length, 0);
  assert.deepEqual(
    f.tableRows("items").map((row) => [row.name, row.status]),
    [
      ["Jacket", "needsCredits"],
      ["Trainers", "needsCredits"],
    ],
  );
  assert.deepEqual(await f.select([3, 1]), original);
  await f.db.patch("owner", { packCredits: 2 });
  const resumed = await f.transaction(() => uploads.resume._handler(f.ctx, { uploadId: "photo" }));
  assert.notEqual(resumed.jobId, original.jobId);
  assert.equal((await f.db.get("photo")).jobId, resumed.jobId);
  assert.equal(f.tableRows("items").length, 2);
  assert.equal((await f.db.get("owner")).packCredits, 0);
  await assert.rejects(
    f.transaction(() => uploads.resume._handler(f.ctx, { uploadId: "photo" })),
    errorCode("ITEM_BUSY"),
  );
});

test("partial balance reserves only available selected items; failure refunds exactly that reservation once", async () => {
  const f = fixture({ balance: 1 });
  const { jobId } = await f.select([1, 3]);
  assert.deepEqual(
    f.tableRows("items").map((row) => row.status),
    ["extracting", "needsCredits"],
  );
  assert.equal(f.scheduled()[0].args.args.itemIds.length, 1);
  await setStep(f.ctx, jobId, "extract:0", { status: "failed", error: "Image service failed" });
  const callback = { workflowId: "workflow-1", context: { jobId }, result: { kind: "success", returnValue: {} } };
  await onIngestComplete._handler(f.ctx, callback);
  await onIngestComplete._handler(f.ctx, callback);
  assert.equal((await f.db.get("owner")).packCredits, 1);
  assert.deepEqual(
    f.tableRows("creditLedger").map((row) => row.delta),
    [-1, 1],
  );
  assert.equal(
    f.tableRows("items").some((row) => row.status === "extracting"),
    false,
  );
});

test("paid billing freshness, wardrobe capacity, and pre-scan state fail closed with atomic rollback", async () => {
  const stale = fixture({ userFields: { plan: "pro", planPeriodEnd: Date.now() + 3_600_000, billingCheckedAt: 1 } });
  await assert.rejects(stale.select([1]), errorCode("SUBSCRIPTION_REFRESH_REQUIRED"));
  assert.equal(stale.tableRows("jobs").length, 1);
  assert.equal(stale.tableRows("items").length, 0);
  assert.equal((await stale.db.get("photo")).status, "awaiting_selection");
  const full = fixture();
  for (let i = 0; i < LIMITS.maxItemsPerUser; i++)
    full.put("items", `existing-${i}`, { userId: "owner", status: "needsCredits" });
  await assert.rejects(full.select([1]), errorCode("WARDROBE_FULL"));
  const scanning = fixture({ detecting: true });
  await assert.rejects(scanning.select([1]), errorCode("INVALID_INPUT"));
  assert.equal(scanning.tableRows("creditLedger").length, 0);
});

test("two photo confirmations competing for the last credit cannot overspend or extract an unselected item", async () => {
  const f = fixture({ balance: 1 });
  f.put("uploads", "photo-two", await f.db.get("photo"));
  const results = await Promise.all([
    f.select([1]),
    f.transaction(() => uploads.confirmSelection._handler(f.ctx, { uploadId: "photo-two", indices: [3] })),
  ]);
  assert.notEqual(results[0].jobId, results[1].jobId);
  assert.equal((await f.db.get("owner")).packCredits, 0);
  assert.equal(
    f.tableRows("creditLedger").reduce((sum, row) => sum - row.delta, 0),
    1,
  );
  assert.deepEqual(
    f.tableRows("items").map((row) => [row.name, row.status]),
    [
      ["Jacket", "extracting"],
      ["Trainers", "needsCredits"],
    ],
  );
  assert.equal(f.scheduled().length, 1);
});

test("cancellation before resumed extraction starts clears pending items and refunds once", async () => {
  const f = fixture({ balance: 0 });
  await f.select([1]);
  await f.db.patch("owner", { packCredits: 1 });
  const { jobId } = await f.transaction(() => uploads.resume._handler(f.ctx, { uploadId: "photo" }));
  await onIngestComplete._handler(f.ctx, {
    workflowId: "workflow-1",
    context: { jobId },
    result: { kind: "canceled" },
  });
  assert.equal(f.tableRows("items")[0].status, "failed");
  assert.equal((await f.db.get("owner")).packCredits, 1);
  assert.equal((await f.db.get(jobId)).status, "cancelled");
});

test("re-extraction cannot overlap an active import from the same photo or reserve a second credit", async () => {
  const f = fixture({ balance: 2 });
  await f.select([1]);
  const item = f.tableRows("items")[0];
  const user = await f.db.get("owner");
  await assert.rejects(
    f.transaction(() => startExtractionJob(f.ctx, user, [item._id], "photo")),
    errorCode("ITEM_BUSY"),
  );
  assert.equal((await f.db.get("owner")).packCredits, 1);
  assert.equal(f.tableRows("creditLedger").length, 1);
  assert.equal(f.scheduled().length, 1);
  await assert.rejects(
    f.transaction(() => startExtractionJob(f.ctx, { ...user, _id: "foreign" }, [item._id], "photo")),
    errorCode("NOT_FOUND"),
  );
});

test("zero-result and failed scans leave no active job; delayed scan callback cannot reset a selection", async () => {
  const empty = fixture({ detecting: true });
  assert.equal(await recordCandidates(empty.ctx, { uploadId: "photo", jobId: "scan", items: [] }), 0);
  assert.equal((await empty.db.get("photo")).status, "done");
  assert.equal((await empty.db.get("scan")).status, "done");
  const failed = fixture({ detecting: true });
  await onScanComplete._handler(failed.ctx, {
    workflowId: "scan-workflow",
    context: { jobId: "scan" },
    result: { kind: "failed", error: "Detector unavailable" },
  });
  assert.equal((await failed.db.get("scan")).status, "failed");
  assert.equal((await failed.db.get("photo")).status, "failed");
  const selected = fixture();
  const { jobId } = await selected.select([1]);
  await onScanComplete._handler(selected.ctx, {
    workflowId: "scan-workflow",
    context: { jobId: "scan" },
    result: { kind: "failed", error: "Late callback" },
  });
  assert.equal((await selected.db.get("photo")).jobId, jobId);
  assert.equal((await selected.db.get("photo")).status, "extracting");
});
