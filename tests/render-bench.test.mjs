// Render benchmark harness tests (Phase B). Synthetic in-memory images only:
// no models, no network, no provider calls, no production code touched.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

const { validateManifest, validateOutput, validateResult } = await import("../bench/render/validate.mjs");
const manifest = JSON.parse(readFileSync(new URL("../bench/render/manifest.json", import.meta.url), "utf8"));

const png = (width, height, channels = 3) =>
  sharp({ create: { width, height, channels, background: { r: 20, g: 40, b: 60 } } })
    .png()
    .toBuffer();

const record = (overrides = {}) => ({
  candidate: "harness-selftest",
  caseId: "TOP_BASIC",
  success: true,
  outputPath: "bench/render/.out/harness-selftest-TOP_BASIC.png",
  width: 1024,
  height: 1536,
  format: "png",
  opaque: true,
  latencyMs: 1000,
  peakRssMb: 512,
  externalCostUsd: 0,
  error: null,
  ...overrides,
});

const withFile = async (buffer, run) => {
  const dir = mkdtempSync(join(tmpdir(), "render-bench-"));
  const path = join(dir, "out.png");
  writeFileSync(path, buffer);
  return run(path);
};

test("manifest carries the 7 fixed Phase B cases with distinct ids", () => {
  assert.equal(manifest.cases.length, 7);
  const ids = manifest.cases.map((kase) => kase.id).sort();
  assert.deepEqual(ids, [
    "BOTTOM_BASIC",
    "DETAIL_FIDELITY",
    "HARD_PERSON",
    "LAYERED",
    "ONE_PIECE",
    "TOP_BASIC",
    "TOP_BOTTOM",
  ]);
  assert.equal(new Set(ids).size, 7);
  assert.equal(manifest.target.width, 1024);
  assert.equal(manifest.target.height, 1536);
});

test("validateManifest accepts the shipped manifest and rejects broken ones", () => {
  assert.equal(validateManifest(manifest).ok, true);
  assert.equal(validateManifest({}).ok, false);
  assert.equal(validateManifest({ cases: [] }).ok, false);
  const dupes = structuredClone(manifest);
  dupes.cases.push(structuredClone(manifest.cases[0]));
  assert.equal(validateManifest(dupes).ok, false);
  const nogarments = structuredClone(manifest);
  delete nogarments.cases[0].garments;
  assert.equal(validateManifest(nogarments).ok, false);
});

test("validateOutput accepts a valid 1024x1536 PNG with explicit externalCostUsd 0", async () => {
  const checked = await withFile(await png(1024, 1536), async (outputPath) =>
    validateOutput(record({ outputPath })),
  );
  assert.equal(checked.ok, true);
  assert.equal(checked.info.exactDimensions, true);
  assert.equal(checked.info.aspectOk, true);
  assert.equal(checked.info.format, "png");
});

test("validateOutput detects wrong dimensions and broken aspect", async () => {
  const checked = await withFile(await png(800, 600), async (outputPath) =>
    validateOutput(record({ outputPath, width: 800, height: 600 })),
  );
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((message) => message.includes("2:3")));
  assert.equal(checked.info.aspectOk, false);
});

test("validateOutput detects record/measurement dimension mismatch", async () => {
  const checked = await withFile(await png(1024, 1536), async (outputPath) =>
    validateOutput(record({ outputPath, width: 512, height: 768 })),
  );
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((message) => message.includes("do not match")));
});

test("validateOutput rejects malformed images and missing outputs", async () => {
  const garbage = await withFile(Buffer.from("not an image at all"), async (outputPath) =>
    validateOutput(record({ outputPath })),
  );
  assert.equal(garbage.ok, false);
  const missing = await validateOutput(record({ outputPath: "/nonexistent/out.png" }));
  assert.equal(missing.ok, false);
});

test("validateOutput rejects non-PNG outputs", async () => {
  const jpeg = await sharp({
    create: { width: 1024, height: 1536, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toBuffer();
  const checked = await withFile(jpeg, async (outputPath) => validateOutput(record({ outputPath })));
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((message) => message.includes("png")));
});

test("validateResult requires explicit externalCostUsd and accepts 0", () => {
  assert.equal(validateResult(record()).ok, true);
  const missing = record();
  delete missing.externalCostUsd;
  const checked = validateResult(missing);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((message) => message.includes("externalCostUsd")));
  const paid = record({ externalCostUsd: 0.05 });
  assert.equal(validateResult(paid).ok, true);
  const negative = record({ externalCostUsd: -1 });
  assert.equal(validateResult(negative).ok, false);
});

test("validateResult rejects malformed records", () => {
  assert.equal(validateResult(null).ok, false);
  assert.equal(validateResult(record({ success: "yes" })).ok, false);
  assert.equal(validateResult(record({ caseId: "lowercase" })).ok, false);
  assert.equal(validateResult(record({ latencyMs: Number.NaN })).ok, false);
});
