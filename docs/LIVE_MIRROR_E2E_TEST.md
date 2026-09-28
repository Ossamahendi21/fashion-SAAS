# Live Mirror — Secure Path End-to-End Test Matrix

Covers Step 2D: proving the secure Live Mirror path behaves correctly across account, entitlement,
billing, provider and session states, and that the legacy browser-key path is only reachable when
auth is not configured.

Companion documents:
- `docs/COMBINED_ARCHITECTURE_AUDIT.md` — current OpenWear Live Mirror architecture.
- `docs/EXTENSION_AUTH_AUDIT.md` — auth properties and the required secure-path matrix.

## What the secure path guarantees

| # | Property | Where it is enforced | Test |
|---|---|---|---|
| 1 | No legacy fallback once auth is configured | `resolveLiveMirrorSession()` branches on `authEnabled` before any key lookup | `A`, `B`, `C`, `E`, `8` |
| 2 | No client-supplied identity, plan, model, duration or key | `AuthorizeLiveMirror` action is typed `Record<string, never>`; called as `deps.authorize({})` | `D`, `8` |
| 3 | Server session cap is authoritative | `effectiveSessionSeconds()` is a hard `min` | `5` |
| 4 | No cached authorization across sessions or account changes | `createLiveMirrorAuthorizer()` clears `inFlight` on settle | `4`, `F` |
| 5 | Only server decisions are surfaced, with extension-authored copy | `toLiveMirrorFailure()` maps `error.data.code` to a fixed message | `error contract` |
| 6 | Concurrent starts mint one token | `createLiveMirrorAuthorizer()` single-flight guard | `G` |
| 7 | No permanent server secret in the extension | Server-only key reads in `convex/liveMirror/decart.ts` | `8` |
| 8 | Legacy path unchanged when auth is unconfigured | `authEnabled === false` branch | `legacy` |

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
mapping reads only `error.data.code` and returns copy authored in the extension. Legacy `NO_KEY` /
`KEY_REJECTED` string handling is unchanged and still owned by the background worker.

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
- **Expected:** `Live Mirror is available on a paid plan.` with **no** retry button. `browser.storage`
  must not gain a `decartApiKey` entry, and the background `token` handler must not be called.

### 3. Paid plan, fresh billing
- Subscribe via Stripe, wait for the webhook, and confirm the subscription shows in the Billing tab.
- Enable Live Mirror.
- **Expected:** Decart connects; DevTools Network shows the Convex `authorizeLiveMirror` action call
  with an **empty** argument object `{}`; the Decart client is constructed with a short-lived token
  (not `sk_…`). The camera stops at the server-issued session length.

### 4. Stale billing
- Set `billingCheckedAt` back, or stop the Stripe webhook, so `assertFreshBilling` throws.
- Attempt Live Mirror.
- **Expected:** the refresh-your-subscription notice, no retry button, no legacy fallback. After
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
- **Expected:** signed-out notice with sign-in. No legacy fallback even though the browser may still
  hold a previously configured key.

### 9. Duplicate start
- Double-click **Enable camera** (or trigger garment auto-start twice).
- **Expected:** one `authorizeLiveMirror` call, one Decart client, one camera stream. No second
  permission prompt and no `NotReadableError` from opening the webcam twice.

### 10. Second session token freshness
- Complete two Live Mirror sessions in sequence in the same room window.
- **Expected:** two `authorizeLiveMirror` calls returning two different tokens. The second session must
  never reuse the first session's settled token. Repeat after a **failed** attempt (e.g. case 5) —
  the next attempt must issue a new authorization rather than replaying the failure.

## Fast Mode — behaviour and cost risk

Fast Mode is a **local client-side preference** (`fastMode`, persisted in extension settings) passed
to the Decart SDK as a realtime speed hint. It is deliberately unchanged in Step 2D:

- It is **not** a business rule, so it introduces no plan gate and no metering.
- It is **not** part of the authorization call, so the server cannot currently see or deny it, and
  enabling it cannot lengthen the server-authorized session length (test `6`).
- Fast Mode **may materially increase Decart provider cost**, and because the flag is local, that
  cost is currently borne by the operator rather than the user.

**Blocker:** treat client-side Fast Mode as a release blocker for **removing the legacy key path and
shipping to production**. Decide explicitly before that work:

1. keep Fast Mode as an unlimited client-side speed hint (accepting unbounded operator cost), or
2. make the server aware of it — include it in the authorization decision and have the server grant,
   deny, or meter it.

Do not ship the secure path to production or delete the legacy key path until this is decided. The
current recommendation is to document the risk and defer the decision; the default remains enabled
to preserve existing behaviour for users.

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
5. **`background("status")` is still called on the secure path.** It returns only a boolean
   (`hasKey`) used by the legacy gate and the settings copy. It is not a secret and was left in place
   to keep the legacy path intact.
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
