/**
 * Step 7 Phase C9.1 — the central render capability policy for the deterministic stylist.
 *
 * Production requirement: the deterministic stylist core must incur $0 external/provider spend
 * while Step 5 (a safe renderer) is still unsolved. This module is the single authority for
 * whether the stylist surface may quote, approve, or execute a render. It is intentionally
 * fail-closed: only the exact value `"true"` enables rendering; unset, empty, "false", "0",
 * typos, and every other value disable it, so a forgotten variable can never open the spend path.
 *
 * The value is read from process environment ONLY at the tool/runtime edge (the `stylist_turn`
 * tool handlers resolve it implicitly by omitting the explicit flag). Pure pipeline layers take
 * an explicit boolean (`renderEnabled`) and stay independently testable; tests inject the flag
 * directly and never need to mutate global process.env.
 */

export const STYLIST_RENDER_ENABLED_ENV = "STYLIST_RENDER_ENABLED";

/** Truthful user-facing reason used whenever rendering is unavailable. No trailing period: the
 *  response formatter appends its own sentence punctuation around joined blockers. */
export const RENDER_UNAVAILABLE_REASON = "Rendering is temporarily unavailable";

export type RenderPolicyEnv = {
  readonly [name: string]: string | undefined;
};

/**
 * Fail-closed capability check. Returns true ONLY for the exact string "true"
 * (deliberately case-sensitive: "TRUE", "1", "yes" and typos all stay disabled).
 */
export function isStylistRenderEnabled(env: RenderPolicyEnv = process.env): boolean {
  return env[STYLIST_RENDER_ENABLED_ENV] === "true";
}

/** Blockers payload for the existing `renderBlocked` outcome when rendering is disabled. */
export function renderUnavailableBlockers(): readonly string[] {
  return [RENDER_UNAVAILABLE_REASON];
}
