import assert from "node:assert/strict";
import test from "node:test";

const { deterministicDetectedItem } = await import("../convex/ai/deterministic_detection.ts");

test("zero-provider detection classifies the reported t-short filename as a T-shirt", () => {
  const item = deterministicDetectedItem("test saas t short.jpg", ["#f7f7f7", "#c62828"]);
  assert.equal(item.category, "top");
  assert.equal(item.subcategory, "t-shirt");
  assert.equal(item.colours.primary, "red");
  assert.deepEqual(item.bbox, [0, 0, 1, 1]);
});

test("zero-provider detection recognizes common garment filenames", () => {
  const cases = [
    ["blue-jeans.png", "bottom"],
    ["winter_jacket.webp", "outerwear"],
    ["summer-dress.jpg", "dress"],
    ["white sneakers.jpg", "shoes"],
    ["leather-bag.jpg", "bag"],
    ["baseball-cap.png", "headwear"],
  ];
  for (const [fileName, category] of cases) {
    assert.equal(deterministicDetectedItem(fileName, []).category, category);
  }
});

test("zero-provider detection is replay-stable and never invents multiple pieces", () => {
  const first = deterministicDetectedItem("IMG_1234.jpg", ["#214f91"]);
  const replay = deterministicDetectedItem("IMG_1234.jpg", ["#214f91"]);
  assert.deepEqual(replay, first);
  assert.equal(first.category, "top");
  assert.equal(first.colours.primary, "blue");
});
