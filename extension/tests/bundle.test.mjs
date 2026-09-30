import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { models } from "../vendor/decart-sdk.mjs"

const root = new URL("../build/chrome-mv3-prod/", import.meta.url)
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"))

test("the browser SDK resolves Decart models with finite camera constraints", () => {
  const model = models.realtime("lucy-vton-latest")
  assert.ok(Number.isFinite(model.width))
  assert.ok(Number.isFinite(model.height))
  assert.ok(Number.isFinite(model.fps?.ideal))
})

test("the packaged popup, content script, fitting room and vision files exist", () => {
  assert.equal(manifest.action.default_popup, "popup.html")
  assert.ok(existsSync(new URL(manifest.action.default_popup, root)))
  const content = manifest.content_scripts[0].js[0]
  assert.ok(existsSync(new URL(content, root)))
  const source = readFileSync(new URL(content, root), "utf8")
  assert.ok(existsSync(new URL("tabs/room.html", root)))
  assert.ok(existsSync(new URL("vision/pose_landmarker_lite.task", root)))
  assert.ok(manifest.content_security_policy.extension_pages.includes("wasm-unsafe-eval"))
  assert.ok(!source.includes('"./v4/classic/external.js":!1'), "Parcel stripped Zod and would crash before mounting")
})

test("the production room ships no camera diagnostics", () => {
  const tabs = new URL("tabs/", root)
  const room = readFileSync(new URL(findRoomChunk(tabs), tabs), "utf8")
  // The dev-only guard must be folded away, not merely short-circuited at runtime: the diagnostic
  // body and its device-count helper must not survive into the shipped bundle. Only fragments
  // unique to this code are asserted — "aspectRatio", "displaySurface" and "videoinput" all occur
  // in the vendored React/Daily/Decart stack and would give false positives.
  for (const fragment of ["OpenWear camera", "videoInputCount"]) {
    assert.ok(!room.includes(fragment), `production bundle must not contain ${JSON.stringify(fragment)}`)
  }
  // The retry itself must ship: the fix has to be in the build users load.
  assert.ok(room.includes("NotFoundError") && room.includes("OverconstrainedError"), "the constraint retry ships")
  assert.ok(room.includes("No camera was available to OpenWear."), "the new NotFoundError copy ships")
  assert.ok(room.includes("Your camera could not use the requested video settings."), "the new OverconstrainedError copy ships")
})

test("the production room ships the freeze UI and quota copy", () => {
  const tabs = new URL("tabs/", root)
  const room = readFileSync(new URL(findRoomChunk(tabs), tabs), "utf8")
  for (const fragment of ["Freeze & inspect", "Frozen preview", "Go live again", "No Live Mirror sessions left this cycle."]) {
    assert.ok(room.includes(fragment), `production bundle must contain ${JSON.stringify(fragment)}`)
  }
  // Quota display copy must never include provider internals.
  assert.ok(!room.includes("authorized-seconds"), "no internal counter naming in shipped copy")
})

/** The room chunk carries a content hash; find it rather than hard-coding a name. */
function findRoomChunk(tabs) {
  for (const entry of readdirSync(tabs)) {
    if (/^room\..+\.js$/.test(entry)) return entry
  }
  throw new Error("no room chunk found in the production build")
}

test("the production build contains no E2E harness markers", () => {
  // The browser-E2E harness (extension/e2e) is overlaid onto a COPY of this build at
  // test time; none of it may ever ship. Scan every shipped script for the markers.
  const markers = ["__owE2e", "e2e-room", "E2E Field Jacket", "E2E Riverside Combo", "forceAuthenticated", "mockConvex", "E2E_LIVE_MIRROR_BLOCKED", "harness-reset", "e2e-auth-provider-stub", "pk_test_e2e_harness"];
  const scripts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = new URL(entry.name, dir);
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir));
      else if (entry.name.endsWith(".js")) scripts.push(path);
    }
  };
  walk(new URL("../build/chrome-mv3-prod/", import.meta.url));
  assert.ok(scripts.length > 0, "production scripts exist to scan");
  for (const script of scripts) {
    const source = readFileSync(script, "utf8");
    for (const marker of markers) {
      assert.ok(!source.includes(marker), `production bundle must not contain ${JSON.stringify(marker)} (${script})`);
    }
  }
});
