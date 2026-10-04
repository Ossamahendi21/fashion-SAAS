// Step 6 Phase B helper unit tests: pure deterministic functions only.
// No models, no network, no fixtures required.
import assert from "node:assert/strict";
import test from "node:test";

const {
  PALETTE,
  nameColour,
  bboxIoU,
  dedupeBoxes,
  detectStripes,
  CATEGORY_SUB,
  itemName,
  itemDescription,
  defaultSeason,
  defaultFormality,
} = await import("../bench/detection/analyze.mjs");

test("nameColour maps obvious RGB values to contract colour names", () => {
  assert.equal(nameColour(59, 91, 146), "blue");
  assert.equal(nameColour(200, 161, 101), "gold");
  assert.equal(nameColour(31, 111, 139), "teal");
  assert.equal(nameColour(217, 42, 47), "red");
  assert.equal(nameColour(244, 241, 234), "white");
  assert.equal(nameColour(20, 20, 22), "black");
  assert.equal(nameColour(122, 84, 51), "brown");
  assert.equal(typeof nameColour(0, 0, 0), "string");
  assert.ok(PALETTE.length >= 10);
});

const solidMask = (w, h) => new Uint8Array(w * h).fill(1);
const solidPixels = (w, h, r, g, b) => {
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
  }
  return px;
};

test("detectStripes calls a plain solid region solid", () => {
  assert.equal(detectStripes(solidPixels(120, 120, 59, 91, 146), 120, 120, solidMask(120, 120)), "solid");
});

test("detectStripes calls two interior vertical bars striped, ignoring silhouette edges", () => {
  const w = 200;
  const h = 120;
  const px = solidPixels(w, h, 244, 241, 234);
  for (let x = 60; x < 80; x++) {
    for (let y = 0; y < h; y++) {
      px[(y * w + x) * 3] = 212;
      px[(y * w + x) * 3 + 1] = 58;
      px[(y * w + x) * 3 + 2] = 47;
    }
  }
  for (let x = 120; x < 140; x++) {
    for (let y = 0; y < h; y++) {
      px[(y * w + x) * 3] = 212;
      px[(y * w + x) * 3 + 1] = 58;
      px[(y * w + x) * 3 + 2] = 47;
    }
  }
  assert.equal(detectStripes(px, w, h, solidMask(w, h)), "striped");
});

test("detectStripes returns solid for an empty mask", () => {
  assert.equal(detectStripes(solidPixels(40, 40, 10, 10, 10), 40, 40, new Uint8Array(40 * 40)), "solid");
});

test("bboxIoU measures overlap on the 0-1 scale", () => {
  assert.equal(bboxIoU([0, 0, 10, 10], [0, 0, 10, 10]), 1);
  assert.equal(bboxIoU([0, 0, 10, 10], [20, 20, 30, 30]), 0);
  const half = bboxIoU([0, 0, 10, 10], [5, 0, 15, 10]);
  assert.ok(Math.abs(half - 1 / 3) < 1e-9);
});

test("dedupeBoxes merges near-duplicate boxes across prompts", () => {
  const kept = dedupeBoxes([
    { box: [0, 0, 10, 10], prompt: "a" },
    { box: [1, 1, 11, 11], prompt: "b" },
    { box: [50, 50, 60, 60], prompt: "a" },
  ]);
  assert.equal(kept.length, 2);
});

test("itemName/itemDescription derive deterministic factual strings", () => {
  assert.equal(itemName("blue", "top"), "Blue T-shirt");
  assert.equal(itemName("gold", "dress"), "Gold dress");
  const desc = itemDescription("teal", "solid", "dress", [600, 500, 1500, 1700], [2133, 2133]);
  assert.match(desc, /teal/);
  assert.match(desc, /dress/);
  assert.ok(!desc.includes("  "));
  assert.deepEqual(Object.keys(CATEGORY_SUB).sort(), ["accessory", "bag", "bottom", "dress", "headwear", "outerwear", "shoes", "top"]);
});

test("season/formality fallbacks match current coercion defaults", () => {
  assert.deepEqual(defaultSeason(), ["spring", "summer", "autumn", "winter"]);
  assert.equal(defaultFormality(), "casual");
});
