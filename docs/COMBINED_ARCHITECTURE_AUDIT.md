# Combined Architecture Audit — Fitcheck SaaS + OpenWear Extension

> **Scope:** AUDIT ONLY. No application code was modified, no dependencies installed, no migrations implemented.
> No model IDs are proposed unless the repository already uses them. SAM2 is not assumed equivalent to
> current extraction; FASHN VTON is not assumed equivalent to the multi-item full-outfit render.
> OpenAI and Decart stay as-is.
>
> **Date:** 2026-09-27 · **Repo:** `AI-Wardrobe-app-vercel-eve-clerk-nextjs` · **Extension:** `extension/` (`openwear-extension@0.4.0`)

---

## 1. Repository architecture map

Two disjoint products share one monorepo with **zero cross-imports** (verified: no `decart`/`lucy`/`openwear`/`openrouter`/`fashn`/`sam2`/`live-mirror` string appears anywhere under `convex/`, `agent/`, or `src/`).

```
AI-Wardrobe-app-vercel-eve-clerk-nextjs/
├── src/                    # Next.js 16 App Router frontend (React 19, Tailwind v4, shadcn/Base UI)
│   ├── app/                # Routes: / (landing), (auth)/sign-in|sign-up, (app)/onboarding|wardrobe|add|
│   │                       #   outfits|stylist|lookbook|billing|settings|admin, /share/[token]
│   ├── components/         # ui/ (generated shadcn), common/, layout/, providers/, <feature>/
│   ├── hooks/              # use-credits, use-active-jobs, use-stylist, use-items, ...
│   ├── lib/                # env.ts, routes.ts, format.ts, errors.ts, auth.ts, image-upload.ts, ...
│   └── proxy.ts            # clerkMiddleware() passthrough (Next 16 name for middleware)
├── convex/                 # Backend: DB + storage + realtime queries + durable workflows
│   ├── schema.ts           # 15 tables (users → stepStats)
│   ├── *.ts                # Thin public wrappers: users, avatars, uploads, items, outfits,
│   │                       #   renders, jobs, credits, subscriptions, threads, agent, admin, views
│   ├── model/              # Business logic on ctx (credits, jobs, users, items, outfits, renders, ...)
│   ├── lib/                # auth.ts, errors.ts, env.ts (server-only helpers)
│   ├── shared/             # Isomorphic constants: credits.ts, wardrobe.ts, validators.ts, jobs.ts,
│   │                       #   demo_wardrobe.ts (imported by src/ and agent/ too)
│   ├── ai/                 # "use node" actions: openai.ts, prompts.ts, image_input.ts,
│   │                       #   colours.ts, pipeline.ts (internal mutations/queries for workflows)
│   ├── workflows/          # manager.ts (pool 8, retry 3×/2s×2), ingest.ts, render.ts
│   ├── http.ts             # EMPTY httpRouter — no routes registered
│   ├── auth.config.ts      # Clerk JWT issuer, applicationID "convex"
│   ├── subscriptions.ts    # Clerk Backend SDK reads ("use node" action)
│   ├── demoWardrobe.ts     # Static-asset demo seeding (no AI)
│   └── dev/smoke.ts        # Internal scratch-deployment helpers (ALLOW_DEV_SMOKE=1 only)
├── agent/                  # Vercel Eve stylist (withEve in next.config.ts)
│   ├── agent.ts            # defineAgent({ model: "openai/gpt-5.4-mini" }) via AI Gateway
│   ├── instructions.md     # Stylist persona + rules
│   ├── channels/eve.ts     # Clerk bearer verify + session-ownership wrapper
│   ├── tools/              # 18 files: get_context, get_wardrobe, gap_analysis, get_weather,
│   │                       #   compose_outfits, quote_renders, start_renders (approval: always),
│   │                       #   save_outfit, ask_question, load_skill + disabled sandbox/file tools
│   ├── lib/                # convex.ts (service client), session-auth.ts, session-ownership.ts, threads.ts
│   ├── hooks/message-cap.ts# Per-turn stylist rate-limit counting
│   └── skills/             # colour-pairing.md, dress-codes.md (loaded on demand)
├── extension/              # OpenWear Fitting Room (Plasmo 0.90.5, SEPARATE npm package + lockfile)
│   ├── background.ts       # Service worker: garment/product image fetch only (no credentials)
│   ├── content.tsx         # Content script: launcher, drag capture, room iframe host
│   ├── popup.tsx           # Toolbar popup (open room / settings / sign-in / allowance)
│   ├── options.tsx         # Options page (local auto-freeze preference only)
│   ├── tabs/room.tsx       # Fitting-room tab: webcam, framing, Decart session, drag-drop receive
│   ├── lib/                # settings.ts, garment.ts, drop.ts, vision.ts (MediaPipe tracker)
│   ├── vendor/             # decart-entry.ts shim → bundled decart-sdk.mjs (1.2 MB, gitignored);
│   │                       #   frame-metadata-worker.js (gitignored, copied at prebundle)
│   ├── vision/             # pose_landmarker_lite.task (source; wasm copied from node_modules)
│   ├── scripts/            # copy-decart-worker.mjs, copy-vision.mjs
│   └── tests/              # bundle.test.mjs, image-links.test.mjs
├── docs/                   # assets/ (screenshots) + reference/ (vendored Convex docs)
├── tests/                  # 17 root test files (Node test runner, no paid AI/checkout needed)
└── PLAN.md / AGENTS.md / README.md / DESIGN.md / .env.example
```

**Runtime topology (current):**

| Path | Client | Auth | Backend | AI provider |
|---|---|---|---|---|
| Fitcheck web | Next.js → Convex React hooks | Clerk JWT (`convex` template) | Convex functions + workflows | Direct OpenAI **or** AI Gateway (config-selected) + Eve/Gateway stylist |
| Eve stylist | `useEveAgent` chat stream | Clerk bearer + `x-fitcheck-thread-id` | Scoped `convex/agent.*` via `AGENT_SERVICE_KEY` | `openai/gpt-5.4-mini` via Gateway |
| OpenWear ext | Plasmo extension pages | Clerk JWT (`convex` template) via Sync Host | Convex `liveMirror:authorizeLiveMirror` (quota + server key) | Decart Lucy realtime (`lucy-vton-latest`) |

> **Step 2E3: the legacy browser-stored Decart credential ("None / Decart direct" above) is
> REMOVED.** The extension holds no permanent key; `background.ts` mints nothing; Fast Mode is
> deleted. Historical findings below marked accordingly stay for context.

---

## 2. Fitcheck AI/provider map

### 2.1 Provider selection (single choke point)

`convex/ai/openai.ts:44-59` — one client factory for **all** Convex AI actions:

- `OPENAI_API_KEY` set → direct OpenAI, model IDs bare (`gpt-5-mini`, `gpt-image-2`, `text-embedding-3-small`).
- Else `AI_GATEWAY_API_KEY` + `baseURL https://ai-gateway.vercel.sh/v1`, model IDs prefixed `openai/…`.
- Config-selected at call time, **not** failover: a failed direct call is never retried through Gateway.
- SDK `maxRetries: 0`, `timeout 300 s`; retries belong to the workflow layer.

Exact models (`convex/ai/openai.ts:29-31`, `agent/agent.ts:13`):

| Operation | Model string in code | Via |
|---|---|---|
| Garment detection | `gpt-5-mini` | Convex action → direct/Gateway |
| Garment extraction | `gpt-image-2` | Convex action → direct/Gateway |
| Try-on render | `gpt-image-2` | Convex action → direct/Gateway |
| Embeddings | `text-embedding-3-small` | Convex action → direct/Gateway |
| Stylist chat | `openai/gpt-5.4-mini` (+ `reasoning: "low"`) | Eve → AI Gateway (`AI_GATEWAY_API_KEY` or Vercel OIDC) |
| Weather | Open-Meteo (no key) | Agent tool direct fetch — not an AI provider call |

### 2.2 Operation-by-operation ledger

**OP-1 · Detection — `detectItems` internalAction (`convex/ai/openai.ts:65-110`)**

- Provider/model: OpenAI-compatible `responses.create`, `gpt-5-mini`, `input_image detail:"high"`, strict `json_schema` (`detected_items`).
- Prompt/schema: `convex/ai/prompts.ts:51-137` (`detectionInstructions()`); coercion `parseDetectedItems`/`coerceDetectedItem` (`openai.ts:395-452`, bbox fallback `[0,0,1,1]`, category fallback `accessory`).
- Inputs: `{uploadId, jobId}` → upload photo bytes from storage.
- Outputs: `vDetectedItem[]` (name, category/subcategory, colours, pattern, material guess, seasons, formality, bbox, description); capped at `LIMITS.maxItemsPerPhoto = 12`.
- DB reads: `uploads`, `_storage`. Writes: `jobs` steps (`detect` running/done/failed + usage meta), `uploads.status = detecting`.
- Credits: **0** (free scan; operator still pays ~$0.002). COGS priced via `detectPricing` (0.25/0.25/2 per M) into `dailyStats.cogsUsd`.
- Retry: workflow `retry: true` → 3 attempts, 2 s ×2 backoff (`workflows/manager.ts:8-13`). Note: `INVALID_INPUT` also retries — wasteful but harmless (UNCONFIRMED intent).
- Failure: step `failed` → `onScanComplete` marks upload `failed`, job `failed/cancelled`. No refund (nothing reserved).
- Replaceability: needs Responses API + strict structured output + vision. A Chat-Completions-only endpoint needs an **adapter** (translate call shape, re-validate JSON).

**OP-2 · Scan recording — `recordCandidates` (`convex/model/uploads.ts:209-242`)**

- Not an AI call; the detection sink. Slices to 12, stores candidates, sets `awaiting_selection`. Idempotent on replay. No credits, no items created.

**OP-3 · Selection — `confirmSelection` (`convex/uploads.ts:104` → `convex/model/uploads.ts:244-333`)**

- Validates ownership, unique in-range indices, wardrobe capacity (1500), fresh billing; reserves `extractionCreditCost = 1/selected item`; creates `items` rows (`extracting`) and starts `extractItems`. Same-selection repeat is idempotent; changed re-selection rejected. Shortfall race → selected items wait in `needsCredits`, resumable via `uploads.resume`.

**OP-4 · Extraction — `extractItem` (`convex/ai/openai.ts:116-179`) + colours + embed + duplicate**

- Provider/model: `images.edit`, `gpt-image-2`, `1024×1024`, `quality: "medium"`, `output_format: "png"`, never `input_fidelity`. Transparent-background attempt with single `opaque` retry on background-param 4xx only (`editWithTransparency`, `openai.ts:286-307`).
- Prompt: `extractionPrompt(description)` (`prompts.ts:140-148`) — flat-lay, transparent BG, preserve exact garment.
- Post-image pipeline (same action): store PNG → `dominantHex(bytes, 3)` (`ai/colours.ts`: 20k samples, alpha ≥ 200, 3-bit quantise; non-PNG/opaque → `[]`) → `embedText(embeddingInput(…))` (name·category·…·description joined ` · `) → `vectorSearch(itemEmbeddings.by_embedding, limit 4, filter userId)` → threshold `0.92` → `items.duplicateOfId` (flagged, never merged/deleted).
- Embeddings: `text-embedding-3-small`, 1536 dims (schema-fixed vector index `by_embedding`, `filterFields: [userId]`). Embedding tokens have **no separate COGS line** (UNCONFIRMED whether excluded intentionally).
- Inputs: `{itemId, jobId, stepKey}`. Reads: `items`, `uploads`+`_storage`, `itemEmbeddings`. Writes: `_storage`, `items` (ready + hex + usage + costUsd), `itemEmbeddings` (upsert), `jobs` (appendResult, step done + costUsd), `dailyStats`.
- Credits: 1/item. Finalize refunds `reservation − extracted` (`workflows/ingest.ts:139-196`).
- Retry: per-item `retry: true`, chunks of 4 (`MAX_PARALLEL_EXTRACTIONS`), deterministic order for replay. Stuck items settled (`extracting → failed|needsCredits`); re-extract keeps old ready cutout until replacement succeeds.
- Replaceability: most portable **if** the endpoint supports multi-image edit + `1024×1024` + transparent background + `b64_json` + usage passthrough. `gpt-image-2` quirks (background fallback, 4xx mapping) are adapter material. Changing embedding dims requires a **schema migration**.

**OP-5 · Render / virtual try-on — `renderImage` (`convex/ai/openai.ts:182-256`)**

- Provider/model: `images.edit`, `gpt-image-2`, `1024×1536`, `quality medium (standard) / high (HQ)`, no `background`/`input_fidelity`.
- References: avatar first + garment cutouts in `LAYER_ORDER` (dress, top, bottom, shoes, outerwear, accessories), max 16 images (avatar + 15 garments, `MAX_REFERENCE_IMAGES`). Missing blobs filtered; zero wearables → `NOT_FOUND`.
- Prompt: `renderPrompt` (`prompts.ts:151-179`) — image order, `SLOT_PHRASE`s, outerwear open, identity/pose preservation, headshot→full-body inference, neutral fallbacks for empty slots (fallbacks not added to wardrobe), fit + presentation phrase.
- Input normalisation (`convex/ai/image_input.ts`): Sharp decode of actual bytes; allow jpeg/png/webp only; reject empty/multi-frame/>50 MP; auto-orient, longest edge ≤ 2048, sRGB PNG. Handles iPhone HDR gain-map JPEGs. Failures → `appError("INVALID_INPUT")` (permanent).
- Inputs: `{renderId, jobId, stepKey}`. Reads: `renders → avatars + outfits + users`, layered ready items. Writes: `_storage`, `renders` (done + usage + costUsd), `jobs`, `dailyStats{rendersDone, cogsUsd}`.
- Credits: standard 1/image, HQ 3/image (`CREDIT_COSTS.render`). `startRenderJob` validates avatar/ownership/plan/daily allowance/concurrency, `reserve`s, inserts `renders{pending, creditsCharged}`, starts workflow. `onRenderComplete` refunds unfinished rows; job → `done|partial|failed|cancelled`.
- Retry: `renderOutfits` fans out over all targets (`Promise.all`, bounded globally by pool 8), `retry: true`. Permanent-error classifier `isPermanentRenderError` (4xx except 408/409/429, or non-transient AppError) settles without retry; transient rethrows. SDK retries off.
- Replaceability: same adapter class as extraction. Multi-image edit + exact output size + identity preservation are the coupling points; cost accounting needs usage passthrough or estimates. **FASHN VTON must not be assumed a drop-in**: current render is multi-garment + avatar + prompt composition in one call; single-garment try-on is a different domain contract.

**OP-6 · Stylist chat — Eve agent (`agent/agent.ts`, `agent/instructions.md`, `agent/channels/eve.ts`)**

- Model `openai/gpt-5.4-mini` via Gateway; sandbox/shell/file tools disabled (`agent/tools/agent.ts`).
- Product tools (10): `get_context` (prefs, avatar count, balance), `get_wardrobe` (owned ready pieces), `get_weather` (Open-Meteo geocode + forecast, no key), `gap_analysis` (pure arithmetic: coverage + concrete gaps, `COLOUR_DOMINANCE 0.6`), `load_skill` (colour-pairing / dress-codes), `ask_question` (focused clarification), `compose_outfits` (validates ids/slots → `outfits{source:"agent"}` + `proposals`; invalid → `{problems}`), `save_outfit` (sets `savedAt`), `quote_renders` (cost + ordered blockers, no reservation), `start_renders` (`approval: always()`; denies on blockers; executor re-derives user from session and requires match with initiator).
- Page context: frontend may attach a one-turn snapshot (item/selection/draft); marked untrusted, never authorization; agent re-verifies via tools.
- Credits: chat/tools free to the user; `recordMessage` bumps `stylistMessagesPerDay = 100` (fail-closed, counts approvals/questions too).
- Replaceability: Gateway model string is portable, but `reasoning`, tool loop, and approval flow are Eve-specific — swapping runtimes needs an **adapter/rewrite**, not a string swap.

**OP-7 · Quote — `credits.quote` (`convex/credits.ts:34-79`) + `agent.quoteRenders` (`convex/agent.ts:313-355`)**

- No AI. Mirror `renders.start` gates (`canAfford`, `reason: balance|daily_cap|feature_locked`). Agent variant adds avatar/running-cap checks and `refreshForAgent` first.

**OP-8 · Demo seeding — `demoWardrobe.seed` (`convex/demoWardrobe.ts:28-54`)**

- No AI. Fetches static `DEMO_WARDROBE` images from `SITE_URL`, validates png/jpeg/webp ≤ 5 MB, inserts `items{status: ready, costUsd: 0}` idempotently (`demoKey` + owner index). Zero credits.

---

## 3. OpenWear architecture map

Plasmo MV3 extension, own `package.json`/`package-lock.json`, React 18, `@decartai/sdk ^0.2.2`, `@mediapipe/tasks-vision ^1.0.1`.

| Piece | File | Role |
|---|---|---|
| Background service worker | `extension/background.ts` | **Holds no credentials.** Fetches/resolves public image URLs (incl. `og:image` fallback); install-time retro-inject; dev-reload gate. (Step 2E3 removed the `token`/`status`/`test-key` handlers and all provider calls.) |
| Content script | `extension/content.tsx` | Shadow-DOM launcher (`<openwear-root>`), drag capture (capture-phase `dragstart`/`dragend`), transparent `.ow-drop-catcher` overlay, hosts room iframe (`tabs/room.html`, `allow="camera; autoplay; clipboard-write"`) |
| Popup | `extension/popup.tsx` | Toolbar popup: sign-in/out, open fitting room (with `scripting.executeScript` fallback + retry), read-only Live Mirror allowance |
| Options page | `extension/options.tsx` | Local auto-freeze preference only (`autoFreezeSeconds`); no credentials, no Fast Mode |
| Fitting room | `extension/tabs/room.tsx` | Webcam lifecycle, pose framing, garment receive, secure Decart session (server-minted token), Freeze & Inspect, drag-drop receive, snapshot download |
| Settings store | `extension/lib/settings.ts` | `chrome.storage.local` `{autoFreezeSeconds}` only; legacy `apiKey`/`fastMode`/`sessionMinutes` values cleaned on load |
| Garment helpers | `extension/lib/garment.ts` | `cleanName`, `buildPrompt` (≤48 chars: "Substitute the outfit with the complete outfit shown in the reference image[, including the …]"), `normalizeImage` (white-letterbox 768 px JPEG q0.92, preview q0.8) |
| Drop parsing | `extension/lib/drop.ts` | File-first; else `text/html → img[src\|data-src]`, `text/uri-list`, `text/plain` first `https?://` |
| Pose tracker | `extension/lib/vision.ts` | `PoseLandmarker` (CPU, `VIDEO`, 1 pose, segmentation masks), 256 px detect path, `coverRect`/`silhouetteBox`/`TARGET`/`guide()` instructions |
| Vendor shim | `extension/vendor/decart-entry.ts` | Re-exports `createDecartClient, models` + `PoseLandmarker`; esbuilt to `vendor/decart-sdk.mjs` (1.2 MB, gitignored) |
| Worker copy | `extension/scripts/copy-decart-worker.mjs` | Copies SDK `frame-metadata-worker.js` → `vendor/` (Windows-safe `cp` replacement) |
| Vision copy | `extension/scripts/copy-vision.mjs` | Copies MediaPipe `vision_wasm_internal.js/.wasm` + `pose_landmarker_lite.task` → `build/…/vision/` |

Manifest (from `extension/package.json:32-64` `manifest` block):

- `permissions: ["storage", "scripting"]` — minimal.
- `host_permissions: ["https://*/*", "http://*/*"]` — **overly broad** (needed for arbitrary shop image fetch + tab inject fallback).
- `content_scripts matches: ["http://*/*", "https://*/*"], all_frames: false, run_at: "document_idle"` (`content.tsx:13`).
- `web_accessible_resources: [{resources: ["tabs/room.html"], matches: ["http://*/*", "https://*/*"]}]` — broad audience, single resource.
- `CSP extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` — `wasm-unsafe-eval` required for MediaPipe.
- `externally_connectable: {matches: ["http://localhost/*"]}` — narrow, dev-only reload.
- No `extension/README.md` or in-extension docs exist. Build outputs (`build/`, `.plasmo/`, `vendor/decart-sdk.mjs`, `vendor/frame-metadata-worker.js`, `*.zip`) are gitignored.

---

## 4. Current Fitcheck user flow

1. `/` landing (public; signed-in → `/wardrobe`). Marketing + pricing summary.
2. `/sign-in | /sign-up` (Clerk) → client `StoreUser` runs `users.ensure` → `subscriptions.refresh` → `/onboarding` until `onboardedAt`.
3. `/onboarding` — upload avatar(s) (`avatars.create`, plan-capped), pick `presentation ∈ {masculine, feminine}` (neutral rejected for new onboarding; legacy neutral readable), set fit prefs → `users.completeOnboarding`.
4. `/wardrobe` — grid of `items.list` (default `ready`); filters (category/colour/season/formality), text search (`search_text` index), sort; bulk hide/delete/recategorize; empty → `/add`.
5. `/add` — dropzone (1–50 photos, jpg/png/webp, 20 MiB each; HEIC rejected). `uploads.createBatch` → **free** `scanUpload` per photo → `detectItems` (`gpt-5-mini`) → review original + numbered candidates grouped by photo (`uploads.needsReview`) → `confirmSelection` (quote shown, credits reserved, item rows created) → `extractItems` (`gpt-image-2` + colours + embeddings + duplicate flag) → ready. Partial credit exhaustion → `needsCredits` + one-tap `Resume`.
6. `/outfits/new | /outfits/[id]` — builder (outerwear/top/bottom-or-dress/shoes/accessories). "Render on me" sheet: avatar picker, count 1–4, standard/HQ (HQ needs `hq_renders`), live `credits.quote`, confirm → `renders.start` → workflow → images stream in place; regenerate single; mark worn (bumps wear counts).
7. `/stylist | /stylist/[threadId]` — Eve chat: brief → `compose_outfits` proposal cards → `quote_renders` approval card (cost on button) → `start_renders` → render cards subscribe to `jobs.get` (correct terminal state even after turn ends). `ask_question` renders option buttons. Resumes on reload.
8. `/lookbook` — `renders.listMine`, share/unshare (`sharing` feature), download, delete; failed renders dismissable after settle.
9. `/billing` — Clerk `<PricingTable/>`, plan + non-expiring balances, renews-on, paginated `creditLedger`. Low-balance nudge (`CreditBadge` ≤ 10) in topbar; `Activity` popover for running jobs; toasts on completion/failure.
10. `/settings` — avatars (add/remove/default, in-place replace incl. only-Free-avatar preserving ID), preferences, theme, delete-all-data (batched purge; preserves account/plan/ledger/signup-bonus ref; not the Clerk account).
11. `/admin` (role `admin` only) — windows 1/7/30 d: credits sold vs spent, real COGS from token usage, margin, active/failed jobs, top spenders, daily spend vs `MAX_DAILY_SPEND_USD`; `retryJob` / `refundJob` / `adjustCredits`.
12. `/share/[token]` — public, no auth; render + item strip; 404 when revoked.

---

## 5. Current OpenWear Live Mirror flow

Exact files/functions per step:

1. **Product page → launcher.** Shop page loads → `content.tsx:18-39` mounts `<openwear-root>` + shadow root + `style.css` → "AI fitting room" button (`content.tsx:170-177`) or toolbar `popup.tsx:8-29` → `tabs.sendMessage(tab.id, {type:"openwear:open"})` (with `scripting.executeScript` fallback) → `content.tsx:105-114` opens (`setOpen(true)`) and embeds room iframe `chrome.runtime.getURL("tabs/room.html")` (`content.tsx:44-45,185`).
2. **Garment image acquire (drag-only; no DOM scraper).** `dragstart` capture (`content.tsx:117-134`): `composedPath()` → first anchor + first image (`querySelector("img")` fallback); URL = `bestImageUrl` (largest `srcset` candidate, Pinterest `i.pinimg.com` → `736x` rewrite, absolutized) or `link.href`; name = `productName` (alt/title → nearest `h1-h4/[class*=name|title]` within 6 ancestors → wide-image `h1`/`og:title` → link text). Drop on overlay (`content.tsx:137-148`) → `parseDrop` (`lib/drop.ts`: file-first, else HTML/URI-list/plain URL) → `postMessage({type:"openwear:garment", file|url, name})` to iframe (`content.tsx:102`, origin-targeted `ROOM_ORIGIN`).
3. **Fitting room receive.** `room.tsx:322-330` (accepts `event.source === window.parent` only) → `tryOn()` (`room.tsx:289-308`): `garmentSeq++`, `cleanName`, status reading; idle → `start()`. Local file input (`room.tsx:547`, jpg/png/webp) and in-room drop (`room.tsx:464-470` via `parseDrop`) feed the same path.
4. **Webcam start (with camera-compatibility fallback).** `start()`: signed-out users get the
sign-in notice before any camera prompt; `acquireCamera()` tries the model capture size, then
retries once with generic `{video:true}` on `NotFoundError`/`OverconstrainedError` (never on
`NotAllowedError`); `onended → stop("Camera disconnected.")`. Grant fallback page (`?grant`)
requests `video:true` then stops tracks immediately.
5. **Pose framing (local, MediaPipe).** Lazy `createPoseTracker()` (`lib/vision.ts:11-22`: local `vision/` fileset, `pose_landmarker_lite.task`, CPU, `VIDEO`, 1 pose, masks) → `enterFraming()` → rAF loop (`room.tsx:337-439`, detect throttled ~15 fps while framing/scanning) → `guide()` instructions ("Step into the frame" / "Face the camera" / "Step back" / …) → 900 ms hold (`HOLD_MS`) → `markFramed()` → `phase ready`, waiters released.
6. **Image prep.** `normalizeImage` (`lib/garment.ts:25-47`): remote URL → `background("image",{url})` → `background.ts:78-143` (validate, fetch ≤ 8 MB, `text/html` ≤ 2 MB → `previewImageUrl` scanning `og:image|og:image:secure_url|twitter:image` → re-fetch; allow jpg/png/webp/svg) → white-letterbox 768 px JPEG (q0.92; preview q0.8).
7. **Decart authorization (server-side only).** `connect()` → `authorizeLiveMirror({})`
(`convex/liveMirror.ts`): identity from the verified Clerk session; monthly session quota +
fresh billing + daily operator cap enforced server-side; returns a short-lived token the room
hands to `createDecartClient({apiKey: token})`. The browser holds no permanent key and chooses
no model, duration, or speed. Missing auth configuration fails closed with a setup error.
8. **Lucy realtime session.** `createDecartClient({apiKey: token, telemetry:false}).realtime.connect(stream, {model: models.realtime("lucy-vton-latest"), mirror:true, speed fast?, initialState:{prompt:{text: buildPrompt(name), enhance:true}, image}, onRemoteStream})` (`room.tsx:215-226`). Listeners: `connectionChange` (queue clear on `generating|connected`; `disconnected → stop`), `queuePosition`, `sessionEnded → stop`, `error → stop(friendly)` (`room.tsx:228-238`). Client countdown enforces `sessionSeconds` (`room.tsx:239-246`). Later garments → `connection.set({prompt, image, enhance:true})`; rename re-sends; `SETTLE_MS 900 (+500 first)` then reveal + laser-scan overlay masked by tracker mask.
9. **Session termination.** `stop()` (`room.tsx:115-133`): `sessionRef++` (invalidates in-flight waits), `connection.disconnect()`, tracks stopped, `srcObject = null`, state reset, optional notice. Triggers: toolbar off, countdown expiry, `disconnected`/`sessionEnded`/`error`, `visibilitychange` hidden, `pagehide`, unmount. (No explicit server `terminate` call found — termination is `disconnect()` + timers; server `maxSessionDuration` is the backstop.)

---

## 6. Authentication and billing architecture

**Clerk owns identity + subscriptions; Convex owns the credit ledger. No webhooks.**

- JWT: template `convex`, audience/applicationID `convex` (`convex/auth.config.ts`, `src/lib/auth.ts:21`, `AppProviders`). `src/proxy.ts` is a bare `clerkMiddleware()` passthrough; gating is per-page (`requireSignedIn`) + per-function (`requireUser`).
- `convex/lib/auth.ts`: `getCurrentUser` (identity.subject → `users.by_clerkId`), `requireUser` (`UNAUTHENTICATED`), `requireAdmin` (stored `role == admin` **and** live Clerk claim `admin`, else `FORBIDDEN`), `requireOnboarded` (gates `renders.start/regenerate`, `uploads.*`, item writes), `requireServiceUser({serviceKey, clerkUserId})` (constant-XOR compare vs `AGENT_SERVICE_KEY`, then user lookup), `assertOwner` (null/foreign → `NOT_FOUND`, hiding existence).
- Eve channel (`agent/channels/eve.ts` + `agent/lib/*`): browser Clerk bearer verified via `verifyToken` (+ optional `SITE_URL` authorizedParties); tools call Convex with `{serviceKey, clerkUserId}` derived from the session principal (`session-auth.ts` same-principal check; only `clerk` or explicit local-dev `AGENT_DEV_CLERK_USER_ID` — never a rejected bearer). Session creation requires owned `x-fitcheck-thread-id`; server binds Eve session ↔ thread (`threads.eveSessionId/sessionVerifiedAt`) before exposing the ID; later ops re-check the binding (`session-ownership.ts`, `model/threads.ts`: no retarget, no duplicates, advance-only cursor, outage fail-closed).
- Subscriptions (`convex/subscriptions.ts`, "use node"): `billing.getUserBillingSubscription` → pick highest-price active/canceled current-period non-free plan → map slugs → `reconcileSubscription` with ref `clerk:plan:{clerkId}:{plan}:{periodStart}` (idempotent; slower older reads cannot overwrite newer via `readStartedAt ≤ billingCheckedAt` guard). Refresh triggers: sign-in, focus/visibility, plan/version change, before paid ops, before agent quote/execute, and `refreshForJob` for stale running jobs. Paid writes older than 60 s (`BILLING_FRESHNESS_MS`) or past `planPeriodEnd` fail `SUBSCRIPTION_REFRESH_REQUIRED`. SDK errors leave state unchanged (never downgrade).
- Plans (`convex/shared/credits.ts:33-64`; mirror in Clerk Billing `pro`/`plus` with `sharing`, `hq_renders`): Free $0 = 25 once + 1 avatar; Pro $9.99 = 150/cycle + 2 avatars + `sharing`; Plus $19.99 = 300/cycle + 5 avatars + `sharing` + `hq_renders`. `priority_queue` slug defined but unenforced. No metered billing, no one-off packs (legacy `topup` ledger kind is read-only history; `packCredits` field retains the "Non-expiring credits" balance).

---

## 7. Credit/usage safeguards

All balance/ledger writes live in `convex/model/credits.ts` (nothing else touches `planCredits`/`packCredits`/`creditLedger`).

- **Costs:** scan 0 · extract 1/piece · standard render 1/image · HQ render 3/image · stylist/weather/compose/save/demo 0.
- **Buckets:** `planCredits` (current-period allowance, spend-first) + `packCredits` (non-expiring signup/legacy, refund-first). Expired plan credits excluded from spendable balance. Signup grant ref `signup:{clerkId}` survives content wipes.
- **`reserve(user, amount, jobId)`:** `granted = min(amount, balance, dailyRemaining, globalRemaining)`; reason `balance|daily_cap|kill_switch`; one `reserve` ledger line per bucket touched; ref `reserve:{jobId}:{bucket}` (retry-safe). Partial grants possible — callers decide (renders fail fast; ingest parks in `needsCredits`).
- **`refund(job, amount, note)`:** pack-first, capped at `reservation − refunds`, seq refs `refund:{jobId}:{bucket}:{seq}` (idempotent); same-day `dailySpend` decrement; `dailyStats.creditsRefunded`.
- **`grantPlan`:** `plan_reset` (discard remainder) + `plan_grant` (allowance), period-ref idempotent.
- **Caps (`LIMITS`, `shared/credits.ts:66-80`):** 150 credits/user/day · 3 concurrent units/user (render job = 1, whole upload batch = 1) · 4 renders/request · 3 outfits/render-request · 50 photos/batch · 12 candidates/photo · 1500 items/user · 200 detects/day · 100 stylist msgs/day · low-balance ≤ 10.
- **Global kill switch:** `MAX_DAILY_SPEND_USD` (Convex env) ÷ `cogsUsdPerCredit 0.033` vs `systemCounters.credits_reserved`; unset = unbounded.
- **Workflow retries:** pool `maxParallelism 8`; `maxAttempts 3, initialBackoff 2 s ×2`; SDK retries off. Permanent render errors (4xx except 408/409/429, non-transient AppError) settle immediately.
- **Settlement:** `onIngestComplete` / `onRenderComplete` count successes, mark rest failed, refund unused, job → `done|partial|failed|cancelled`. Delete/retry blocked until the batch settles (no lost refunds). Re-extract keeps old cutout until replacement succeeds.
- **Known limitation:** reservations carry no originating billing period — a late plan refund across renewal lands in the new period (README §credits). Must be fixed before strict period accounting.
- **Admin:** `retryJob` (re-runs failed portions, charges user), `refundJob` (outstanding reservation + audit note), `adjustCredits` (idempotent ref).

---

## 8. Secret-management findings

| # | Finding | Location | Severity |
|---|---|---|---|
| S-1 | **RESOLVED (Step 2E3).** Permanent Decart key was stored in `chrome.storage.local` plaintext. The credential, its storage, the background minting path and Fast Mode are all deleted; the only permanent key is the server-side `DECART_API_KEY` env variable. | `extension/lib/settings.ts`, `options.tsx`, `background.ts` (all rewritten) | Was **High** — closed |
| S-2 | Mitigation exists but partial: only background reads the key; room/popup/content receive a 60 s scoped token (`expiresIn: 60`, `allowedModels`, server `maxSessionDuration`) | `background.ts:52-61`, `room.tsx:212-214`, `options.tsx:48` | Lowers blast radius; does not fix S-1 |
| S-3 | Client-trusted session countdown (`token.sessionSeconds` interval) — server `maxSessionDuration` is the only real control (semantics UNCONFIRMED server-side) | `room.tsx:239-246` | Medium (metering) |
| S-4 | `AGENT_SERVICE_KEY` correctly never leaves server/Eve runtime; no `NEXT_PUBLIC_` secret; Convex secrets set via dashboard/CLI, not `.env.local` | `.env.example`, `convex/lib/env.ts` | Good — preserve pattern for any Decart server key |
| S-5 | **RESOLVED (Step 2E3).** `test-key` background path (local key-guessing loop) deleted with the whole credential workflow. | `background.ts` (rewritten) | Was Low — closed |
| S-6 | Room accepts `postMessage` on `source === window.parent` without `event.origin` check (relies on extension-origin iframe) | `room.tsx:322-330` vs `content.tsx:102` | Low-Medium (hardening) |
| S-7 | Content-script message listener accepts any `openwear:open` runtime message without sender check | `content.tsx:105-114` | Low |
| S-8 | Background message gate correctly rejects non-extension pages (`sender.url` must start with extension URL) | `background.ts:147-150` | Good — keep |
| S-9 | Image fetch SSRF surface: blocks localhost/`.local`/IPv4-literal/credentials, caps 8 MB/2 MB, allowlists MIME, `credentials: omit`; gaps: DNS-rebinding/private-range hostnames, redirect-to-private after `follow`, SVG→canvas without sanitization, regex HTML parsing | `background.ts:66-143`, `lib/garment.ts:29-31` | Medium |
| S-10 | `host_permissions ["https://*/*","http://*/*"]` broader than least-privilege (required today for arbitrary shop fetch + inject fallback) | `extension/package.json:37-40` | Medium (store review + blast radius) |
| S-11 | Webcam: `audio:false`, auto-pause on hidden tab, `onended` handling, explicit copy ("streams to Decart only while open; nothing recorded"); residual: camera on while window open pre-garment, `?grant` full-`video:true` probe, AI-frame download without redaction | `room.tsx:54,142,187-197,444-456,512` | Privacy note, not a vuln |
| S-12 | No per-garment throttle / per-`set()` confirmation; drag-spam fans out `set()` calls; rename re-sends — cost abuse is currently only bounded by session duration | `room.tsx:263-319` | Medium (metering) |
| S-13 | `safeEqual` length early-return (not fully constant-time) | `convex/lib/auth.ts:65-70` | Negligible |

---

## 9. Fitcheck ↔ extension integration boundaries

**Current state: none.** No shared code, types, API, or message contract exists. `convex/http.ts` is an empty router.

Reusable Fitcheck mechanisms (no new auth primitive needed):

- **Identity proof:** extension obtains the user's Clerk session token and calls Convex with the same `convex`-template JWT the web app uses (`requireUser` + `assertOwner`). Fallback if the extension cannot host a Convex client: new `httpAction` verifying `Authorization: Bearer` with `verifyToken(…, {secretKey, authorizedParties: [SITE_URL]})` — the exact `agent/channels/eve.ts:19-49` pattern. **Never** reuse `requireServiceUser`/`AGENT_SERVICE_KEY` for the extension (would ship a shared secret to browsers).
- **Authorization endpoint:** new thin module, e.g. `convex/extension.ts` (queries/mutations) or one `httpAction` in `convex/http.ts` (explicit CORS, `cache-control: no-store`). Reuse `requireUser` (+ `requireOnboarded` if wardrobe access), `assertFreshBilling`, `getBalance`, `credits.quote`.
- **Entitlement check:** `hasCurrentPlan` / `hasCurrentFeature` (`model/credits.ts:21-27`) + `assertFreshBilling` (60 s) before any spend/share/avatar path — mirror `renders.start` and `agent.quoteRenders`.
- **Metering:** Live Mirror usage = a `jobs` row + `reserve(jobId)` + `refund` on early stop, reusing `countRunningUnits`/`assertBelowJobLimit` concurrency and `bumpUsageCounter` for free previews. Display remaining seconds from server state, never from the client's countdown.
- **Remaining-seconds representation:** derived, not stored as a spendable balance: `min(plan allowance policy, dailyRemaining, globalRemaining)` translated to seconds at the Decart cost rate, computed in the authorizer per request (avoids a new balance column and the period-refund trap in §7).
- **Short-lived Decart session:** server mints the Decart client token (same `POST /v1/client/tokens` call moved from `background.ts:52-61` into a Convex "use node" action holding `DECART_API_KEY`), scoped (`expiresIn: 60`, `allowedModels: [lucy-vton-latest]`, `maxSessionDuration` = granted seconds), returned with `sessionSeconds`; `DECART_API_KEY` lives only in the Convex deployment env (dashboard/CLI), following the `OPENAI_API_KEY` precedent.
- **API contracts eventually needed:** `extension.authorizeMirror{expectedSeconds?} → {token, sessionSeconds, features}` · `extension.reportMirrorUsage{jobId, secondsUsed} → {refunded}` (or server-pushed via Decart webhook if available) · reuse `credits.balance/quote`, `jobs.get/listActive` as-is.
- **Shared types:** `convex/shared/*` already imports into `src/` and `agent/`; extension (separate toolchain, no workspace) should **copy the tiny contract** (amounts, reasons, `vBalance` shape) rather than a `packages/shared` workspace — a workspace is premature until ≥2 contracts drift more than once. Revisit only when the mirror authorizer and web client demonstrably diverge.
- **Session binding:** if mirror sessions attach to conversations, reuse `threads.eveSessionId/sessionVerifiedAt` + `bindSession/canAccessSession` — do not invent a second binding table.

---

## 10. Provider-coupling matrix

| Operation (§2.2) | Current provider | OpenAI-compatible swap, no contract change? | Custom adapter required? | Notes |
|---|---|---|---|---|
| Detection (OP-1) | OpenAI/Gateway `gpt-5-mini`, Responses API + strict JSON + vision | Only if endpoint speaks Responses + strict schema + `detail:"high"` images | **Yes** for Chat-Completions-only endpoints (reshape call, re-validate, coerce) | Thresholds/prompts are provider-sensitive; re-measure `maxItemsPerPhoto` quality |
| Extraction (OP-4) | OpenAI/Gateway `gpt-image-2` edit | **Yes, conditionally** — multi-image edit + `1024×1024` + transparent BG + `b64_json` + usage | Small (background fallback, 4xx mapping, cost math) | Safest image substitution; `dominantHex` already tolerates opaque fallback |
| Render (OP-5) | OpenAI/Gateway `gpt-image-2` edit | **Yes, conditionally** — same + `1024×1536` + 16 refs + identity preservation | Small (same as extraction + prompt tuning) | Do **not** treat FASHN single-garment as equivalent — different contract (multi-garment + avatar + fallbacks) |
| Embeddings (OP-4) | `text-embedding-3-small` 1536-d | **Yes** if 1536-float cosine-compatible | Recalibrate `0.92` threshold for other geometries | Dim change = schema migration (`by_embedding` dims fixed) |
| Stylist chat (OP-6) | Gateway `openai/gpt-5.4-mini` + Eve | Model string portable within Gateway | **Yes** to leave Eve (tool loop, approvals, `reasoning`) | Keep Eve until a replacement passes stylist regression suite |
| Weather (OP-6) | Open-Meteo | N/A (not AI) | No | No-key; check usage terms per deployment |
| Gap/compose/quote (OP-6/7) | Arithmetic/validators | N/A | No | Provider-independent |
| Live Mirror (ext) | Decart Lucy realtime | N/A (no compatible stand-in) | Server authorizer first; model stays | `lucy-vton-latest` pinned in 3 places (`room.tsx:25`, `background.ts:12`, bundle test) — keep in sync |

---

## 11. Risks

1. **Permanent Decart key in every browser (S-1) — RESOLVED (Step 2E3).** Key deleted from
   storage, background minting deleted, Fast Mode deleted. Only the server-side `DECART_API_KEY`
   env variable remains.
2. **Unmetered realtime usage.** No reservation/ledger/counter touches Decart minutes today; client countdown is advisory. SaaS margin has no guardrail on the most expensive operation.
3. **No extension authN/authZ.** No identity, no entitlement check, no `requireUser` on any mirror path — subscription bypass is total until the authorizer lands.
4. **Overly broad host permissions** (`https://*/*`, `http://*/*` + all-frames-off content script + single-file WAR). Least-privilege tightening will break arbitrary-shop fetch unless replaced by server-side fetch.
5. **Untrusted image/URL pipeline** (S-9): DNS-rebinding/private-range fetch, redirect-to-private, SVG→canvas, regex meta parsing. Server-side fetch with egress controls fixes most of it.
6. **Period-bound refund trap** (§7 limitation): disconnect mid-renewal accounting before promising strict period guarantees for mirror minutes.
7. **Embedding geometry lock-in:** threshold `0.92` + 1536-d index tuned to one model; silent quality decay if swapped without recalibration.
8. **Eve runtime lock-in:** approval-gated spend path (`quote → approve → start`) is Eve-specific; re-platforming the stylist risks breaking the spend gate.
9. **Two package managers/lockfiles** (root pnpm + extension npm) and separate toolchains — dependency drift; `npm audit` issues in extension are currently (correctly) deferred.
10. **No shared contract yet** — drift risk is currently zero (no integration), but the first contract must be versioned deliberately.

---

## 12. Recommended migration order

**Class key:** A = safe independent substitution · B = needs adapter · C = needs schema/domain change · D = do not combine in one migration · E = untouched until later.

| Order | Step | Class | Invariants protected |
|---|---|---|---|
| 0 | Freeze + record baselines: `pnpm test`, extension `npm test`, typechecks, one real scan→extract→render + one mirror session notes | — | Everything |
| 1 | **Decart server authorizer** (new `convex/extension.ts` or `httpAction`; `requireUser` + `assertFreshBilling` + `reserve`/`refund` on a mirror `jobs` row; `DECART_API_KEY` in Convex env; 60 s scoped token return; `background.ts` token call repointed, permanent key deleted from storage) | B | Extension webcam UX, Lucy realtime flow shape, credit reserve/refund semantics |
| 2 | **Mirror metering + entitlement** (remaining-seconds derivation, `countRunningUnits` inclusion, HQ/`sharing`-style feature gate if launched, admin `dailyStats` columns) | C (small) | Retry semantics, ledger idempotency |
| 3 | **Harden extension transport** (server-side image fetch replaces background fetch; `event.origin` check; narrow WAR/host permissions where shops allow; SVG policy) | B | Drag-drop flow, framing UX |
| 4 | **Extraction provider substitution** (cheapest image op, best-isolated contract, opaque-tolerant) behind the existing adapter seam (`editWithTransparency`, usage→USD) | A/B | Wardrobe behavior, duplicate detection, onboarding/reference photos |
| 5 | **Render provider substitution** (same seam, larger blast radius; re-measure quality/cost; keep fallbacks + `LAYER_ORDER` + 16-ref contract) | B | Outfit behavior, HQ pricing, Lookbook/share |
| 6 | **Detection substitution** (Responses/strict-JSON adapter; re-validate coerce + 12-cap quality) | B | Scan/selection UX, free-scan economics |
| 7 | **Embeddings recalibration** (only with a provider change; re-tune `0.92`, or migrate dims) | C | Duplicate-flag behavior, wardrobe search |
| D | Never combine in one migration: authorizer+metering (1+2) with any provider swap (4–7); extraction+render swaps together; stylist re-platform with anything spend-adjacent | D | — |
| E | Untouched until later: Eve/stylist runtime, FASHN evaluation (single-garment only, never as full-outfit replacement without a dedicated trial), SAM2 evaluation (segmentation ≠ generated product cutout until proven), OpenRouter fallback (after ≥1 successful single-provider swap), `packages/shared` workspace (premature — copy the tiny contract) | E | Stylist behavior, credit semantics |

**Recommended first implementation step:** Step 1 — the Decart server authorizer. It removes the highest-risk coupling (browser-held permanent key + unmetered spend) without touching any AI domain contract, and every later step depends on its metering hook.

---

## 13. Tests that must protect each migration stage

**Currently available:**

- Root `tests/*.test.mjs` (17 files, Node runner, no paid AI): account-bootstrap (7), client-errors (4), credit-balances (7), image-input (9), item-form-concurrency (5), job-progress (16), onboarding-preference (4), render-failure (4), store-user (8), stylist-initial-brief (4), stylist-page-context (9), stylist-render-status (6), stylist-session (10), stylist-tool-activity (7), stylist-unavailable-session (4), upload-recovery (6), upload-selection (12). Recorded: 144 passed (2026-09-17 release); `pnpm typecheck` (app + convex + agent), `pnpm lint`.
- Extension `tests/`: `bundle.test.mjs` (Lucy model dims, packaged manifest/popup/content/room/vision presence, CSP `wasm-unsafe-eval`, Zod-crash guard), `image-links.test.mjs` (og:image resolution, fetch `credentials:omit`, imageless-page error, optional live-URL skipped). Recorded: 4 passed, 1 optional skipped; `tsc --noEmit`.
- Backend `convex/dev/smoke.ts` (scratch deployments, `ALLOW_DEV_SMOKE=1`): credit idempotency, snapshot ordering/expiry, avatar replacement, batched purge, role parsing (+ real-AI pipeline helpers that spend funds).

**Missing (needed before migration):**

- M1 · Authorizer contract tests: unauthenticated/foreign-user denied; stale-billing (>60 s) rejected; reserve-then-disconnect refunds exactly; double-report idempotent; token scoped (60 s, single model, session cap).
- M2 · Metering tests: concurrent mirror + render jobs counted together; daily-cap and kill-switch stop new sessions; renewal-boundary refund lands per documented policy.
- M3 · Extension transport tests: `event.origin` rejection; private-range/redirect-to-private fetch blocked; SVG policy; permission-narrowing checklist per shop.
- M4 · Extraction-swap goldens: fixed photo+description → assert size `1024×1024`, PNG, `duplicateOfId` behavior on near-dupes, `dominantHex` non-crash on opaque fallback, cost math from passthrough usage.
- M5 · Render-swap goldens: fixed avatar+garments → assert `1024×1536`, slot coverage, fallback presence, identity prompt intact, `partial` + exact-refund on 1-of-N failure.
- M6 · Detection-swap fixtures: malformed JSON / 13-item overflow / bad-bbox coercion cases; strict-schema validation errors surfaced, not imported.
- M7 · Embedding recalibration set: labeled near-duplicate pairs to re-tune `0.92` (or justify keeping it).
- M8 · Stylist spend-gate tests (already partially covered by stylist-session/tool-activity): cross-principal approval rejected; quote-then-balance-change denies execution.

---

## 14. Files inspected

**Instructions/docs (6):** `AGENTS.md`, `CLAUDE.md`, `README.md` (§architecture through §deployment), `PLAN.md` (§1–10), `DESIGN.md`, `.env.example`. (Extension has no README/docs — verified by glob.)

**Fitcheck AI pipeline (13):** `convex/ai/openai.ts`, `convex/ai/prompts.ts`, `convex/ai/image_input.ts`, `convex/ai/colours.ts`, `convex/ai/pipeline.ts`, `convex/workflows/ingest.ts`, `convex/workflows/render.ts`, `convex/workflows/manager.ts`, `convex/uploads.ts`, `convex/model/uploads.ts`, `convex/renders.ts`, `convex/model/renders.ts`, `convex/model/jobs.ts` (+ `convex/jobs.ts`, `convex/items.ts`, `convex/model/items.ts`).

**Stylist/agent (20):** `agent/agent.ts`, `agent/instructions.md`, `agent/channels/eve.ts`, `agent/lib/convex.ts`, `agent/lib/session-auth.ts`, `agent/lib/session-ownership.ts`, `agent/lib/threads.ts`, `agent/hooks/message-cap.ts`, `agent/tools/` (18 files: `agent, ask_question, bash, compose_outfits, gap_analysis, get_context, get_wardrobe, get_weather, load_skill, quote_renders, read_file, save_outfit, start_renders, task_cancel, todo, web_fetch, web_search, write_file`), `convex/agent.ts`, `convex/threads.ts`, `convex/model/threads.ts`.

**Auth/billing/credits/schema/env (22):** `convex/lib/auth.ts`, `convex/lib/errors.ts`, `convex/lib/env.ts`, `convex/model/credits.ts`, `convex/credits.ts`, `convex/shared/credits.ts`, `convex/shared/wardrobe.ts`, `convex/shared/validators.ts`, `convex/shared/jobs.ts`, `convex/shared/demo_wardrobe.ts`, `convex/subscriptions.ts`, `convex/users.ts`, `convex/model/users.ts`, `convex/model/admin.ts`, `convex/admin.ts`, `convex/schema.ts`, `convex/http.ts`, `convex/auth.config.ts`, `convex/avatars.ts`, `convex/model/avatars.ts`, `convex/demoWardrobe.ts`, `convex/model/demo_wardrobe.ts`, `convex/dev/smoke.ts`, `src/proxy.ts`, `src/lib/env.ts`, `src/lib/auth.ts`, `src/hooks/use-credits.ts`, `src/hooks/use-billing.ts`, `src/hooks/use-clerk-plan.ts`, `src/hooks/use-current-user.ts`, `src/components/providers/app-providers.tsx`, `src/components/providers/store-user.tsx`.

**Routes/views (30+):** `src/app/**/page.tsx` + `layout.tsx` (landing, auth ×2, onboarding, wardrobe ×2, add, outfits ×3, stylist ×2, lookbook, billing, settings, admin, share/[token]), `convex/views.ts`, `convex/outfits.ts`, `convex/model/outfits.ts`, `convex/threads.ts` (proposals/save), `src/lib/routes.ts`, `src/lib/errors.ts`, `src/components/common/job-progress.ts`, `src/components/stylist/*`.

**Extension (24):** `extension/package.json`, `extension/tsconfig.json`, `extension/background.ts`, `extension/content.tsx`, `extension/popup.tsx`, `extension/popup.css`, `extension/options.tsx`, `extension/options.css`, `extension/tabs/room.tsx`, `extension/tabs/room.css`, `extension/lib/settings.ts`, `extension/lib/garment.ts`, `extension/lib/drop.ts`, `extension/lib/vision.ts`, `extension/vendor/decart-entry.ts`, `extension/vendor/decart-sdk.d.mts`, `extension/vendor/decart-sdk.mjs` (first ~100 lines only — 1.2 MB bundle), `extension/vendor/frame-metadata-worker.js` (header), `extension/scripts/copy-decart-worker.mjs`, `extension/scripts/copy-vision.mjs`, `extension/tests/bundle.test.mjs`, `extension/tests/image-links.test.mjs`, `extension/style.css`, `extension/vision/pose_landmarker_lite.task` (presence).

**Tests inventory:** `tests/*.test.mjs` — all 17 files (headers + `test()` names; not executed per audit constraints).

**Grep sweeps (case-insensitive, excl. `node_modules`):** `decart|lucy|extension|openwear|openrouter|fashn|sam2|live mirror|live-mirror|livemirror` across `convex/`, `agent/`, `src/`, `extension/` → hits only in `extension/` (Decart/Lucy/openwear) and false-positive `extension` = file-extension in `src/`; `COMBINED_ARCHITECTURE_AUDIT` repo-wide → absent (confirmed new file).

> Evidence convention: claims cite `path:line`. Residual unknowns are marked UNCONFIRMED in the working notes; only confirmed findings are stated above as fact.

---

## 15. Step 3 hardening (extension transport) &mdash; implementation record

> **Date:** 2026-10-01 &middot; Implements roadmap Step 3 above. This is a post-audit record of the change made from the findings in sections 6/9/12 (see updated storage of S-6, S-9, S-10 below).

**Requirement A &mdash; image fetch moved server-side, SSRF-guarded (was `S-9`):**

- New `convex/lib/imageFetch.ts`: pure `fetchRemoteImage(href, deps)` with `ResolveHost` injection and optional `fetchImpl` for tests; `validateFetchUrl` rejects non-http(s), credentials, whitespace, localhost/`.local`/IP-literal fast gates; every URL (including `og:image` captures and each manual redirect hop) runs `validateFetchUrl` + DNS classification of **every** resolved A/AAAA record in `nodeResolveHost` (`convex/shoppingImages.ts`); capped 8 MB image / 2 MB HTML page, 5 redirects, 12 s timeout, raster-only `image/jpeg|image/png|image/webp` allowlist, no cookies/headers forwarded. `previewImageUrl` reads only `og:image`/`og:image:secure_url`/`twitter:image` (first share tag), and its captured value is re-validated before re-fetch.
- New `convex/shoppingImages.ts` (actions only, `"use node"`): `fetchRemote` (auth via `ctx.auth.getUserIdentity` + internal `resolveFetchUser`) stores the fetched bytes into Convex storage and returns `{ storageId, mimeType, sizeBytes, downloadUrl }`; `discardFetch` deletes only blobs with **no** `uploads` row referencing them (`internal.shoppingImagesInternal.discardUnreferenced`, `uploads.by_storage` index in `convex/schema.ts`). Blobs never registered are GC'd by the caller's `discard()`/`priorStorageRef` lifecycle.
- `extension/background.ts` no longer fetches images, no `case "image"`, no `fetch(`, no `data:image`; it mints capabilities via `handleIssueCapability` and injects the content script at install only. The browser supplies **only** the public URL.
- `extension/lib/remote-image.ts` is the sole client boundary (`prepare` for try-on: server fetch &rarr; download bytes &rarr; `normalizeImage`; `registerBlob` reuses the SAME storage id for save; `registerRemote` for a headless page save fetches+registers in one op; `discard` relays the storage id). `extension/lib/wardrobe-save.ts:saveRemoteGarment` gates the URL with a cheap http(s) regex, then one-time token (`takeToken`), then `registerRemote`. Root tests: `tests/image-fetch.test.mjs` (25) cover validate/redirect/DNS/IP caps/caps/MIME/preview; extension tests `remote-image.test.mjs`, `image-links.test.mjs`, `page-save-adoption.test.mjs` cover the client boundary; E2E test 12 asserts the save path re-fetches through the boundary.

**Requirement B &mdash; fail-closed parent-origin gate (was `S-6`):**

- New `extension/lib/room-origin.ts`: `createOriginGuardCore()` fails closed; `establish(claimedOrigin, eventOrigin)` arms only when both are http(s) and equal; `accept`/`origin` stay locked until a verified handshake; outgoing `targetOrigin()` is `"*"` before arming (so `openwear:room-ready` can be answered) and the exact verified origin after. `fromParent` additionally requires the exact parent `window` object (not `MessageEvent.source`).
- `extension/content.tsx` posts `openwear:origin` on iframe `onLoad`, on `openwear:room-ready` before flushing pending garments, and before immediate forwarding. Cross-origin hostile posts and replayed/forged capabilities still change nothing (E2E tests 8/9/11).
- Tests: `extension/tests/room-origin.test.mjs` (9) cover fail-closed, forged/mismatched claims, non-http(s), re-arm on navigation, target-origin pinning, `fromParent`.

**Requirement C &mdash; host permissions / WAR review (was `S-10`):**

- **Decided: keep** `"permissions": ["cookies", "storage", "scripting"]` and `"host_permissions": ["https://*/*", "http://*/*"]`, and keep WAR `tabs/room.html &rarr; http(s)` in `extension/package.json` (Plasmo manifest key). Neither the manifest nor the WAR were changed. Rationale:
  - `scripting` + broad host permissions: the content script must run on **arbitrary shop pages** (declarative `content_scripts` matches are host-permission-bounded in MV3), and the fit-room ribbon needs an in-page sidecar on any shop. There is no finite shop allowlist, so narrowing host permissions cannot be done safely yet.
  - `cookies`: Clerk session sync on the app domain (the extension signs the user into the app to mint/refresh the Convex grant). The key never was and still is not stored in `chrome.storage`.
  - The **blast radius** the audit was worried about has shrunk: the worker no longer does `fetch`, so broad host permissions no longer grant arbitrary network egress from a fetch-capable background context. Remaining surface: `chrome.tabs`-level injection and cookie visibility — low-value to an attacker, and the `content_security_policy` `extension_pages` stays `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
  - **Residual (accepted):** a compromised content script on a page still reads that page, and `cookies` still exposes app-domain cookies to a compromised worker. Server-side fetch means neither lets an attacker pivot to arbitrary retailer hosts. Narrowing host permissions can be revisited per-shop when a shop allowlist exists; the audit's "permission-narrowing checklist per shop" (M3) is tracked, not done.

**Requirement D/E &mdash; SVG policy everywhere (was `S-9` residual):**

- `convex/lib/imageFetch.ts` allowlists raster MIME only (SVG never accepted from the fetch core); `convex/model/shoppingImports.ts`/`convex/model/uploads.ts` accept only `ACCEPTED_IMAGE_TYPES` and `assertStoredImage` cross-checks the stored blob.
- `extension/lib/garment.ts` `ACCEPTED` is the exact three raster types and a **string** source is restricted to `data:image/(jpeg|png|webp);base64,`; `extension/lib/drop.ts` filters drops to the raster list; `extension/lib/wardrobe-save.ts` the client upload gate refuses any declared non-raster Blob before minting an upload URL; `background.ts` has no image path to regress.
- Tests: `extension/tests/raster-only.test.mjs` (static pins across all five entry points) and the runtime SVG/`text/html` refusal case in `extension/tests/wardrobe-save.test.mjs`.

**Verification recorded (2026-10-01):** root `node --test tests/*.test.mjs` 320 passed; extension `npm test` 350 passed (hang in the old `image-links` listener removed &mdash; it was rewritten for the server boundary); `tsc --noEmit -p convex/tsconfig.json` and extension `tsc --noEmit` clean; `npx convex codegen --typecheck disable` regenerated `convex/_generated`. E2E (`npm run test:e2e`) is the last green gate; the fixture server now sends `access-control-allow-origin: *` and E2E test 12's assertion was reworded to the server-fetch boundary.

**Files added/changed for Step 3:** `convex/lib/imageFetch.ts`, `convex/shoppingImages.ts`, `convex/shoppingImagesInternal.ts`, `convex/schema.ts` (`uploads.by_storage`), `extension/lib/room-origin.ts`, `extension/lib/remote-image.ts`, `extension/lib/wardrobe-save.ts`, `extension/lib/garment.ts`, `extension/lib/drop.ts`, `extension/background.ts`, `extension/content.tsx`, `extension/tabs/room.tsx`, `extension/e2e/harness/backend-stub.ts`, `extension/e2e/harness/room-harness.tsx`, `extension/e2e/fixture/server.mjs`, `tests/image-fetch.test.mjs` (new), `extension/tests/{room-origin,remote-image,image-links,raster-only}.test.mjs` (new/rewritten), `extension/tests/{no-legacy-credentials,capability-service,page-save-adoption,wardrobe-save}.test.mjs` (updated).

---

## 16. Step 7 Phase C (local BGE embeddings) &mdash; implementation record

> **Date:** 2026-10-04 &middot; Implements the approved Step 7 Phase C roadmap (self-hosted `BAAI/bge-small-en-v1.5` for shopping similarity, no paid OpenAI embedding path). Product decision: cosine similarity never assigns `duplicateOfId` for new local-BGE ingests; legacy/manual values and `dismissDuplicate()` stay, and the UI badge stays for those values.

**Why BGE can carry similarity but not duplicates (frozen evidence):** Phase B1 duplicate AUC 0.8407 with zero recall at zero false positives &mdash; retired the `vectorSearch &rarr; cosine threshold &rarr; duplicateOfId` chain. Phase B2 kept semantic prose: threshold `0.896396` (TP 41, FP 0, FN 7; precision 1.0, recall 0.854), pool 16, stable same-category-first rerank (top-3 expected recall 23/27 &rarr; 25/27, bad top-3 7 &rarr; 5), max 3 results.

**Runtime contract (B1-validated, pinned):** official FP32 `onnx/model.onnx`, `onnxruntime` CPU, Linux aarch64, 384 dims, CLS pooling, L2 normalization exactly once, intra-op threads 2 (`bench/embeddings/bench_bge.py`). Revision note: the validated snapshot is `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`; the Phase C brief text dropped two hex chars (`...4b94cc5...`) and is treated as a typo &mdash; code, gateway, install and health all pin the B1 hash, never a branch ref.

**What changed (additive, Option C &mdash; same table, second field):**

- `convex/shared/embeddingText.ts` (new): the single embedding-text contract (field order, ` · ` separator, empty-field rule) plus `EMBEDDING_GENERATION = "bge-v1"`. All 16 frozen B0 strings stay byte-identical (`tests/embedding-provider.test.mjs`).
- `convex/ai/embedding.ts` (new): provider seam. Static dims (local 384 / openai 1536), NO default — missing/empty/unsupported fails closed before any runner, so a deployment can neither silently spend on OpenAI nor silently depend on an undeployed gateway. Explicit `openai` only; no local&rarr;openai fallback; local adapter (`POST {base}/v1/embed`, `X-API-Key`, 60 s timeout, $0); strict validation (exact dims, finite, unit norm &mdash; asserted, never re-normalized). Legacy OpenAI branch audited explicitly unpriced (no embedding price exists in `usageToUsd`; pre-Phase-C behavior restored).
- `convex/model/shoppingAdvice.ts` + `convex/shoppingAdvice.ts`: `EMBEDDING_READ_GENERATION` decouples reads from the write provider — `legacy` (TEMPORARY migration default: stored `embedding` / `by_embedding`, pool 8, cosine order, 0.92 prose threshold) vs `bge` (`embeddingBge` / `by_embeddingBge`, pool 16, same-category-first stable rerank, 0.896396). Unsupported values fail before any vector search; the selector only names stored vectors and can never bill. Fingerprint leads with the ACTIVE generation's token (`openai-1536-v1` vs `bge-v1`), so legacy&rarr;bge invalidates cache.
- `convex/ai/openai.ts`: ingest embeds via the seam into `embeddingBge`; no vector search, no `duplicateOfId` assignment. Legacy OpenAI runner retained as explicit rollback/reference only.
- `convex/ai/pipeline.ts` + `convex/model/items.ts`: `itemReady` takes `embeddingBge` only (asserts 384); `setItemEmbeddingBge` patches that field alone and never touches `duplicateOfId`; legacy `setItemEmbedding` (1536-d + duplicate param) retained unchanged for rollback.
- `convex/schema.ts`: `embedding` made optional (new BGE-only rows cannot satisfy required without paid dual-write), `embeddingBge` optional, legacy `by_embedding` untouched, new `by_embeddingBge` (384, `filterFields: [userId]`). Neither index redefined in place.
- `convex/model/shoppingAdvice.ts` + `convex/shoppingAdvice.ts`: candidate vector, index, pool, rerank, prose threshold and fingerprint token all follow the ACTIVE read generation (see above); max 3 results in both generations; no cosine result ever assigns `duplicateOfId`.
- `convex/embeddingBackfill.ts` (public key-guarded action) + `convex/embeddingBackfillInternal.ts` (internal reads/write): direct `localEmbed` only (never the provider seam), bounded pages/concurrency/retry batches, skips rows with BGE, reports `scanned/embedded/skipped/failed/remaining/done/nextCursor/failedItemIds/costUsd` (cost always 0), explicit `retryItemIds` for failures (cursor never revisits them), dedicated `EMBEDDING_BACKFILL_KEY` (constant-time, not `AGENT_SERVICE_KEY`).
- `bench/embeddings/server/` (deploy-only, never bundled): `bge_gateway.py` (single-flight, auth, `/v1/embed` + `/health`), `test_gateway.py` (11 contract tests, model-free), `bge-gateway.service`, `Caddyfile.fragment`, `install.sh` (downloads the pinned snapshot onto the host; weights never in git).
- Env: `EMBEDDING_PROVIDER`, `EMBEDDING_READ_GENERATION`, `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_BACKFILL_KEY` in `SERVER_ENV_KEYS` + `.env.example`. Migration posture is `PROVIDER=local` + `READ_GENERATION=legacy` (new BGE writes, legacy reads — new items temporarily absent from legacy similarity, accepted for $0 spend); cutover sets `READ_GENERATION=bge` explicitly after backfill/shadow validation. `EMBEDDING_PROVIDER` has no default; `EMBEDDING_READ_GENERATION` defaults to legacy.

**Cutover (D&ndash;G, operator-run, in order):** deploy gateway additively (existing VPS services untouched) &rarr; health + live embed check &rarr; set env on the deployment &rarr; `runBackfill` pages until `done`, retry `failedItemIds`, verify `countMissingBge` is zero &rarr; shadow-compare BGE vs legacy neighbors &rarr; switch readers (already code-switched; do not serve until backfill is complete) &rarr; observe, then clean up legacy only afterwards. VPS deployment of the gateway remains an operator step; everything else was verified live below.

**Verification recorded (2026-10-04):** `corepack pnpm typecheck` clean; `corepack pnpm lint` 0 errors (2 pre-existing warnings in untouched `imageFetch.ts`/`shoppingImagesInternal.ts`); `node --test "tests/*.test.mjs"` 432 passed, 0 failed (includes new `tests/embedding-provider.test.mjs` 13/13 and updated `extraction-delivery`/`shopping-advice` expectations); `python bench/embeddings/server/test_gateway.py` 11/11 OK; `npx convex dev --once` pushed to the local test deployment.
**Live E2E (same day, local test deployment + gateway on pinned weights):** `/health` reports `BAAI/bge-small-en-v1.5 @ 5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`, 384 dims, CLS, L2-once, CPU; `/v1/embed` on a frozen corpus string returns 384 dims, norm 1.0, deterministic across calls, 401 on wrong key; the real `convex/ai/embedding.ts` `localEmbed` over HTTP returns `{dims: 384, costUsd: 0, deterministic: true}` with Convex-side validation OK; the real `embeddingBackfill:runBackfill` action on the deployment (empty wardrobe = no-item case) returns `{scanned: 0, embedded: 0, failed: 0, remaining: 0, done: true, costUsd: 0}`. One-item seeding needs a logged-in session on a dev deployment (operator step); the write path itself is covered by `extraction-delivery` tests through the real `setItemEmbeddingBge`.

**Files added/changed for Step 7 Phase C:** `convex/shared/embeddingText.ts`, `convex/ai/embedding.ts`, `convex/embeddingBackfill.ts`, `convex/embeddingBackfillInternal.ts`, `bench/embeddings/server/{bge_gateway.py,test_gateway.py,bge-gateway.service,Caddyfile.fragment,install.sh}` (new); `convex/ai/openai.ts`, `convex/ai/pipeline.ts`, `convex/model/items.ts`, `convex/model/shoppingAdvice.ts`, `convex/shoppingAdvice.ts`, `convex/schema.ts`, `convex/shared/credits.ts`, `convex/lib/env.ts`, `.env.example`, `tests/embedding-provider.test.mjs` (new), `tests/{extraction-delivery,shopping-advice}.test.mjs` (updated), `docs/COMBINED_ARCHITECTURE_AUDIT.md` (this section).
