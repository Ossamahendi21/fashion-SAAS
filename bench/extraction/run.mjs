"use node";

/*
 * Extraction baseline benchmark (Step 4). Generates the 7 case-type fixtures, then runs one lane:
 *
 *   node bench/extraction/run.mjs --lane mock       (default) no network; exercises the adapter +
 *                                                   square normalization with a stubbed transport.
 *   node bench/extraction/run.mjs --lane withoutbg  hits the self-hosted WITHOUTBG gateway (your own
 *                                                   infra, no charge). Needs WITHOUTBG_BASE_URL and
 *                                                   WITHOUTBG_API_KEY in the environment.
 *   node bench/extraction/run.mjs --lane openai --spend
 *                                                   paid gpt-image-2 reference lane; needs an OpenAI
 *                                                   key (or Vercel AI Gateway key) and the explicit
 *                                                   --spend approval.
 *
 * It never touches the database or the credits ledger, and its artifacts (.out/) are gitignored.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import OpenAI, { toFile } from "openai";

// Pull WITHOUTBG_* (and only those) from .env.local so the live lane can run without exporting them.
{
  const envPath = fileURLToPath(new URL("../../.env.local", import.meta.url));
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = /^(WITHOUTBG_[A-Z_]+)=(.+)$/.exec(line.trim());
      if (match) process.env[match[1]] ??= match[2];
    }
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      for (const extension of [".ts", ".js"]) {
        const candidate = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
});

globalThis.Convex = {
  async asyncSyscall(operation, args) {
    assert.equal(operation, "1.0/createFunctionHandle");
    return JSON.stringify(`handle:${JSON.parse(args).name}`);
  },
};

const { ensureSquareCutout, withoutBgExtract, withoutBgConfig, parseWithoutBgBytes } = await import(
  "../../convex/ai/extraction.ts"
);
const { usageToUsd } = await import("../../convex/shared/credits.ts");

const OUT = new URL("./.out/", import.meta.url);
const FIXTURES = new URL("./.out/fixtures/", import.meta.url);
const CUTOUTS = new URL("./.out/cutouts/", import.meta.url);

for (const dir of [OUT, FIXTURES, CUTOUTS]) mkdirSync(fileURLToPath(dir), { recursive: true });

const svgFrame = (bg, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${bg}"/>${body}</svg>`;
const rasterize = async (bg, body) => {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(svgFrame(bg, body)), { density: 150 }).png().toBuffer();
};

const Tee = (fill) =>
  `<path fill="${fill}" d="M492 288 L560 236 L812 264 L836 436 L724 482 L724 868 L296 868 L296 482 L184 436 L208 264 L460 236 Z"/>`;
const Dress = (fill) =>
  `<path fill="${fill}" d="M472 268 L548 252 L700 300 L720 470 L658 820 L360 820 L300 470 L320 300 Z"/>`;
const Jacket = (fill, lapel) =>
  `<path fill="${fill}" d="M470 296 L470 226 L250 268 L180 428 L290 476 L290 856 L734 856 L734 476 L844 428 L774 268 L554 226 Z"/>` +
  `<path fill="${lapel}" d="M470 296 L560 344 L470 420 L378 344 Z"/><path fill="${lapel}" d="M554 296 L464 344 L554 420 L646 344 Z"/>`;
const stripes = (x) => `<rect x="${x}" y="120" width="52" height="880" fill="#d43a2f" opacity="0.85"/>`;
const Hoodie = (fill) =>
  `<circle cx="512" cy="230" r="64" fill="${fill}"/><path fill="${fill}" d="M450 252 L470 240 L470 214 L380 136 L180 250 L200 420 L290 452 L290 860 L734 860 L734 452 L824 420 L844 250 L644 136 L554 214 Z"/>`;
const Shoe = (fill, accent) =>
  `<path fill="${fill}" d="M216 640 L424 576 L640 536 C704 528 780 542 800 596 L828 640 C856 694 828 744 764 744 L588 744 L608 696 L420 696 L344 740 L120 744 L116 672 C138 650 180 648 216 640 Z"/>` +
  `<path fill="${accent}" d="M424 576 C500 566 576 562 640 536 L684 620 L608 632 L424 640 Z"/>`;

const CASES = [
  { id: "light-background", bg: "#f2f0ec", body: () => Tee("#3b5b92") },
  { id: "dark-background", bg: "#1b1b1f", body: () => Dress("#c8a165") },
  { id: "patterned-garment", bg: "#e9e7e2", body: () => `${Tee("#f4f1ea")}${stripes(430)}${stripes(542)}` },
  { id: "dark-garment", bg: "#f1efe9", body: () => Jacket("#2a2a2e", "#141416") },
  { id: "worn-on-body", bg: "#e2dbcf", body: () => `${Dress("#1f6f8b").replace("828 Z", "906 Z")}<ellipse cx="512" cy="940" rx="230" ry="150" fill="#d9a06b"/>` },
  { id: "occluded", bg: "#efefee", body: () => `${Hoodie("#b3402f")}<rect x="620" y="120" width="330" height="420" rx="18" fill="#8e8f98"/>` },
  { id: "accessory-shoe", bg: "#f4f1ea", body: () => Shoe("#e8e6e1", "#bcc0c4") },
];

async function generateFixtures() {
  for (const c of CASES) {
    const target = fileURLToPath(new URL(`${c.id}.png`, FIXTURES));
    if (existsSync(target)) continue;
    writeFileSync(target, Buffer.from(await rasterize(c.bg, c.body())));
  }
}

const BASE_PROMPT = "Clean e-commerce flat-lay product photo of the one item, front view, on a transparent background.";
const SUBJECT = (id) => id.replace(/-/g, " ");

async function mockTransport() {
  return async () => {
    const png = await rasterize("none", `<rect x="128" y="160" width="768" height="704" rx="28" fill="#3b5b92"/>`);
    const body = new Uint8Array(png.byteLength);
    body.set(png);
    return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
  };
}

function parseArgs(argv) {
  const flags = { lane: "mock", spend: false, cases: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--lane") flags.lane = argv[++i];
    else if (arg === "--spend") flags.spend = true;
    else if (arg === "--cases") flags.cases = argv[++i] ?? flags.cases;
    else throw new Error(`Unknown flag ${arg}`);
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv);
  await generateFixtures();
  const selected = flags.cases ? flags.cases.split(",") : null;
  const rows = [];

  for (const c of CASES) {
    if (selected && !selected.includes(c.id)) continue;
    const input = new Uint8Array(readFileSync(fileURLToPath(new URL(`${c.id}.png`, FIXTURES))));
    const prompt = `${BASE_PROMPT} Subject: ${SUBJECT(c.id)}.`;
    let result;
    let error = null;

    if (flags.lane === "openai") {
      if (!flags.spend) throw new Error("The openai lane spends money; pass --spend to run it.");
      const started = Date.now();
      try {
        const client = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY ?? process.env.AI_GATEWAY_API_KEY,
          ...(process.env.OPENAI_API_KEY ? {} : { baseURL: "https://ai-gateway.vercel.sh/v1" }),
        });
        const edited = await client.images.edit({
          model: "gpt-image-2",
          image: await toFile(input, "photo.png", { type: "image/png" }),
          prompt,
          size: "1024x1024",
          quality: "medium",
          output_format: "png",
          background: "transparent",
        });
        const b64 = edited.data?.[0]?.b64_json;
        if (!b64) throw new Error("no image in response");
        const raw = Buffer.from(b64, "base64");
        const bytes = new Uint8Array(raw.byteLength);
        bytes.set(raw);
        const usage = edited.usage
          ? {
              inputTextTokens: edited.usage.input_tokens_details?.text_tokens ?? 0,
              inputImageTokens: edited.usage.input_tokens_details?.image_tokens ?? 0,
              outputTokens: edited.usage.output_tokens ?? 0,
            }
          : { inputTextTokens: 0, inputImageTokens: 0, outputTokens: 0 };
        result = { bytes, usage, costUsd: usageToUsd(usage), latencyMs: Date.now() - started };
      } catch (caught) {
        error = caught;
      }
    } else {
      const config =
        flags.lane === "withoutbg"
          ? withoutBgConfig()
          : withoutBgConfig({ ...process.env, WITHOUTBG_BASE_URL: "https://mock.local", WITHOUTBG_API_KEY: "mock" });
      const transport = flags.lane === "mock" ? await mockTransport() : undefined;
      try {
        result = await withoutBgExtract({ bytes: input, prompt }, config, transport);
      } catch (caught) {
        error = caught;
      }
    }

    if (error) {
      rows.push({ caseId: c.id, lane: flags.lane, ok: false, error: error.message, kind: error.kind });
      continue;
    }

    const square = await ensureSquareCutout(result.bytes);
    const parsed = parseWithoutBgBytes(square.bytes);
    const cutoutPath = fileURLToPath(new URL(`${flags.lane}-${c.id}.png`, CUTOUTS));
    writeFileSync(cutoutPath, Buffer.from(square.bytes));
    rows.push({
      caseId: c.id,
      lane: flags.lane,
      ok: true,
      width: square.width,
      height: square.height,
      alpha: parsed.hasAlpha,
      background: result.background ?? (parsed.hasAlpha ? "transparent" : "opaque"),
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      cutout: cutoutPath,
    });
  }

  const ok = rows.filter((r) => r.ok);
  const summary = {
    lane: flags.lane,
    date: new Date().toISOString(),
    cases: rows.length,
    ok: ok.length,
    failed: rows.length - ok.length,
    meanLatencyMs: ok.length ? Math.round(ok.reduce((sum, r) => sum + r.latencyMs, 0) / ok.length) : null,
    totalCostUsd: Math.round((ok.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) + Number.EPSILON) * 1000000) / 1000000,
  };
  writeFileSync(
    fileURLToPath(new URL("report.json", OUT)),
    JSON.stringify({ summary, rows }, null, 2),
  );
  console.table(
    rows.map((r) => ({
      case: r.caseId,
      ok: r.ok,
      alpha: r.alpha ?? r.kind ?? "-",
      dims: r.width ? `${r.width}x${r.height}` : r.error ?? "-",
      costUsd: r.costUsd ?? "-",
      latencyMs: r.latencyMs ?? "-",
    })),
  );
  console.log(JSON.stringify(summary));
  process.exit(ok.length === rows.length ? 0 : 1);
}

await main();