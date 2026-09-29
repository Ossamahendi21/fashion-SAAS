// Step 3B: contextual hover overlay controller.
//
// One pill, retargeting, rAF-throttled repositioning, detach handling, teardown — all against
// fakes. No DOM, no network, no timers beyond an explicit frame scheduler the tests drive.

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

async function bundleModule(relative) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, format: "esm", write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

const { createHoverOverlay, OVERLAY_COPY } = await bundleModule("../lib/hover-overlay.ts")

const RECT_A = { x: 100, y: 200, width: 300, height: 400 }
const RECT_B = { x: 500, y: 100, width: 250, height: 350 }

function fakeTarget(key, rect = RECT_A, alive = true) {
  let current = { ...rect }
  let living = alive
  return {
    target: {
      key,
      imageUrl: `https://shop.example.com/${key}.jpg`,
      productTitle: `Product ${key}`,
      rect: () => (living ? { ...current } : null),
      alive: () => living
    },
    move: (next) => { current = { ...next } },
    detach: () => { living = false }
  }
}

function harness() {
  const pills = []
  const frames = []
  const actions = { tryOn: [], save: [] }
  const visibility = []
  const controller = createHoverOverlay({
    createPill: (callbacks) => {
      const pill = {
        shown: false,
        destroyed: false,
        titles: [],
        moves: [],
        saves: [],
        tryOnEnabled: [],
        show: (title) => { pill.shown = true; pill.titles.push(title) },
        move: (rect) => { pill.moves.push({ ...rect }) },
        hide: () => { pill.shown = false },
        setSaveState: (state, label) => { pill.saves.push([state, label]) },
        setTryOnEnabled: (enabled) => { pill.tryOnEnabled.push(enabled) },
        destroy: () => { pill.destroyed = true },
        callbacks
      }
      pills.push(pill)
      return pill
    },
    requestFrame: (callback) => { frames.push(callback) },
    onTryOn: (target) => actions.tryOn.push(target.key),
    onSave: (target) => actions.save.push(target.key),
    onVisibility: (visible) => visibility.push(visible)
  })
  return {
    pills,
    frames,
    actions,
    visibility,
    controller,
    flushFrames: () => { while (frames.length > 0) frames.shift()() }
  }
}

test("11: only one overlay exists no matter how many images hover", () => {
  const h = harness()
  const a = fakeTarget("a")
  const b = fakeTarget("b", RECT_B)
  h.controller.hover(a.target)
  h.controller.hover(b.target)
  h.controller.hover(a.target)
  assert.equal(h.pills.length, 1, "a single pill element for the whole page")
})

test("12: hovering an eligible image shows actions bound to it", () => {
  const h = harness()
  const a = fakeTarget("a")
  h.controller.hover(a.target)
  assert.equal(h.pills[0].shown, true)
  assert.deepEqual(h.pills[0].titles, ["Product a"])
  assert.deepEqual(h.pills[0].moves, [RECT_A])
  h.pills[0].callbacks.onTryOn()
  h.pills[0].callbacks.onSave()
  assert.deepEqual(h.actions.tryOn, ["a"])
  assert.deepEqual(h.actions.save, ["a"])
})

test("13: moving to another eligible image retargets the same pill", () => {
  const h = harness()
  const a = fakeTarget("a")
  const b = fakeTarget("b", RECT_B)
  h.controller.hover(a.target)
  h.controller.hover(b.target)
  assert.equal(h.pills.length, 1)
  assert.deepEqual(h.pills[0].titles, ["Product a", "Product b"])
  assert.deepEqual(h.pills[0].moves.at(-1), RECT_B)
  assert.equal(h.controller.current?.key, "b")
  h.pills[0].callbacks.onSave()
  assert.deepEqual(h.actions.save, ["b"], "actions follow the retarget")
})

test("13b: re-hovering the same image is a no-op", () => {
  const h = harness()
  const a = fakeTarget("a")
  h.controller.hover(a.target)
  h.controller.hover(a.target)
  assert.deepEqual(h.pills[0].titles, ["Product a"], "no duplicate show")
})

test("14: a non-product image removes the overlay", () => {
  const h = harness()
  h.controller.hover(fakeTarget("a").target)
  assert.equal(h.pills[0].shown, true)
  h.controller.hover(null)
  assert.equal(h.pills[0].shown, false)
  assert.equal(h.controller.current, null)
})

test("15/16: scrolling and resize reposition through one rAF frame", () => {
  const h = harness()
  const a = fakeTarget("a")
  h.controller.hover(a.target)
  a.move({ x: 100, y: 400, width: 300, height: 400 })
  h.controller.reposition()
  h.controller.reposition()
  h.controller.reposition()
  assert.equal(h.frames.length, 1, "rapid events collapse into one frame")
  h.flushFrames()
  assert.deepEqual(h.pills[0].moves.at(-1), { x: 100, y: 400, width: 300, height: 400 })
})

test("17: a detached image removes the overlay on the next reposition", () => {
  const h = harness()
  const a = fakeTarget("a")
  h.controller.hover(a.target)
  a.detach()
  h.controller.reposition()
  h.flushFrames()
  assert.equal(h.pills[0].shown, false)
  assert.equal(h.controller.current, null)
})

test("visibility transitions fire exactly on show and hide", () => {
  const h = harness()
  const a = fakeTarget("a")
  h.controller.hover(a.target)
  h.controller.hover(null)
  h.controller.hover(a.target)
  assert.deepEqual(h.visibility, [true, false, true])
})

test("teardown destroys the pill and drops all references", () => {
  const h = harness()
  h.controller.hover(fakeTarget("a").target)
  h.controller.teardown()
  assert.equal(h.pills[0].destroyed, true)
  assert.equal(h.pills[0].shown, false)
  assert.equal(h.controller.current, null)
  h.controller.teardown()
  assert.equal(h.pills.length, 1, "teardown is safe to repeat")
})

test("40: overlay cleanup is complete on teardown", () => {
  const h = harness()
  h.controller.hover(fakeTarget("a").target)
  h.controller.reposition()
  h.controller.teardown()
  h.flushFrames()
  assert.equal(h.pills[0].moves.length, 1, "no queued frame touches a destroyed pill")
  assert.deepEqual(h.visibility.at(-1), false)
})

test("pill copy carries no provider, Convex, or storage names", () => {
  const serialized = JSON.stringify(OVERLAY_COPY)
  for (const forbidden of ["decart", "convex", "openai", "storage", "token", "sk_"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden), `pill copy must not mention ${forbidden}`)
  }
  assert.equal(OVERLAY_COPY.tryOn, "Try on")
  assert.equal(OVERLAY_COPY.save, "Save")
})
