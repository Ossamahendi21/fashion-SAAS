import type { Infer } from "convex/values";
import { vColours } from "./validators";

/**
 * The embedding-input contract, shared by every writer.
 *
 * This module is the single source of truth for the text that gets embedded. It used to live as a
 * module-private `embeddingInput()` in `ai/openai.ts`; it is here now because three writers must
 * produce byte-identical text: production ingest (`ai/openai.ts`), the BGE backfill
 * (`embeddingBackfill.ts`), and the frozen Phase B benchmark fixtures. If the field order, the
 * separator or the empty-field rule changed independently in two places, stored vectors and the
 * validated thresholds would silently stop describing the same space.
 *
 * Byte-for-byte compatibility with the frozen B0 corpus is asserted by
 * `tests/embedding-provider.test.mjs`; do not reorder, re-join or trim anything here without
 * regenerating and revalidating the fixtures.
 */

/** U+00B7 MIDDLE DOT surrounded by single spaces — the production separator. */
export const EMBEDDING_SEPARATOR = " · ";

/** The production field order, in the exact sequence the parts are joined. */
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
] as const);

/**
 * Everything the contract reads. `colours.hex` is part of the persisted `vColours` shape rather than
 * a second argument: `markItemReady` merges the cutout's dominant hex into the item's colours, so by
 * the time an embedding is written the hex is already the item's own field.
 */
export type EmbeddingTextSource = {
  name: string;
  category: string;
  subcategory: string;
  colours: Infer<typeof vColours>;
  pattern: string;
  material: string;
  description: string;
};

/**
 * Builds the embedding text. Empty parts are dropped (never emitted as empty separators), the rest
 * are joined with `EMBEDDING_SEPARATOR`. No normalisation, lowercasing or truncation happens here:
 * a persisted item's attributes are embedded exactly as stored.
 */
export function embeddingText(source: EmbeddingTextSource): string {
  return [
    source.name,
    source.category,
    source.subcategory,
    source.colours.primary,
    ...source.colours.secondary,
    ...source.colours.hex,
    source.pattern,
    source.material,
    source.description,
  ]
    .filter((part) => part.length > 0)
    .join(EMBEDDING_SEPARATOR);
}

/**
 * Which embedding generation produced the vectors a similarity result came from.
 *
 * Part of the shoppingAdvice cache fingerprint (see `model/shoppingAdvice.ts` `adviceFingerprint`),
 * so changing the generation automatically invalidates every cached similarity and prose result
 * instead of serving prose computed against a different vector space. Bump this whenever the
 * embedding model, its revision, its dimensions or the text contract above change.
 */
export const EMBEDDING_GENERATION = "bge-v1";

/**
 * The static generation identifier for cached analyses computed against LEGACY stored OpenAI
 * vectors (1536-d `embedding` / `by_embedding`). It exists so the shopping-advice fingerprint can
 * name the ACTIVE read generation: switching `EMBEDDING_READ_GENERATION` from legacy to bge changes
 * the fingerprint and invalidates stale advice instead of serving prose computed in the other
 * vector space. Like `EMBEDDING_GENERATION`, a fingerprint token — never a secret, never env.
 */
export const LEGACY_EMBEDDING_GENERATION = "openai-1536-v1";