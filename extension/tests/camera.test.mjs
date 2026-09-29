// Camera acquisition across desktop webcams.
//
// Decart's realtime model asks for a specific capture size. Plenty of built-in and external
// webcams do not offer it, and Chrome then rejects the whole getUserMedia call even though the
// camera is present and working — the grant page's plain `{ video: true }` request succeeds on
// the same machine. These tests pin the retry contract: retry exactly the two constraint-shaped
// failures, never a permission denial, never a third attempt.

import test from "node:test"
import assert from "node:assert/strict"
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const entry = fileURLToPath(new URL("../lib/camera.ts", import.meta.url))
const bundled = await build({ entryPoints: [entry], bundle: true, format: "esm", write: false })
const { acquireCamera, stopStream } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)

const CAPTURE = { width: 1280, height: 720, fps: 30 }

// ---------- Test doubles ----------

/** A MediaStream whose tracks record whether they were stopped. */
function fakeStream(label, settings = {}) {
  const tracks = [{ kind: "video", label, readyState: "live", stopped: false, stop() { this.stopped = true; this.readyState = "ended" }, getSettings: () => settings }]
  return {
    label,
    tracks,
    getTracks: () => tracks,
    getVideoTracks: () => tracks
  }
}

/** A getUserMedia that replays a scripted list of outcomes and records every request. */
function fakeDevices(script) {
  const requests = []
  return {
    requests,
    async getUserMedia(constraints) {
      requests.push(constraints)
      const step = script[Math.min(requests.length - 1, script.length - 1)]
      if (step instanceof Error) throw step
      return step
    },
    getSupportedConstraints: () => ({ width: true, height: true, frameRate: true, facingMode: true }),
    async enumerateDevices() {
      return [
        { kind: "videoinput", deviceId: "cam-0", groupId: "grp-0", label: "Integrated Webcam" },
        { kind: "videoinput", deviceId: "cam-1", groupId: "grp-1", label: "Logitech C920" },
        { kind: "audioinput", deviceId: "mic-0", groupId: "grp-0", label: "Microphone" }
      ]
    }
  }
}

const domError = name => Object.assign(new Error(name), { name, isDOMException: true })

// ---------- Preferred request succeeds ----------

test("preferred request succeeds: exactly one request, no fallback", async () => {
  const stream = fakeStream("preferred")
  const devices = fakeDevices([stream])
  const result = await acquireCamera(CAPTURE, devices)

  assert.equal(result, stream, "the preferred stream is returned")
  assert.equal(devices.requests.length, 1, "no fallback attempt when the preferred request works")
  assert.deepEqual(devices.requests[0], {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: "user" },
    audio: false
  })
})

test("preferred request succeeds: a numeric fps is sent as an ideal constraint", async () => {
  const devices = fakeDevices([fakeStream("s")])
  await acquireCamera({ width: 640, height: 480, fps: 24 }, devices)
  assert.deepEqual(devices.requests[0].video.frameRate, { ideal: 24 })
})

test("preferred request succeeds: an object fps is passed through unchanged", async () => {
  const devices = fakeDevices([fakeStream("s")])
  await acquireCamera({ width: 640, height: 480, fps: { min: 15, max: 60 } }, devices)
  assert.deepEqual(devices.requests[0].video.frameRate, { min: 15, max: 60 })
})

// ---------- Retryable failures fall back ----------

test("preferred NotFoundError: retries once with the generic request", async () => {
  const fallback = fakeStream("fallback")
  const devices = fakeDevices([domError("NotFoundError"), fallback])
  const result = await acquireCamera(CAPTURE, devices)

  assert.equal(result, fallback, "the fallback stream is used")
  assert.equal(devices.requests.length, 2, "exactly one retry, never a loop")
  assert.deepEqual(devices.requests[1], { video: true, audio: false }, "the retry is the generic request")
})

test("preferred OverconstrainedError: retries once with the generic request", async () => {
  const fallback = fakeStream("fallback")
  const devices = fakeDevices([domError("OverconstrainedError"), fallback])
  const result = await acquireCamera(CAPTURE, devices)

  assert.equal(result, fallback)
  assert.equal(devices.requests.length, 2)
  assert.deepEqual(devices.requests[1], { video: true, audio: false })
})

test("retryable failure: a NotFoundError on the fallback preserves the original NotFoundError", async () => {
  const devices = fakeDevices([domError("NotFoundError"), domError("NotFoundError")])
  await assert.rejects(acquireCamera(CAPTURE, devices), { name: "NotFoundError" })
  assert.equal(devices.requests.length, 2, "still only two attempts")
})

test("retryable failure: an OverconstrainedError on the fallback preserves the original OverconstrainedError", async () => {
  // The room's copy keys off the ORIGINAL name, so a preferred OverconstrainedError must not
  // degrade into a "no camera" message just because the generic retry also failed.
  const devices = fakeDevices([domError("OverconstrainedError"), domError("NotFoundError")])
  await assert.rejects(acquireCamera(CAPTURE, devices), { name: "OverconstrainedError" })
})

test("retryable failure: a non-DOM failure on the fallback still surfaces the original error", async () => {
  const original = domError("NotFoundError")
  const devices = fakeDevices([original, new TypeError("Failed to fetch")])
  await assert.rejects(acquireCamera(CAPTURE, devices), error => {
    assert.equal(error, original, "the original error object is rethrown, not wrapped")
    return true
  })
})

// ---------- NotAllowedError is never retried ----------

test("preferred NotAllowedError: NO fallback, permission denial stays a permission error", async () => {
  const devices = fakeDevices([domError("NotAllowedError"), fakeStream("must-not-be-used")])
  await assert.rejects(acquireCamera(CAPTURE, devices), { name: "NotAllowedError" })
  assert.equal(devices.requests.length, 1, "a denied permission must never trigger a retry")
})

test("every non-retryable failure name is final", async () => {
  for (const name of ["NotAllowedError", "PermissionDeniedError", "NotReadableError", "AbortError", "SecurityError", "TypeError"]) {
    const devices = fakeDevices([domError(name), fakeStream("must-not-be-used")])
    await assert.rejects(acquireCamera(CAPTURE, devices), { name })
    assert.equal(devices.requests.length, 1, `${name} must not be retried`)
  }
})

// ---------- No retry loops ----------

test("no retry loop: at most two requests, whatever the failure", async () => {
  for (const name of ["NotFoundError", "OverconstrainedError"]) {
    for (let i = 0; i < 5; i++) {
      const devices = fakeDevices([domError(name), domError(name), domError(name), domError(name), domError(name)])
      await assert.rejects(acquireCamera(CAPTURE, devices), { name })
      assert.ok(devices.requests.length <= 2, `${name} was requested ${devices.requests.length} times`)
    }
  }
})

// ---------- Fallback stream is cleaned up by the room's teardown ----------

test("a fallback stream is released by the same stopStream the room's teardown uses", async () => {
  const fallback = fakeStream("fallback")
  const devices = fakeDevices([domError("OverconstrainedError"), fallback])
  const stream = await acquireCamera(CAPTURE, devices)

  assert.equal(stream.tracks.every(track => !track.stopped), true, "a fresh stream has live tracks")
  // This is the exact call the room's stop() makes, so a fallback stream cannot outlive a session.
  stopStream(stream)
  assert.equal(stream.tracks.every(track => track.stopped), true, "stopStream released every track")
  assert.equal(stream.tracks.every(track => track.readyState === "ended"), true)
})

test("stopStream tolerates a null or absent stream", () => {
  assert.doesNotThrow(() => stopStream(null))
  assert.doesNotThrow(() => stopStream(undefined))
})

test("a stream dropped because the session changed mid-acquisition is released", async () => {
  // The room calls stopStream when the session id moved on between request and resolve.
  const stream = fakeStream("stale")
  const devices = fakeDevices([domError("NotFoundError"), stream])
  const acquired = await acquireCamera(CAPTURE, devices)
  stopStream(acquired)
  assert.equal(stream.tracks[0].stopped, true)
})

// ---------- Diagnostics are safe ----------

test("diagnostics log only the allowlisted fields, never deviceId or groupId", async () => {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    const stream = fakeStream("Logitech C920", {
      width: 640, height: 480, frameRate: 30, aspectRatio: 1.333, facingMode: "user",
      deviceId: "cam-1", groupId: "grp-1", resizeMode: "crop-and-scale"
    })
    await acquireCamera(CAPTURE, fakeDevices([stream]))
  } finally {
    console.warn = original
  }

  assert.ok(warnings.length > 0, "a development build reports the acquisition")
  const serialised = JSON.stringify(warnings)
  assert.ok(!serialised.includes("cam-1"), "no deviceId")
  assert.ok(!serialised.includes("grp-1"), "no groupId")
  assert.ok(!serialised.includes("Logitech C920"), "no device label")
  assert.ok(serialised.includes("videoInputCount"), "reports how many cameras were seen")
  assert.ok(serialised.includes("640"), "reports the resulting track settings")
})

test("diagnostics report the error name on a failure, without the error body", async () => {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    await acquireCamera(CAPTURE, fakeDevices([domError("OverconstrainedError"), fakeStream("s")]))
  } finally {
    console.warn = original
  }
  const serialised = JSON.stringify(warnings)
  assert.ok(serialised.includes("OverconstrainedError"), "the error name is reported")
  assert.ok(serialised.includes("fallback"), "and the stage it happened at")
  assert.ok(!serialised.includes("sk_"), "never any key-shaped value")
})

// ---------- The room uses the helper and keeps its permission flow ----------

test("the room acquires the camera through the helper, not a bare getUserMedia", () => {
  const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
  assert.ok(room.includes("acquireCamera(capture)"), "the room must acquire through the helper")
  const bare = room.match(/navigator\.mediaDevices\.getUserMedia\(\{/g) ?? []
  // Only the grant page's generic permission probe may call getUserMedia directly.
  assert.equal(bare.length, 1, `expected only the grant page probe, found ${bare.length} direct calls`)
  assert.ok(room.includes("import { acquireCamera, stopStream } from \"../lib/camera\""))
})

test("the room keeps the camera-permission flow and adds both constraint messages", () => {
  const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
  assert.ok(room.includes('error?.name === "NotAllowedError"'), "permission denial keeps its own flow")
  assert.ok(room.includes('action: "grant"'), "with the grant action")
  assert.ok(room.includes("No camera was available to OpenWear."), "NotFoundError copy")
  assert.ok(room.includes("Your camera could not use the requested video settings."), "OverconstrainedError copy")
})

test("teardown releases the stream through stopStream", () => {
  const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
  assert.ok(room.includes("stopStream(streamRef.current)"), "stop() must use the shared release")
  assert.ok(!/streamRef\.current\?\.getTracks\(\)/.test(room), "no duplicated track-stopping left behind")
})

test("the change did not touch the camera's permission surface", () => {
  // The iframe allow-list is unchanged, and no new manifest permission was needed: getUserMedia
  // over an extension page is covered by the existing host permissions plus the iframe allow.
  const content = readFileSync(fileURLToPath(new URL("../content.tsx", import.meta.url)), "utf8")
  assert.ok(content.includes('allow="camera; autoplay; clipboard-write"'), "iframe allow-list unchanged")
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).manifest
  assert.deepEqual(manifest.permissions, ["cookies", "storage", "scripting"], "no manifest permission added")
  assert.equal("videoCapture" in manifest, false, "no videoCapture permission added")
  assert.equal(manifest.optional_permissions, undefined, "no optional permissions added")
})
