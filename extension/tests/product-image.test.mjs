// Step 3B: product-image eligibility heuristics for contextual shopping actions.
//
// Conservative by design: false negatives beat page-covering buttons. Synthetic signal
// fixtures only — no DOM, no retailer sites, no network.

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

async function bundleModule(relative) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, format: "esm", write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

const productImage = await bundleModule("../lib/product-image.ts")

const product = (overrides = {}) => ({
  width: 400,
  height: 500,
  visible: true,
  src: "https://shop.example.com/images/blue-shirt.jpg",
  alt: "Blue Oxford Shirt",
  ...overrides
})

// ---------- Eligibility ----------

test("1: a normal large product image is eligible", () => {
  assert.equal(productImage.isEligibleProductImage(product()), true)
  assert.equal(productImage.isEligibleProductImage(product({ width: 160, height: 160 })), true)
})

test("2: tiny icons are rejected", () => {
  assert.equal(productImage.isEligibleProductImage(product({ width: 32, height: 32 })), false)
  assert.equal(productImage.isEligibleProductImage(product({ width: 159, height: 400 })), false)
  assert.equal(productImage.isEligibleProductImage(product({ width: 0, height: 0 })), false)
})

test("3: avatars are rejected when identifiable", () => {
  assert.equal(productImage.isEligibleProductImage(product({ src: "https://shop.example.com/avatars/user-1.jpg", width: 200, height: 200 })), false)
})

test("4: logos are rejected", () => {
  for (const src of [
    "https://shop.example.com/assets/logo.png",
    "https://cdn.example.com/images/store-logo-white.svg",
    "https://shop.example.com/icons/cart-icon.png"
  ]) {
    assert.equal(productImage.isEligibleProductImage(product({ src, width: 300, height: 300 })), false, src)
  }
})

test("5: extremely wide banners are rejected", () => {
  assert.equal(productImage.isEligibleProductImage(product({ width: 1200, height: 200 })), false)
  assert.equal(productImage.isEligibleProductImage(product({ width: 800, height: 200 })), false)
  assert.equal(productImage.isEligibleProductImage(product({ width: 640, height: 480 })), true)
})

test("6: invisible images are rejected", () => {
  assert.equal(productImage.isEligibleProductImage(product({ visible: false })), false)
  assert.equal(productImage.isEligibleProductImage(product({ src: "data:image/gif;base64,R0lGOD" })), false)
  assert.equal(productImage.isEligibleProductImage(product({ src: "blob:https://shop.example.com/abc" })), false)
  assert.equal(productImage.isEligibleProductImage(product({ src: "not a url" })), false)
})

test("7: extension-owned images are rejected", () => {
  assert.equal(
    productImage.isEligibleProductImage(product({ src: "chrome-extension://abc/tabs/room.html", extensionOwned: true })),
    false
  )
  assert.equal(productImage.isEligibleProductImage(product({ extensionOwned: true })), false)
})

test("7b: svg, sprites, pixels and placeholders are rejected", () => {
  for (const src of [
    "https://shop.example.com/artwork/deco.svg",
    "https://cdn.example.com/sprites/icons-2x.png",
    "https://tracker.example.com/pixel.gif",
    "https://shop.example.com/images/placeholder-grey.jpg"
  ]) {
    assert.equal(productImage.isEligibleProductImage(product({ src, width: 400, height: 400 })), false, src)
  }
})

// ---------- Target resolution ----------

test("8: a useful product title is resolved with alt winning", () => {
  assert.equal(productImage.usefulText("Blue Oxford Shirt"), "Blue Oxford Shirt")
  assert.equal(productImage.usefulText("Pin"), "")
  assert.equal(productImage.usefulText("image"), "")
  assert.equal(
    productImage.productName({ alt: "Blue Oxford Shirt", title: null, parentElement: null }, null, null, false),
    "Blue Oxford Shirt"
  )
  assert.equal(
    productImage.productName({ alt: "", title: "", parentElement: null }, { textContent: "  " }, null, false),
    ""
  )
})

test("8b: card titles resolve through bounded ancestor walking", () => {
  const card = {
    alt: "",
    title: "",
    parentElement: {
      querySelector: () => null,
      parentElement: {
        querySelector: () => ({ textContent: "  Relaxed Linen Blazer  " }),
        parentElement: null
      }
    }
  }
  assert.equal(productImage.productName(card, null, null, false), "Relaxed Linen Blazer")
})

test("8c: large images fall back to document title sources", () => {
  const doc = {
    querySelector: (selectors) => selectors === "h1" ? { textContent: "Summer Collection" } : null
  }
  assert.equal(
    productImage.productName({ alt: "", title: "", parentElement: null }, null, doc, true),
    "Summer Collection"
  )
  assert.equal(productImage.productName({ alt: "", title: "", parentElement: null }, null, null, true), "")
})

test("9: the sharpest image URL wins and resolves against the page", () => {
  const image = {
    srcset: "https://shop.example.com/small.jpg 300w, https://shop.example.com/large.jpg 1200w",
    currentSrc: "https://shop.example.com/small.jpg",
    src: "https://shop.example.com/small.jpg"
  }
  assert.equal(
    productImage.bestImageUrl(image, "https://shop.example.com/products/x"),
    "https://shop.example.com/large.jpg"
  )
  const relative = { srcset: "", currentSrc: "", src: "/images/blue.jpg" }
  assert.equal(
    productImage.bestImageUrl(relative, "https://shop.example.com/products/x"),
    "https://shop.example.com/images/blue.jpg"
  )
  const pin = { srcset: "", currentSrc: "", src: "https://i.pinimg.com/236x/aa/bb.jpg" }
  assert.equal(
    productImage.bestImageUrl(pin, "https://www.pinterest.com/"),
    "https://i.pinimg.com/736x/aa/bb.jpg"
  )
})

test("9b: target building keeps safe fields and drops unsafe URLs", () => {
  const target = productImage.buildProductTarget({
    imageUrl: "https://shop.example.com/images/blue.jpg",
    productTitle: "Blue Shirt",
    sourcePageUrl: "https://shop.example.com/p/1"
  })
  assert.deepEqual(target, {
    imageUrl: "https://shop.example.com/images/blue.jpg",
    productTitle: "Blue Shirt",
    sourcePageUrl: "https://shop.example.com/p/1"
  })
  assert.equal(productImage.buildProductTarget({ imageUrl: "javascript:alert(1)" }), null)
  assert.equal(productImage.buildProductTarget({ imageUrl: "" }), null)
  const long = productImage.buildProductTarget({ imageUrl: "https://shop.example.com/i.jpg", productTitle: "x".repeat(500) })
  assert.equal(long?.productTitle.length, 160)
})

test("10: unsafe URLs never become targets", () => {
  for (const imageUrl of ["data:image/png;base64,xx", "blob:https://x/y", "ftp://x/y", "https://", ""]) {
    assert.equal(productImage.buildProductTarget({ imageUrl }), null, imageUrl || "(empty)")
  }
})
