// Step 3, Requirement A: the extension's client for server-fetched shopping images.
//
// The room sends only a public URL across the boundary; the server fetches, stores and
// returns an identity. Both save shapes (try-on first, or a headless page save) register that
// SAME server blob, so nothing is uploaded or downloaded twice. Every dependency is a fake:
// no Convex, storage, or retailer is contacted.
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../lib/remote-image.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  write: false,
})
const { createRemoteImageClient, fileNameFromRemoteUrl, validateRemoteUrl } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

const JPEG = new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" })

/** Records every boundary crossing so a test can assert on the exact traffic. */
function harness(overrides = {}) {
  const calls = { fetched: [], registered: [], discarded: [], downloads: [], normalized: [] }
  const client = createRemoteImageClient({
    fetchRemote: async (url) => {
      calls.fetched.push(url)
      return { storageId: "storage-1", mimeType: "image/jpeg", sizeBytes: 3, downloadUrl: "https://convex.invalid/blob" }
    },
    readBlob: async (downloadUrl) => {
      calls.downloads.push(downloadUrl)
      return JPEG
    },
    normalizeImage: async (source) => {
      calls.normalized.push(source)
      return { blob: JPEG, preview: "data:image/jpeg;base64,/9j/" }
    },
    registerImport: async (input) => {
      calls.registered.push(input)
      return { uploadId: "uploads-1", jobId: "jobs-1", deduped: false }
    },
    discardRemote: async (storageId) => {
      calls.discarded.push(storageId)
    },
    ...overrides,
  })
  return { client, calls }
}

// ---------- URL gate ----------

test("validateRemoteUrl passes public http(s) URLs and normalizes them", () => {
  assert.equal(validateRemoteUrl("https://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg")
  assert.equal(validateRemoteUrl("http://cdn.example.com/a.jpg"), "http://cdn.example.com/a.jpg")
  assert.equal(validateRemoteUrl("https://cdn.example.com/a.jpg?v=2#x"), "https://cdn.example.com/a.jpg?v=2#x")
})

test("validateRemoteUrl rejects non-http(s), credentialed, local and oversized addresses", () => {
  for (const bad of [
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "file:///etc/passwd",
    "chrome-extension://abc/tabs/room.html",
    "https://user:pass@cdn.example.com/a.jpg",
    "http://localhost/a.jpg",
    "https://room.localhost/a.jpg",
    "https://printer.local/a.jpg",
    `https://cdn.example.com/${"a".repeat(2100)}.jpg`,
    "https://cdn.example.com/a b.jpg",
    "",
    null,
    42,
  ]) {
    assert.throws(() => validateRemoteUrl(bad), /Drag a web image|credentials|Private-network/i, `expected rejection: ${bad}`)
  }
})

test("fileNameFromRemoteUrl uses the URL path and caps it, with a safe fallback", () => {
  assert.equal(fileNameFromRemoteUrl("https://cdn.example.com/images/blue-shirt.jpg"), "blue-shirt.jpg")
  assert.equal(fileNameFromRemoteUrl("https://cdn.example.com/images/blue%20shirt.jpg"), "blue%20shirt.jpg")
  assert.equal(fileNameFromRemoteUrl("https://cdn.example.com/"), "shopping-garment.jpg")
  assert.equal(fileNameFromRemoteUrl("https://cdn.example.com/images/"), "shopping-garment.jpg")
  // A pathologically long segment is a display name only, so it is hard-capped.
  assert.equal(fileNameFromRemoteUrl(`https://cdn.example.com/${"n".repeat(400)}.jpg`), "n".repeat(128))
  assert.equal(fileNameFromRemoteUrl("not a url"), "shopping-garment.jpg")
})

// ---------- prepare (try-on) ----------

test("prepare sends only the URL, then downloads the stored bytes for normalization", async () => {
  const { client, calls } = harness()
  const prepared = await client.prepare("https://cdn.example.com/blue.jpg")
  assert.deepEqual(calls.fetched, ["https://cdn.example.com/blue.jpg"], "the boundary carries the URL, nothing else")
  assert.deepEqual(calls.downloads, ["https://convex.invalid/blob"], "bytes come back from server storage")
  assert.equal(calls.normalized.length, 1)
  assert.equal(calls.normalized[0], JPEG, "the downloaded blob is what gets normalized")
  assert.equal(prepared.preview, "data:image/jpeg;base64,/9j/")
  assert.equal(prepared.storageId, "storage-1")
  assert.equal(prepared.mimeType, "image/jpeg")
  assert.equal(prepared.sizeBytes, 3)
  assert.equal(prepared.fileName, "blue.jpg")
  assert.equal(calls.registered.length, 0, "preparing a garment registers nothing")
})

test("prepare fails fast on an invalid URL, before any network call", async () => {
  const { client, calls } = harness()
  await assert.rejects(() => client.prepare("javascript:alert(1)"))
  assert.equal(calls.fetched.length, 0)
  assert.equal(calls.downloads.length, 0)
})

test("prepare surfaces a server rejection without inventing local copy", async () => {
  const { client } = harness({
    fetchRemote: async () => {
      throw new Error("Private-network image URLs are not supported.")
    },
  })
  await assert.rejects(() => client.prepare("https://cdn.example.com/a.jpg"), /Private-network/)
})

// ---------- registerBlob (try-on then Save) ----------

test("registerBlob registers the SAME server blob: no second fetch, no upload", async () => {
  const { client, calls } = harness()
  const result = await client.registerBlob(
    { storageId: "storage-1", mimeType: "image/jpeg", sizeBytes: 3 },
    { clientImportId: "client-1", fileName: "blue.jpg", productTitle: "Blue Shirt", sourcePageUrl: "https://shop.example.com/p/1" }
  )
  assert.equal(result.uploadId, "uploads-1")
  assert.equal(calls.fetched.length, 0, "try-on already fetched; saving must not fetch again")
  assert.equal(calls.downloads.length, 0, "and must not download the bytes again")
  assert.deepEqual(calls.registered, [
    {
      storageId: "storage-1",
      fileName: "blue.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 3,
      clientImportId: "client-1",
      productTitle: "Blue Shirt",
      sourcePageUrl: "https://shop.example.com/p/1",
    },
  ])
})

test("registerBlob omits optional provenance entirely rather than sending empty strings", async () => {
  const { client, calls } = harness()
  await client.registerBlob({ storageId: "storage-1", mimeType: "image/png", sizeBytes: 10 }, { clientImportId: "client-1" })
  assert.deepEqual(Object.keys(calls.registered[0]).sort(), ["clientImportId", "fileName", "mimeType", "sizeBytes", "storageId"])
  assert.equal(calls.registered[0].fileName, "shopping-garment.jpg", "a display name is always present")
})

// ---------- registerRemote (headless page save) ----------

test("registerRemote fetches and registers in one op, carrying provenance", async () => {
  const { client, calls } = harness()
  const result = await client.registerRemote("https://cdn.example.com/blue.jpg", {
    clientImportId: "client-2",
    productTitle: "Blue Shirt",
    sourcePageUrl: "https://shop.example.com/p/1",
  })
  assert.equal(result.uploadId, "uploads-1")
  assert.deepEqual(calls.fetched, ["https://cdn.example.com/blue.jpg"])
  assert.equal(calls.registered.length, 1)
  assert.equal(calls.registered[0].storageId, "storage-1")
  assert.equal(calls.registered[0].fileName, "blue.jpg")
  assert.equal(calls.registered[0].productTitle, "Blue Shirt")
  assert.equal(calls.registered[0].sourcePageUrl, "https://shop.example.com/p/1")
  // A headless save never touches try-on: no blob download, no normalization.
  assert.equal(calls.downloads.length, 0)
  assert.equal(calls.normalized.length, 0)
})

test("registerRemote fails fast on an invalid URL and never fetches it", async () => {
  const { client, calls } = harness()
  await assert.rejects(() => client.registerRemote("file:///etc/passwd", { clientImportId: "client-2" }))
  assert.equal(calls.fetched.length, 0)
  assert.equal(calls.registered.length, 0)
})

test("registerRemote propagates a registration failure rather than reporting success", async () => {
  const { client } = harness({
    registerImport: async () => {
      throw new Error("Could not register")
    },
  })
  await assert.rejects(() => client.registerRemote("https://cdn.example.com/a.jpg", { clientImportId: "c" }), /Could not register/)
})

// ---------- discard ----------

test("discard relays the storage id so the server can delete only unreferenced blobs", async () => {
  const { client, calls } = harness()
  await client.discard("storage-1")
  assert.deepEqual(calls.discarded, ["storage-1"])
  assert.equal(calls.fetched.length, 0)
  assert.equal(calls.registered.length, 0)
})

test("discard never rejects the caller's control flow when the server refuses", async () => {
  const { client } = harness({
    discardRemote: async () => {
      throw new Error("storage backend unavailable")
    },
  })
  await assert.rejects(() => client.discard("storage-1"), /unavailable/)
})
