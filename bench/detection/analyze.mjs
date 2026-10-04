// Step 6 Phase B analysis: deterministic enrichment + metrics (no models here).
// Imports boxes/masks from .out JSONs, reads fixture + reference PNGs with sharp.
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const DIR = "bench/detection";
const boxes = JSON.parse(readFileSync(`${DIR}/.out/florence-boxes.json`, "utf8")).cases;
const masks = JSON.parse(readFileSync(`${DIR}/.out/sam-masks.json`, "utf8"));
const cases = JSON.parse(readFileSync(`${DIR}/cases.json`, "utf8"));

const WITHOUTBG_MAP = {
  "single-top": "withoutbg-light-background.png",
  "dress": "withoutbg-dark-background.png",
  "patterned": "withoutbg-patterned-garment.png",
  "jacket": "withoutbg-dark-garment.png",
  "worn-dress": "withoutbg-worn-on-body.png",
  "occluded-hoodie": "withoutbg-occluded.png",
  "shoe": "withoutbg-accessory-shoe.png",
};
const CUTOUTS = "bench/extraction/.out/cutouts";

export const PALETTE = [
  ["black", 20, 20, 22], ["white", 244, 241, 234], ["cream", 233, 231, 226],
  ["red", 200, 40, 40], ["blue", 59, 91, 146], ["teal", 31, 111, 139],
  ["gold", 200, 161, 101], ["brown", 122, 84, 51], ["gray", 142, 143, 152],
  ["green", 60, 140, 80], ["navy", 35, 55, 95], ["pink", 220, 150, 170],
  ["orange", 217, 130, 60], ["purple", 120, 80, 160], ["yellow", 220, 200, 90],
];
export function nameColour(r, g, b) {
  let best = PALETTE[0][0];
  let bestD = Infinity;
  for (const [name, pr, pg, pb] of PALETTE) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

export function bboxIoU(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua <= 0 ? 0 : inter / ua;
}

export function dedupeBoxes(list, thresh = 0.5) {
  const kept = [];
  for (const b of list) {
    if (!kept.some((k) => bboxIoU(k.box, b.box) >= thresh)) kept.push(b);
  }
  return kept;
}

/** Conservative vertical-stripe detector on masked RGB rows. Returns striped|solid.
 * Silhouette edges always produce transitions, so only bands strictly interior to the
 * mask's horizontal extent count: a plain garment yields zero, stripes yield 2+. */
export function detectStripes(pixels, width, height, mask) {
  const cols = [];
  let minX = width;
  let maxX = -1;
  for (let x = 0; x < width; x += 4) {
    let r = 0; let g = 0; let bl = 0; let n = 0;
    for (let y = 0; y < height; y += 4) {
      const i = y * width + x;
      if (!mask[i]) continue;
      r += pixels[i * 3]; g += pixels[i * 3 + 1]; bl += pixels[i * 3 + 2]; n++;
    }
    if (n > 10) {
      cols.push([r / n, g / n, bl / n, x]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (cols.length < 8 || maxX <= minX) return "solid";
  const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const mr = median(cols.map((c) => c[0]));
  const mg = median(cols.map((c) => c[1]));
  const mb = median(cols.map((c) => c[2]));
  const margin = 0.04 * (maxX - minX);
  let bands = 0;
  let interior = 0;
  let inBand = false;
  for (const [r, g, b, x] of cols) {
    const d = Math.abs(r - mr) + Math.abs(g - mg) + Math.abs(b - mb);
    const significant = d > 90;
    if (significant && !inBand) {
      bands++;
      if (x > minX + margin && x < maxX - margin) interior++;
      inBand = true;
    }
    if (!significant) inBand = false;
  }
  return bands >= 2 && interior >= 1 ? "striped" : "solid";
}

export const CATEGORY_SUB = { top: "T-shirt", bottom: "pants", dress: "dress", outerwear: "jacket", shoes: "sneaker", bag: "bag", accessory: "accessory", headwear: "hat" };
export function itemName(colour, category) {
  const sub = CATEGORY_SUB[category] ?? category;
  return `${colour[0].toUpperCase()}${colour.slice(1)} ${sub}`;
}
export function itemDescription(colour, pattern, category, box, dims) {
  const sub = CATEGORY_SUB[category] ?? category;
  const cx = (box[0] + box[2]) / 2 / dims[0];
  const cy = (box[1] + box[3]) / 2 / dims[1];
  const horiz = cx < 0.35 ? "on the left" : cx > 0.65 ? "on the right" : "at the center";
  const vert = cy < 0.4 ? "upper part" : cy > 0.6 ? "lower part" : "middle";
  const pat = pattern === "solid" ? "" : `${pattern} `;
  return `the ${colour} ${pat}${sub} ${horiz} of the frame ${vert}`.replace("  ", " ");
}
export function defaultSeason() {
  return ["spring", "summer", "autumn", "winter"];
}
export function defaultFormality() {
  return "casual";
}

async function maskStats(fixturePath, maskPath) {
  const { data, info } = await sharp(maskPath).raw().toBuffer({ resolveWithObject: true });
  const mch = info.channels;
  const img = await sharp(fixturePath).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const hist = new Map();
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i * mch] <= 127) continue;
    n++;
    const r = img.data[i * img.info.channels];
    const g = img.data[i * img.info.channels + 1];
    const b = img.data[i * img.info.channels + 2];
    const key = `${r >> 5},${g >> 5},${b >> 5}`;
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => {
    const [r, g, b] = k.split(",").map((x) => Number(x) * 32 + 16);
    return { colour: nameColour(r, g, b), share: Math.round((v / Math.max(1, n)) * 100) };
  });
  return { pixels: n, top, width: w, height: h };
}

async function referenceBoxes(caseId) {
  if (WITHOUTBG_MAP[caseId]) {
    const { data, info } = await sharp(`${CUTOUTS}/${WITHOUTBG_MAP[caseId]}`).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    let minX = info.width; let minY = info.height; let maxX = -1; let maxY = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * ch + ch - 1] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    // withoutBG cutouts are normalized 1024; scale to fixture 2133.
    const s = 2133 / 1024;
    return [[minX * s, minY * s, (maxX + 1) * s, (maxY + 1) * s]];
  }
  return cases.expectedBoxes[caseId.replace("pants", "pants-bottom").replace("bag", "accessory-bag").replace("multi-outfit", "multi-outfit")] ?? [];
}

export async function runBenchmark() {
const rows = [];
for (const [caseId, spec] of Object.entries(cases.fixtures)) {
  const caseBoxes = boxes[caseId];
  const caseMasks = masks[caseId];
  const refs = cases.reference[caseId].items;
  const expBoxes = await referenceBoxes(caseId);
  const allRuns = [];
  for (const run of caseBoxes.runs) {
    const sel = run.boxes.length > 0
      ? run.boxes.reduce((a, b) => ((b[2] - b[0]) * (b[3] - b[1]) > (a[2] - a[0]) * (a[3] - a[1]) ? b : a))
      : null;
    const maskEntry = caseMasks.masks.find((m) => m.prompt === run.prompt);
    let colour = null;
    let colourShare = 0;
    let pattern = "solid";
    if (maskEntry && sel) {
      const maskPath = `${DIR}/.out/sam-${caseId}-${run.prompt.replace(" ", "")}.png`;
      const stats = await maskStats(`${DIR}/${spec.file}`, maskPath);
      if (stats.top.length > 0) {
        colour = stats.top[0].colour;
        colourShare = stats.top[0].share;
      }
      const rgb = await sharp(`${DIR}/${spec.file}`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const mw = await sharp(maskPath).raw().toBuffer({ resolveWithObject: true });
      const mch = mw.info.channels;
      const bin = new Uint8Array(mw.info.width * mw.info.height);
      for (let i = 0; i < bin.length; i++) bin[i] = mw.data[i * mch] > 127 ? 1 : 0;
      pattern = detectStripes(rgb.data, rgb.info.width, rgb.info.height, bin);
    }
    const bestIoU = sel && expBoxes.length > 0 ? Math.max(...expBoxes.map((e) => bboxIoU(sel, e))) : null;
    allRuns.push({ prompt: run.prompt, inferMs: run.infer_ms, boxes: run.boxes.length, labels: run.labels, selected: sel, bestIoU: bestIoU === null ? null : Math.round(bestIoU * 100) / 100, colour, colourShare, pattern, maskPx: maskEntry?.px ?? 0 });
  }
  const regions = dedupeBoxes(caseBoxes.runs.flatMap((r) => r.boxes.map((box) => ({ box, prompt: r.prompt }))));
  const matched = expBoxes.length > 0 ? expBoxes.filter((e) => regions.some((r) => bboxIoU(r.box, e) >= 0.5)).length : null;
  rows.push({
    caseId, dims: caseBoxes.dims, expectedItemCount: refs.length,
    expected: refs, referenceBoxes: expBoxes.map((b) => b.map(Math.round)),
    runs: allRuns, regionsFound: regions.length,
    regionRecall: matched === null ? null : `${matched}/${expBoxes.length}`,
    florenceLatencyMs: allRuns.reduce((s, r) => s + r.inferMs, 0),
    samLatencyMs: caseMasks.masks.reduce((s, m) => s + (m.infer_ms ?? 0), 0),
  });
}

// sam-masks.json entries lack infer_ms (saved as infer_ms? check) — recompute defensively above guarded.
writeFileSync(`${DIR}/.out/detection-report.json`, JSON.stringify({ rows, generatedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify(rows.map((r) => ({ case: r.caseId, regions: r.regionsFound, recall: r.regionRecall, runs: r.runs.map((x) => ({ p: x.prompt, boxes: x.boxes, iou: x.bestIoU, colour: x.colour, pat: x.pattern })) })), null, 1));
return rows;
}

if ((process.argv[1] ?? "").replaceAll("\\", "/").endsWith("bench/detection/analyze.mjs")) {
  await runBenchmark();
}
