"use node";

import { PNG } from "pngjs";

/**
 * Dominant colour swatches for a cutout PNG. Runs in the Node runtime (pngjs needs zlib);
 * imported directly by ai/openai.ts rather than wrapped in an action.
 */

/** Roughly how many pixels we look at, whatever the image size. */
const SAMPLE_TARGET = 20_000;
/** Cutouts are transparent outside the garment; anything softer than this is an antialiased edge. */
const MIN_ALPHA = 200;
/** 32 levels per channel: enough to separate navy from black, coarse enough to merge shading. */
const QUANTISE_SHIFT = 3;

type Bin = { count: number; r: number; g: number; b: number };

/** The `count` most common opaque colours in a PNG, as `#rrggbb`, most common first. */
export function dominantHex(png: Uint8Array, count = 3): string[] {
  const decoded = decode(png);
  if (!decoded) return [];
  const { data, width, height } = decoded;
  const pixels = width * height;
  if (pixels === 0) return [];

  const stride = Math.max(1, Math.floor(pixels / SAMPLE_TARGET));
  const bins = new Map<number, Bin>();

  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4;
    const alpha = data[offset + 3];
    if (alpha === undefined || alpha <= MIN_ALPHA) continue;
    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    const key = ((r >> QUANTISE_SHIFT) << 10) | ((g >> QUANTISE_SHIFT) << 5) | (b >> QUANTISE_SHIFT);
    const bin = bins.get(key);
    if (bin) {
      bin.count += 1;
      bin.r += r;
      bin.g += g;
      bin.b += b;
    } else {
      bins.set(key, { count: 1, r, g, b });
    }
  }

  return [...bins.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(0, count))
    .map((bin) => toHex(bin.r / bin.count, bin.g / bin.count, bin.b / bin.count));
}

function decode(png: Uint8Array): { data: Buffer; width: number; height: number } | null {
  try {
    const image = PNG.sync.read(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
    return { data: image.data, width: image.width, height: image.height };
  } catch {
    // A non-PNG (the opaque fallback can return jpeg) or a truncated file just means no swatches.
    return null;
  }
}

function toHex(r: number, g: number, b: number): string {
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function channel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}
