// Step 3, boundaries at the extension edge for retail-image links.
//
// The old worker answered `{type:"image", url}` with a browser-side fetch. That path is gone:
// retail bytes are now fetched, validated and stored by the authenticated Convex action
// `shoppingImages:fetchRemote` (pure logic covered unit-level in ../tests/image-fetch.test.mjs).
// These tests pin (1) the worker has no image handler to answer at all, (2) no extension module
// still issues an image-fetch message, and (3) the image URL never crosses to the server
// boundary until the one-time page-token handoff has succeeded.
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, "utf8")

async function bundleModule(relative) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, format: "esm", write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

test("the worker no longer answers image requests of any kind", async () => {
  let handledAnything = false
  globalThis.chrome = {
    storage: { session: { get: async () => ({}) }, local: { get: async () => ({}) } },
    runtime: {
      id: "ext",
      getURL: path => `chrome-extension://ext/${path}`,
      onMessage: { addListener: () => { handledAnything = true } },
      onMessageExternal: { addListener() {} },
      onInstalled: { addListener() {} }
    },
    scripting: { executeScript() {} }
  }
  await bundleModule("../background.ts")
  assert.ok(handledAnything, "the worker still has a message listener")
  // And that listener runs a capability gate, not a fetch: prove it from source, not bundles.
  const background = read("background.ts")
  assert.equal(background.includes('case "image"'), false, "there is no image case to reach")
  assert.equal(background.includes("requestImage"), false)
  assert.equal(background.includes("IMAGE_TYPES"), false)
  assert.equal(background.includes("getUrlOrPreview"), false)
  assert.ok(background.includes("ISSUE_CAPABILITY_MESSAGE"), "the only handled message is capability issuance")
})

test("no extension module asks the worker to fetch an image anymore", () => {
  for (const file of ["content.tsx", "tabs/room.tsx", "popup.tsx", "options.tsx", "lib/capability-client.ts", "lib/hover-overlay.ts", "lib/vision.ts"]) {
    const source = read(file)
    assert.equal(source.includes('type: "image"'), false, `${file} must not issue image-fetch messages`)
  }
})

test("the page-token handoff gates the image URL at the server boundary", async () => {
  const { saveRemoteGarment } = await bundleModule("../lib/wardrobe-save.ts")
  const calls = { registerRemote: 0, takeToken: 0 }
  await saveRemoteGarment({
    isSignedIn: () => true,
    openSignIn: () => {},
    remoteImage: {
      registerRemote: async () => { calls.registerRemote++; return { uploadId: "u", jobId: "j" } }
    },
    takeToken: async () => { calls.takeToken++; return false },
    saver: { watch: async () => "ready" },
    reply: () => {}
  }, { imageUrl: "https://cdn.shop.example/product.jpg", clientImportId: "client-a-b-c", token: "forged" })
  assert.equal(calls.registerRemote, 0, "a forged token never crosses the boundary")
  assert.equal(calls.takeToken, 1)
})