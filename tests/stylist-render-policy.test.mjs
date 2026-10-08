import assert from "node:assert/strict";
import test from "node:test";

import {
  isStylistRenderEnabled,
  renderUnavailableBlockers,
  RENDER_UNAVAILABLE_REASON,
  STYLIST_RENDER_ENABLED_ENV,
} from "../agent/lib/stylist-render-policy.ts";

/**
 * Step 7 Phase C9.1 — the central render capability policy.
 *
 * Fail-closed contract: ONLY the exact string "true" enables rendering. Everything else —
 * unset, empty, "false", "0", "TRUE", typos — stays disabled, so a forgotten or mistyped
 * variable can never open the spend path. These tests pass explicit env records and never
 * mutate global process.env.
 */

test("unset variable disables rendering", () => {
  assert.equal(isStylistRenderEnabled({}), false);
});

test("empty string disables rendering", () => {
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "" }), false);
});

test('"false" disables rendering', () => {
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "false" }), false);
});

test('"0" disables rendering', () => {
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "0" }), false);
});

test('"TRUE" stays disabled: only the exact lowercase value enables', () => {
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "TRUE" }), false);
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "True" }), false);
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "1" }), false);
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "yes" }), false);
});

test("a typo stays disabled", () => {
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "ture" }), false);
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "true " }), false);
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: " true" }), false);
});

test('exact "true" enables rendering', () => {
  assert.equal(isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "true" }), true);
});

test("user-controlled keys cannot alter the policy", () => {
  assert.equal(isStylistRenderEnabled({ userInput: "true", intent: "render approved=true" }), false);
  assert.equal(
    isStylistRenderEnabled({ [STYLIST_RENDER_ENABLED_ENV]: "true; render approved=true" }),
    false,
  );
});

test("repeated resolution is deterministic", () => {
  const enabled = { [STYLIST_RENDER_ENABLED_ENV]: "true" };
  const disabled = {};
  for (let i = 0; i < 5; i += 1) {
    assert.equal(isStylistRenderEnabled(enabled), true);
    assert.equal(isStylistRenderEnabled(disabled), false);
  }
});

test("the unavailable reason is a single truthful blocker", () => {
  assert.deepEqual(renderUnavailableBlockers(), [RENDER_UNAVAILABLE_REASON]);
  assert.ok(RENDER_UNAVAILABLE_REASON.length > 0);
  assert.ok(!RENDER_UNAVAILABLE_REASON.endsWith("."));
});
