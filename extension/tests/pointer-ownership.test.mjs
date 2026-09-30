// Step 4A: pointer-boundary ownership guard for the contextual pill.
//
// Regression for a real bug found by the browser E2E: moving the pointer from a product
// image into the contextual pill fires `pointerout` on the image, and because the pill
// lives in a Shadow root the event's `relatedTarget` is RETARGETED to the shadow host.
// The host carried no ownership marker, so the guard could not recognise the crossing as
// "still inside our own UI" and hid the pill before the pointer could reach it -- making
// the pill unclickable for real users.
//
// Native retargeting needs a real browser (covered by e2e/shopping-loop.e2e.mjs). This
// file proves the decision logic the content script runs, using the same exported helper.

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { build } from "esbuild"

async function bundleModule(relative) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, format: "esm", write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

const { createHoverOverlay, isExtensionOwnedUi, UI_ATTR } = await bundleModule("../lib/hover-overlay.ts")

// Minimal element stand-in: enough `hasAttribute`/`closest` for the ownership guard.
function el(tagName, attrs = {}, parent = null) {
  const node = {
    tagName: tagName.toUpperCase(),
    attrs: { ...attrs },
    parent,
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attrs, name)
    },
    closest(selector) {
      const attr = selector.replace(/^\[|\]$/g, "")
      let cur = node
      while (cur) {
        if (Object.prototype.hasOwnProperty.call(cur.attrs, attr)) return cur
        cur = cur.parent
      }
      return null
    }
  }
  return node
}

const RECT = { x: 100, y: 200, width: 300, height: 400 }

/**
 * Reproduces the content script's delegated pointer handling against the real overlay
 * controller: `onPointerOver` on an eligible image, `onPointerOut` on the boundary
 * crossing (the exact production decision, delegating to the shared helper).
 */
function page() {
  const state = { hoverImg: null }
  const pills = []
  const tried = []
  const saved = []

  const overlay = createHoverOverlay({
    createPill: (actions) => {
      const record = { shown: false, destroyed: false, onTryOn: actions.onTryOn, onSave: actions.onSave }
      pills.push(record)
      return {
        show: () => { record.shown = true },
        move: () => {},
        hide: () => { record.shown = false },
        setSaveState: () => {},
        setTryOnEnabled: () => {},
        destroy: () => { record.destroyed = true },
        get shown() { return record.shown }
      }
    },
    requestFrame: (cb) => cb(),
    onTryOn: (target) => tried.push(target),
    onSave: (target) => saved.push(target)
  })

  // Extension-owned Shadow tree: the host is what the browser hands us after retargeting.
  const host = el("openwear-root", { [UI_ATTR]: "host" })
  const pill = el("div", { [UI_ATTR]: "contextual", class: "ow-contextual" }, host)
  const tryOnButton = el("button", {}, pill)
  const saveButton = el("button", {}, pill)

  const productImage = el("img", { id: "product-main" })
  const unrelatedContent = el("div", { class: "product-copy" })

  function pointerOver(node) {
    const path = [node]
    if (path.some((n) => n.tagName === "OPENWEAR-ROOT" || n.hasAttribute(UI_ATTR))) return
    if (!node.tagName || node.tagName !== "IMG") return
    state.hoverImg = node
    overlay.hover({
      key: "https://shop.example.com/jacket.jpg",
      imageUrl: "https://shop.example.com/jacket.jpg",
      productTitle: "Olive field jacket",
      rect: () => ({ ...RECT }),
      alive: () => true
    })
  }

  function pointerOut(event) {
    const img = state.hoverImg
    if (!img || event.target !== img) return
    const related = event.relatedTarget
    if (isExtensionOwnedUi(related)) return
    state.hoverImg = null
    overlay.hide()
  }

  return {
    overlay, pills, tried, saved, productImage, unrelatedContent, pillEl: pill,
    tryOnButton, saveButton, host,
    get shown() { return pills[pills.length - 1]?.shown === true },
    get pill() { return pills[pills.length - 1] },
    hoverImage: () => pointerOver(productImage),
    leaveImageTo: (related) => pointerOut({ target: productImage, relatedTarget: related }),
    clickTryOn: () => pills[pills.length - 1]?.onTryOn(),
    clickSave: () => pills[pills.length - 1]?.onSave()
  }
}

test("the Shadow host carries the ownership marker the guard needs", () => {
  const content = readFileSync(fileURLToPath(new URL("../content.tsx", import.meta.url)), "utf8")
  assert.match(content, /host\.setAttribute\(UI_ATTR, "host"\)/, "content script tags the shadow host")
  assert.match(content, /if \(isExtensionOwnedUi\(related\)\) return/, "pointerout guard uses the shared helper")
})

test("1: pointer moving from a product image into the pill does not hide it", () => {
  const p = page()
  p.hoverImage()
  assert.equal(p.shown, true, "pill shows on hover")

  // The browser retargets the crossing to the shadow host, not to the pill.
  p.leaveImageTo(p.host)

  assert.equal(p.shown, true, "pill survives the retargeted crossing into the pill")
})

test("2: pointer moving from the image to unrelated page content hides the pill", () => {
  const p = page()
  p.hoverImage()
  p.leaveImageTo(p.unrelatedContent)
  assert.equal(p.shown, false, "unrelated page content still dismisses the pill")
})

test("3: Try on stays clickable after crossing into the pill", () => {
  const p = page()
  p.hoverImage()
  p.leaveImageTo(p.host)
  p.clickTryOn()
  assert.equal(p.tried.length, 1, "Try on fired once")
  assert.equal(p.tried[0].productTitle, "Olive field jacket", "Try on kept the hovered product")
})

test("4: Save stays clickable after crossing into the pill", () => {
  const p = page()
  p.hoverImage()
  p.leaveImageTo(p.host)
  p.clickSave()
  assert.equal(p.saved.length, 1, "Save fired once")
  assert.equal(p.saved[0].imageUrl, "https://shop.example.com/jacket.jpg", "Save kept the hovered image")
})

test("5: only extension-owned UI is exempt, at any depth", () => {
  const p = page()
  const nested = el("span", {}, p.pillEl)
  assert.equal(isExtensionOwnedUi(p.host), true, "the retargeted host is exempt")
  assert.equal(isExtensionOwnedUi(p.pillEl), true, "the pill itself is exempt")
  assert.equal(isExtensionOwnedUi(nested), true, "a descendant of our UI is exempt")
  assert.equal(isExtensionOwnedUi(p.unrelatedContent), false, "page content is not exempt")
  assert.equal(isExtensionOwnedUi(null), false, "no related target is not exempt")
  assert.equal(isExtensionOwnedUi("#text"), false, "a non-element target is not exempt")
  assert.equal(isExtensionOwnedUi({ tagName: "DIV" }), false, "a lookalike object without closest() is not exempt")
})

test("6: ordinary shop markup cannot spoof the exemption", () => {
  const p = page()
  // Attribute-name lookalikes must not satisfy the `[data-ow-ui]` selector.
  const lookalikes = [
    el("div", { "data-ow-ui-host": "", class: "ow-contextual" }),
    el("div", { "data-ow-ui-lookalike": "" }),
    el("div", { "data-ow-uix": "" }),
    el("div", { "data-ow": "" }),
    el("div", { "dataowui": "" }),
    // An openwear-root lookalike is not the host we created either: no marker.
    el("openwear-root", {}),
    el("div", { class: "ow-contextual" }),
    el("div", { id: "pill" })
  ]
  for (const node of lookalikes) {
    assert.equal(isExtensionOwnedUi(node), false, `spoof rejected: ${JSON.stringify(node.attrs)}`)
  }
  p.hoverImage()
  p.leaveImageTo(lookalikes[0])
  assert.equal(p.shown, false, "a spoofing element does not keep the pill alive")
})
