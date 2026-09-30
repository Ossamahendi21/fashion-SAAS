// Generates the repository-owned synthetic fixture images for the shopping E2E.
// Dependency-free (node:zlib only): solid blocks plus a few rectangles, written as
// plain RGB PNGs. Content is intentionally boring — eligibility is size/visibility
// based, never content based. Regenerate with: node e2e/scripts/make-images.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixture", "images");

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**.paint fills rects over a base color; each rect is [x, y, w, h, r, g, b]. */
function png(width, height, base, rects = []) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 3] = base[0];
    pixels[i * 3 + 1] = base[1];
    pixels[i * 3 + 2] = base[2];
  }
  for (const [x, y, w, h, r, g, b] of rects) {
    for (let row = y; row < y + h; row += 1) {
      for (let col = x; col < x + w; col += 1) {
        if (col < 0 || row < 0 || col >= width || row >= height) continue;
        const i = (row * width + col) * 3;
        pixels[i] = r;
        pixels[i + 1] = g;
        pixels[i + 2] = b;
      }
    }
  }
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    raw[row * (1 + width * 3)] = 0;
    pixels.copy(raw, row * (1 + width * 3) + 1, row * width * 3, (row + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(root, { recursive: true });
// Large clothing product shots (eligible: big, squarish, clean filenames).
writeFileSync(join(root, "product-jacket.png"), png(600, 800, [107, 112, 67], [
  [150, 120, 300, 560, 84, 88, 52],
  [60, 180, 90, 480, 84, 88, 52],
  [450, 180, 90, 480, 84, 88, 52],
  [230, 640, 140, 40, 60, 62, 36],
]));
writeFileSync(join(root, "product-dress.png"), png(500, 700, [148, 84, 96], [
  [175, 90, 150, 520, 120, 64, 76],
  [150, 560, 200, 60, 120, 64, 76],
]));
// Tiny + deny-listed names: never eligible.
writeFileSync(join(root, "logo.png"), png(48, 48, [30, 30, 30], [[8, 8, 32, 32, 200, 200, 200]]));
writeFileSync(join(root, "avatar.png"), png(64, 64, [70, 120, 160], [[16, 12, 32, 32, 220, 200, 180]]));
// Wide banner: aspect ratio excludes it.
writeFileSync(join(root, "banner.png"), png(1200, 180, [40, 60, 90], [[0, 70, 1200, 40, 90, 140, 200]]));
console.log("fixture images written to", root);
