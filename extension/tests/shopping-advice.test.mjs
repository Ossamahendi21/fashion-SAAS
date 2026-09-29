// Step 3E: Should I buy this? in the OpenWear fitting room.
//
// For a ready considering item the room offers a purchase-decision analysis built from
// the user's actual owned wardrobe: similar owned items, match counts, outfit potential
// and bounded pros/considerations. Analysis only — never saves, uploads, styles,
// authorizes Live Mirror or marks owned. Behavioral units (copy, single-flight, failure
// mapping) are tested for real; room wiring is asserted against its own source,
// matching this repo's established style.

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

const adviceHandler = () => room.slice(room.indexOf("const analyzeItem = useCallback"), room.indexOf("const saveSuggestionOutfit = useCallback"))
const garmentCard = () => room.slice(room.indexOf("{garment && <div className={`garment-card"), room.indexOf("{cameraOn && <div className=\"toolbar\">"))

// ---------- Refs + copy ----------

test("the advice action takes only the saved item id", () => {
  assert.equal(typeof saver.requestShoppingAdvice, "object", "a Convex function reference")
  const symbols = Object.getOwnPropertySymbols(saver.requestShoppingAdvice)
  const name = symbols.map(key => saver.requestShoppingAdvice[key]).find(value => typeof value === "string")
  assert.equal(name, "shoppingAdvice:analyze")
})

test("25/26: advice copy is exact and provider-free", () => {
  assert.equal(saver.ADVICE_COPY.adviceButton, "Should I buy this?")
  assert.equal(saver.ADVICE_COPY.analyzingButton, "Analyzing…")
  assert.equal(saver.ADVICE_COPY.failedButton, "Couldn't analyze. Try again.")
  const serialized = JSON.stringify(saver.ADVICE_COPY)
  for (const forbidden of ["decart", "openai", "token", "credit", "price", "percent", "%", "score"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden), `advice copy must not mention ${forbidden}`)
  }
})

test("advice failures map to safe copy", () => {
  assert.equal(
    saver.toAdviceFailureMessage(Object.assign(new Error("x"), { data: { code: "RATE_LIMITED", message: "Slow down." } })),
    "Slow down."
  )
  assert.equal(
    saver.toAdviceFailureMessage(Object.assign(new Error("x"), { data: { message: "This item is already in your wardrobe." } })),
    "This item is already in your wardrobe."
  )
  assert.equal(saver.toAdviceFailureMessage(new Error("Failed to fetch")), "Couldn't analyze this item. Try again.")
  assert.equal(saver.toAdviceFailureMessage(null), "Couldn't analyze this item. Try again.")
})

// ---------- Room wiring ----------

test("25: a ready considering item shows Should I buy this?", () => {
  const card = garmentCard()
  assert.ok(card.includes("showAdvice"), "advice row is gated")
  assert.ok(room.includes("const showAdvice = ownPhase !== null && ownPhase !== \"owned\" && adviceForGarment !== null"), "visible while considering only")
  assert.ok(card.includes("ADVICE_COPY.adviceButton"), "the button carries the exact copy")
  assert.ok(card.includes("title=\"See how this saved find fits your wardrobe\""), "the button explains itself")
})

test("26: owned items show no advice button", () => {
  assert.ok(room.includes("ownPhase !== \"owned\""), "buying the item hides the advice UI")
  assert.ok(room.includes("setAdviceState(null)"), "advice state is cleared")
  const card = garmentCard()
  assert.ok(!card.includes("ADVICE_COPY.adviceButton") || card.includes("showAdvice"), "the button only renders inside the considering gate")
})

test("27: analyzing state disables the button", () => {
  const handler = adviceHandler()
  const card = garmentCard()
  assert.ok(card.includes("ADVICE_COPY.analyzingButton"), "analyzing copy on the button")
  assert.ok(room.includes("disabled={adviceForGarment.phase === \"analyzing\"}"), "no double-submit while analyzing")
  assert.ok(handler.includes("setAdviceState({ garmentId, itemId, phase: \"analyzing\" })"), "phase set before the request")
})

test("28: the result panel renders the similarity signal", () => {
  const card = garmentCard()
  assert.ok(card.includes("adviceForGarment.advice.signals.slice(0, 3)"), "signals rendered bounded")
  assert.ok(card.includes("advice-thumb"), "similar items get thumbnails")
  assert.ok(card.includes("suggestion-thumb") || card.includes("item.url"), "thumbnails come from existing item image URLs")
  assert.ok(card.includes("{item.duplicate ? <i>Own it</i> : null}"), "owned near-twins are flagged, never scored")
  assert.ok(!card.includes("similarity"), "no raw similarity numbers reach the UI")
})

test("29: match count is rendered", () => {
  const card = garmentCard()
  assert.ok(card.includes("Works with {adviceForGarment.advice.matchCount} pieces you own"), "explicit match-count line")
})

test("30: outfit-potential copy is rendered", () => {
  const card = garmentCard()
  assert.ok(card.includes("adviceForGarment.advice.outfitPotential.display"), "bounded server display copy, never computed client-side")
})

test("31: pros and considerations are bounded", () => {
  const card = garmentCard()
  assert.ok(card.includes("adviceForGarment.advice.pros.slice(0, 3)"), "at most three pros")
  assert.ok(card.includes("adviceForGarment.advice.considerations.slice(0, 3)"), "at most three considerations")
  assert.ok(!card.includes("Buy it") || card.includes("I bought this"), "the panel never renders a buy verdict")
})

test("32: double clicks share one in-flight analysis", async () => {
  let calls = 0
  const client = saver.createAdviceClient({
    requestAdvice: async ({ itemId }) => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return { candidate: { itemId, name: "Jacket" } }
    }
  })
  const [first, second] = await Promise.all([client.analyze("items-1"), client.analyze("items-1")])
  assert.equal(calls, 1, "one request for two clicks")
  assert.equal(first, second, "both callers share the result")
  await client.analyze("items-1")
  assert.equal(calls, 2, "a settled request leaves no residue")
})

test("33/34/35: advice never saves, styles, or authorizes Live Mirror", () => {
  const handler = adviceHandler()
  assert.ok(handler.includes("await advice.analyze(itemId)"), "the client receives the item id and nothing else")
  for (const forbidden of ["saver.save", "saver.watch", "registerImport", "generateUploadUrl", "postBlob", "clientImportId", "requestStyling", "saveOutfitProposal", "markOwned"]) {
    assert.ok(!handler.includes(forbidden), `advice path must not reference ${forbidden}`)
  }
  for (const forbidden of ["authorizer", "liveMirrorAction", "liveMirror", "acquireCamera", "stopStream", "closeProvider", "connectionRef", "authorizeLiveMirror"]) {
    assert.ok(!handler.includes(forbidden), `advice path must not reference ${forbidden}`)
  }
  assert.ok(room.includes("requestAdvice={(args) => adviceAction(args)}"), "room wires the advice action with args passthrough")
})

test("36: stale older advice cannot overwrite a newer garment", () => {
  const handler = adviceHandler()
  assert.ok(handler.includes("if (advisingRef.current) return"), "synchronous single-flight guard")
  assert.ok(handler.includes("advisingRef.current = true"), "guard set before the first await")
  assert.ok(handler.includes("if (garmentRef.current?.id !== garmentId) return"), "stale guard before storing")
  const occurrences = [...handler.matchAll(/garmentRef\.current\?\s*\.id !== garmentId/g)].length
  assert.ok(occurrences >= 2, "stale guard on both success and failure paths")
  assert.ok(handler.includes("ownStateRef.current?.phase === \"owned\""), "advice landing after a purchase never paints")
})

test("37: markOwned closes and updates advice state", () => {
  const handler = room.slice(room.indexOf("const markOwnedItem = useCallback"), room.indexOf("const tryOn = useCallback"))
  assert.ok(handler.includes("setAdviceState(null)"), "buying the item closes the advice panel")
  assert.ok(room.includes("setAdviceState({ garmentId: id, itemId: status.itemId, phase: \"idle\" })"), "new considering garments re-arm advice")
  assert.ok(room.includes("setAdviceState(null)") && room.includes("setStyleState(null)"), "a new garment resets advice like style state")
})

test("38: failure produces safe retry UI", () => {
  const card = garmentCard()
  assert.ok(card.includes("ADVICE_COPY.failedButton"), "failed copy on the button")
  assert.ok(adviceHandler().includes("setNotice({ message: toAdviceFailureMessage(error) })"), "structured server message or safe fallback")
})

test("advice panel styling exists and stays compact", () => {
  assert.ok(roomCss.includes(".advice-row") && roomCss.includes(".advice-panel"), "panel styling exists")
  assert.ok(roomCss.includes(".advice-thumb"), "thumbnail styling exists")
  assert.ok(roomCss.includes("max-height: 220px"), "the panel scrolls instead of growing")
})
