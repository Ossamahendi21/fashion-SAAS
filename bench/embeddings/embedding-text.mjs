"use strict";

/*
 * Step 7 Phase B0 — the FROZEN embedding-text contract, replicated for benchmarking only.
 *
 * `embeddingText()` below is a byte-for-byte copy of the production contract in
 * convex/ai/openai.ts (`embeddingInput`). Production code is NOT modified: this file exists so the
 * benchmark derives its strings from the real source of truth (convex/shared/demo_wardrobe.ts) and
 * so the test can prove the pinned fixtures still match that contract.
 *
 * Nothing in this file runs a model, installs a package, or calls a network API.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

/** U+00B7 MIDDLE DOT surrounded by single spaces — the production separator. */
export const EMBEDDING_SEPARATOR = " · ";

/** Production field order, in the exact sequence production joins them. */
export const EMBEDDING_FIELD_ORDER = Object.freeze([
  "name",
  "category",
  "subcategory",
  "colours.primary",
  "colours.secondary[]",
  "colours.hex[]",
  "pattern",
  "material",
  "description",
]);

/** Mirror of convex/ai/openai.ts `embeddingInput`. Order, empties and separator must not drift. */
export function embeddingText(attributes) {
  return [
    attributes.name,
    attributes.category,
    attributes.subcategory,
    attributes.colours.primary,
    ...attributes.colours.secondary,
    ...attributes.colours.hex,
    attributes.pattern,
    attributes.material,
    attributes.description,
  ]
    .filter((part) => part.length > 0)
    .join(EMBEDDING_SEPARATOR);
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

export const { DEMO_WARDROBE } = await import("../../convex/shared/demo_wardrobe.ts");

/** The 16 demo garments in source order, with their production embedding text derived. */
export function demoCorpus() {
  return DEMO_WARDROBE.map((entry) => ({
    id: entry.key,
    name: entry.attributes.name,
    embeddingText: embeddingText(entry.attributes),
  }));
}