# Shopping Extension — Real-Chrome E2E Test Matrix

Covers Step 3B (contextual shopping actions) and Step 4A.2 (canonical page-pill Save adoption) in a
**real Chrome extension runtime**. Every paid boundary is stubbed: the room harness replaces all
Convex/Clerk/Decart/OpenAI calls, and the only network is the local fixture server. The suite is the
source of truth for "the page pill and the in-room Save reach the same saved state through one
transition" — the canonical-adoption guarantee of Step 4A.2.

Companion documents:
- `docs/EXTENSION_AUTH_AUDIT.md` — auth properties and the required secure-path matrix.
- `docs/LIVE_MIRROR_E2E_TEST.md` — the secure Live Mirror matrix.

## What the suite proves

| # | Property | Where it is enforced | Test |
|---|---|---|---|
| 1 | The pill is a single contextual singleton; site DOM is untouched | `hover-overlay.ts` single pill; content script never mutates product nodes | `2`, `6`, `23` |
| 2 | Tiny/branded/banner imagery gets no pill | `isEligibleProductImage` in `lib/product-image.ts` | `3` |
| 3 | The pill repositions on scroll/resize and survives layout shifts | rAF-throttled `reposition()` in `hover-overlay.ts` | `4`, `5` |
| 4 | A trusted Try on reaches the room exactly once | one-time garment capability in `content.tsx` `forwardGarment` | `7`, `8`, `9` |
| 5 | Hostile/forged page posts change nothing | capability handshake, origin + `event.source` checks | `8`, `9`, `11` |
| 6 | Contextual Save walks Saving → Processing → Saved | `createWardrobeSaver` single-flight + room status replies | `12`, `14` |
| 7 | Double-click collapses to one operation (Save, Style, Advice) | single-flight refs in `wardrobe-save.ts` and `room.tsx` | `14`, `17` |
| 8 | Retargeting to a second product resets the pill UI | overlay retarget on `pointerover` key change | `5`, `15` |
| 9 | Style → suggestions, Advice → panel, Own → ownership transition | room harness deterministic responses | `16`, `18`, `19` |
| 10 | **Page-pill Save and in-room Save share one canonical transition** | `adoptSavedItem` in `tabs/room.tsx` (Step 4A.2) | `12`, `13` |
| 11 | Disabling shopping actions tears the overlay down completely | `overlayRef.current?.teardown()` in `content.tsx` | `22` |
| 12 | Re-enabling re-arms the overlay and re-probes a parked cursor | `pointerPosRef` + re-probe on effect re-run | `22` |
| 13 | SPA replacement keeps one root/pill/iframe and retargets under a parked cursor | `refreshParked` on the DOM observer | `23` |
| 14 | Zero provider hits, zero Convex calls, zero console errors across all targets | `watchTarget` attaches CDP to every exposed target | `24` |

Automated coverage: `extension/e2e/shopping-loop.e2e.mjs` (23 tests) run by
`extension/e2e/run-e2e.mjs` via `npm run test:e2e`.

## How to run

```
cd extension
npm run test:e2e
```

The orchestrator:
1. builds a fresh production extension (`npm run build`),
2. assembles a test extension whose room page boots the harness bundle instead of the production
   room (`e2e/scripts/assemble-test-extension.mjs`),
3. launches headless Chrome (real binary, `chrome.exe`) with the fixture host mapped,
4. installs the unpacked extension via CDP `Extensions.loadUnpacked`,
5. serves the fixture shop on `127.0.0.1`, then runs the 23-test suite against it.

Output shows one `✔`/`✖` line per test plus the node test-runner summary line. A full cycle takes
~5-6 minutes (a production build happens every run).

## The harness boundary

- `extension/e2e/harness/room-harness.tsx` — a real `Room` running against stub adapters: `auth` is a
  fake signed-in user, `backend` returns fixed passes (save sequence, 2 style cards,
  advice summary), `capability` grants immediately, and identity is hardcoded.
- `extension/e2e/harness/backend-stub.ts` — the fake `RemoteSaveRoomDeps`-shaped backend that records
  `calls` (register, style, advice, owned) and `events` for assertions.
- `extension/e2e/fixture/shop.html` — the synthetic shop: two products (`#product-main`,
  `#product-second`), a hostile page-world script that tries forged `openwear:garment` posts
  (every attempt must fail silently).

## The Step 4A.2 guarantee these tests pin down

A contextual Save (page pill) and an in-room Save (room Save button) reach the **same** room state
through **one** transition:

- both call the canonical `adoptSavedItem` in `tabs/room.tsx`,
- the page-pill handler captures `targetGarmentId` when the `openwear:save-garment` message
  arrives, so the adopted item is the arriving item even while a previous save is still in flight,
- adoption requires `status.state === "ready"` and the authoritative `itemId`,
- Save/Style/Advice/Own arm only while `ownership !== "owned"`,
- a page Save never triggers its own upload, register, credit consumption, Style/Advice, Live
  Mirror, or camera flow — the null transaction (test `12`, `13`, `19`).

The E2E suite proves the equivalence at the browser level, with unit coverage in
`extension/tests/page-save-adoption.test.mjs` (13 tests).

## E2E-specific fixes worth keeping

Three bugs surfaced only in the real-Chrome suite:

1. **Room window docking** (`content.tsx`): a never-dragged room window hugs the right edge; a
   resize (viewport change) re-anchors it via `dockedRef` instead of clamping it mid-canvas over
   product imagery.
2. **Re-enable re-probes the parked cursor**: toggling `shoppingActionsEnabled` off tears the
   overlay down; toggling it back on while the cursor sits over a product produces no new
   `pointerover`, so the overlay re-probes `elementFromPoint` at the last pointer position and (on
   DOM swaps, via `refreshParked`) retargets the pill to the replacement image.
3. **CDP target observation** (`e2e/shopping-loop.e2e.mjs`): Puppeteer reports OOPIF/extension
   iframe targets as `TargetType.OTHER`, not `"iframe"`; the observer accepts every target except
   `browser`/`tab` so the room's network is actually covered (test `24`).