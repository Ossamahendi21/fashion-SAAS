import { defineAgent } from "eve";
import { createDeterministicStylistModel } from "../../agent/lib/deterministic-stylist-model";

/**
 * Step 7 Phase C8 — the deterministic Eve root.
 *
 * This is a production-shaped root, not a test harness: it runs the SAME real channel
 * (`agent/channels/eve.ts`) and the SAME real `stylist_turn` tool (`agent/lib/stylist-turn.ts`, which
 * talks to the real Convex backend through the real service-key auth) as the legacy root. The only
 * difference is the transport model: the deterministic, zero-provider adapter from C7B, which opens
 * no model connection and is selected at build time via `withEve(..., { eveRoot })` in `next.config.ts`.
 *
 * The legacy root (`agent/`, model `openai/gpt-5.4-mini`) is untouched and remains the default.
 */
export default defineAgent({
  defaultTools: false,
  model: createDeterministicStylistModel(),
  modelContextWindowTokens: 1_000_000,
});