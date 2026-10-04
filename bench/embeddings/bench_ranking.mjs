/**
 * Step 7 Phase B2 — shopping-similarity ranking benchmark.
 *
 * Reuses the frozen B0 fixtures (corpus.json, neighbors.json), the B1 BGE vectors
 * (.out/b1-corpus-vectors.json) and the B1 pair scores (.out/b1-pairs-scored.json).
 * No model is loaded or trained here: this is pure arithmetic over B1's output.
 *
 * Rules compared, both deterministic and neither tuned per item:
 *   A. raw            — BGE cosine order, unchanged.
 *   B. same-category  — the candidate pool is reordered so canonical `item.category`
 *                       matches sort ahead of everything else, cosine order preserved
 *                       inside each partition (a stable partition, i.e. a rerank).
 *
 * Writes .out/b2-ranking.json. Frozen fixtures are read-only.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, ".out");
const readJson = (path) => JSON.parse(readFileSync(isAbsolute(path) ? path : resolve(HERE, path), "utf8"));

const POOL_SIZES = [8, 16, 32];
const TOP_KS = [3, 8];

const corpus = readJson("corpus.json");
const neighbors = readJson("neighbors.json");
const vectorsDoc = readJson(join(OUT_DIR, "b1-corpus-vectors.json"));
const pairsScored = readJson(join(OUT_DIR, "b1-pairs-scored.json"));

// ----------------------------------------------------------------------- fixture integrity

const corpusIds = corpus.items.map((item) => item.id);
const vectorIds = vectorsDoc.items.map((item) => item.id);
const expectations = new Map(neighbors.items.map((item) => [item.id, item]));

const problems = [];
if (corpus.items.length !== 16) problems.push(`corpus is ${corpus.items.length}, expected 16`);
if (JSON.stringify(corpusIds) !== JSON.stringify(vectorIds)) {
  problems.push("vector ids do not match frozen corpus ids in order");
}
if (vectorsDoc.dim !== 384) problems.push(`vector dim is ${vectorsDoc.dim}, expected 384`);
for (const item of vectorsDoc.items) {
  if (item.vector.length !== 384) problems.push(`${item.id} has ${item.vector.length} dims`);
  if (!expectations.has(item.id)) problems.push(`${item.id} has no neighbours.json entry`);
}
for (const [, entry] of expectations) {
  for (const id of [...entry.expected, ...entry.bad]) {
    if (!corpusIds.includes(id)) problems.push(`neighbours.json references unknown id ${id}`);
  }
}
if (problems.length) {
  console.error("fixture integrity failed:\n  " + problems.join("\n  "));
  process.exit(1);
}

// ----------------------------------------------------------------------- helpers

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
};

const categoryOf = new Map(vectorsDoc.items.map((item) => [item.id, item.category]));

/** Cosine order for one query, self excluded. Ties break on id so the run is reproducible. */
function cosineOrder(queryIndex) {
  const query = vectorsDoc.items[queryIndex];
  return vectorsDoc.items
    .map((item, index) => ({ id: item.id, index, score: index === queryIndex ? -Infinity : dot(query.vector, item.vector) }))
    .filter((row) => row.score > -Infinity)
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
    .map((row) => ({ id: row.id, score: row.score }));
}

/** Rule A: BGE order, untouched. */
function ruleRaw(order) {
  return order;
}

/** Rule B: stable partition putting the query's own category first, cosine order kept inside. */
function ruleSameCategoryFirst(order, queryCategory) {
  const same = [];
  const rest = [];
  for (const row of order) (categoryOf.get(row.id) === queryCategory ? same : rest).push(row);
  return [...same, ...rest];
}

function pool(order, size) {
  return order.slice(0, Math.min(size, order.length));
}

function judged(head, expectation) {
  const expected = new Set(expectation.expected);
  const bad = new Set(expectation.bad);
  return head.map((row) => ({
    id: row.id,
    score: Number(row.score.toFixed(4)),
    judgement: expected.has(row.id) ? "expected" : bad.has(row.id) ? "bad" : "neutral",
  }));
}

function evaluate(orderedIds, expectation) {
  const expected = new Set(expectation.expected);
  const bad = new Set(expectation.bad);
  const result = { expectedTotal: expected.size };
  for (const k of TOP_KS) {
    const head = orderedIds.slice(0, k);
    result[`expectedInTop${k}`] = head.filter((id) => expected.has(id)).length;
    result[`badInTop${k}`] = head.filter((id) => bad.has(id)).length;
    result[`filledTop${k}`] = head.length;
    result[`allExpectedInTop${k}`] = expected.size > 0 && result[`expectedInTop${k}`] === expected.size;
  }
  return result;
}

// ----------------------------------------------------------------------- benchmark

const RULES = [
  { id: "A_raw", label: "raw BGE ranking", apply: (order) => ruleRaw(order) },
  {
    id: "B_same_category_first",
    label: "same-category-first BGE rerank",
    apply: (order, queryCategory) => ruleSameCategoryFirst(order, queryCategory),
  },
];

const results = {};
for (const rule of RULES) {
  results[rule.id] = { label: rule.label, pools: {} };

  for (const size of POOL_SIZES) {
    const perItem = [];
    const totals = {};
    for (const k of TOP_KS) {
      totals[`expectedHitsTop${k}`] = 0;
      totals[`expectedTotalTop${k}`] = 0;
      totals[`badHitsTop${k}`] = 0;
      totals[`itemsWithAllExpectedTop${k}`] = 0;
      totals[`itemsTouchedByBadTop${k}`] = 0;
    }

    for (let queryIndex = 0; queryIndex < vectorsDoc.items.length; queryIndex += 1) {
      const item = vectorsDoc.items[queryIndex];
      const expectation = expectations.get(item.id);
      const ordered = rule.apply(cosineOrder(queryIndex), categoryOf.get(item.id));
      const pooled = pool(ordered, size);
      const ids = pooled.map((row) => row.id);
      const metrics = evaluate(ids, expectation);
      const sameCategoryInPool = ids.filter((id) => categoryOf.get(id) === categoryOf.get(item.id)).length;

      for (const k of TOP_KS) {
        totals[`expectedHitsTop${k}`] += metrics[`expectedInTop${k}`];
        totals[`expectedTotalTop${k}`] += metrics.expectedTotal;
        totals[`badHitsTop${k}`] += metrics[`badInTop${k}`];
        if (metrics[`allExpectedInTop${k}`]) totals[`itemsWithAllExpectedTop${k}`] += 1;
        if (metrics[`badInTop${k}`] > 0) totals[`itemsTouchedByBadTop${k}`] += 1;
      }

      perItem.push({
        id: item.id,
        name: item.name,
        category: item.category,
        sameCategoryInPool,
        ...metrics,
        top3: judged(pooled.slice(0, 3), expectation),
        top8: judged(pooled.slice(0, 8), expectation),
      });
    }

    results[rule.id].pools[size] = {
      poolSize: size,
      effectivePoolSize: Math.min(size, vectorsDoc.items.length - 1),
      perQuery: perItem,
      summary: Object.fromEntries(
        TOP_KS.map((k) => [
          `top${k}`,
          {
            expectedRecall: `${totals[`expectedHitsTop${k}`]}/${totals[`expectedTotalTop${k}`]}`,
            expectedRecallFraction:
              Number((totals[`expectedHitsTop${k}`] / totals[`expectedTotalTop${k}`]).toFixed(4)),
            badInTop: totals[`badHitsTop${k}`],
            itemsTouchedByBad: totals[`itemsTouchedByBadTop${k}`],
            itemsWithAllExpected: `${totals[`itemsWithAllExpectedTop${k}`]}/16`,
          },
        ]),
      ),
    };
  }
}

// ----------------------------------------------------------------------- strong similarity prose

/**
 * The user-facing "Very similar to your X" sentence. Evaluated ONLY against
 * isStronglySimilar; isDuplicate is never consulted, so this signal can not
 * re-acquire ownership of items.duplicateOfId.
 */
function proseSweep(threshold) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const falsePositives = [];
  for (const pair of pairsScored) {
    const fires = pair.cosine >= threshold;
    const should = pair.isStronglySimilar;
    if (fires && should) tp += 1;
    else if (fires && !should) {
      fp += 1;
      falsePositives.push({ pairId: pair.pairId, cls: pair.cls, cosine: pair.cosine });
    } else if (!fires && should) fn += 1;
    else tn += 1;
  }
  return {
    threshold,
    fires: tp + fp,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision: tp + fp === 0 ? 1 : Number((tp / (tp + fp)).toFixed(4)),
    recall: tp + fn === 0 ? 1 : Number((tp / (tp + fn)).toFixed(4)),
    falsePositiveDetail: falsePositives.sort((a, b) => b.cosine - a.cosine),
  };
}

const PROSE_THRESHOLDS = [0.92, 0.896396];
const prose = {
  note:
    "LIMITS.duplicateCosineThreshold (0.92) is currently shared by the duplicate flag and the " +
    "advice sentence. B2 splits them: only this prose gate uses a strong-similarity threshold, " +
    "and it never writes items.duplicateOfId.",
  candidates: PROSE_THRESHOLDS.map(proseSweep),
  duplicateLabelsConsulted: false,
};

/**
 * What today's production flag actually does on the frozen human labels: cosine >= 0.92
 * predicts isDuplicate. Recorded because removing automatic assignment is only acceptable
 * if the flag being removed is understood, not merely because it is removable.
 */
const LEGACY_FLAG_THRESHOLD = 0.92;
const legacyFlag = (() => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const pair of pairsScored) {
    const fires = pair.cosine >= LEGACY_FLAG_THRESHOLD;
    const isDuplicate = pair.isDuplicate;
    if (fires && isDuplicate) tp += 1;
    else if (fires && !isDuplicate) fp += 1;
    else if (!fires && isDuplicate) fn += 1;
    else tn += 1;
  }
  return {
    threshold: LEGACY_FLAG_THRESHOLD,
    note: "convex/ai/openai.ts:365 — vectorSearch(limit 4) filtered at _score >= 0.92, ready[0] wins",
    pairsEvaluated: pairsScored.length,
    duplicatesInFixture: tp + fn,
    nonDuplicatesInFixture: fp + tn,
    wouldFlag: tp + fp,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision: Number((tp / (tp + fp)).toFixed(4)),
    recall: Number((tp / (tp + fn)).toFixed(4)),
    falsePositiveRateAmongNonDuplicates: Number((fp / (fp + tn)).toFixed(4)),
  };
})();

// ----------------------------------------------------------------------- output

mkdirSync(OUT_DIR, { recursive: true });
const payload = {
  benchmark: "step7-phase-b2-ranking",
  model: vectorsDoc.model,
  revision: vectorsDoc.revision,
  dim: vectorsDoc.dim,
  vectorsFrom: vectorsDoc.producedBy,
  frozenFixtures: ["corpus.json", "neighbors.json"],
  poolSizes: POOL_SIZES,
  topKs: TOP_KS,
  categoryCounts: vectorsDoc.items.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] ?? 0) + 1;
    return acc;
  }, {}),
  rules: results,
  strongSimilarityProse: prose,
  legacyDuplicateFlag: legacyFlag,
};

writeFileSync(join(OUT_DIR, "b2-ranking.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`corpus=${corpus.items.length} dim=${vectorsDoc.dim} pools=${POOL_SIZES.join(",")}`);
console.log(`categories: ${JSON.stringify(payload.categoryCounts)}`);
for (const rule of RULES) {
  for (const size of POOL_SIZES) {
    const { top3, top8 } = results[rule.id].pools[size].summary;
    console.log(
      `${rule.id.padEnd(26)} pool=${String(size).padStart(2)} ` +
        `exp@3=${top3.expectedRecall} bad@3=${top3.badInTop} allExp@3=${top3.itemsWithAllExpected} | ` +
        `exp@8=${top8.expectedRecall} bad@8=${top8.badInTop} allExp@8=${top8.itemsWithAllExpected}`,
    );
  }
}
for (const row of prose.candidates) {
  console.log(
    `prose t=${row.threshold} fires=${row.fires} P=${row.precision} R=${row.recall} FP=${row.falsePositives}`,
  );
}
console.log(
  `legacy flag t=${legacyFlag.threshold}: wouldFlag=${legacyFlag.wouldFlag} ` +
    `P=${legacyFlag.precision} R=${legacyFlag.recall} FP=${legacyFlag.falsePositives}/${legacyFlag.nonDuplicatesInFixture}`,
);
console.log("wrote .out/b2-ranking.json");