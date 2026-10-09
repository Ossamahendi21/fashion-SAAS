"use node";

import sharp from "sharp";
import type { RenderRequest, RenderRunnerResult } from "./rendering";

/**
 * A deterministic, local try-on preview. It is deliberately not generative: it lays the user's
 * selected garment images over their fitting photo using fixed, slot-specific placement. That
 * makes it available without an AI provider, a network request, or external inference spend.
 */
const CANVAS = { width: 1024, height: 1536 };

type Placement = { left: number; top: number; width: number; height: number };

const PLACEMENTS = {
  dress: { left: 222, top: 310, width: 580, height: 830 },
  top: { left: 245, top: 330, width: 535, height: 430 },
  bottom: { left: 275, top: 705, width: 475, height: 520 },
  shoes: { left: 300, top: 1190, width: 425, height: 250 },
  outerwear: { left: 200, top: 300, width: 625, height: 885 },
  accessories: { left: 650, top: 420, width: 220, height: 300 },
} satisfies Record<RenderRequest["garments"][number]["slot"], Placement>;

const MAX_INPUT_PIXELS = 50_000_000;
const EDGE_THRESHOLD = 52;

/** Always returns the same 1024×1536 PNG for the same normalized source images. */
export async function compositeOutfitImage(request: RenderRequest): Promise<RenderRunnerResult> {
  const started = Date.now();
  const base = await sharp(Buffer.from(request.person.bytes), { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(CANVAS.width, CANVAS.height, {
      fit: "contain",
      background: { r: 248, g: 247, b: 244, alpha: 1 },
    })
    .png()
    .toBuffer();

  const layers = await Promise.all(
    request.garments.map(async (garment) => {
      const placement = PLACEMENTS[garment.slot];
      const input = await transparentEdges(garment.bytes);
      const image = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
        .resize(placement.width, placement.height, { fit: "contain", withoutEnlargement: false })
        .png()
        .toBuffer();
      return { input: image, left: placement.left, top: placement.top, blend: "over" as const };
    }),
  );

  const output = await sharp(base).composite(layers).png().toBuffer();
  const bytes = new Uint8Array(output.byteLength);
  bytes.set(output);
  return { bytes, costUsd: 0, latencyMs: Date.now() - started };
}

/**
 * Most wardrobe photos have a flat product-photo backdrop. Remove only backdrop pixels connected
 * to an edge; similar coloured pixels inside the garment remain untouched. Existing transparent
 * cutouts keep their alpha and therefore pass through unchanged.
 */
async function transparentEdges(input: Uint8Array): Promise<Buffer> {
  const decoded = await sharp(Buffer.from(input), { limitInputPixels: MAX_INPUT_PIXELS }).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const { data, info } = decoded;
  const { width, height, channels } = info;
  if (!width || !height || channels !== 4) throw new Error("The garment image could not be composed.");

  const edge = edgeColour(data, width, height, channels);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (visited[index]) return;
    visited[index] = 1;
    if (!matchesBackground(data, index * channels, edge)) return;
    queue.push(index);
  };

  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    push(0, y);
    push(width - 1, y);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor];
    data[index * channels + 3] = 0;
    const x = index % width;
    const y = Math.floor(index / width);
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

function edgeColour(data: Buffer, width: number, height: number, channels: number): [number, number, number] {
  const points = [0, width - 1, (height - 1) * width, height * width - 1];
  const totals = [0, 0, 0];
  for (const point of points) {
    for (let channel = 0; channel < 3; channel++) totals[channel] += data[point * channels + channel];
  }
  return [
    Math.round(totals[0] / points.length),
    Math.round(totals[1] / points.length),
    Math.round(totals[2] / points.length),
  ];
}

function matchesBackground(data: Buffer, offset: number, edge: [number, number, number]): boolean {
  if (data[offset + 3] === 0) return true;
  return (
    Math.max(
      Math.abs(data[offset] - edge[0]),
      Math.abs(data[offset + 1] - edge[1]),
      Math.abs(data[offset + 2] - edge[2]),
    ) <= EDGE_THRESHOLD
  );
}
