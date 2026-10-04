"use strict";

/*
 * Step 7 Phase B0 — the semantic intent behind each pair class.
 *
 * These are ORDINAL judgements only. B0 deliberately contains no numeric cosine threshold and no
 * model output: Phase B will calibrate the two gates later, from the labels frozen here.
 *
 *   isDuplicate       -> would a wardrobe owner want the duplicate flag raised (same garment twice)?
 *   isStronglySimilar -> is this pair sensible to describe to a shopper as "very similar" when it
 *                        turns up among their nearest neighbours?
 *
 * Invariant the fixtures must always satisfy: isDuplicate => isStronglySimilar. A garment that is
 * the same physical item is trivially also its own strongest neighbour.
 */

export const PAIR_CLASSES = Object.freeze([
  "true_duplicate",
  "same_garment_alt_wording",
  "near_duplicate",
  "same_category_diff_colour",
  "same_colour_diff_category",
  "related_not_duplicate",
  "hard_negative",
]);

export const LABEL_CONTRACT = Object.freeze({
  true_duplicate: {
    isDuplicate: true,
    isStronglySimilar: true,
    meaning: "the same physical garment listed twice (different retailer wording or photos)",
  },
  same_garment_alt_wording: {
    isDuplicate: true,
    isStronglySimilar: true,
    meaning: "the same physical garment with no attribute change, described in different vocabulary or with reordered clauses",
  },
  near_duplicate: {
    isDuplicate: false,
    isStronglySimilar: true,
    meaning: "one important attribute differs (colour, wash, fit, length, neckline, material), so it is a different garment but the nearest sensible neighbour",
  },
  same_category_diff_colour: {
    isDuplicate: false,
    isStronglySimilar: true,
    meaning: "same garment type and subcategory in a different colourway",
  },
  same_colour_diff_category: {
    isDuplicate: false,
    isStronglySimilar: false,
    meaning: "the shared colour is the only overlapping attribute; unrelated garment classes",
  },
  related_not_duplicate: {
    isDuplicate: false,
    isStronglySimilar: false,
    meaning: "complementary wardrobe roles in one style family (worn together, not similar), so not neighbours in a similarity ranking",
  },
  hard_negative: {
    isDuplicate: false,
    isStronglySimilar: false,
    meaning: "high lexical or material overlap but a genuinely different garment (denim jacket vs denim jeans, bag vs belt, shirt vs shirt dress)",
  },
});