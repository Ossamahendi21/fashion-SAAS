// Step 6 Phase B extra fixtures (synthetic SVG, same vocabulary as bench/extraction/run.mjs).
// New cases only: pants/bottom, accessory-bag, multi-item outfit. 2133px like the rest.
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const DIR = "bench/detection/fixtures";
mkdirSync(DIR, { recursive: true });

const svg = (bg, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${bg}"/>${body}</svg>`;
const render = async (name, bg, body) => {
  const buf = await sharp(Buffer.from(svg(bg, body)), { density: 150 }).png().toBuffer();
  writeFileSync(`${DIR}/${name}.png`, buf);
  const meta = await sharp(buf).metadata();
  console.log(name, `${meta.width}x${meta.height}`, `${buf.length}B`);
};

// Pants: two legs + waistband, denim blue.
await render(
  "pants-bottom",
  "#f1efe9",
  `<rect x="360" y="240" width="304" height="60" fill="#2e4a6b"/>` +
    `<path fill="#33507a" d="M360 300 L512 300 L512 880 L400 880 L380 420 L360 300 Z"/>` +
    `<path fill="#33507a" d="M512 300 L664 300 L644 420 L624 880 L512 880 Z"/>`,
);

// Accessory: handbag with handles.
await render(
  "accessory-bag",
  "#f4f1ea",
  `<ellipse cx="430" cy="330" rx="46" ry="46" fill="none" stroke="#6b4a2f" stroke-width="22"/>` +
    `<ellipse cx="594" cy="330" rx="46" ry="46" fill="none" stroke="#6b4a2f" stroke-width="22"/>` +
    `<rect x="330" y="360" width="364" height="420" rx="36" fill="#7a5433"/>` +
    `<rect x="330" y="360" width="364" height="60" rx="24" fill="#6b4a2f"/>`,
);

// Multi-item: tee (top-left) + pants (bottom-right), both fully visible.
await render(
  "multi-outfit",
  "#efefee",
  `<path fill="#3b5b92" d="M180 300 L240 260 L380 276 L392 380 L330 400 L330 640 L170 640 L170 400 L108 380 L120 276 L180 260 Z"/>` +
    `<path fill="#33507a" d="M620 420 L760 420 L760 470 L740 470 L730 860 L650 860 L640 470 L620 470 Z"/>` +
    `<path fill="#33507a" d="M620 420 L690 420 L690 860 L610 860 L600 470 Z"/>`,
);
