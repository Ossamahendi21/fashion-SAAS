# Live Mirror — Secure Path End-to-End Test Matrix

> **Step 2E3 status: the legacy browser-key path described below is REMOVED.** There is no
> browser-stored Decart credential, no background `token`/`status`/`test-key` handler, no Fast
> Mode, and no unconfigured-auth fallback. Every "no legacy fallback" expectation below is now
> unconditional: the code paths no longer exist. The Fast Mode cost blocker (§Fast Mode) is
> resolved by removal. Residual risk #5 is resolved the same way.

Covers Step 2D: proving the secure Live Mirror path behaves correctly across account, entitlement,
billing, provider and session states. Step 2E3 deleted the legacy browser-key mode outright, so
the "only reachable when auth is not configured" qualifier no longer applies to anything.

Companion documents:
- `docs/COMBINED_ARCHITECTURE_AUDIT.md` — current OpenWear Live Mirror architecture.
- `docs/EXTENSION_AUTH_AUDIT.md` — auth properties and the required secure-path matrix.

## What the secure path guarantees

| # | Property | Where it is enforced | Test |
|---|---|---|---|
| 1 | No legacy credential path at all (Step 2E3: fallback deleted, not just gated) | `resolveLiveMirrorSession()` takes no key input and knows no `legacyToken` | `A`, `B`, `C`, `E`, `8` |
| 2 | No client-supplied identity, plan, model, duration or key | `AuthorizeLiveMirror` action is typed `Record<string, never>`; called as `deps.authorize({})` | `D`, `8` |
| 3 | Server session cap is authoritative | `effectiveSessionSeconds()` is a hard `min` | `5` |
| 4 | No cached authorization across sessions or account changes | `createLiveMirrorAuthorizer()` clears `inFlight` on settle | `4`, `F` |
| 5 | Only server decisions are surfaced, with extension-authored copy | `toLiveMirrorFailure()` maps `error.data.code` to a fixed message | `error contract` |
| 6 | Concurrent starts mint one token | `createLiveMirrorAuthorizer()` single-flight guard | `G` |
| 7 | No permanent server secret in the extension | Server-only key reads in `convex/liveMirror/decart.ts` | `8` |
| 8 | Legacy browser-key mode REMOVED (Step 2E3): no key storage, no background minting | deleted `token`/`status`/`test-key` handlers; `no-legacy-credentials.test.mjs` | — |

Automated coverage: `extension/tests/live-mirror-secure.test.mjs` (35 tests) and
`extension/tests/live-mirror.test.mjs` (25 tests).

The tests build errors with the **installed Convex client class** and attach `.data` the way both
real transports do (`forwardData` on the WebSocket path, `forwardErrorData` on the HTTP fallback), so
the error contract is exercised against the real shape rather than a hand-rolled fake. **No test
contacts Clerk, Convex or Decart.**

## Error contract

`convex/lib/errors.ts` throws `ConvexError<AppErrorData>`, so the extension reads `error.data.code`:

| Server `code` | `LiveMirrorFailure` | Message shown | Offered action |
|---|---|---|---|
| `UNAUTHENTICATED` | `UNAUTHENTICATED` | Sign in to Fitcheck to use Live Mirror. | **Sign in on Fitcheck** |
| `FEATURE_LOCKED` | `FEATURE_LOCKED` | Live Mirror is available on a paid plan. | none (retry cannot help) |
| `SUBSCRIPTION_REFRESH_REQUIRED` | `SUBSCRIPTION_REFRESH_REQUIRED` | Refresh your subscription to use Live Mirror. | none (the refresh is a side effect) |
| `UPSTREAM_FAILED` | `UPSTREAM_FAILED` | Live Mirror is temporarily unavailable. Please try again. | **Start again** |
| any other code | `UNKNOWN` | Live Mirror couldn't start. Please try again. | **Start again** |
| transport / malformed payload | `UNKNOWN` | Live Mirror couldn't start. Please try again. | **Start again** |

Server messages, Convex hybrid stack traces and Decart response bodies are never rendered: the
mapping reads only `error.data.code` and returns copy authored in the extension. The former
`NO_KEY` / `KEY_REJECTED` key flows were deleted with the legacy path in Step 2E3.

## Manual matrix

Steps 1–3 must pass before the rest. Set the extension's Clerk publishable key to your **dev** project
so the Convex dev deployment is used.

### 1. Signed out, auth configured
- Open the room with no Clerk session.
- **Expected:** a sign-in prompt; **Enable camera** is not the primary affordance; no webcam
  permission prompt; zero requests to the Decart token endpoint; no network request carrying a Decart key.
- Also: drop a garment while signed out. **Expected:** the camera must **not** open — the room
  returns a sign-in notice before `getUserMedia` is called.

### 2. Free plan
- Sign in with a Clerk user on the free plan.
- Enable the camera and enter Live Mirror.
- **Expected:** `Live Mirror is available on a paid plan.` with **no** retry button. No Decart
  credential exists anywhere in the browser: no `chrome.storage` key, no background minting.

### 3. Paid plan, fresh billing
- Subscribe via Stripe, wait for the webhook, and confirm the subscription shows in the Billing tab.
- Enable Live Mirror.
- **Expected:** Decart connects; DevTools Network shows the Convex `authorizeLiveMirror` action call
  with an **empty** argument object `{}`; the Decart client is constructed with a short-lived token
  (not `sk_…`). The camera stops at the server-issued session length.

### 4. Stale billing
- Set `billingCheckedAt` back, or stop the Stripe webhook, so `assertFreshBilling` throws.
- Attempt Live Mirror.
- **Expected:** the refresh-your-subscription notice, no retry button. After
  `subscriptions.refresh` completes, the next attempt succeeds.

### 5. Decart provider failure
- Block `api.decart.ai` in DevTools → Network request blocking, or point the dev env at a bad host.
- Attempt Live Mirror.
- **Expected:** the temporary-unavailability notice with a working **Start again**. The UI shows no
  raw provider error. Removing the block makes the next attempt succeed.

### 6. Server cap
- With the server grant set to 15s and the local session preference at 300s: **expected** ~15s.
- With the server grant at 300s and the local preference at 60s: **expected** ~60s.
- Set the local preference to 86400s with a 15s server grant: **expected** ~15s.
- The local setting must never lengthen a session beyond what the server authorized.

### 7. Account switch
- Start a session as a paid user, then sign in as a free user (same browser).
- **Expected:** the next Live Mirror attempt is denied as a free user.
- Reverse the order (free → paid): **Expected:** the next attempt authorizes for the paid principal.
- DevTools must show a fresh `authorizeLiveMirror` call per attempt — no cached grant is replayed.

### 8. Logout mid-session
- Start a paid session, click Stop, then sign out of Clerk.
- Start a new Live Mirror session.
- **Expected:** signed-out notice with sign-in. Stored legacy credentials, if any survive from
  before Step 2E3, are cleaned from storage on load and never read.

### 9. Duplicate start
- Double-click **Enable camera** (or trigger garment auto-start twice).
- **Expected:** one `authorizeLiveMirror` call, one Decart client, one camera stream. No second
  permission prompt and no `NotReadableError` from opening the webcam twice.

### 10. Second session token freshness
- Complete two Live Mirror sessions in sequence in the same room window.
- **Expected:** two `authorizeLiveMirror` calls returning two different tokens. The second session must
  never reuse the first session's settled token. Repeat after a **failed** attempt (e.g. case 5) —
  the next attempt must issue a new authorization rather than replaying the failure.

## Fast Mode — REMOVED in Step 2E3 (was: behaviour and cost risk)

Fast Mode was a **local client-side preference** (`fastMode`, persisted in extension settings)
passed to the Decart SDK as a realtime speed hint. Step 2E3 deleted it completely — settings
field, SDK `speed` option, and all references — resolving the operator-cost blocker below by
removal rather than by decision. The historical analysis is kept for context:

- It was **not** a business rule, so it introduced no plan gate and no metering.
- It was **not** part of the authorization call.
- It **could materially increase Decart provider cost**, borne by the operator.

**Blocker (RESOLVED):** the release blocker for removing the legacy key path is closed: both the
legacy key path and Fast Mode are deleted. There is no longer a decision to make.

## Residual risks and accepted limitations

1. **In-flight race on account switch.** If the user changes Clerk account while an
   `authorizeLiveMirror` call is in flight, that single in-flight call completes against the previous
   principal's token. The authorizer holds no settled token, so the *next* session always
   re-authorizes. This matches `docs/EXTENSION_AUTH_AUDIT.md` §10 ("no stale-user window beyond one
   in-flight call") and is accepted; closing it would require a generation counter keyed to
   `authStatus` and is out of scope for Step 2D.
2. **Transport-level auth errors are unstructured.** If a JWT is rejected by the transport before the
   action handler runs, the thrown error may carry no `data.code` and maps to `UNKNOWN` generic copy
   rather than `UNAUTHENTICATED`. This fails closed and leaks nothing, but a user may see "couldn't
   start" where "sign in" would be more accurate. Case 1 and 8 cover the realistic paths.
3. **Model pinning.** `parseAuthorization()` accepts whatever model string the server returns and
   resolves it through the SDK catalogue, failing closed on an unknown model. The server is the trust
   boundary and the token's `allowedModels` is enforced by Decart, so the client is not the
   enforcement point. Pinning the model client-side was deliberately not added, to avoid a second
   source of truth that can drift from the server.
4. **`expiresIn` is not used for the session timer.** The grant's 60s token expiry is consumed when
   the realtime connection is established; the room's session timer is bounded by the server's
   `sessionSeconds` instead. This is correct, but worth remembering when reasoning about token
   lifetime.
5. **RESOLVED in Step 2E3.** `background("status")`, the `hasKey` gate, and the key-status
   handler it called are all deleted. There is no legacy path left to keep intact.
6. **Nested `ctx.runQuery()` error propagation is verified statically, not against a live
   deployment.** The Convex client SDK sources confirm `errorData` is forwarded as `.data` on both the
   sync and HTTP transports; confirming it end-to-end requires a deployed Convex dev environment, which
   the manual matrix above provides.
7. **Third-party bundle literals.** The production room chunk contains `DECART_API_KEY` and `sk_test_`
   strings. These are **vendored Decart/Clerk SDK literals**, not secret values, and must not be
   treated as a leak. The authored-source guards in the test suite are the real check.

## Development-only diagnostics

No production backdoors, debug flags or plan overrides were added. If a manual case needs to be
isolated, use the sequence in this document plus the dev-only Clerk/Convex project configuration
rather than changing code.
