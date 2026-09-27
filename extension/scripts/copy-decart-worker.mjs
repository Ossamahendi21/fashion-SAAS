// Copies the Decart frame-metadata worker into vendor/.
// Cross-platform replacement for `cp` (which fails on Windows).
import { copyFileSync, existsSync } from "node:fs";

const src = "node_modules/@decartai/sdk/dist/realtime/browser/frame-metadata-worker.js";
const dest = "vendor/frame-metadata-worker.js";

if (!existsSync(src)) {
  throw new Error(`Decart worker source file does not exist: ${src}`);
}

copyFileSync(src, dest);
console.log(`Copied ${src} to ${dest}`);
