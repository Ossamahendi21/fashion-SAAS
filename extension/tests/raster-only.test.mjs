// Step 3E: every extension image entry point is raster-only; SVG is refused everywhere.
//
// Static pins, because the behaviours are spread across browser-only modules (a Document, a
// canvas). Each entry point has its own guard so a single missed call site cannot regress:
// drags, file pickers, a data-URL string, the client upload gate, and the curl of server-made
// blobs all decline image/svg+xml and any other markup type.
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, "utf8")

const RASTER = "ACCEPTED = new Set([\"image/jpeg\", \"image/png\", \"image/webp\"])"

test("normalizeImage hard-codes a raster allowlist, not a blanket image/*", () => {
  const garment = read("lib/garment.ts")
  assert.ok(garment.includes(RASTER), "ACCEPTED must be the exact three raster types")
  assert.equal(garment.includes('"image/svg+xml"'), false, "SVG is not in the allowlist")
  // A string source (the former data-URL path) is restricted to raster data URLs too.
  assert.ok(garment.includes("/^data:image\\/(jpeg|png|webp);base64,/"), "even a data-URL string must claim a raster MIME")
})

test("parseDrop accepts only the raster types; overlapping URL paths are untyped and checked elsewhere", () => {
  const drop = read("lib/drop.ts")
  assert.ok(drop.includes('["image/jpeg", "image/png", "image/webp"]'), "file drops filter on the exact raster list")
  assert.equal(drop.includes('"image/svg+xml"'), false)
})

test("the client upload gate refuses a declared non-raster Blob (see wardrobe-save.test.mjs runtime case)", () => {
  const save = read("lib/wardrobe-save.ts")
  assert.ok(save.includes('const RASTER = ["image/jpeg", "image/png", "image/webp"]'), "the upload gate has its own raster list")
  assert.ok(save.includes('if (input.blob.type && !RASTER.includes(input.blob.type)) throw'), "a declared SVG is thrown out before any upload")
})

test("the background worker has no image path at all and no data-URL construction", () => {
  const background = read("background.ts")
  assert.equal(background.includes("data:image"), false)
  assert.equal(background.includes("IMAGE_TYPES"), false)
  assert.equal(background.includes("image/svg"), false)
})

test("the server-bypass client hands server-checked blobs only", () => {
  const remoteImage = read("lib/remote-image.ts")
  assert.equal(remoteImage.includes("image/svg"), false, "the client never accepts an SVG MIME anywhere")
  // The client deliberately claims a plain raster fallback name, never a markup type.
  assert.ok(remoteImage.includes('"shopping-garment.jpg"'), "display-name fallback stays raster")
})