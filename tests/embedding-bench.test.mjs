// Step 7 Phase B0: the frozen benchmark corpus must stay byte-identical to the production
// embedding-text contract, and the hand-authored labels must stay well-formed.
// Pure string/fixture checks. No model, no network, no Convex call, no OpenAI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const {
  DEMO_WARDROBE,
  demoCorpus,
  embeddingText,
  EMBEDDING_SEPARATOR,
  EMBEDDING_FIELD_ORDER,
} = await import("../bench/embeddings/embedding-text.mjs");
const { CATEGORIES } = await import("../convex/shared/wardrobe.ts");
const { PAIR_CLASSES, LABEL_CONTRACT } = await import("../bench/embeddings/label-contract.mjs");

const readJson = (name) => JSON.parse(readFileSync(new URL(`../bench/embeddings/${name}`, import.meta.url), "utf8"));
const corpus = readJson("corpus.json");
const pairs = readJson("pairs.json");
const neighbors = readJson("neighbors.json");

const EXPECTED_FIELD_ORDER = [
  "name",
  "category",
  "subcategory",
  "colours.primary",
  "colours.secondary[]",
  "colours.hex[]",
  "pattern",
  "material",
  "description",
];

/** The tokens production would produce, in order, for one item. */
const expectedTokens = (attributes) => [
  attributes.name,
  attributes.category,
  attributes.subcategory,
  attributes.colours.primary,
  ...attributes.colours.secondary,
  ...attributes.colours.hex,
  attributes.pattern,
  attributes.material,
  attributes.description,
];

const words = (item) =>
  new Set(
    `${item.name} ${item.subcategory} ${item.material} ${item.description}`
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter(Boolean),
  );

/** Anything that would mean a model output leaked into human ground truth. */
const FORBIDDEN_KEY = /^(score|scores|similarity|cosine|distance|vector|vectors|embedding|embeddings|threshold|thresholds|rank|ranking|ranked|neighbours_scored|model|model_id|dimensions|dim)$/i;

const walk = (node, visit, path = "$") => {
  visit(node, path);
  if (Array.isArray(node)) node.forEach((child, index) => walk(child, visit, `${path}[${index}]`));
  else if (node && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) walk(child, visit, `${path}.${key}`);
  }
};

const leaves = (node) => {
  const found = [];
  walk(node, (value, path) => {
    if (value === null || typeof value !== "object") found.push([path, value]);
  });
  return found;
};

// ---------------------------------------------------------------------------------------------
// Corpus: 16 demo garments, byte-pinned against the production contract.
// ---------------------------------------------------------------------------------------------

test("corpus freezes exactly the 16 demo garments, in source order", () => {
  assert.equal(DEMO_WARDROBE.length, 16, "the demo wardrobe itself must stay at 16 items");
  assert.equal(corpus.items.length, 16);
  assert.deepEqual(
    corpus.items.map((item) => item.id),
    DEMO_WARDROBE.map((entry) => entry.key),
  );
  assert.equal(new Set(corpus.items.map((item) => item.id)).size, 16, "corpus ids must be unique");
});

test("the separator is a space, U+00B7 MIDDLE DOT, space", () => {
  assert.equal(EMBEDDING_SEPARATOR, " · ");
  assert.deepEqual([...EMBEDDING_SEPARATOR], [" ", "\u00b7", " "]);
  assert.equal(corpus.contract.separator, EMBEDDING_SEPARATOR);
});

test("the field order is the production order and is recorded in the fixture", () => {
  assert.deepEqual(EMBEDDING_FIELD_ORDER, EXPECTED_FIELD_ORDER);
  assert.deepEqual(corpus.contract.fieldOrder, EXPECTED_FIELD_ORDER);
  assert.equal(corpus.contract.replicatedFrom, "convex/ai/openai.ts embeddingInput");
  assert.equal(corpus.contract.productionModified, false);
});

test("every corpus embeddingText is byte-identical to the production contract", () => {
  const derived = demoCorpus();
  assert.equal(derived.length, 16);
  for (const [index, entry] of DEMO_WARDROBE.entries()) {
    assert.equal(corpus.items[index].embeddingText, embeddingText(entry.attributes));
    assert.equal(corpus.items[index].embeddingText, derived[index].embeddingText);
    assert.equal(corpus.items[index].name, entry.attributes.name);
  }
});

test("splitting on the separator reproduces the production field order for all 16 items", () => {
  for (const [index, entry] of DEMO_WARDROBE.entries()) {
    const tokens = corpus.items[index].embeddingText.split(EMBEDDING_SEPARATOR);
    assert.deepEqual(tokens, expectedTokens(entry.attributes), entry.key);
    assert.ok(tokens.every((token) => token.length > 0), `${entry.key} must not contain empty tokens`);
  }
});

test("empty colour lists are dropped rather than joined as empty segments", () => {
  const longSleeve = corpus.items.find((item) => item.id === "v2-men-mens-long-sleeve");
  const tokens = longSleeve.embeddingText.split(EMBEDDING_SEPARATOR);
  assert.equal(tokens.length, 8, "name, category, subcategory, primary, one hex, pattern, material, description");
  assert.deepEqual(tokens, [
    "Navy long-sleeve tee",
    "top",
    "long-sleeve T-shirt",
    "navy",
    "#3f5577",
    "solid",
    "cotton",
    "An adult men’s fitted navy long-sleeve crew-neck T-shirt.",
  ]);

  const checkShirt = corpus.items.find((item) => item.id === "v2-men-blue-check-shirt");
  assert.equal(checkShirt.embeddingText.split(EMBEDDING_SEPARATOR).length, 11, "2 secondary colours + 2 hex");
});

test("the corpus pins the byte-identical denim pair and the gendered-trainer difference", () => {
  const men = corpus.items.find((item) => item.id === "v2-men-blue-jeans");
  const women = corpus.items.find((item) => item.id === "v2-women-blue-jeans");
  assert.equal(men.embeddingText, women.embeddingText, "these two demo items are textually identical");

  const menTrainers = corpus.items.find((item) => item.id === "v2-men-white-red-trainers");
  const womenTrainers = corpus.items.find((item) => item.id === "v2-women-white-red-trainers");
  assert.notEqual(menTrainers.embeddingText, womenTrainers.embeddingText);
  assert.equal(menTrainers.embeddingText, womenTrainers.embeddingText.replace("women’s", "men’s"));
});

// ---------------------------------------------------------------------------------------------
// Pairs: valid, unambiguous, human-labelled ground truth.
// ---------------------------------------------------------------------------------------------

test("every pair class is one of the seven declared classes", () => {
  assert.equal(PAIR_CLASSES.length, 7);
  assert.deepEqual(pairs.contract.classes, PAIR_CLASSES);
  for (const entry of pairs.pairs) assert.ok(PAIR_CLASSES.includes(entry.cls), entry.id);
});

test("every pair carries the label combination its class declares", () => {
  for (const entry of pairs.pairs) {
    const contract = LABEL_CONTRACT[entry.cls];
    assert.equal(typeof entry.isDuplicate, "boolean", entry.id);
    assert.equal(typeof entry.isStronglySimilar, "boolean", entry.id);
    assert.equal(entry.isDuplicate, contract.isDuplicate, `${entry.id} isDuplicate`);
    assert.equal(entry.isStronglySimilar, contract.isStronglySimilar, `${entry.id} isStronglySimilar`);
  }
  assert.deepEqual(pairs.contract.labels, LABEL_CONTRACT);
});

test("the duplicate gate implies the strong-similarity gate everywhere", () => {
  for (const entry of pairs.pairs) {
    if (entry.isDuplicate) assert.ok(entry.isStronglySimilar, `${entry.id} duplicates must be strongly similar`);
  }
});

test("pair ids are unique and each class owns exactly one id prefix", () => {
  const ids = pairs.pairs.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate pair id");

  const byClass = new Map();
  const byPrefix = new Map();
  for (const entry of pairs.pairs) {
    const match = /^([a-z]+)-(\d{3})$/.exec(entry.id);
    assert.ok(match, `malformed pair id ${entry.id}`);
    const [, prefix] = match;
    const clsPrefixes = byClass.get(entry.cls) ?? new Set();
    clsPrefixes.add(prefix);
    byClass.set(entry.cls, clsPrefixes);
    const prefixClasses = byPrefix.get(prefix) ?? new Set();
    prefixClasses.add(entry.cls);
    byPrefix.set(prefix, prefixClasses);
  }
  for (const [cls, prefixes] of byClass) assert.equal(prefixes.size, 1, `${cls} must use one id prefix`);
  for (const [prefix, classes] of byPrefix) assert.equal(classes.size, 1, `${prefix} must belong to one class`);
});

test("every class has at least 12 pairs and the fixture holds at least 84", () => {
  const counts = Object.fromEntries(PAIR_CLASSES.map((cls) => [cls, 0]));
  for (const entry of pairs.pairs) counts[entry.cls] += 1;
  for (const cls of PAIR_CLASSES) assert.ok(counts[cls] >= 12, `${cls} has only ${counts[cls]} pairs`);
  assert.ok(pairs.pairs.length >= 84, `only ${pairs.pairs.length} pairs`);
});

test("pairs record what changed: near-duplicates must, true duplicates must not", () => {
  for (const entry of pairs.pairs) {
    if (entry.cls === "near_duplicate") {
      assert.ok(Array.isArray(entry.changedAttributes) && entry.changedAttributes.length > 0, entry.id);
      assert.ok(entry.changedAttributes.every((value) => typeof value === "string" && value.length > 0), entry.id);
    }
    if (entry.cls === "true_duplicate") assert.equal(entry.changedAttributes, undefined, entry.id);
    assert.equal(typeof entry.note, "string");
    assert.ok(entry.note.length > 20, `${entry.id} note must explain the label for a human reviewer`);
  }
});

test("every pair's two items use contract-derived embedding text and are not the same string", () => {
  for (const entry of pairs.pairs) {
    for (const side of ["a", "b"]) {
      const item = entry[side];
      assert.equal(item.embeddingText, embeddingText(item), `${entry.id}.${side}`);
      assert.ok(CATEGORIES.includes(item.category), `${entry.id}.${side} category ${item.category}`);
      assert.ok(item.colours.hex.length >= 1, `${entry.id}.${side} must carry hex like production`);
      assert.match(item.colours.hex[0], /^#[0-9a-f]{6}$/, `${entry.id}.${side} hex`);
      assert.equal(item.embeddingText.split(EMBEDDING_SEPARATOR).length, expectedTokens(item).length, `${entry.id}.${side}`);
    }
    assert.notEqual(entry.a.embeddingText, entry.b.embeddingText, `${entry.id} must compare two distinct strings`);
  }
});

test("hard negatives really are lexically hard: every pair shares at least two content words", () => {
  for (const entry of pairs.pairs) {
    if (entry.cls !== "hard_negative") continue;
    const left = words(entry.a);
    const right = words(entry.b);
    const shared = [...left].filter((word) => right.has(word));
    assert.ok(shared.length >= 2, `${entry.id} shares only ${shared.join(", ") || "nothing"}`);
  }
});

test("same-category and same-colour pairs really do differ on exactly that axis", () => {
  for (const entry of pairs.pairs) {
    if (entry.cls === "same_category_diff_colour") {
      assert.equal(entry.a.category, entry.b.category, entry.id);
      assert.equal(entry.a.subcategory, entry.b.subcategory, entry.id);
      assert.notEqual(entry.a.colours.primary, entry.b.colours.primary, `${entry.id} must differ in colour`);
    }
    if (entry.cls === "same_colour_diff_category") {
      const shared = [entry.a.colours.primary, entry.b.colours.primary].filter(
        (colour, _, all) => all.includes(colour) && all.indexOf(colour) !== _,
      );
      assert.equal(entry.a.colours.primary, entry.b.colours.primary, `${entry.id} must share the colour`);
      assert.notEqual(entry.a.category, entry.b.category, `${entry.id} must differ in category`);
      assert.notEqual(entry.a.subcategory, entry.b.subcategory, entry.id);
      assert.ok(shared.length >= 0);
    }
  }
});

test("related pairs stay complementary: different garment roles, not the same garment family", () => {
  for (const entry of pairs.pairs) {
    if (entry.cls !== "related_not_duplicate") continue;
    assert.notEqual(entry.a.subcategory, entry.b.subcategory, `${entry.id} must not be the same garment type`);
  }
});

// ---------------------------------------------------------------------------------------------
// Neighbours: membership only, no ranking.
// ---------------------------------------------------------------------------------------------

test("the neighbour fixture covers exactly the 16 demo garments", () => {
  assert.equal(neighbors.items.length, 16);
  assert.deepEqual(
    neighbors.items.map((entry) => entry.id),
    DEMO_WARDROBE.map((entry) => entry.key),
  );
});

test("neighbour lists reference real garments, never themselves, and never both ways", () => {
  const known = new Set(DEMO_WARDROBE.map((entry) => entry.key));
  for (const entry of neighbors.items) {
    for (const list of [entry.expected, entry.bad]) {
      assert.ok(Array.isArray(list), entry.id);
      assert.equal(new Set(list).size, list.length, `${entry.id} repeats a neighbour`);
      for (const id of list) {
        assert.ok(known.has(id), `${entry.id} references unknown garment ${id}`);
        assert.notEqual(id, entry.id, `${entry.id} must not neighbour itself`);
      }
    }
    const overlap = entry.expected.filter((id) => entry.bad.includes(id));
    assert.deepEqual(overlap, [], `${entry.id} marks ${overlap.join(", ")} both expected and bad`);
    assert.equal(typeof entry.note, "string");
    assert.ok(entry.note.length > 20, `${entry.id} needs a human-readable note`);
  }
});

// ---------------------------------------------------------------------------------------------
// Nothing model-specific may exist yet.
// ---------------------------------------------------------------------------------------------

test("no fixture contains a score, vector, rank or threshold field", () => {
  for (const [name, fixture] of Object.entries({ "corpus.json": corpus, "pairs.json": pairs, "neighbors.json": neighbors })) {
    walk(fixture, (value, path) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const key of Object.keys(value)) {
          assert.ok(!FORBIDDEN_KEY.test(key), `${name} has forbidden key "${key}" at ${path}`);
        }
      }
    });
  }
});

test("no fixture contains a number, so no vector or score can hide in one", () => {
  for (const [name, fixture] of Object.entries({ "corpus.json": corpus, "pairs.json": pairs, "neighbors.json": neighbors })) {
    for (const [path, value] of leaves(fixture)) {
      assert.ok(
        value === null || ["string", "boolean"].includes(typeof value),
        `${name} has a ${typeof value} at ${path}; B0 fixtures are human labels only`,
      );
    }
  }
});

test("the fixtures declare no numeric thresholds and no model identity", () => {
  assert.deepEqual(pairs.contract.invariants, ["isDuplicate => isStronglySimilar"]);
  assert.equal(typeof pairs.contract.phase, "string");
  assert.ok(pairs.contract.phase.length > 0);
  assert.equal(corpus.contract.emptyPartsDropped, true);
  assert.equal(neighbors.contract.complementaryOutfitsAreNotNeighbours, true);
});

test("the committed fixtures are exactly what the builder produces from the hand-authored sources", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../bench/embeddings/build-fixtures.mjs", import.meta.url)), "--check"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "pipe",
  });
});