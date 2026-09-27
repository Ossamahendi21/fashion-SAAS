# Fitcheck — Build Plan

AI wardrobe: photograph your clothes, get every item cut out and tagged into a digital wardrobe, build outfits, ask a stylist agent what to wear, and see yourself wearing it. Every image generation is metered in credits so the margin is protected by design. Everything slow runs in the background and every step is visible in the UI.

Working title: **Fitcheck**. Package name `fitcheck`.

---

## 1. Stack (pinned by `package.json`)

| Layer         | Choice                                                                                                                                      | Why                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| App           | Next.js 16 (App Router, `src/`, Turbopack), React 19, TypeScript strict                                                                     | Standard. Read `node_modules/next/dist/docs/` before using any Next API — this version differs from training data.                       |
| UI            | Tailwind v4 + shadcn/ui (`base-nova`, neutral), lucide icons, `motion/react`, `sonner`, `next-themes`                                       | Clean, modern, dark mode, no bespoke design system.                                                                                      |
| Auth + plans  | Clerk 7 (`@clerk/nextjs`, `@clerk/backend`), Clerk Billing (`<PricingTable />`, `has()`, `<Protect>`)                                       | Identity and subscription plans. Clerk Billing has **no metered billing**, so credits live in Convex.                                    |
| Data + jobs   | Convex 1.45 (DB, file storage, realtime queries, HTTP actions), `@convex-dev/workflow`                                                      | Durable pipelines with retries and reactive status; the progress UI is just a subscription.                                              |
| AI            | OpenAI SDK 7: `gpt-image-2` (extract cutouts, try-on renders), `gpt-5-mini` (vision detect + tag), `text-embedding-3-small` (search/dedupe) | Measured: extraction $0.031/item, render $0.029–0.033/image at `quality: medium`, 30–50 s each.                                          |
| Stylist agent | Vercel eve 0.56 (`withEve` in `next.config.ts`, `agent/` dir, `useEveAgent` from `eve/react`)                                               | Durable sessions, native approval gate on the one tool that spends credits, Clerk-verified channel auth. Docs: `node_modules/eve/docs/`. |
| Payments      | Clerk Billing for recurring user plans                                                           | Clerk owns subscriptions; Convex meters usage against the verified plan allowance.                                                                                                  |
| Env           | `@t3-oss/env-nextjs` + zod 4                                                                                                                | Typed, validated env on both sides.                                                                                                      |

Reference material for agents: `docs/reference/convex_*.md`, `docs/reference/convex_rules.txt`, `node_modules/eve/docs/`, `node_modules/next/dist/docs/`, and the installed `@clerk/*` package types (no vendored Clerk/eve skills).

---

## 2. Directory layout

```
agent/                      eve agent (stylist)
  agent.ts                  defineAgent({ model })
  instructions.md           always-on persona + rules
  channels/eve.ts           Clerk bearer auth + server-side session ownership; explicit local-dev opt-in
  tools/*.ts                one defineTool per file; filename = tool name (eve discovers tools from this folder; `defineAgent` has no tool list)
  skills/*.md               colour-pairing, dress-codes (loaded on demand)
  lib/convex.ts             service client for Convex (agent.* functions)
convex/
  schema.ts                 all tables (section 4)
  convex.config.ts          workflow component
  auth.config.ts            Clerk JWT issuer
  http.ts                   HTTP router; no custom payment routes
  shared/                   isomorphic constants + types (imported by src/ and agent/ too)
    credits.ts              CREDIT_COSTS, PLANS, LIMITS, pricing math
    wardrobe.ts             CATEGORIES, SLOTS, SEASONS, FORMALITY, PATTERNS…
    validators.ts           convex validators derived from shared enums
  lib/                      server-only helpers used by functions
    auth.ts                 requireUser(ctx), requireAdmin(ctx), requireServiceUser(ctx, { serviceKey, clerkUserId })
    errors.ts               appError(code, message) → ConvexError with a typed code
  model/                    business logic on ctx (no validators, no exports of Convex functions)
    users.ts credits.ts jobs.ts items.ts outfits.ts renders.ts avatars.ts threads.ts uploads.ts admin.ts stats.ts
  users.ts avatars.ts uploads.ts items.ts jobs.ts outfits.ts renders.ts credits.ts admin.ts agent.ts threads.ts
  subscriptions.ts         Clerk SDK reads; no Clerk webhook synchronization
  demoWardrobe.ts           authenticated adult demo-catalog seeding; no credit charge
  ai/openai.ts ai/prompts.ts ai/colours.ts ("use node" actions; embeddings live in openai.ts) ai/pipeline.ts (internal mutations/queries the workflows call)
  workflows/manager.ts workflows/ingest.ts workflows/render.ts
docs/reference/             vendored docs (read-only)
src/
  app/                      routes (section 3)
  components/ui/            shadcn (generated; do not hand-edit)
  components/common/        EmptyState, PageHeader, CreditBadge, CreditQuote, JobStepper, ItemImage, ItemTile, ConfirmDialog, LoadingGrid…
  components/layout/        AppShell, AppFrame, Topbar, global StylistPanel
  components/providers/     ClerkConvexProvider, ThemeProvider
  components/<feature>/     wardrobe/ upload/ outfits/ renders/ stylist/ billing/ settings/ admin/ onboarding/
  hooks/                    use-current-user, use-credits, use-active-jobs, use-items
  lib/                      env.ts, format.ts, routes.ts, utils.ts
  proxy.ts                  clerkMiddleware (Next 16 name for middleware)
```

Path aliases: `@/*` → `src/*`, `@convex/*` → `convex/*` (for `@convex/_generated/api` and `@convex/shared/*`).

---

## 3. Screens and flows

Every screen has: a loading state (skeleton matching the final layout), an empty state (`Empty` component with one primary action), an error state (toast + inline `Alert` where the user can retry), and works at phone width.

| Route                                 | Screen               | Key behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                   | Landing (public)     | Hero, three-step explainer, pricing summary, sign-in CTA. Redirect signed-in users to `/wardrobe`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/sign-in`, `/sign-up`                | Clerk                | Catch-all routes with a shared editorial Fitcheck shell, themed inline Clerk forms, desktop outfit imagery and a compact form-first mobile layout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/onboarding`                         | Avatar setup         | Upload photos within the plan limit (tips overlay), pick default, explicitly choose Men’s wardrobe or Women’s wardrobe, then fit prefs. Gate: `(app)` layout redirects here until `users.onboardedAt` is set.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/add`                                | Add clothes          | Dropzone (1–50 photos, jpg/png/webp; HEIC is rejected because gpt-image-2 does not accept it and browsers cannot transcode it — iPhones set to "Most compatible" upload JPEG). Each file becomes a free scan: Uploaded → Detecting → Choose pieces. Review the original photo and numbered candidates; only explicitly selected pieces are imported and charged. Pending review is grouped by photo on Add clothes and Wardrobe. Confirmation shows the selected credit cost before extraction → tagging → ready. Partial runs when credits run out with one-tap "Resume" when credits become available. Duplicates flagged, not merged. |
| `/wardrobe`                           | Wardrobe grid        | Transparent cutouts on soft cards. Filters: category, colour, season, formality; text search; sort newest / most worn / never worn. Bulk select → hide / delete / change category. Skeleton grid while loading.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/wardrobe/[itemId]`                  | Item detail          | Large cutout, editable attributes (form), colour swatches from pixels, wear history, "outfits with this", re-extract, hide, delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/outfits`                            | Outfits list         | Cards with item collage; worn dates; "New outfit".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/outfits/new`, `/outfits/[outfitId]` | Outfit builder       | Saved outfit: large selected render on the left with switchable thumbnails; always-visible compact garment grid and editing controls on the right. Processing states sit beside ready images. Slots: outerwear, top, bottom (or dress), shoes, accessories. Click a tile to change it; high-contrast remove controls appear on hover/focus and stay visible on touch. Save. "Render on me" sheet: avatar picker, count 1–4, standard/HQ (HQ gated by plan feature), live credit quote, confirm. Renders appear in place as each completes; regenerate single render; mark worn today.                                   |
| `/stylist`, `/stylist/[threadId]`     | Stylist chat (eve)   | Thread list + chat. Brief → outfit proposal cards (item collage + one-line reasoning) → approval card for renders with the credit cost on the button → renders stream into the thread. `ask_question` prompts render as option buttons. Resumes on reload.                                                                                                                                                                                                                                                                                                                                                              |
| `/lookbook`                           | Renders gallery      | All renders, filter by outfit, share/unshare, download, delete; dismiss failed renders after their request settles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/share/[token]`                      | Public render page   | No auth. Render + item strip + "made with Fitcheck". 404 when revoked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/billing`                            | Billing              | Clerk `<PricingTable />`, current plan, plan credits + non-expiring credits, renews-on date, ledger table (paginated). Low-balance nudge lives in the topbar `CreditBadge`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/settings`                           | Settings             | Avatars (add/remove/default), preferences, theme, delete all data (confirm dialog → purges storage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/admin`                              | Admin (role `admin`) | Today/7d/30d: credits sold vs credits spent, real COGS from render/extraction token usage, gross margin, active jobs, failed jobs with retry/refund, per-user top spenders, daily spend vs `MAX_DAILY_SPEND_USD`.                                                                                                                                                                                                                                                                                                                                                                                                       |

Global: horizontal responsive navigation and page-aware Ask stylist panel. Desktop panel occupies a 440px right rail while keeping the page interactive; mobile uses a full-screen dialog. Chat/draft persist across navigation and reset on account changes. Current owned page data, selected items, and unsaved outfit drafts are sent as optional untrusted per-turn context, never as authorization. The topbar shows `CreditBadge` (plan + non-expiring credits, tooltip breakdown, low-balance state at ≤10, click → billing); an "Activity" popover lists running jobs with progress; toasts on job completion/failure.

Avatar upload limits follow the plan: Free 1, Pro 2, Plus 5. Settings supports replacing an existing avatar in place, including the only Free avatar, while preserving its ID/default/onboarding state. Ownership and stored-image checks run on the server, and a pending render prevents replacing or deleting the photo it uses.

Before AI detection, extraction or try-on, stored photos are decoded with Sharp, oriented, converted to sRGB PNG and bounded to 2048px on the longest edge. This supports iPhone HDR JPEGs containing an auxiliary gain map without changing the original upload. Invalid, animated or over-50-megapixel inputs fail with an actionable message. Permanent render errors settle immediately; transient errors remain processing until retries finish. Retry and deletion wait for the original render batch to settle so refunds cannot be lost.

Onboarding requires an explicit men’s/women’s choice mapped to existing `prefs.presentation` masculine/feminine values. Legacy neutral profiles remain readable and are prompted to choose in Settings; examples do not guess. Add clothes uses matching adult examples and shows recent scans above decorative guidance.

The wardrobe's **Seed demo wardrobe** dialog requires a men's or women's catalog choice and adds eight adult garments/accessories. Switching catalogs replaces only previously seeded demo items, preserving uploaded clothes. `demoKey` plus the owner index makes repeated seeds idempotent; adding demo clothes never charges credits. Rendering them uses the normal meter.

---

## 4. Data model (Convex)

User-owned content carries `userId: Id<"users">`; global counters and aggregate tables do not. Timestamps are `number` (ms). Enums come from `convex/shared/*` so the client, the agent and the DB agree.

```
users         clerkId (idx by_clerkId), email?, name?, imageUrl?, role: "user"|"admin",
              plan: "free"|"pro"|"plus", planPeriodEnd?, billingCheckedAt?, features: string[],
              planCredits: number, packCredits: number,          // packCredits retains non-expiring welcome/legacy credits; expired plan credits excluded
              dailySpend: { dayKey: "YYYY-MM-DD", credits: number },
              defaultAvatarId?: Id<avatars>, onboardedAt?,
              prefs: { presentation: "masculine"|"feminine"|"neutral", fit: "slim"|"regular"|"relaxed",
                       avoidColours: string[], homeCity?: string },
              createdAt
avatars       userId (idx by_user), storageId, label, isDefault, createdAt
uploads       userId (idx by_user, by_user_status [userId,status]), batchId, storageId, fileName, mimeType, sizeBytes, jobId?,
              detectedCount?, candidates?: DetectedItem[], selectedIndices?: number[], selectionJobId?, selectionConfirmedAt?,
              status: "queued"|"detecting"|"awaiting_selection"|"extracting"|"done"|"failed"|"partial", createdAt
items         userId, uploadId?, demoKey?, storageId (cutout), thumbStorageId?, sourceBbox?: number[4],
              name, category, subcategory, colours: { primary, secondary: string[], hex: string[] },
              pattern, material, season: string[], formality, fit?, brand?, notes?,
              description (one sentence, used for embeddings + agent context), searchText,
              status: "extracting"|"ready"|"failed"|"hidden"|"needsCredits",
              wearCount, lastWornAt?, duplicateOfId?, pendingJobId? (re-extract in flight; item stays ready), usage?, costUsd?, createdAt, updatedAt
              idx by_user_status [userId,status], by_user_category [userId,category], by_user_demoKey [userId,demoKey], by_upload, by_createdAt
              searchIndex search_text { searchField: searchText, filterFields: [userId] }
itemEmbeddings itemId (idx by_item), userId, embedding: number[1536]      // apart from items so wardrobe reads stay small
              vectorIndex by_embedding { vectorField: embedding, dimensions: 1536, filterFields: [userId] }
outfits       userId (idx by_user), name, slots: { outerwear?, top?, bottom?, dress?, shoes?, accessories: Id[] },
              occasion?, brief?, reasoning?, source: "manual"|"agent", threadId?, savedAt? (listed in /outfits when set: creation for manual,
              "Save" for agent proposals), wornOn: number[], createdAt, updatedAt   idx by_user, by_user_savedAt, by_thread
renders       userId (idx by_user), outfitId (idx by_outfit), avatarId, jobId (idx by_job), storageId?,
              quality: "standard"|"hq", status: "pending"|"done"|"failed", prompt,
              usage?: { inputTextTokens, inputImageTokens, outputTokens }, costUsd?, creditsCharged,
              shareToken? (idx by_shareToken), error?, createdAt, completedAt?
jobs          userId, type: "ingest"|"render", status: "queued"|"running"|"done"|"partial"|"failed"|"cancelled",
              steps: [{ key, label, status: "pending"|"running"|"done"|"failed"|"skipped", startedAt?, finishedAt?, error?, meta? }],
              progress: number 0..1, reservation: { plan: number, pack: number }, refunds: { plan: number, pack: number },
              workflowId?, uploadId?, batchId? (all photo jobs of one upload batch), outfitIds?: Id[], resultIds: string[], error?, createdAt, updatedAt, completedAt?
              idx by_user_status [userId,status], by_user, by_workflowId
creditLedger  userId (idx by_user), delta, bucket: "plan"|"pack", kind: "plan_grant"|"plan_reset"|"signup_bonus"|
              "topup"|"reserve"|"refund"|"admin", jobId?, ref (idx by_ref, unique), note?, balanceAfter, createdAt
threads       userId (idx by_user), title, eveSessionId? (idx by_eveSessionId), sessionVerifiedAt?, streamIndex?, lastMessageAt, createdAt
proposals     threadId (idx by_thread), userId (idx by_user), outfitId, jobId?, createdAt
systemCounters dayKey, key: "credits_reserved"|"users_total", value            // kill switch + all-time counters
usageCounters  userId, dayKey, counter: "detect"|"stylist", count               // free-work rate limits
dailyStats     dayKey (idx by_day), creditsSold, creditsGranted, creditsSpent, creditsRefunded, revenueUsd, cogsUsd, rendersDone, itemsExtracted, jobsFailed, newUsers
stepStats      key (idx by_key), count, avgMs                                     // running average per step prefix for ETAs
```

Extraction/tagging vocab (`convex/shared/wardrobe.ts`): categories `top | bottom | outerwear | dress | shoes | accessory | bag | headwear`; slots map categories → builder slots; seasons `spring | summer | autumn | winter`; formality `casual | smart-casual | formal`.

---

## 5. Credits (the meter)

**Standard image generation costs one credit; HQ renders cost three.** Text-only work (detect, tag, embed, stylist reasoning, weather) is free and rate-limited. Adding the demo wardrobe costs no credits.

| Action                                | Credits | Our cost (measured)                       |
| ------------------------------------- | ------- | ----------------------------------------- |
| Detect + tag a photo                  | 0       | ≈ $0.002                                  |
| Extract one item                      | 1       | $0.031                                    |
| Render one image, standard (`medium`) | 1       | $0.029–0.033                              |
| Render one image, HQ (`high`)         | 3       | ≈ $0.09 (estimate; measure before launch) |

Plans (Clerk Billing slugs `free`, `pro`, `plus`) — from `convex/shared/credits.ts`. All paid checkout uses Clerk Billing; there are no one-off packs:

| Plan           | Price                  | Credits                  | Features                             |
| -------------- | ---------------------- | ------------------------ | ------------------------------------ |
| free           | $0                     | 25 once (`signup_bonus`) | wardrobe, builder, stylist, 1 avatar |
| pro            | $9.99/mo               | 150 / cycle              | `sharing`, 2 avatars                 |
| plus           | $19.99/mo              | 300 / cycle              | `sharing`, `hq_renders`, 5 avatars   |

Feature gates in the UI read Clerk SDK `has()`; backend transactions validate a recent Clerk Backend SDK subscription read. Clerk's plan features must mirror the supported `sharing` and `hq_renders` features. No plan currently receives queue priority.

`subscriptions.refresh` is authenticated and accepts no client-supplied plan information. It fetches `getUserBillingSubscription`, selects a current paid item, and passes the verified period/features to an internal atomic reconciliation. `billingCheckedAt` records the read's start time so a slower older response cannot overwrite a newer snapshot. Refresh happens at sign-in, on focus, after Clerk subscription changes, and before paid operations. The agent refreshes before quoting/approving and again before executing a render. SDK errors leave the existing accounting state unchanged.

Paid writes fail with `SUBSCRIPTION_REFRESH_REQUIRED` when the last SDK read is more than 60 seconds old or the period has expired. Read views hide expired features and plan credits. Free scanning needs no billing read. Selection confirmation refreshes the Clerk SDK snapshot before reserving for selected pieces; already-running legacy ingest also refreshes before reserving. No Clerk webhook endpoint, signing secret or subscription-event processing is required.

Ledger mechanics (`convex/model/credits.ts`, all inside mutations, atomic):

- Two buckets on the user: `planCredits` (reset to the allowance once per billing period, confirmed by a current Clerk Backend SDK subscription read — the grant ref is `clerk:plan:<clerkUserId>:<plan>:<periodStart>` so repeated refreshes never double-grant) and `packCredits` (the non-expiring welcome and legacy balance). The field and bucket names remain stable for existing records; no balance migration is needed. The 25 signup credits live in this bucket (ref `signup:<clerkId>`) so a plan reset can never wipe them. Spend current plan credits first, then non-expiring credits. Expired plan credits, including late refunds to an expired plan, are excluded from the spendable balance.
- **reserve(user, amount, jobId)** → takes `min(amount, balance, dailyRemaining)`; writes one `reserve` line per bucket touched; returns `{ granted, shortfall, reservation }`. Job stores `reservation`.
- **refund(job, amount)** → returns credits to the buckets in reverse order of consumption (non-expiring credits first, then plan), writes `refund` lines, updates `job.refunds`, and never exceeds the reservation.
- **grantPlan(user, plan, ref)** → sets `planCredits` to the allowance (writes `plan_reset` for the discarded remainder, then `plan_grant`). Idempotent by the period-based `ref`. The current SDK result decides the plan. SDK failures do not downgrade a user.
- Every ledger line has a unique `ref`; the `by_ref` lookup makes repeated period grants, reservations and refunds no-ops. Existing `topup` ledger entries remain readable for historical purchases; there is no new purchase or top-up endpoint.
- Guardrails (`LIMITS`): daily cap 150 credits/user, max 3 running units/user (a render job is one unit, a whole upload batch is one unit), max 4 renders per request, max 1500 wardrobe items, global `MAX_DAILY_SPEND_USD` kill switch checked in reserve, 200 detect calls/day, 100 stylist messages/day.
- Feature gates: `users.features` (derived from verified Clerk SDK reads for backend transactions) checked in the mutation **and** in the UI via `has({ feature })` / `<Protect>`. Quantities are always checked against the ledger.

Nothing outside `convex/model/credits.ts` touches `planCredits`, `packCredits` or `creditLedger`.

Content deletion preserves the account and ledger, including the signup-bonus reference. Bounded owner-indexed batches remove content and files; proposals are deleted through `by_user` independently of threads so previously orphaned rows are included. The internal account-purge mode additionally removes accounting data and the user. Clerk account deletion does not trigger an automatic purge because the app has no Clerk webhooks.

---

## 6. Background pipelines (Convex Workflow component)

Every long operation is a `jobs` row + a durable workflow. Steps write to `jobs.steps` through `model/jobs.setStep`, the browser subscribes to `jobs.get` / `jobs.listActive`, and the UI renders whatever the job says.

**Scan and selected import** (`workflows/ingest.ts`):

1. `uploads.createBatch` starts `scanUpload` per photo. `detectItems` performs free detection, then stores bounded `candidates` and marks the scan job done. Upload status is `awaiting_selection`; there are no wardrobe rows or credit reservations yet.
2. `uploads.needsReview` reads the current user's pending photos through `by_user_status`. The UI shows the original image with numbered candidate boxes and unchecked choices. Users may discard an unwanted photo.
3. `uploads.confirmSelection({uploadId,indices})` validates ownership and unique in-range indices, checks capacity, reserves only selected costs, creates only selected item rows and starts `extractItems` atomically. The same selection is idempotent; a changed second selection is rejected. A balance race may leave selected items `needsCredits`; unselected candidates never enter the wardrobe.
4. `extract:<n>` runs in chunks of at most four per photo; image extraction, colour detection, embeddings and duplicate checks retain the existing pipeline. Finalization settles failures, refunds unused reservations and updates the job/upload. Resume handles only the remaining selected items.

Existing `ingestUpload` and its detection handler are retained so already-running workflows can replay safely. New scans use separate completion callbacks; late scan callbacks cannot overwrite a confirmed import. Re-extract keeps the original ready item visible until a replacement succeeds.

**Render** (`workflows/render.ts`, one per request):

1. `reserve` — happens in `renders.start` mutation before the workflow starts (quote = count × cost × outfits). Rejects with `INSUFFICIENT_CREDITS` and the shortfall.
2. `render:<n>` (parallel) — `ai/openai.renderOutfit` with avatar + all garment cutouts as references, one prompt; store result; patch `renders` row with usage + `costUsd`.
3. `finalize` — refund failures, mark job.

Retries: actions `{ maxAttempts: 3, initialBackoffMs: 2000, base: 2 }`. Step keys are stable strings the UI maps to labels via `convex/shared/jobs.ts`.

The UI never blocks: `setStep` keeps a running average per step prefix in `stepStats`, and `jobs.stepEstimates` provides rounded historical duration guidance per image, piece, or photo. Progress shows actual ready/failed/skipped counts and queued, running, retrying, or terminal phases. It does not turn step weights into completion percentages or count down an estimated remaining time for parallel AI requests; only file uploads show measured byte percentages.

Convex's OpenAI client prefers `OPENAI_API_KEY`. If absent, it uses `AI_GATEWAY_API_KEY` with `https://ai-gateway.vercel.sh/v1` and `openai/` model IDs. This is configuration-based provider selection, not an automatic retry of failed direct requests through a second provider. Detection and image token costs update daily aggregates; historical price/latency measurements are estimates to recheck for production.

---

## 7. Stylist agent (eve)

- `agent/agent.ts`: `defineAgent({ model: "openai/gpt-5.4-mini" })` (AI Gateway string; `AI_GATEWAY_API_KEY` locally).
- `agent/channels/eve.ts` verifies the Clerk bearer token with `verifyToken` and adds a server ownership wrapper around the Eve session routes. Session creation requires an owned `x-fitcheck-thread-id`; the server binds the new Eve session and writes `threads.sessionVerifiedAt` before exposing the session ID. Existing session operations require the verified owner binding. Local development impersonation requires an explicit `AGENT_DEV_CLERK_USER_ID` and never accepts a rejected bearer token.
- Tools call Convex through `agent/lib/convex.ts`: `ConvexHttpClient` + `api.agent.*` functions that take `{ serviceKey, clerkUserId, ... }`, verified by `requireServiceUser` and scoped to that user. Approval is a gate, not authorization: executors re-derive the user from `ctx.session.auth.current` and require it to match the session initiator. `subscriptions.refreshForAgent` verifies service access before reading Clerk; pending approvals do not freeze paid entitlements.
- Tools: `get_wardrobe`, `get_weather` (Open-Meteo geocoding + forecast, no key), `compose_outfits` (validates ids, one per slot, writes `outfits` with `source: "agent"` + `proposals`), `quote_renders`, `start_renders` (`approval: always()`; policy denies with a reason when balance < quote; executor calls `api.agent.startRenders`), `save_outfit` (sets `outfits.savedAt` so the proposal is listed in `/outfits`), `gap_analysis` (category / season / formality / colour coverage and concrete gaps). Built-in sandbox/file tools are disabled for this agent.
- `agent/instructions.md`: stylist persona; only use wardrobe items; respect occasion/weather/prefs; explain briefly; propose before rendering; always quote before `start_renders`; use `ask_question` when a missing detail changes the answer.
- UI: `useEveAgent({ initialSession, resume: true, headers })`; messages rendered from `agent.data.messages`; tool parts render as outfit cards (`compose_outfits` output) and render-job cards (subscribe to `jobs.get` by `jobId`); pending `approval-requested` parts render the credit card and call `agent.respond`. Browser cursor updates require the same server-verified Eve session and cannot establish or reassign ownership.

---

## 8. Environment variables

`.env.example` documents all of these; `src/lib/env.ts` validates the Next side.

| Where                   | Name                                                                                                                                                                                                                                                                    | Purpose             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Next                    | `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT`                                                                                                                                                                                                                           | Convex client / CLI |
| Next                    | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`, `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/wardrobe`, `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/onboarding` | Clerk               |
| Convex dashboard        | `CLERK_JWT_ISSUER_DOMAIN`, `CLERK_SECRET_KEY`, `OPENAI_API_KEY` or `AI_GATEWAY_API_KEY`, `AGENT_SERVICE_KEY`, `SITE_URL`, `MAX_DAILY_SPEND_USD`                                                                           | server secrets      |
| eve (same `.env.local`) | `AI_GATEWAY_API_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CONVEX_URL`, `AGENT_SERVICE_KEY`                                                                                                                                                                                 | agent runtime       |

Clerk setup: JWT template named `convex` (Convex ↔ Clerk docs); Billing user plans `pro` and `plus` with features `sharing`, `hq_renders`. No Clerk webhooks. Subscription reads use the Clerk SDK, and `users.ensure` refreshes the signed-in profile. For admin provisioning, include `public_metadata: "{{user.public_metadata}}"` in the verified JWT and deliberately set `publicMetadata.role` to `admin` for the intended account. Missing, malformed or unknown roles become `user`; admin functions verify the current claim as well as the stored role. All subscription checkout uses Clerk Billing; no standalone payment endpoints or webhook secrets are required. Convex `SITE_URL` points to the app origin so demo wardrobe seeding can fetch its garment images.

---

## 9. Build phases and ownership

| Phase           | Owner   | Output                                                                                                                               |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0 Scaffold      | lead    | Next app, shadcn, deps, vendored docs, this plan, `AGENTS.md`                                                                        |
| 1 Foundation    | lead    | schema, config, shared constants, `lib/auth`, `model/credits`, `model/jobs`, providers, app shell, common components, env, proxy     |
| 2a Backend data | agent A | `model/*` (rest), `users/avatars/uploads/items/jobs/outfits/renders/credits/subscriptions/admin/threads/agent.ts`, `http.ts` |
| 2b Pipelines    | agent B | `ai/*`, `workflows/*`                                                                                                                |
| 2c Frontend I   | agent C | onboarding, add-clothes stepper UI, wardrobe grid + item detail                                                                      |
| 2d Frontend II  | agent D | outfit builder, render sheet, outfits, lookbook, share page                                                                          |
| 2e Frontend III | agent E | billing, settings, admin, landing page                                                                                               |
| 2f Stylist      | agent F | `agent/*`, `next.config.ts` withEve, stylist routes + components                                                                     |
| 3 Integration   | lead    | codegen, `tsc`, `eslint`, `next build`, review, fixes                                                                                |
| 4 Sync          | lead    | commit to the Mac folder, install deps, README                                                                                       |

Agents in phase 2 own disjoint files. Anything shared they need (a new common component, a new shared constant) goes in their own feature folder unless it clearly belongs in `common/` or `shared/`, in which case they add it and note it in their final report so the lead can dedupe.

---

## 10. Verification checklist

- `pnpm typecheck` (root `tsc --noEmit` incl. `convex/`), `pnpm lint`, `pnpm build` pass.
- `npx convex codegen` regenerates `convex/_generated` cleanly. A login-free local deployment comes from `CONVEX_AGENT_MODE=anonymous npx convex dev`.
- Every route renders a loading skeleton, an empty state and an error state.
- No component reads `planCredits`/`packCredits` except through `credits.balance`; no function outside `model/credits.ts` writes the ledger.
- Every Convex function has argument validators and checks `requireUser`/`requireAdmin`/`requireServiceKey`.
- Clerk SDK reconciliation is idempotent by billing period and ignores stale overlapping reads. Existing non-expiring credits and historical ledger entries remain intact.
- Approval-gated tool is the only path to `renders.start` from the agent.
- Secrets never reach the client bundle (`NEXT_PUBLIC_` only for URLs and publishable keys).

### Recorded local evidence

The local Convex deployment passed 26 deterministic backend checks and three additional verified-identity mapping checks on 2026-09-16. Backend TypeScript, focused lint and formatting also passed. Run `dev/smoke:runRegressions` on a scratch deployment to repeat the backend checks. These results do not certify real paid Clerk transactions, production deployment, or completed browser/AI workflows; record those separately after observing their results.

### Public landing page presentation

The public `/` page uses a fashion editorial hero, layered scroll parallax, a native sticky Scan / Style / Try-on story, an interactive style study, truthful credit costs, pricing, FAQ and a large signup footer. This user-requested landing motion is an exception to the signed-in app's short layout-only transitions. Mobile and reduced-motion layouts remain static, stacked and accessible. Assets show fictional adults, not user avatars.

Authenticated visits to `/` still redirect to `/wardrobe`. In development only, `/?preview=landing` allows the landing page to be reviewed while signed in; production ignores that preview flag. No new public route, data model or backend operation is added.
