// Step 3C: Style this item in the OpenWear fitting room.
//
// After a save reaches ready, the room offers outfit suggestions around the saved wardrobe
// item: one authenticated request, compact cards, per-card view/save, and a web handoff
// carrying only the opaque outfit id. No re-upload, no Live Mirror, no camera involvement.
// Behavioral units (copy, URL building, failure mapping, refs) are tested for real;
// room wiring is asserted against its own source, matching this repo's established style.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

async function bundleModule(relative) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, format: "esm", write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

const saver = await bundleModule("../lib/wardrobe-save.ts")

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, "utf8")
const room = read("tabs/room.tsx")
const roomCss = read("tabs/room.css")

// ---------- Refs + copy ----------

test("the styling action takes only the saved item id", () => {
  assert.equal(typeof saver.requestItemStyling, "object", "a Convex function reference")
  const symbols = Object.getOwnPropertySymbols(saver.requestItemStyling)
  const name = symbols.map(key => saver.requestItemStyling[key]).find(value => typeof value === "string")
  assert.equal(name, "styling:suggestOutfits")
})

test("proposal saves reuse the existing threads mutation", () => {
  const symbols = Object.getOwnPropertySymbols(saver.saveOutfitProposal)
  const name = symbols.map(key => saver.saveOutfitProposal[key]).find(value => typeof value === "string")
  assert.equal(name, "threads:saveProposal")
})

test("style copy is exact and provider-free", () => {
  assert.equal(saver.STYLE_COPY.styleButton, "Style this item")
  assert.equal(saver.STYLE_COPY.stylingButton, "Styling…")
  assert.equal(saver.STYLE_COPY.failedButton, "Couldn't style. Try again.")
  assert.equal(saver.STYLE_COPY.viewButton, "View in Fitcheck")
  assert.equal(saver.STYLE_COPY.saveButton, "Save outfit")
  assert.equal(saver.STYLE_COPY.savedButton, "Saved ✓")
  const serialized = JSON.stringify(saver.STYLE_COPY)
  for (const forbidden of ["decart", "openai", "token", "credit", "price"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden), `style copy must not mention ${forbidden}`)
  }
})

test("styling failures map to safe copy", () => {
  assert.equal(
    saver.toStyleFailureMessage(Object.assign(new Error("x"), { data: { code: "RATE_LIMITED", message: "Slow down." } })),
    "Slow down."
  )
  assert.equal(saver.toStyleFailureMessage(new Error("Failed to fetch")), "Couldn't style this item. Try again.")
  assert.equal(saver.toStyleFailureMessage(null), "Couldn't style this item. Try again.")
})

test("22: the web handoff carries only the opaque outfit id", () => {
  assert.equal(saver.buildOutfitUrl("https://app.fitcheck.example/", "outfits-1"), "https://app.fitcheck.example/outfits/outfits-1")
  assert.equal(saver.buildOutfitUrl("https://app.fitcheck.example", "outfits-1"), "https://app.fitcheck.example/outfits/outfits-1")
  const url = saver.buildOutfitUrl("https://app.fitcheck.example", "outfits-1")
  assert.ok(!/jwt|token|prompt|wardrobe|bearer/i.test(url), "no secrets, data, or prompts in the URL")
  assert.ok(room.includes("buildOutfitUrl(getAuthConfig().fitcheckAppUrl, outfitId)"), "handoff uses the configured app origin")
  assert.ok(room.includes("chrome.tabs.create({ url: buildOutfitUrl("), "handoff opens a tab, never the room")
})

// ---------- Room wiring ----------

test("13: the Style button appears only once a garment is saved", () => {
  assert.ok(room.includes("styleState.garmentId === garment.id"), "button scoped to the visible garment")
  assert.ok(room.includes("STYLE_COPY.stylingButton") && room.includes("STYLE_COPY.failedButton") && room.includes("STYLE_COPY.styleButton"), "phase-driven button copy")
  assert.ok(room.includes("disabled={styleState.phase === \"styling\"}"), "no double-submit while styling")
})

test("14: processing and failed saves expose no Style button", () => {
  const card = room.slice(room.indexOf("{garment && <div className={`garment-card"), room.indexOf("{cameraOn && <div className=\"toolbar\">"))
  assert.ok(card.includes("styleState && styleState.garmentId === garment.id && styleState.itemId"), "style UI needs a saved item id")
})

test("16/24: double clicks collapse and stale completions never paint or navigate", () => {
  const handler = room.slice(room.indexOf("const styleItem = useCallback"), room.indexOf("/** Keeps one proposal outfit"))
  assert.ok(handler.includes("if (stylingRef.current) return"), "synchronous single-flight guard")
  assert.ok(handler.includes("stylingRef.current = true"), "guard set before the first await")
  const checks = [...handler.matchAll(/garmentRef\.current\?\.id !===?( garmentId| current\.id)/g)]
  assert.ok(handler.includes("garmentRef.current?.id !== garmentId"), "stale guard before storing")
  assert.ok(handler.includes("garmentRef.current?.id !== current.id") || checks.length >= 1, "stale guard present")
  const viewer = room.slice(room.indexOf("const viewOutfit"), room.indexOf("const onNoticeAction"))
  assert.ok(viewer.includes("state.garmentId !== garmentRef.current?.id"), "stale garments never navigate")
})

test("17/18/19: styling uses the saved itemId only — no upload, no registration", () => {
  const handler = room.slice(room.indexOf("const styleItem = useCallback"), room.indexOf("/** Keeps one proposal outfit"))
  assert.ok(handler.includes("await requestStyling({ itemId })"), "the action receives the item id and nothing else")
  for (const forbidden of ["generateUploadUrl", "registerImport", "postBlob", "saver.save", "saver.watch", "clientImportId"]) {
    assert.ok(!handler.includes(forbidden), `style path must not reference ${forbidden}`)
  }
})

test("20: styling never authorizes Live Mirror or touches the camera", () => {
  const handler = room.slice(room.indexOf("const styleItem = useCallback"), room.indexOf("/** Keeps one proposal outfit"))
  for (const forbidden of ["authorizer", "liveMirrorAction", "liveMirror", "acquireCamera", "stopStream", "closeProvider", "connectionRef"]) {
    assert.ok(!handler.includes(forbidden), `style path must not reference ${forbidden}`)
  }
})

test("21: successful styling shows compact cards with view and save per suggestion", () => {
  assert.ok(room.includes("{styleState.phase === \"ready\" ?"), "cards render on ready")
  assert.ok(room.includes("suggestion.items.filter(item => item.url)"), "thumbnails from item image URLs")
  assert.ok(room.includes("Your pick"), "the saved item is visibly identified")
  assert.ok(room.includes("{suggestion.reasoning"), "reasoning shown")
  assert.ok(room.includes("onClick={() => viewOutfit(suggestion.outfitId)}"), "per-card handoff")
  assert.ok(room.includes("onClick={() => void saveSuggestionOutfit(suggestion.outfitId)}"), "per-card save")
  assert.ok(room.includes("STYLE_COPY.savedButton"), "saved state shown")
  assert.ok(roomCss.includes(".suggestion-card") && roomCss.includes(".suggestion-thumbs"), "card styling exists")
})

test("23: server denials surface safe copy without styling", () => {
  const handler = room.slice(room.indexOf("const styleItem = useCallback"), room.indexOf("/** Keeps one proposal outfit"))
  assert.ok(handler.includes("setNotice({ message: toStyleFailureMessage(error) })"), "denials surface safe copy")
})

test("save resolution feeds styling: ready saves resolve their item id once", () => {
  // Step 4A.2 moved this transition into the canonical adoptSavedItem helper, which BOTH the
  // in-room button and a contextual page-pill save now call.
  const adopt = room.slice(room.indexOf("const adoptSavedItem = useCallback"), room.indexOf("const saveToWardrobe = useCallback"))
  assert.ok(adopt.includes("wardrobeSave.queryStatus(uploadId)"), "item id resolved read-only")
  assert.ok(adopt.includes("setStyleState({ garmentId, itemId: status.itemId"), "style armed with the saved id")
  assert.ok(room.includes('if (terminal === "ready") await adoptSavedItem(id, uploadId)'), "in-room save adopts through the shared helper")
})
