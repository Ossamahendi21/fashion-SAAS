// Step 4A.2: a contextual page-pill Save must leave the room in the SAME state as the in-room
// Save button, without a second save.
//
// Real Chrome finding: `saveRemoteGarment` saved and replied "ready" to the page, but never
// touched the room's save/style/own/advice state, so the pill said "Saved v" while the room
// card stayed unsaved and Style this item / Should I buy this? / I bought this never appeared.
// The fix routes BOTH entry points through one canonical adoption transition in room.tsx.

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { build } from "esbuild"

async function bundleModule(relative) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, format: "esm", write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

const { saveRemoteGarment } = await bundleModule("../lib/wardrobe-save.ts")

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, "utf8")
const room = read("tabs/room.tsx")

/** Records every registration and status watch so we can prove no second save ever happens. */
function fakeSaver({ terminal = "ready" } = {}) {
  const calls = { register: 0, watch: 0, registeredIds: [], watchedIds: [] }
  return {
    calls,
    remoteImage: {
      registerRemote: async (_url, registerInput) => {
        calls.register++
        calls.registeredIds.push(registerInput.clientImportId)
        return { uploadId: "uploads-1", jobId: "jobs-1" }
      }
    },
    saver: {
      save: async () => { throw new Error("the room must never upload; the server fetched the bytes") },
      watch: async (uploadId) => { calls.watch++; calls.watchedIds.push(uploadId); return terminal }
    }
  }
}

const deps = (overrides = {}) => ({
  isSignedIn: () => true,
  openSignIn: () => {},
  // Step 3: the image is fetched, stored and registered server-side. The room never downloads
  // retail bytes or builds a data URL, so there is no fetchImageDataUrl/normalizeImage dep left.
  remoteImage: {
    registerRemote: async () => ({ uploadId: "uploads-1", jobId: "jobs-1" })
  },
  takeToken: async () => true,
  reply: () => {},
  ...overrides
})

const input = (overrides = {}) => ({
  imageUrl: "https://shop.example.com/images/blue.jpg",
  clientImportId: "client-import-1",
  token: "save-token-1",
  ...overrides
})

// ---------- 1, 2, 15: a ready contextual save adopts and still replies Saved ----------

test("1/2/15: a ready contextual save adopts the saved item and still replies ready", async () => {
  const { saver, remoteImage } = fakeSaver({ terminal: "ready" })
  const replies = []
  const adopted = []
  await saveRemoteGarment(
    deps({ saver, remoteImage, reply: (phase) => replies.push(phase), adoptSavedItem: async (uploadId) => { adopted.push(uploadId) } }),
    input()
  )
  assert.deepEqual(adopted, ["uploads-1"], "the room is told to adopt the completed save, with its uploadId")
  assert.deepEqual(replies, ["ready"], "the page pill still receives its terminal reply")
})

// ---------- 6, 7: adoption is state synchronisation only ----------

test("6: adopting a contextual save never starts a second registration or any provider call", async () => {
  const { saver, remoteImage, calls } = fakeSaver({ terminal: "ready" })
  const adopted = []
  await saveRemoteGarment(deps({ saver, remoteImage, adoptSavedItem: async (uploadId) => { adopted.push(uploadId) } }), input())
  assert.equal(calls.register, 1, "exactly one server-side registration")
  assert.equal(calls.watch, 1, "exactly one watch cycle")
  assert.equal(adopted.length, 1, "adoption is called once, after the save completed")
  // Adoption only receives an uploadId, so it structurally cannot register or upload again.
  assert.equal(adopted[0], "uploads-1")
})

test("6b: adoption runs after the watch completes, never before the reply", async () => {
  const order = []
  await saveRemoteGarment(
    deps({
      saver: { watch: async () => { order.push("watch"); return "ready" } },
      remoteImage: {
        registerRemote: async () => { order.push("register"); return { uploadId: "u", jobId: "j" } }
      },
      adoptSavedItem: async () => { order.push("adopt") },
      reply: () => { order.push("reply") }
    }),
    input()
  )
  assert.deepEqual(order, ["register", "watch", "adopt", "reply"], "one registration, then adoption, then the page reply")
})

// ---------- 8-12: only a real ready item enables the downstream actions ----------

test("8/9/10/11/12: a non-ready terminal phase never adopts the saved-item state", async () => {
  for (const terminal of ["processing", "needs_credits", "no_item", "failed"]) {
    const adopted = []
    const replies = []
    const { saver, remoteImage } = fakeSaver({ terminal })
    await saveRemoteGarment(deps({ saver, remoteImage, reply: (phase) => replies.push(phase), adoptSavedItem: async (u) => { adopted.push(u) } }), input())
    assert.deepEqual(adopted, [], `${terminal} does not expose Style / Advice / I bought this`)
    assert.deepEqual(replies, [terminal], `${terminal} is still reported to the page`)
  }
})

test("12b: signed_out adopts nothing", async () => {
  let signInOpened = 0
  const adopted = []
  const replies = []
  const { saver, remoteImage, calls } = fakeSaver()
  await saveRemoteGarment(
    deps({
      saver,
      remoteImage,
      isSignedIn: () => false,
      openSignIn: () => { signInOpened++ },
      reply: (phase) => replies.push(phase),
      adoptSavedItem: async (u) => { adopted.push(u) }
    }),
    input()
  )
  assert.equal(signInOpened, 1)
  assert.equal(calls.register, 0, "a signed-out room never registers")
  assert.equal(calls.watch, 0, "a signed-out room never watches")
  assert.deepEqual(adopted, [], "signed_out adopts nothing")
  assert.deepEqual(replies, ["signed_out"])
})

test("12c: a forged token adopts nothing", async () => {
  const adopted = []
  const { saver, remoteImage, calls } = fakeSaver()
  await saveRemoteGarment(deps({ saver, remoteImage, takeToken: async () => false, adoptSavedItem: async (u) => { adopted.push(u) } }), input())
  assert.equal(calls.register, 0, "a forged token never reaches the server boundary")
  assert.equal(calls.watch, 0)
  assert.deepEqual(adopted, [])
})

// ---------- 16: adoption stays single-flight ----------

test("16: a double-clicked contextual save carries one idempotency key to the server", async () => {
  // Step 3 moved deduplication to the server: shoppingImports:register is keyed on the
  // clientImportId, so the client's job is to forward that key UNCHANGED and to never let the
  // two clicks produce two different keys (which would be two uploads and two credit spends).
  const registeredKeys = []
  const sharedUpload = { uploadId: "uploads-1", jobId: "jobs-1" }
  const remoteImage = {
    registerRemote: async (_url, registerInput) => {
      // Stands in for the server's by-clientImportId lookup: a repeat key resolves the same upload.
      if (registeredKeys.includes(registerInput.clientImportId)) return sharedUpload
      registeredKeys.push(registerInput.clientImportId)
      return sharedUpload
    }
  }
  const { saver } = fakeSaver({ terminal: "ready" })
  const adopted = []
  const adopt = async (u) => { adopted.push(u) }
  const replies = []
  // Same clientImportId twice: the retry/reuse path a double click produces.
  await Promise.all([
    saveRemoteGarment(deps({ saver, remoteImage, adoptSavedItem: adopt, reply: (p) => replies.push(p) }), input()),
    saveRemoteGarment(deps({ saver, remoteImage, adoptSavedItem: adopt, reply: (p) => replies.push(p) }), input())
  ])
  assert.deepEqual(registeredKeys, ["client-import-1"], "both clicks resolve to one server upload: no duplicate save and no extra credit")
  assert.deepEqual(replies, ["ready", "ready"], "both attempts are answered")
  assert.equal(adopted.length, 2, "each completed request adopts once; the shared save is not repeated")
})

// ---------- 8: single source of truth in room.tsx ----------

test("8: both save entry points share ONE canonical adoption transition", () => {
  const helper = room.slice(room.indexOf("const adoptSavedItem = useCallback"), room.indexOf("const saveToWardrobe = useCallback"))
  assert.ok(helper.length > 0, "the canonical helper exists")
  assert.ok(helper.includes('setSaveState({ garmentId, clientImportId: current.clientImportId, phase: "ready" })'), "it marks the garment saved")
  assert.ok(helper.includes("setStyleState({ garmentId, itemId: status.itemId, phase: \"idle\" })"), "it arms Style")
  assert.ok(helper.includes("setOwnState"), "it arms I bought this")
  assert.ok(helper.includes("setAdviceState"), "it arms Should I buy this?")
  assert.ok(helper.includes('status.ownership !== "owned"'), "ownership still gates the purchase transition")
  // The in-room button delegates to the helper instead of repeating the transitions.
  const inRoom = room.slice(room.indexOf("const saveToWardrobe = useCallback"), room.indexOf("const styleItem = useCallback"))
  assert.ok(inRoom.includes('if (terminal === "ready") await adoptSavedItem(id, uploadId)'), "in-room Save calls the helper")
  assert.equal(inRoom.includes("setStyleState"), false, "in-room Save has no second implementation")
  assert.equal(inRoom.includes("setOwnState"), false, "in-room Save has no second implementation")
  assert.equal(inRoom.includes("setAdviceState"), false, "in-room Save has no second implementation")
  // The page-save handler delegates to the same helper.
  const pageSave = room.slice(room.indexOf('event.data.type === "openwear:save-garment"'), room.indexOf("window.addEventListener(\"message\", onMessage)"))
  assert.ok(pageSave.includes("adoptSavedItem: targetGarmentId === undefined ? undefined : (uploadId) => adoptSavedItem(targetGarmentId, uploadId)"), "the page save calls the same helper")
})

test("14: the canonical helper does no provider work of its own", () => {
  const helper = room.slice(room.indexOf("const adoptSavedItem = useCallback"), room.indexOf("const saveToWardrobe = useCallback"))
  for (const forbidden of ["authorizeLiveMirror", "saver.save", "generateUploadUrl", "registerImport", "startDecart", "markOwned", "requestStyling", "requestAdvice", "createWardrobeSaver"]) {
    assert.equal(helper.includes(forbidden), false, `adoption never calls ${forbidden}`)
  }
  assert.equal(helper.split("queryStatus").length - 1, 1, "it reads the completed save exactly once, to resolve the itemId")
})

// ---------- 3: stale-garment safety ----------

test("3: a stale save for an older garment cannot overwrite the newer garment", () => {
  const helper = room.slice(room.indexOf("const adoptSavedItem = useCallback"), room.indexOf("const saveToWardrobe = useCallback"))
  // Guarded before the await AND after it, so a garment swap during the status read is caught.
  assert.ok(helper.includes("if (!started || started.id !== garmentId) return"), "checks the garment before resolving")
  assert.ok(helper.includes("if (!current || current.id !== garmentId"), "re-checks after the await resolves")
  assert.ok(helper.includes("return"), "a stale completion resolves without painting")
  // The page-save path captures the visible garment id at request time and passes it in.
  const pageSave = room.slice(room.indexOf('event.data.type === "openwear:save-garment"'), room.indexOf("window.addEventListener(\"message\", onMessage)"))
  assert.ok(pageSave.includes("const targetGarmentId = garmentRef.current?.id"), "the garment is identified when the request arrives")
  assert.ok(pageSave.includes("targetGarmentId === undefined ? undefined"), "a save with no visible garment is simply not adoptable")
})

test("3b: adoption is keyed on the garment id, not on image URL equality", () => {
  const helper = room.slice(room.indexOf("const adoptSavedItem = useCallback"), room.indexOf("const saveToWardrobe = useCallback"))
  assert.equal(helper.includes("imageUrl"), false, "no weaker image-URL identity is used")
  assert.ok(helper.includes("garmentId"), "the strong monotonic garment id is the identity")
})

// ---------- 6: room consistency, no camera, no Live Mirror ----------

test("6c: adopting a contextual save needs no camera and no Live Mirror", () => {
  const pageSave = room.slice(room.indexOf('event.data.type === "openwear:save-garment"'), room.indexOf("window.addEventListener(\"message\", onMessage)"))
  for (const forbidden of ["authorizeLiveMirror", "getUserMedia", "startDecart", "start()", "loadQuotaStatus"]) {
    assert.equal(pageSave.includes(forbidden), false, `the page save never calls ${forbidden}`)
  }
  assert.ok(pageSave.includes("isSignedIn"), "it still requires the authenticated room context")
})

test("6d: the existing safe copy and gating are unchanged", () => {
  assert.ok(room.includes('if (terminal === "failed") setNotice({ message: "Couldn\'t save. Try again." })'), "failed copy preserved")
  assert.ok(room.includes("SAVE_COPY.needs_credits.note!"), "needs_credits copy preserved")
  assert.ok(room.includes("SAVE_COPY.no_item.note!"), "no_item copy preserved")
  // The three actions still render only off an adopted itemId, never off a bare phase.
  assert.ok(room.includes("{ownPhase ? <div className=\"save-row\">"), "I bought this renders only when ownPhase is set")
  assert.ok(room.includes("showAdvice && adviceForGarment"), "advice renders only with an adopted item")
  assert.ok(room.includes("styleState && styleState.garmentId === garment.id && styleState.itemId"), "Style renders only with an adopted itemId")
})
