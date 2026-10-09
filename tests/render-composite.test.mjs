import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

const { compositeOutfitImage } = await import("../convex/ai/composite.ts");

async function png(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } })
    .png()
    .toBuffer();
}

test("local composite creates a deterministic full-length PNG with zero external cost", async () => {
  const person = await png(400, 800, { r: 220, g: 190, b: 160, alpha: 1 });
  const garment = await sharp({ create: { width: 160, height: 220, channels: 4, background: "white" } })
    .composite([{ input: await png(90, 150, { r: 190, g: 20, b: 30, alpha: 1 }), left: 35, top: 35 }])
    .png()
    .toBuffer();
  const request = {
    person: { bytes: new Uint8Array(person), name: "person" },
    garments: [{ bytes: new Uint8Array(garment), name: "red-top", slot: "top" }],
    prompt: "unused by deterministic local composition",
    quality: "standard",
  };
  const first = await compositeOutfitImage(request);
  const second = await compositeOutfitImage(request);
  const metadata = await sharp(first.bytes).metadata();

  assert.equal(first.costUsd, 0);
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, 1536);
  assert.deepEqual(first.bytes, second.bytes, "the same inputs must produce the same preview");
});
