// Step 3A: Save to wardrobe from the OpenWear fitting room.
//
// The saver uploads the normalized garment Blob through authenticated Convex storage,
// registers a shopping import, and watches its status — with no Live Mirror, no camera, and
// no credentials involved. No test contacts Convex, Decart, OpenAI, or any live website:
// every boundary is a fake.

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
const drop = await bundleModule("../lib/drop.ts")

const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
const content = readFileSync(fileURLToPath(new URL("../content.tsx", import.meta.url)), "utf8")

const STATUS = (state) => ({ state, uploadId: "uploads-1", jobId: "jobs-1" })

/** Injected Convex boundaries with call recording. Status resolves through a scripted queue. */
function fakeDeps({ statuses = [STATUS("ready")] } = {}) {
  const calls = { generateUploadUrl: 0, postBlob: [], register: [], queryStatus: 0 }
  const queue = [...statuses]
  return {
    calls,
    deps: {
      generateUploadUrl: async () => { calls.generateUploadUrl++; return "https://convex.invalid/upload" },
      postBlob: async (url, blob, mimeType) => { calls.postBlob.push({ url, size: blob.size, mimeType }); return "storage-1" },
      registerImport: async (input) => { calls.register.push(input); return { uploadId: "uploads-1", jobId: "jobs-1", deduped: false } },
      queryStatus: async () => { calls.queryStatus++; return queue.length > 1 ? queue.shift() : queue[0] }
    }
  }
}

const garmentInput = (overrides = {}) => ({
  blob: new Blob(["fake-jpeg-bytes"], { type: "image/jpeg" }),
  fileName: "Blue Shirt.jpg",
  productTitle: "Blue Oxford Shirt",
  sourcePageUrl: "https://shop.example.com/products/blue-oxford",
  clientImportId: "client-import-1",
  ...overrides
})

// ---------- Upload protocol ----------

test("21/22: save uploads the current normalized Blob with its MIME and size", async () => {
  const { calls, deps } = fakeDeps()
  const wardrobe = saver.createWardrobeSaver(deps)
  const result = await wardrobe.save(garmentInput())
  assert.deepEqual(result, { uploadId: "uploads-1", jobId: "jobs-1" })
  assert.equal(calls.generateUploadUrl, 1, "one signed URL per save")
  assert.equal(calls.postBlob.length, 1)
  assert.equal(calls.postBlob[0].url, "https://convex.invalid/upload")
  assert.equal(calls.postBlob[0].mimeType, "image/jpeg", "the normalized blob MIME is sent")
  assert.ok(calls.postBlob[0].size > 0)
  const [registration] = calls.register
  assert.equal(registration.storageId, "storage-1")
  assert.equal(registration.fileName, "Blue Shirt.jpg")
  assert.equal(registration.mimeType, "image/jpeg")
  assert.equal(registration.sizeBytes, calls.postBlob[0].size, "the blob's own size is reported")
  assert.equal(registration.productTitle, "Blue Oxford Shirt")
  assert.equal(registration.sourcePageUrl, "https://shop.example.com/products/blue-oxford")
  assert.equal(registration.clientImportId, "client-import-1")
})

test("save refuses an empty or missing garment image before any network call", async () => {
  const { calls, deps } = fakeDeps()
  const wardrobe = saver.createWardrobeSaver(deps)
  await assert.rejects(wardrobe.save(garmentInput({ blob: new Blob([], { type: "image/jpeg" }) })), /no garment image/i)
  assert.equal(calls.generateUploadUrl, 0, "nothing leaves the browser without an image")
})

test("postBlobToConvex follows the Convex storage protocol", async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url, contentType: init.headers["Content-Type"] })
    return { ok: true, async json() { return { storageId: "storage-9" } } }
  }
  try {
    const storageId = await saver.postBlobToConvex("https://convex.invalid/upload", new Blob(["x"], { type: "image/jpeg" }), "image/jpeg")
    assert.equal(storageId, "storage-9")
    assert.deepEqual(seen, [{ url: "https://convex.invalid/upload", contentType: "image/jpeg" }])
  } finally {
    delete globalThis.fetch
  }
})

test("postBlobToConvex fails safely on transport, status, and malformed replies", async () => {
  const blob = new Blob(["x"], { type: "image/jpeg" })
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch") }
  await assert.rejects(saver.postBlobToConvex("https://u", blob, "image/jpeg"), /connection/i)
  globalThis.fetch = async () => ({ ok: false, status: 500 })
  await assert.rejects(saver.postBlobToConvex("https://u", blob, "image/jpeg"), /500/)
  globalThis.fetch = async () => ({ ok: true, async json() { return {} } })
  await assert.rejects(saver.postBlobToConvex("https://u", blob, "image/jpeg"), /storage id/i)
  delete globalThis.fetch
})

test("server error copy passes through, everything else becomes the safe retry copy", () => {
  assert.equal(
    saver.toSaveFailureMessage(Object.assign(new Error("x"), { data: { code: "WARDROBE_FULL", message: "Your wardrobe is full." } })),
    "Your wardrobe is full."
  )
  assert.equal(saver.toSaveFailureMessage(new Error("Failed to fetch")), "Couldn't save. Try again.")
  assert.equal(saver.toSaveFailureMessage(null), "Couldn't save. Try again.")
})

// ---------- Single-flight + idempotency ----------

test("24: duplicate clicks share one in-flight save", async () => {
  const { calls, deps } = fakeDeps()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = { ...deps, generateUploadUrl: async () => { await gate; return deps.generateUploadUrl() } }
  const wardrobe = saver.createWardrobeSaver(slow)
  const attempts = [wardrobe.save(garmentInput()), wardrobe.save(garmentInput()), wardrobe.save(garmentInput())]
  release()
  const results = await Promise.all(attempts)
  assert.ok(results.every(result => result.uploadId === "uploads-1"))
  assert.equal(calls.generateUploadUrl, 1, "one upload URL for three clicks")
  assert.equal(calls.postBlob.length, 1, "one blob POST for three clicks")
  assert.equal(calls.register.length, 1, "one registration for three clicks")
})

test("25: a retry after settling reuses the same clientImportId", async () => {
  const { calls, deps } = fakeDeps()
  const wardrobe = saver.createWardrobeSaver(deps)
  await wardrobe.save(garmentInput())
  await wardrobe.save(garmentInput())
  assert.equal(calls.register.length, 2, "a deliberate retry issues a new request")
  assert.ok(calls.register.every(input => input.clientImportId === "client-import-1"), "with the same idempotency key")
})

// ---------- Status watching ----------

test("28–32: terminal states resolve with exact UI copy", async () => {
  const { deps } = fakeDeps({ statuses: [STATUS("processing"), STATUS("ready")] })
  const wardrobe = saver.createWardrobeSaver(deps)
  const seen = []
  const terminal = await wardrobe.watch("uploads-1", { onPhase: phase => seen.push(phase), intervalMs: 1 })
  assert.equal(terminal, "ready")
  assert.deepEqual(seen, ["processing", "ready"])
  assert.equal(saver.SAVE_COPY.ready.button, "Saved to wardrobe ✓")
  assert.equal(saver.SAVE_COPY.needs_credits.button, "Needs 1 credit to finish")
  assert.equal(saver.SAVE_COPY.no_item.button, "Couldn't identify this product")
  assert.equal(saver.SAVE_COPY.failed.button, "Couldn't save. Try again.")
  assert.equal(saver.SAVE_COPY.idle.button, "Save to wardrobe")
})

test("27: a stale completion resolves quietly without touching new UI", async () => {
  const { deps } = fakeDeps({ statuses: [STATUS("processing"), STATUS("ready")] })
  const wardrobe = saver.createWardrobeSaver(deps)
  let current = true
  const seen = []
  const terminal = await wardrobe.watch("uploads-1", {
    onPhase: phase => seen.push(phase),
    isCurrent: () => { current = false; return current },
    intervalMs: 1
  })
  assert.equal(terminal, "processing", "stale watcher stops at the first check")
  assert.deepEqual(seen, [], "no UI callbacks once stale")
})

test("watch maps every terminal state and fails safe on query errors", async () => {
  for (const [state, expected] of [["ready", "ready"], ["needs_credits", "needs_credits"], ["no_item", "no_item"], ["failed", "failed"]]) {
    const { deps } = fakeDeps({ statuses: [STATUS(state)] })
    const wardrobe = saver.createWardrobeSaver(deps)
    assert.equal(await wardrobe.watch("uploads-1", { intervalMs: 1 }), expected)
  }
  const broken = saver.createWardrobeSaver({
    generateUploadUrl: async () => { throw new Error("unreachable") },
    postBlob: async () => { throw new Error("unreachable") },
    registerImport: async () => { throw new Error("unreachable") },
    queryStatus: async () => { throw new Error("Convex unreachable") }
  })
  assert.equal(await broken.watch("uploads-1", { intervalMs: 1 }), "failed")
})

// ---------- Room wiring (source assertions) ----------

test("23/34/35: saving never authorizes, never reads quota, never touches camera or provider", () => {
  const block = room.slice(room.indexOf("const saveToWardrobe"), room.indexOf("/** Entry point for every garment"))
  for (const forbidden of ["authorizer", "liveMirrorAction", "quotaStatus", "connect(", "stop(", "stopStream", "closeProvider", "frozenPreview", "createDecartClient"]) {
    assert.ok(!block.includes(forbidden), `save path must not reference ${forbidden}`)
  }
  assert.ok(block.includes("saver.save(") && block.includes("saver.watch("), "save goes through the wardrobe saver")
})

test("26: a new garment gets a new idempotency key and an idle save UI", () => {
  const tryOn = room.slice(room.indexOf("const tryOn = useCallback"), room.indexOf("/** Renaming the garment"))
  assert.ok(tryOn.includes("crypto.randomUUID()"), "fresh clientImportId per garment")
  assert.ok(tryOn.includes('setSaveState({ garmentId: id, clientImportId, phase: "idle" })'), "save UI resets for the new garment")
})

test("save button appears with a loaded image and reflects each phase", () => {
  assert.ok(room.includes("{garment.preview ? <div className=\"save-row\">"), "save row renders once the image is loaded")
  assert.ok(room.includes("{SAVE_COPY[savePhase].button}"), "button copy follows the save phase")
  assert.ok(room.includes("disabled={saveBusy || savePhase === \"ready\"}"), "no double-submit, no re-save of a saved garment")
  const css = readFileSync(fileURLToPath(new URL("../tabs/room.css", import.meta.url)), "utf8")
  assert.ok(css.includes(".save-row") && css.includes(".save:not(:disabled):hover"), "save row styling exists")
})

test("save works from frozen state: frozen preview is never cleared by saving", () => {
  const block = room.slice(room.indexOf("const saveToWardrobe"), room.indexOf("/** Entry point for every garment"))
  assert.ok(!block.includes("revokeFrozen") && !block.includes("setFrozenPreview"), "saving leaves the frozen still alone")
  assert.ok(room.includes("frozenBlobRef"), "frozen snapshot path is independent of the save path")
})

// ---------- Provenance ----------

test("36: page provenance strips fragments and rejects everything unsafe", () => {
  assert.equal(drop.canonicalSourcePageUrl("https://shop.example.com/p/blue#reviews"), "https://shop.example.com/p/blue")
  assert.equal(drop.canonicalSourcePageUrl("https://shop.example.com/p/blue"), "https://shop.example.com/p/blue")
  for (const bad of ["http://localhost:3000/x", "https://user:pass@shop.example.com/x", "ftp://files.example/x", "not a url", "", "x".repeat(3000)]) {
    assert.equal(drop.canonicalSourcePageUrl(bad), undefined, `must reject ${JSON.stringify(bad).slice(0, 40)}`)
  }
})

test("37: the content script sends provenance only, never page secrets", () => {
  const forward = content.slice(content.indexOf("const forwardGarment"), content.indexOf("/** Try on:"))
  assert.ok(forward.includes('type: "openwear:garment"'), "garment messages exist")
  assert.ok(!/cookie|localStorage|innerHTML|outerHTML|document\.documentElement/.test(forward), "no page secrets in garment posts")
  assert.ok(forward.includes("capability"), "every garment post carries a capability")
  assert.ok(content.includes("canonicalSourcePageUrl(window.location.href)"), "page URL is canonicalized at the source")
  assert.ok(room.includes("const handleGarmentMessage"), "garment posts go through the validation gate")
})

// ---------- Cross-context save protocol ----------

function fakeTokenStore(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => store.has(key)).map(key => [key, store.get(key)])),
    set: async (items) => { for (const [key, value] of Object.entries(items)) store.set(key, value) },
    remove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) store.delete(key) }
  }
}

test("one-time capabilities are minted per scope, consumed once, and reject forgeries", async () => {
  const store = fakeTokenStore()
  const token = await saver.issueCapability(store, "save", () => "fixed-id")
  assert.equal(token, "owcap-save-fixed-id")
  assert.equal(await saver.consumeCapability(store, token, "save"), true, "first use succeeds")
  assert.equal(await saver.consumeCapability(store, token, "save"), false, "replays fail")
  assert.equal(await saver.consumeCapability(store, "owcap-save-never-issued", "save"), false, "forgeries fail")
  assert.equal(await saver.consumeCapability(store, null, "save"), false)
  assert.equal(await saver.consumeCapability(store, "x".repeat(300), "save"), false, "oversized tokens fail")
})

test("capability scopes never overlap", async () => {
  const store = fakeTokenStore()
  const saveToken = await saver.issueCapability(store, "save", () => "scope-a")
  const garmentToken = await saver.issueCapability(store, "garment", () => "scope-b")
  assert.equal(await saver.consumeCapability(store, saveToken, "garment"), false, "save token cannot satisfy garment")
  assert.equal(await saver.consumeCapability(store, garmentToken, "save"), false, "garment token cannot satisfy save")
  // A wrong-scope attempt burns the token: fail closed, never leave it usable afterwards.
  assert.equal(await saver.consumeCapability(store, saveToken, "save"), false)
  assert.equal(await saver.consumeCapability(store, garmentToken, "garment"), false)
})

test("expired capabilities fail closed", async () => {
  const store = fakeTokenStore()
  const token = await saver.issueCapability(store, "save", () => "old-id")
  assert.equal(await saver.consumeCapability(store, token, "save", Date.now() + 11 * 60 * 1000), false)
})

test("client import ids mirror the server charset rule", () => {
  assert.equal(saver.isValidClientImportId("client-import-1"), true)
  assert.equal(saver.isValidClientImportId(crypto.randomUUID()), true)
  for (const bad of ["", "has space", "semi;colon", "x".repeat(129), null, 42]) {
    assert.equal(saver.isValidClientImportId(bad), false, JSON.stringify(bad))
  }
})

test("display file names come from the URL path with a safe fallback", () => {
  assert.equal(saver.fileNameFromUrl("https://shop.example.com/images/blue-shirt.jpg"), "blue-shirt.jpg")
  assert.equal(saver.fileNameFromUrl("https://shop.example.com/images/blue-shirt.jpg?width=800"), "blue-shirt.jpg")
  assert.equal(saver.fileNameFromUrl("https://shop.example.com/"), "shopping-garment.jpg")
  assert.equal(saver.fileNameFromUrl("not a url"), "shopping-garment.jpg")
  assert.ok(saver.fileNameFromUrl("https://shop.example.com/" + "a".repeat(300) + ".jpg").length <= 128)
})

test("reply waiters match responses to requests with timeouts", async () => {
  const waiter = saver.createReplyWaiter()
  const pending = waiter.wait("k1", 50, "timed-out")
  assert.equal(waiter.pendingCount(), 1)
  assert.equal(waiter.resolve("k1", "answer"), true)
  assert.equal(await pending, "answer")
  assert.equal(waiter.pendingCount(), 0)
  assert.equal(waiter.resolve("k1", "late"), false, "replays resolve nothing")
  assert.equal(await waiter.wait("k2", 5, "timed-out"), "timed-out")
  waiter.wait("k3", 1000, "x")
  waiter.cancel("k3")
  assert.equal(waiter.pendingCount(), 0)
})

function remoteSaver({ terminal = "ready" } = {}) {
  const calls = { save: [], watch: 0 }
  return {
    calls,
    saver: {
      save: async (input) => { calls.save.push(input); return { uploadId: "uploads-9", jobId: "jobs-9" } },
      watch: async () => { calls.watch++; return terminal }
    }
  }
}

const remoteDeps = (overrides = {}) => ({
  isSignedIn: () => true,
  openSignIn: () => {},
  fetchImageDataUrl: async () => "data:image/jpeg;base64,/9j/",
  normalizeImage: async () => ({ blob: new Blob(["x"], { type: "image/jpeg" }) }),
  takeToken: async () => true,
  saver: remoteSaver().saver,
  reply: () => {},
  ...overrides
})

const remoteInput = (overrides = {}) => ({
  imageUrl: "https://shop.example.com/images/blue.jpg",
  productTitle: "Blue Shirt",
  sourcePageUrl: "https://shop.example.com/p/1",
  clientImportId: "client-import-9",
  token: "save-token-9",
  ...overrides
})

test("room-side save validates, consumes the token, and replies with the terminal phase", async () => {
  const replies = []
  const { calls, saver: fake } = remoteSaver({ terminal: "needs_credits" })
  await saver.saveRemoteGarment({ ...remoteDeps({ saver: fake, reply: (phase) => replies.push(phase) }), takeToken: async (token) => {
    assert.equal(token, "save-token-9")
    return true
  } }, remoteInput())
  assert.equal(calls.save.length, 1)
  assert.equal(calls.save[0].fileName, "blue.jpg")
  assert.equal(calls.save[0].clientImportId, "client-import-9")
  assert.deepEqual(replies, ["needs_credits"])
})

test("room-side save silently ignores malformed or forged requests", async () => {
  for (const bad of [
    remoteInput({ clientImportId: "has space" }),
    remoteInput({ imageUrl: "javascript:alert(1)" }),
    remoteInput({ imageUrl: "" }),
    remoteInput({ token: 42 })
  ]) {
    const replies = []
    const { calls, saver: fake } = remoteSaver()
    await saver.saveRemoteGarment({ ...remoteDeps({ saver: fake, reply: (phase) => replies.push(phase) }) }, bad)
    assert.equal(calls.save.length, 0, "no saver call for malformed input")
    assert.deepEqual(replies, [], "no reply leaks anything to a hostile sender")
  }
  const replies = []
  await saver.saveRemoteGarment({ ...remoteDeps({ reply: (phase) => replies.push(phase), takeToken: async () => false }) }, remoteInput())
  assert.deepEqual(replies, [], "a forged token is silently ignored")
})

test("room-side save opens sign-in and replies without touching the saver when signed out", async () => {
  let signInOpened = 0
  const replies = []
  const { calls, saver: fake } = remoteSaver()
  await saver.saveRemoteGarment({
    ...remoteDeps({ saver: fake, reply: (phase) => replies.push(phase) }),
    isSignedIn: () => false,
    openSignIn: () => { signInOpened++ }
  }, remoteInput())
  assert.equal(signInOpened, 1)
  assert.deepEqual(replies, ["signed_out"])
  assert.equal(calls.save.length, 0, "nothing is uploaded while signed out")
})

test("room-side save replies failed when the pipeline throws", async () => {
  const replies = []
  await saver.saveRemoteGarment({
    ...remoteDeps({ reply: (phase) => replies.push(phase) }),
    fetchImageDataUrl: async () => { throw new Error("private image URL") }
  }, remoteInput())
  assert.deepEqual(replies, ["failed"])
})

test("content-side save opens the room, handshakes, posts once, and returns the phase", async () => {
  const posts = []
  let opened = 0
  const result = await saver.requestRemoteSave(
    {
      openRoom: () => { opened++ },
      postToRoom: (message) => posts.push(message),
      awaitRoomReady: async () => true,
      issueToken: async () => "save-issued-1",
      awaitSaveStatus: async () => "ready"
    },
    { imageUrl: "https://shop.example.com/i.jpg", productTitle: "Blue", sourcePageUrl: "https://shop.example.com/p" },
    "client-import-7"
  )
  assert.deepEqual(result, { clientImportId: "client-import-7", phase: "ready" })
  assert.equal(opened, 1)
  assert.equal(posts.length, 1, "exactly one save message")
  assert.deepEqual(posts[0], {
    type: "openwear:save-garment",
    imageUrl: "https://shop.example.com/i.jpg",
    productTitle: "Blue",
    sourcePageUrl: "https://shop.example.com/p",
    clientImportId: "client-import-7",
    token: "save-issued-1"
  })
})

test("content-side save fails closed when the room never answers", async () => {
  const posts = []
  const result = await saver.requestRemoteSave(
    {
      openRoom: () => {},
      postToRoom: (message) => posts.push(message),
      awaitRoomReady: async () => false,
      issueToken: async () => { throw new Error("must not mint a token for a dead room") },
      awaitSaveStatus: async () => { throw new Error("must not wait without a post") }
    },
    { imageUrl: "https://shop.example.com/i.jpg" }
  )
  assert.equal(result.phase, "failed")
  assert.equal(posts.length, 0, "nothing is posted to a room that never answered")
})

test("content-side save maps room silence after posting to a retryable failure", async () => {
  const result = await saver.requestRemoteSave(
    {
      openRoom: () => {},
      postToRoom: () => {},
      awaitRoomReady: async () => true,
      issueToken: async () => "save-issued-2",
      awaitSaveStatus: async () => "timeout"
    },
    { imageUrl: "https://shop.example.com/i.jpg" },
    "client-import-8"
  )
  assert.deepEqual(result, { clientImportId: "client-import-8", phase: "failed" })
})
