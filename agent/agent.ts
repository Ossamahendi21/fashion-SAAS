import { defineAgent } from "eve";

/**
 * The Fitcheck stylist. Routed through the Vercel AI Gateway, so the runtime needs
 * `AI_GATEWAY_API_KEY` (or a linked Vercel project supplying `VERCEL_OIDC_TOKEN`).
 *
 * Tools are registered by file under `agent/tools/`: `get_context`, `get_wardrobe`, `gap_analysis`,
 * `get_weather`, `compose_outfits`, `quote_renders`, `start_renders` and `save_outfit`. Sandbox,
 * shell and file tools are disabled; only the question and skill tools are explicitly added back.
 */
export default defineAgent({
  defaultTools: false,
  model: "openai/gpt-5.4-mini",
  reasoning: "low",
});
