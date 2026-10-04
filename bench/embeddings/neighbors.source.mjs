"use strict";

/*
 * Step 7 Phase B0 — HAND-AUTHORED neighbour expectations for the 16 demo garments.
 *
 * SEMANTIC CONTRACT (read before interpreting any Phase B ranking):
 *
 *   expectedNeighbors  garments that SHOULD appear near this item in an embedding similarity
 *                      ranking — the same garment family, or same category and style. This is
 *                      what shoppingAdvice's "very similar" prose is allowed to talk about.
 *   badNeighbors       garments that would be a FALSE neighbour if they ranked high. Nearly all of
 *                      them are colour-token or material-token collisions (blue jeans next to a
 *                      blue shirt, a leather bag next to a leather belt), which is exactly the
 *                      failure mode a text embedding is most prone to.
 *
 * A complementary outfit partner is deliberately NOT an expected neighbour. "White oxford shirt"
 * and "navy chinos" belong together in an outfit but are not similar garments; that distinction is
 * what the `related_not_duplicate` class in pairs.source.mjs encodes.
 *
 * No total ranking is asserted, only membership. Cross-wardrobe ids appear solely where the frozen
 * set offers no in-wardrobe alternative (e.g. the men's trainer has no second men's trainer). Since
 * shoppingAdvice normally ranks within a single wardrobe, Phase B should treat those entries as
 * whole-set expectations and note the caveat rather than treat them as a defect.
 *
 * No scores, distances or rankings appear here — B0 is human ground truth only.
 */

export const NEIGHBOR_EXPECTATIONS = [
  {
    id: "v2-men-blue-check-shirt",
    expected: ["v2-men-blue-tropical-shirt", "v2-men-mens-henley", "v2-men-mens-long-sleeve"],
    bad: ["v2-women-black-evening-gown", "v2-women-black-heeled-sandals", "v2-women-brown-leather-bag"],
    note: "The other men's cotton tops are the sensible neighbours; a dress, a shoe and a bag are not.",
  },
  {
    id: "v2-men-blue-tropical-shirt",
    expected: ["v2-men-blue-check-shirt", "v2-men-mens-henley", "v2-men-mens-long-sleeve"],
    bad: ["v2-women-black-evening-gown", "v2-women-black-heeled-sandals", "v2-women-brown-leather-bag"],
    note: "Same men's-top neighbourhood as the checked shirt; print and sleeve length are not enough to separate them.",
  },
  {
    id: "v2-men-mens-henley",
    expected: ["v2-men-blue-check-shirt", "v2-men-blue-tropical-shirt", "v2-men-mens-long-sleeve"],
    bad: ["v2-men-colourblock-trainers", "v2-women-brown-leather-bag", "v2-women-black-heeled-sandals"],
    note: "The trainers share the word 'colourblock' and nothing else — that is a false neighbour.",
  },
  {
    id: "v2-men-mens-long-sleeve",
    expected: ["v2-men-mens-henley", "v2-men-blue-check-shirt", "v2-men-blue-tropical-shirt"],
    bad: ["v2-men-colourblock-trainers", "v2-men-blue-jeans"],
    note: "The trainers and the jeans share only the colour blue, not a garment family.",
  },
  {
    id: "v2-men-mens-cotton-jacket",
    expected: ["v2-women-womens-leather-jacket"],
    bad: [
      "v2-women-black-evening-gown",
      "v2-women-black-heeled-sandals",
      "v2-women-brown-leather-bag",
      "v2-men-colourblock-trainers",
      "v2-men-white-red-trainers",
    ],
    note: "Outerwear is thin in the frozen 16: exactly one counterpart, and it is the cross-wardrobe one.",
  },
  {
    id: "v2-men-colourblock-trainers",
    expected: ["v2-men-white-red-trainers", "v2-women-white-red-trainers"],
    bad: ["v2-men-blue-check-shirt", "v2-men-mens-long-sleeve", "v2-men-blue-jeans"],
    note: "Only one men's trainer exists in the frozen set, so the expectation reaches across wardrobes.",
  },
  {
    id: "v2-men-white-red-trainers",
    expected: ["v2-men-colourblock-trainers", "v2-women-white-red-trainers", "v2-women-black-heeled-sandals"],
    bad: ["v2-women-black-evening-gown", "v2-men-mens-cotton-jacket"],
    note: "Both trainers are the nearest pair in the frozen set; a gown and a field jacket are not.",
  },
  {
    id: "v2-women-black-evening-gown",
    expected: [],
    bad: [
      "v2-men-blue-check-shirt",
      "v2-men-blue-tropical-shirt",
      "v2-men-mens-henley",
      "v2-men-mens-long-sleeve",
      "v2-men-colourblock-trainers",
      "v2-men-white-red-trainers",
      "v2-men-blue-jeans",
    ],
    note: "The only dress in the frozen 16, so nothing is expected to rank high for it. An empty expected list is the correct ground truth here, not a gap.",
  },
  {
    id: "v2-women-womens-leather-jacket",
    expected: ["v2-men-mens-cotton-jacket"],
    bad: [
      "v2-men-blue-check-shirt",
      "v2-men-blue-tropical-shirt",
      "v2-men-mens-henley",
      "v2-men-mens-long-sleeve",
      "v2-men-colourblock-trainers",
      "v2-men-white-red-trainers",
      "v2-men-blue-jeans",
      "v2-women-blue-jeans",
    ],
    note: "Every men's garment is a bad neighbour here; the single field jacket is the only other coat.",
  },
  {
    id: "v2-women-womens-blouse",
    expected: ["v2-women-womens-sport-top"],
    bad: ["v2-women-brown-leather-bag", "v2-women-black-heeled-sandals", "v2-women-white-red-trainers"],
    note: "Only one in-wardrobe top exists; a men's tee is a false neighbour driven by the shared word 'top'.",
  },
  {
    id: "v2-women-womens-sport-top",
    expected: ["v2-women-womens-blouse"],
    bad: ["v2-women-brown-leather-bag", "v2-women-black-heeled-sandals", "v2-women-white-red-trainers"],
    note: "Mirror of the blouse entry; the remaining women's garments are different classes.",
  },
  {
    id: "v2-women-black-heeled-sandals",
    expected: ["v2-women-white-red-trainers"],
    bad: ["v2-women-black-evening-gown", "v2-women-womens-leather-jacket"],
    note: "The two black garments are colour-only collisions and must not outrank the trainer.",
  },
  {
    id: "v2-women-white-red-trainers",
    expected: ["v2-women-black-heeled-sandals", "v2-men-white-red-trainers", "v2-men-colourblock-trainers"],
    bad: [],
    note: "No clearly-bad neighbour: the rest of the frozen 16 shares neither garment class nor vocabulary with a trainer.",
  },
  {
    id: "v2-women-brown-leather-bag",
    expected: [],
    bad: ["v2-women-womens-leather-jacket", "v2-women-black-heeled-sandals"],
    note: "The only bag in the frozen 16. The leather-token collisions are the trap this entry exists to catch.",
  },
  {
    id: "v2-men-blue-jeans",
    expected: ["v2-women-blue-jeans"],
    bad: ["v2-men-blue-check-shirt", "v2-men-colourblock-trainers"],
    note: "Byte-identical embedding text to the women's pair. There is no second men's bottom in the frozen set, so a single expected neighbour is the correct ground truth.",
  },
  {
    id: "v2-women-blue-jeans",
    expected: ["v2-men-blue-jeans"],
    bad: ["v2-men-colourblock-trainers"],
    note: "Mirror of the men's jeans entry; blue trainers are a colour-only collision.",
  },
];