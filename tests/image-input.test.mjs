import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import sharp from "sharp";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/image_input.ts") && specifier === "../lib/errors") {
      return nextResolve(new URL("../lib/errors.ts", context.parentURL).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { normalizeImageInput } = await import("../convex/ai/image_input.ts");

function photo(width = 30, height = 20, channels = 3) {
  return sharp({ create: { width, height, channels, background: { r: 190, g: 80, b: 40, alpha: 0.5 } } });
}

async function normalized(bytes, type = "image/jpeg") {
  const output = await normalizeImageInput(new Blob([bytes], { type }), "profile photo");
  assert.ok(output instanceof Uint8Array);
  assert.deepEqual([...output.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.space, "srgb");
  assert.equal(metadata.depth, "uchar");
  assert.equal(metadata.bitsPerSample, 8);
  assert.equal(metadata.isPalette, false);
  for (const key of ["orientation", "exif", "icc", "xmp", "iptc", "gainMap", "pages"]) {
    assert.equal(metadata[key], undefined, `${key} must not survive normalization`);
  }
  return metadata;
}

function invalidImage(messagePattern) {
  return (error) => {
    assert.equal(error.data?.code, "INVALID_INPUT");
    assert.match(error.data.message, /profile photo/);
    assert.match(error.data.message, /Replace it/);
    assert.match(error.data.message, messagePattern);
    return true;
  };
}

// Two generated JPEGs in a standard MPF container: the second image is auxiliary,
// not an animation. No user photo bytes are used by this regression fixture.
function mpo(primary, auxiliary) {
  const tiff = Buffer.alloc(82);
  tiff.write("II");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(3, 8);
  const entry = (offset, tag, type, count, value) => {
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4);
    tiff.writeUInt32LE(value, offset + 8);
  };
  entry(10, 0xb000, 7, 4, 0x30303130);
  entry(22, 0xb001, 4, 1, 2);
  entry(34, 0xb002, 7, 32, 50);
  const marker = Buffer.alloc(8);
  marker[0] = 0xff;
  marker[1] = 0xe2;
  marker.writeUInt16BE(tiff.length + 6, 2);
  marker.write("MPF\0", 4);
  const primarySize = primary.length + marker.length + tiff.length;
  tiff.writeUInt32LE(0x030000, 50);
  tiff.writeUInt32LE(primarySize, 54);
  tiff.writeUInt32LE(auxiliary.length, 70);
  tiff.writeUInt32LE(primarySize - 10, 74);
  return Buffer.concat([primary.subarray(0, 2), marker, tiff, primary.subarray(2), auxiliary]);
}

test("autorotates RGB JPEG, strips EXIF/ICC/XMP, and ignores a misleading MIME", async () => {
  const jpeg = await photo(60, 30)
    .withMetadata({ orientation: 6 })
    .withIccProfile("srgb")
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>')
    .jpeg()
    .toBuffer();
  const before = await sharp(jpeg).metadata();
  assert.equal(before.orientation, 6);
  assert.ok(before.exif);
  assert.ok(before.icc);
  assert.ok(before.xmp);
  const after = await normalized(jpeg, "image/png");
  assert.deepEqual([after.width, after.height, after.channels], [30, 60, 3]);
});

test("normalizes a multi-picture JPEG primary image without retaining auxiliary frames", async () => {
  const jpeg = mpo(await photo(30, 20).jpeg().toBuffer(), await photo(10, 15).jpeg().toBuffer());
  assert.ok(jpeg.includes(Buffer.from("MPF\0")));
  const before = await sharp(jpeg).metadata();
  assert.equal(before.format, "jpeg");
  const after = await normalized(jpeg);
  assert.deepEqual([after.width, after.height, after.channels], [30, 20, 3]);
});

test("converts CMYK JPEG to RGB", async () => {
  const jpeg = await photo().toColourspace("cmyk").jpeg().toBuffer();
  assert.equal((await sharp(jpeg).metadata()).space, "cmyk");
  assert.equal((await normalized(jpeg)).channels, 3);
});

test("converts 16-bit grayscale PNG into nonpalette 8-bit RGB", async () => {
  const png = await photo().toColourspace("grey16").png().toBuffer();
  const before = await sharp(png).metadata();
  assert.equal(before.depth, "ushort");
  assert.equal(before.channels, 1);
  assert.equal((await normalized(png, "image/png")).channels, 3);
});

test("expands palette PNG and preserves transparent WebP alpha", async () => {
  const palette = await photo().png({ palette: true }).toBuffer();
  assert.equal((await sharp(palette).metadata()).isPalette, true);
  await normalized(palette, "image/png");
  const webp = await photo(30, 20, 4).webp().toBuffer();
  const after = await normalized(webp, "application/octet-stream");
  assert.equal(after.channels, 4);
  assert.equal(after.hasAlpha, true);
});

test("caps the long edge at 2048 after rotation, preserves ratio, and never upscales", async () => {
  const jpeg = await photo(4000, 3000).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const resized = await normalized(jpeg);
  assert.deepEqual([resized.width, resized.height], [1536, 2048]);
  const small = await normalized(await photo(30, 20).jpeg().toBuffer());
  assert.deepEqual([small.width, small.height], [30, 20]);
});

test("rejects genuine animated WebP", async () => {
  const data = await photo(20, 60).raw().toBuffer();
  data.fill(20, 20 * 30 * 3);
  const webp = await sharp(data, { raw: { width: 20, height: 60, channels: 3, pageHeight: 30 } })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  assert.equal((await sharp(webp).metadata()).pages, 2);
  await assert.rejects(normalized(webp, "image/webp"), invalidImage(/multiple frames/));
});

test("rejects unsupported or corrupt actual bytes despite an image MIME", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("not an image"), Buffer.from([0xff, 0xd8, 0xff, 0xe0])]) {
    await assert.rejects(normalized(bytes), invalidImage(/empty|could not be read/));
  }
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>',
  );
  await assert.rejects(normalized(svg, "image/png"), invalidImage(/not a JPEG, PNG or WebP/));
  const jpeg = await photo().jpeg().toBuffer();
  await assert.rejects(normalized(jpeg.subarray(0, Math.floor(jpeg.length * 0.8))), invalidImage(/could not be read/));
});

test("rejects a valid image above 50 megapixels before full decoding", async () => {
  const png = await photo(10001, 5000).png({ compressionLevel: 1 }).toBuffer();
  assert.equal((await sharp(png).metadata()).width, 10001);
  await assert.rejects(normalized(png, "image/png"), invalidImage(/under 50 megapixels/));
});
