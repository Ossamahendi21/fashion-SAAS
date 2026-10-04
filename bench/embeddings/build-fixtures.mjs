"use strict";

/*
 * Step 7 Phase B0 — freeze the human ground truth into committed JSON fixtures.
 *
 *   node bench/embeddings/build-fixtures.mjs           (rewrite the fixtures)
 *   node bench/embeddings/build-fixtures.mjs --check   (fail if they are stale)
 *
 * corpus.json is DERIVED from convex/shared/demo_wardrobe.ts, so the fixture cannot silently drift
 * from the demo wardrobe; pairs.json and neighbors.json are hand-authored in the *.source.mjs files
 * next to this one and only have their embedding strings derived here.
 *
 * No model, no package, no network, no Convex call. Writes bench/embeddings/*.json only.
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { demoCorpus, embeddingText, EMBEDDING_FIELD_ORDER, EMBEDDING_SEPARATOR } from "./embedding-text.mjs";
import { LABEL_CONTRACT, PAIR_CLASSES } from "./label-contract.mjs";
import { PAIRS } from "./pairs.source.mjs";
import { NEIGHBOR_EXPECTATIONS } from "./neighbors.source.mjs";

const check = process.argv.includes("--check");
const here = (name) => fileURLToPath(new URL(name, import.meta.url));

const write = (name, value) => {
  const path = here(name);
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    let current = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      throw new Error(`${name} is missing. Run: node bench/embeddings/build-fixtures.mjs`);
    }
    if (current !== next) throw new Error(`${name} is stale. Run: node bench/embeddings/build-fixtures.mjs`);
    return;
  }
  writeFileSync(path, next);
  console.log(`wrote ${name}`);
};

mkdirSync(here(".out/"), { recursive: true });

const corpus = {
  schema: "embedding-bench/corpus@1",
  source: "convex/shared/demo_wardrobe.ts",
  contract: {
    replicatedFrom: "convex/ai/openai.ts embeddingInput",
    productionModified: false,
    fieldOrder: EMBEDDING_FIELD_ORDER,
    separator: EMBEDDING_SEPARATOR,
    emptyPartsDropped: true,
  },
  items: demoCorpus(),
};

const pairs = {
  schema: "embedding-bench/pairs@1",
  authoredBy: "human (bench/embeddings/pairs.source.mjs)",
  contract: {
    classes: PAIR_CLASSES,
    labels: LABEL_CONTRACT,
    invariants: ["isDuplicate => isStronglySimilar"],
    phase: "B0 human labels only; Phase B derives the numeric gates from these frozen labels",
  },
  pairs: PAIRS.map((entry) => {
    const labels = LABEL_CONTRACT[entry.cls];
    return {
      id: entry.id,
      cls: entry.cls,
      isDuplicate: labels.isDuplicate,
      isStronglySimilar: labels.isStronglySimilar,
      note: entry.note,
      ...(entry.changedAttributes ? { changedAttributes: entry.changedAttributes } : {}),
      a: { ...entry.a, embeddingText: embeddingText(entry.a) },
      b: { ...entry.b, embeddingText: embeddingText(entry.b) },
    };
  }),
};

const neighbors = {
  schema: "embedding-bench/neighbors@1",
  authoredBy: "human (bench/embeddings/neighbors.source.mjs)",
  contract: {
    meaning:
      "expected = should rank near this item in a similarity ranking (same garment family / same category and style). bad = would be a false neighbour if it ranked high, usually a colour-token or material-token collision.",
    notAsserted: "a total ranking; membership only",
    crossWardrobe:
      "cross-wardrobe ids appear only where the frozen set has no in-wardrobe alternative; shoppingAdvice normally ranks within one wardrobe",
    complementaryOutfitsAreNotNeighbours: true,
  },
  items: NEIGHBOR_EXPECTATIONS,
};

write("corpus.json", corpus);
write("pairs.json", pairs);
write("neighbors.json", neighbors);

if (check) {
  const counts = Object.fromEntries(PAIR_CLASSES.map((cls) => [cls, 0]));
  for (const entry of pairs.pairs) counts[entry.cls] += 1;
  console.log("fixtures are up to date");
  console.log(`  corpus items: ${corpus.items.length}`);
  console.log(`  pairs total:  ${pairs.pairs.length}`);
  for (const cls of PAIR_CLASSES) console.log(`  ${cls.padEnd(28)} ${counts[cls]}`);
  console.log(`  neighbour entries: ${neighbors.items.length}`);
}