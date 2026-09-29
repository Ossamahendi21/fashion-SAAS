// Step 2E2: Freeze & inspect for Live Mirror.
//
// Freezing ends provider realtime work while keeping everything local: the webcam, the garment
// and a captured still of the last usable AI frame. These tests pin the safety contract:
//
//   - freeze never authorizes, never refunds, never reports usage, never touches billing
//   - the provider connection and timer close exactly once; the webcam never closes on freeze
//   - full stop still powers everything off and revokes the frozen object URL
//   - going live again always mints a NEW authorization and keeps the still until the new
//     remote frame is usable
//   - the quota display never mints and never decides
//
// Frame capture, teardown and download helpers are unit-tested with fakes; the room's wiring
// is asserted against its own source, matching this repo's existing test style. No test
// contacts Decart, Clerk or Convex: every provider boundary is a fake.

import test from "node:test"
import assert from "node:assert/strict"
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const entry = fileURLToPath(new URL("../lib/freeze.ts", import.meta.url))
const bundled = await build({ entryPoints: [entry], bundle: true, format: "esm", write: false })
const freeze = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)

const {
  FROZEN_COPY,
  canvasToFrozenFrame,
  captureFrozenFrame,
  clearTimerRef,
  downloadSnapshot,
  drawRemoteFrameToCanvas,
  hasUsableRemoteFrame,
  releaseProviderConnection,
  revokeFrozenPreview,
  takeProviderConnection
} = freeze

const liveMirrorEntry = fileURLToPath(new URL("../lib/live-mirror.ts", import.meta.url))
const liveMirrorBundled = await build({ entryPoints: [liveMirrorEntry], bundle: true, format: "esm", write: false })
const liveMirror = await import(`data:text/javascript;base64,${Buffer.from(liveMirrorBundled.outputFiles[0].text).toString("base64")}`)
const { quotaStatusCopy } = liveMirror

const room = readFileSync(fileURLToPath(new URL("../tabs/room.tsx", import.meta.url)), "utf8")
const roomCss = readFileSync(fileURLToPath(new URL("../tabs/room.css", import.meta.url)), "utf8")

// ---------- Fakes ----------

function fakeBlob(size = 1024) {
  return { size, type: "image/jpeg" }
}

function fakeCanvas({ blob = fakeBlob(), drawThrows = false, context = true } = {}) {
  return {
    draws: [],
    getContext() {
      if (!context) return null
      return {
        drawImage: (video, x, y) => {
          if (drawThrows) throw new Error("tainted canvas")
        }
      }
    },
    toBlob(callback) {
      callback(blob)
    }
  }
}

const frameDeps = (overrides = {}) => ({
  createCanvas: (width, height) => fakeCanvas(),
  createObjectURL: () => "blob:frozen-frame",
  now: () => 1700000000000,
  ...overrides
})

function fakeVideo(width = 640, height = 480) {
  return { videoWidth: width, videoHeight: height }
}

function fakeConnection() {
  return { disconnects: 0, disconnect() { this.disconnects++ } }
}

// ---------- FREEZE: frame capture ----------

test("1: a usable remote frame captures a local still", async () => {
  const frozen = await captureFrozenFrame(fakeVideo(640, 480), frameDeps())
  assert.ok(frozen, "a usable frame must produce a still")
  assert.equal(frozen.url, "blob:frozen-frame")
  assert.equal(frozen.width, 640)
  assert.equal(frozen.height, 480)
  assert.equal(frozen.blob.size, 1024)
})

test("capture: zero or missing dimensions never produce a fake blank frame", async () => {
  for (const video of [null, undefined, {}, { videoWidth: 0, videoHeight: 480 }, { videoWidth: 640, videoHeight: 0 }]) {
    assert.equal(await captureFrozenFrame(video, frameDeps()), null)
  }
  assert.equal(hasUsableRemoteFrame(640, 480), true)
  assert.equal(hasUsableRemoteFrame(0, 480), false)
  assert.equal(hasUsableRemoteFrame(null, undefined), false)
})

test("capture: a failed draw or a null blob yields no preview, never a black image", async () => {
  const drawn = drawRemoteFrameToCanvas(fakeVideo(), () => fakeCanvas({ drawThrows: true }))
  assert.equal(drawn, null)
  const nullBlob = await captureFrozenFrame(fakeVideo(), frameDeps({
    createCanvas: () => fakeCanvas({ blob: null })
  }))
  assert.equal(nullBlob, null)
  const noContext = drawRemoteFrameToCanvas(fakeVideo(), () => fakeCanvas({ context: false }))
  assert.equal(noContext, null)
})

// ---------- FREEZE: realtime-only teardown ----------

test("2/6: taking the provider connection is one-shot, so freeze disconnects exactly once", () => {
  const ref = { current: fakeConnection() }
  const first = takeProviderConnection(ref)
  assert.equal(ref.current, null, "the ref is cleared synchronously")
  assert.equal(releaseProviderConnection(first), true)
  assert.equal(first.disconnects, 1)
  // A repeated freeze finds nothing to close and never touches a newer connection.
  assert.equal(takeProviderConnection(ref), null)
  assert.equal(releaseProviderConnection(takeProviderConnection(ref)), false)
  assert.equal(first.disconnects, 1, "still exactly one disconnect")
})

test("4: clearing the provider timer is one-shot", () => {
  const cleared = []
  const original = globalThis.clearInterval
  globalThis.clearInterval = (id) => { cleared.push(id) }
  try {
    const ref = { current: 7 }
    assert.equal(clearTimerRef(ref), true)
    assert.deepEqual(cleared, [7])
    assert.equal(ref.current, null)
    assert.equal(clearTimerRef(ref), false, "a second clear is a no-op")
    assert.deepEqual(cleared, [7], "clearInterval ran exactly once")
  } finally {
    globalThis.clearInterval = original
  }
})

test("5/28: freeze performs no authorization, no refresh, no server call", () => {
  const freezeBlock = room.slice(room.indexOf("const freezeRealtime"), room.indexOf("const connect = useCallback"))
  for (const forbidden of ["authorizer.acquire", "liveMirrorAction", "refreshBilling", "finalize", "refund", "background<", "fetch("]) {
    assert.ok(!freezeBlock.includes(forbidden), `freeze must not contain ${forbidden}`)
  }
})

test("7: the frozen still is rendered where the live video was, with badge and support copy", () => {
  assert.equal(FROZEN_COPY.badge, "Frozen preview")
  assert.equal(FROZEN_COPY.support, "Live processing stopped. Inspect this look for as long as you like.")
  assert.ok(room.includes('<img className="frozen-frame" src={frozenPreview.url}'), "frozen still element")
  assert.ok(room.includes("{FROZEN_COPY.badge}") && room.includes("{FROZEN_COPY.support}"), "badge + support text")
  assert.ok(roomCss.includes(".frozen-frame") && roomCss.includes(".frozen-badge"), "frozen styles exist")
})

test("freeze: the room keeps webcam, garment and image refs out of the freeze path", () => {
  const freezeBlock = room.slice(room.indexOf("const freezeRealtime"), room.indexOf("const connect = useCallback"))
  assert.ok(!freezeBlock.includes("stopStream"), "freeze never stops camera tracks")
  assert.ok(!freezeBlock.includes("setGarment"), "freeze never clears the garment")
  assert.ok(freezeBlock.includes("closeProvider()"), "freeze shares the realtime-only teardown")
})

// ---------- AUTO-FREEZE ----------

test("8: the session timer auto-freezes instead of full-stopping", () => {
  assert.ok(room.includes('if (!left) void freezeRealtime("timeout")'), "timer calls auto-freeze at zero")
  assert.ok(!room.includes("Session limit reached"), "the old throwaway ending is gone")
})

test("9: auto-freeze without a usable frame shows safe copy and no fake image", () => {
  assert.equal(FROZEN_COPY.noPreview, "The live session ended before a preview was ready.")
  assert.ok(room.includes("FROZEN_COPY.noPreview"), "timeout path surfaces the safe notice")
  const freezeBlock = room.slice(room.indexOf("const freezeRealtime"), room.indexOf("const connect = useCallback"))
  assert.ok(!freezeBlock.includes("placeholder"), "no placeholder image anywhere in the freeze path")
})

test("10: auto-freeze preserves the webcam by construction", () => {
  const closeBlock = room.slice(room.indexOf("const closeProvider"), room.indexOf("const revokeFrozen"))
  assert.ok(!closeBlock.includes("stopStream"), "realtime-only teardown never stops camera tracks")
  assert.ok(!closeBlock.includes("cameraRef"), "realtime-only teardown never clears the camera element")
  assert.ok(closeBlock.includes("clearTimerRef(timerRef)"), "the provider timer is cleared")
  assert.ok(closeBlock.includes("takeProviderConnection(connectionRef)"), "the connection is taken exactly once")
})

// ---------- CONTINUE LIVE ----------

test("11/12/13: going live again mints through the existing authorizer, never reusing a token", () => {
  const goLiveBlock = room.slice(room.indexOf("const goLiveAgain"), room.indexOf("/** Entry point for every garment"))
  assert.ok(goLiveBlock.includes("await apply(current.id, imageRef.current)"), "reconnect goes through apply → connect → authorizer")
  assert.ok(!goLiveBlock.includes("grant.token"), "no previous token is referenced")
  assert.ok(!goLiveBlock.includes(".set("), "no disconnected session is restored locally")
  assert.ok(goLiveBlock.includes("reconnectingRef.current = true"), "synchronous re-entry guard")
  assert.ok(room.includes("disabled={!garment}"), "resume needs a garment")
})

test("14/15: the frozen still stays visible while reconnecting and is replaced by the new frame", () => {
  assert.ok(room.includes("{reconnecting"), "reconnecting state drives the frozen overlay")
  assert.ok(room.includes(FROZEN_COPY.reconnecting) || room.includes("{FROZEN_COPY.reconnecting}"), "truthful loading copy")
  const applyBlock = room.slice(room.indexOf("const apply = useCallback"), room.indexOf("/** Entry point for every garment"))
  const waiter = applyBlock.indexOf("await waitForRemoteFrame()")
  const clearer = applyBlock.indexOf("if (frozenPreviewRef.current) revokeFrozen()")
  assert.ok(waiter >= 0 && clearer > waiter, "the still is cleared only after the new frame is usable")
})

test("16/17: quota denial and provider errors preserve the frozen preview", () => {
  const goLiveBlock = room.slice(room.indexOf("const goLiveAgain"), room.indexOf("/** Entry point for every garment"))
  assert.ok(!goLiveBlock.includes("revokeFrozen"), "errors never clear the still")
  assert.ok(goLiveBlock.includes("setNotice(friendly(error))"), "denials surface safe copy, still intact")
  assert.ok(room.includes("LIVE_MIRROR_LIMIT_REACHED"), "quota denial maps without destroying anything")
})

test("18: duplicate continue clicks collapse onto one reconnect", () => {
  const goLiveBlock = room.slice(room.indexOf("const goLiveAgain"), room.indexOf("/** Entry point for every garment"))
  assert.ok(goLiveBlock.includes("if (reconnectingRef.current || connectingRef.current) return"), "sync duplicate guard")
})

// ---------- GARMENT CHANGE WHILE FROZEN ----------

test("19: a new garment from frozen requires a new authorization via the normal path", () => {
  const tryOnBlock = room.slice(room.indexOf("const tryOn = useCallback"), room.indexOf("/** Renaming the garment"))
  assert.ok(!tryOnBlock.includes("revokeFrozen"), "dropping a garment never clears the still up front")
  assert.ok(!tryOnBlock.includes("setFrozenPreview"), "dropping a garment never touches frozen state")
  assert.ok(tryOnBlock.includes("await apply(id, prepared.blob)"), "new garments flow through apply → connect")
})

test("20: quota denial on a garment change preserves the old frozen preview", () => {
  const occurrences = [...room.matchAll(/if \(frozenPreviewRef\.current\) revokeFrozen\(\)/g)]
  assert.equal(occurrences.length, 1, "exactly one place ever clears the still: the new usable frame")
})

// ---------- STATUS / QUOTA UX ----------

test("21: remaining sessions render as simple human copy", () => {
  const pro = { plan: "pro", monthlyAllowanceSessions: 2, usedSessions: 0, remainingSessions: 2, sessionMaxSeconds: 60 }
  assert.equal(quotaStatusCopy(pro), "2 live sessions left this cycle")
  assert.equal(quotaStatusCopy({ ...pro, remainingSessions: 1 }), "1 live session left this cycle")
  assert.equal(quotaStatusCopy({ ...pro, remainingSessions: 0 }), "No Live Mirror sessions left this cycle.")
  assert.equal(quotaStatusCopy(null), null, "loading shows nothing, never a stale count")
})

test("22: the status load mints nothing and polls nothing", () => {
  assert.ok(room.includes("convex.query(liveMirrorStatus, {})"), "read-only query, no authorize call")
  const statusEffect = room.slice(room.indexOf("Initial allowance display"), room.indexOf("}, [authStatus])"))
  assert.ok(!statusEffect.includes("setInterval"), "no polling loop")
  assert.ok(!statusEffect.includes("authorize"), "no mint on load")
  assert.ok((room.match(/setInterval\(/g) ?? []).length === 1, "the only interval left is the session timer")
})

test("23/24: free shows the paid gate, exhausted paid shows zero", () => {
  assert.equal(
    quotaStatusCopy({ plan: "free", monthlyAllowanceSessions: 0, usedSessions: 0, remainingSessions: 0, sessionMaxSeconds: 60 }),
    "Live Mirror is available on a paid plan."
  )
  assert.ok(room.includes("{quotaCopy && <span className=\"quota\">{quotaCopy}</span>}"), "quota line in the UI")
  assert.ok(roomCss.includes(".footer-note .quota"), "quota styling exists")
})

// ---------- CLEANUP ----------

test("25: full stop from frozen stops the camera and revokes the still", () => {
  const stopBlock = room.slice(room.indexOf("/** Ends everything"), room.indexOf("// Track the local auto-freeze preference"))
  assert.ok(stopBlock.includes("stopStream(streamRef.current)"), "webcam tracks stop")
  assert.ok(stopBlock.includes("revokeFrozen()"), "frozen object URL revoked")
  assert.ok(stopBlock.includes("closeProvider()"), "provider teardown shared, not duplicated")
  assert.ok(stopBlock.includes('setPhase("idle")'), "room returns to idle")
})

test("26/28: revoking is null-safe and freeze alone never revokes early", () => {
  assert.doesNotThrow(() => revokeFrozenPreview(null, () => { throw new Error("must not be called") }))
  assert.doesNotThrow(() => revokeFrozenPreview(undefined, () => { throw new Error("must not be called") }))
  const revoked = []
  revokeFrozenPreview({ url: "blob:old" }, url => revoked.push(url))
  assert.deepEqual(revoked, ["blob:old"])
  const freezeBlock = room.slice(room.indexOf("const freezeRealtime"), room.indexOf("const connect = useCallback"))
  assert.ok(!freezeBlock.includes("revokeFrozen"), "freeze never clears displayed frozen state")
  assert.ok(freezeBlock.includes("URL.revokeObjectURL(frozen.url)"), "a still captured into a dead session is dropped, not leaked")
})

test("27: tab hide, unload and unmount close provider plus camera", () => {
  assert.ok(room.includes("const onHidden = () => { if (document.hidden && streamRef.current) stop("), "hidden tab stops")
  assert.ok(room.includes("const onUnload = () => stop()"), "unload stops")
  assert.ok(room.includes("window.removeEventListener(\"pagehide\", onUnload); stop()"), "unmount stops")
})

// ---------- SNAPSHOT ----------

test("29/30: snapshot downloads a blob without Decart, frozen first when frozen", () => {
  const clicked = []
  const revoked = []
  const url = downloadSnapshot(fakeBlob(2048), {
    createObjectURL: () => "blob:snap",
    revokeObjectURL: (value) => revoked.push(value),
    createAnchor: () => ({ href: "", download: "", click() { clicked.push(this.download) } }),
    now: () => 1700000000000,
    revokeDelayMs: 0
  })
  assert.equal(url, "blob:snap")
  assert.deepEqual(clicked, ["openwear-1700000000000.jpg"])
  return new Promise((resolve) => setTimeout(() => {
    assert.deepEqual(revoked, ["blob:snap"], "the download URL is revoked")
    resolve(null)
  }, 10))
})

test("snapshot: the room prefers the frozen still and never restarts Decart to save", () => {
  const snapshotBlock = room.slice(room.indexOf("const snapshot = ()"), room.indexOf("const onNoticeAction"))
  assert.ok(snapshotBlock.includes("downloadSnapshot(frozenBlobRef.current"), "frozen still downloads directly")
  assert.ok(!snapshotBlock.includes("connect(") && !snapshotBlock.includes("authorizer"), "saving never reconnects")
  assert.ok(room.includes("{(live || frozenPreview) && <button onClick={snapshot}"), "save button visible while frozen")
})

// ---------- SECURITY / BILLING INVARIANTS ----------

test("31/32: freeze touches no refund, no usage, no plan, no period, no counter", () => {
  const freezeSource = readFileSync(fileURLToPath(new URL("../lib/freeze.ts", import.meta.url)), "utf8")
    .replace(/\/\/.*$/gm, "")
  for (const forbidden of ["refund", "finalize", "reserve", "planPeriod", "systemCounter", "authorizedSeconds", "usage"]) {
    assert.ok(!freezeSource.includes(forbidden), `freeze lib must not reference ${forbidden}`)
  }
  const freezeBlock = room.slice(room.indexOf("const freezeRealtime"), room.indexOf("const connect = useCallback"))
  for (const forbidden of ["refund", "finalize", "reserveLiveMirror", "planPeriod", "systemCounter"]) {
    assert.ok(!freezeBlock.includes(forbidden), `freeze path must not reference ${forbidden}`)
  }
})

test("33: no permanent secret in authored or built secure freeze code", () => {
  const freezeSource = readFileSync(fileURLToPath(new URL("../lib/freeze.ts", import.meta.url)), "utf8")
    .replace(/\/\/.*$/gm, "")
  for (const secret of ["DECART_API_KEY", "CLERK_SECRET_KEY", "AGENT_SERVICE_KEY"]) {
    assert.ok(!freezeSource.includes(secret), `freeze lib must not reference ${secret}`)
  }
  assert.ok(!/sk_(test|live)_[A-Za-z0-9]{8,}/.test(freezeSource), "no key-shaped literals")
  assert.ok(!freezeSource.includes("api.decart.ai"), "no provider endpoint in freeze code")
})

test("freeze button: visible only with a usable frame, single-shot, standard mode untouched", () => {
  assert.equal(FROZEN_COPY.freezeButton, "Freeze & inspect")
  assert.ok(room.includes("disabled={!canFreeze}"), "cannot execute twice or without a frame")
  assert.ok(room.includes("const canFreeze = live && !frozenPreview && !reconnecting"), "gated on live, unfrozen, idle")
  const speedOptions = [...room.matchAll(/speed: "fast"/g)]
  assert.equal(speedOptions.length, 0, "no fast mode anywhere: the concept was removed with the legacy path")
})
