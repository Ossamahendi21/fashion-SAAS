# Extension Auth Audit — OpenWear MV3 ↔ Fitcheck (Clerk 7 + Convex)

Status: **AUDIT ONLY. Nothing implemented, installed, or configured by this document.**
Constraint: do not wire `authorizeLiveMirror` yet; do not remove the browser-stored Decart key yet.

## 0. Verified-from-code facts (not recollection)

These were read from the installed packages and repo sources listed at the end, and everything
below follows from them:

- `convex/auth.config.ts`: one provider, `domain: process.env.CLERK_JWT_ISSUER_DOMAIN`,
  `applicationID: "convex"`. Convex accepts a JWT only if it validates against this issuer
  with this application ID.
- `src/lib/auth.ts:21`: the web app already mints `session.getToken({ template: "convex" })`
  for server calls. The **"convex" JWT template already exists** in the Clerk dashboard.
- `convex/src/react-clerk/ConvexProviderWithClerk.tsx` (installed Convex 1.46.0): accepts
  `useAuth` from "`@clerk/react`, `@clerk/clerk-expo`, `@clerk/nextjs` **or another React-based
  Clerk client library**", and calls `getToken({ template: "convex", skipCache })` unless the
  session already uses the Convex integration (`sessionClaims.aud === "convex"`).
- `convex/src/browser/sync/authentication_manager.ts` (installed): `AuthTokenFetcher =
  (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>`. The Convex
  client accepts **any function that returns a JWT string**. It does not care which client
  minted it.
- `convex/liveMirror.ts`: `authorizeLiveMirror` takes **no arguments** and derives identity
  solely from `ctx.auth.getUserIdentity()` (`identity.subject` → Clerk user id).
- Installed Clerk: `@clerk/nextjs 7.9.7`, `@clerk/backend 3.18.1`, `@clerk/react 6.17.2`,
  `@clerk/shared 4.36.0`. **`@clerk/chrome-extension` is NOT installed** and no
  `launchWebAuthFlow` / `chrome.identity` / extension-specific support exists anywhere in the
  installed Clerk or Convex packages (verified by search).
- `extension/package.json` manifest: permissions are only `storage` and `scripting`
  (**no `identity`**); `externally_connectable` allows only `http://localhost/*` (dev-reload);
  CSP is `script-src 'self' 'wasm-unsafe-eval'` (remote scripts are forbidden — any Clerk
  library must be **bundled**, never loaded from a CDN).
- Extension holds the permanent Decart key in `chrome.storage.local` (`extension/lib/settings.ts`);
  only `background.ts` reads it. There is no Clerk code and no Convex client in the extension.

## 1. Existing Fitcheck auth architecture

- **Identity provider:** Clerk 7. `ClerkProvider` (`src/components/providers/app-providers.tsx`)
  is initialized with the public `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (safe to ship; `src/lib/env.ts`
  exposes it as client env, while `CLERK_SECRET_KEY` is server-only).
- **Web → Convex binding:** `ConvexProviderWithClerk client={convex} useAuth={useAuth}`
  (`convex/react-clerk`). On every Convex call the client fetches a `template: "convex"` JWT
  from the Clerk session and sends it on the Convex transport. Refresh is automatic:
  `forceRefreshToken` maps to `skipCache`, and a session change re-triggers `setAuth`.
- **Backend verification:** Convex validates the JWT against `CLERK_JWT_ISSUER_DOMAIN` /
  `applicationID "convex"`. `requireUser` (`convex/lib/auth.ts`) maps `identity.subject`
  (the Clerk user id) to the `users` row via the `by_clerkId` index; `requireServiceUser`
  is a separate shared-secret path for the stylist agent and is **not** usable from a browser.
- **Provisioning:** `StoreUser` (`src/components/providers/store-user.tsx`) calls
  `users.ensure` + `subscriptions.refresh` after Convex authenticates the session, so the
  `users` row and billing snapshot exist before paid gates run.
- **`authorizeLiveMirror`:** no args → `getUserIdentity()` → `checkEntitlement(clerkId)` →
  `assertFreshBilling` + `hasCurrentPlan` → short-lived Decart token. It is transport-agnostic:
  any Convex client presenting a valid "convex"-template JWT for a paid, fresh-billing user
  succeeds. **No backend change is needed for any extension approach that can present such a JWT.**

## 2. Extension constraints

- Chrome MV3 via Plasmo 0.90.5, React 18, TypeScript. Three execution contexts: service worker
  (`background.ts`), content script on every site (`content.tsx`), extension pages
  (`popup.tsx`, `options.tsx`, `tabs/room.html`).
- Runs on origin `chrome-extension://<id>`. This origin **cannot read or share the SaaS
  domain's cookies** (Clerk's session cookies are HTTP-only and bound to the Clerk Frontend
  API domain). Consequence: the extension **cannot silently reuse the web session**; it must
  establish its own Clerk session for the same user.
- Login UI cannot live in the service worker (ephemeral, no DOM). It must live in an
  extension page (popup, options, or room tab).
- CSP forbids remote scripts, so Clerk code must be an npm dependency bundled by
  esbuild/Plasmo — the same way `@decartai/sdk` is vendored today.
- Current permissions (`storage`, `scripting`) do not cover `chrome.identity`, and
  `externally_connectable` does not cover the production SaaS origin. Both gaps matter
  per-approach below (documented, not changed).

## 3. Viable Clerk auth approaches

### Option A — Official Clerk Chrome-extension session (RECOMMENDED)

- **Exact package (to be added at implementation):** `@clerk/chrome-extension`
  (Clerk's first-party extension package; **not installed — API/version must be confirmed
  against Clerk's current docs when implemented**).
- **Where login occurs:** inside an extension page. The package drives the OAuth flow through
  `chrome.identity.launchWebAuthFlow` against the Clerk accounts URL and returns to the
  extension redirect URI. The user signs in with the same Clerk account as on the web.
- **Where session state lives:** the extension's own storage (`chrome.storage`, managed by
  the package), isolated from the web session. Same user, separate session — like signing
  in on two browsers.
- **How the extension obtains the JWT:** the package's `useAuth().getToken({ template:
  "convex" })` — the identical call the web app and `ConvexProviderWithClerk` already make.
- **Direct to Convex:** yes. `ConvexProviderWithClerk client={convex} useAuth={useAuth}`
  accepts "another React-based Clerk client library" (verified contract above), so the
  extension mounts the same provider pair as `app-providers.tsx` and calls
  `authorizeLiveMirror` unchanged. Alternatively `client.setAuth(fetcher)` with a two-line
  fetcher around `getToken`.
- **`chrome.identity` required:** yes (manifest `permissions` addition).
- **OAuth redirect URI required:** yes — the `https://<extension-id>.chromiumapp.org/` (or
  `chrome-extension://<id>`) return URL must be allowlisted in the Clerk dashboard
  (exact field name to confirm in the dashboard at implementation time).
- **Additional extension permissions:** `identity` only. No new host permissions: the
  existing `https://*/*` already covers the Clerk accounts domain and the Convex cloud URL.
- **Logout/account-switch:** native — `signOut()` clears the extension session and the
  Convex client drops auth (`clearAuth()` / `isAuthenticated false`); Clerk's account
  switcher changes `sessionId`, which `ConvexProviderWithClerk` already watches to
  re-fetch tokens. Web and extension sessions are independent (signing out of one does not
  sign out of the other — document this in UX copy).
- **Token refresh:** handled by the Clerk client (`skipCache` on `forceRefreshToken`);
  Convex retries once with refresh on rejection (verified in `authentication_manager.ts`).
- **Security risks:** low and standard — short-lived bearer JWTs in extension storage
  (readable only with local-machine compromise or a malicious extension update, same as
  any stored session); OAuth flow is first-party (no credential ever touches extension code).
- **Chrome Web Store implications:** `identity` is a standard, low-friction permission, but
  the listing's privacy disclosure must state authentication via Clerk. The pre-existing
  broad `https://*/*` + `http://*/*` host permissions remain the larger review surface and
  are out of scope here.
- **Secrets shipped:** none. Only the publishable key (`pk_*`) and the Convex URL ship —
  both are public by design (already in the web bundle).
- **Backend unchanged:** yes — `ctx.auth.getUserIdentity()` validates the JWT identically
  regardless of which client sent it.

### Option B — Web-to-extension linking flow (viable fallback, custom-built)

- **Mechanism:** signed-in user opens a "Connect extension" page on the SaaS; that page (already
  authenticated via `@clerk/nextjs`) mints `getToken({ template: "convex" })` and hands it to
  the extension through `chrome.runtime.sendMessage` from the web page.
- **Where login occurs:** the SaaS website only; the extension never shows login UI.
- **Where session state lives:** the freshly minted JWT in `chrome.storage.local`, used via
  `client.setAuth(() => storedJwt)`.
- **Direct to Convex:** yes, while the JWT is valid — but JWTs are short-lived by design, and
  the extension has **no refresh path** without returning to the SaaS page. Practical
  consequence: linking must be repeated (or the room must deep-link back to it) every time
  the token lapses. This is the approach's defining weakness versus A.
- **`chrome.identity` required:** no.
- **Redirect URI required:** no. But **manifest change required:** the SaaS origin must be
  added to `externally_connectable.matches` (currently localhost-only), plus strict
  `sender.origin` validation in the message listener.
- **Additional permissions:** none beyond the manifest sender-allowlist edit.
- **Logout/account-switch:** manual — the extension must expose "Disconnect" (delete the
  stored JWT + `clearAuth()`); web logout does not propagate; account switch requires
  re-linking from the newly signed-in account.
- **Token refresh:** none built-in; re-link on expiry.
- **Security risks:** medium — a bearer JWT crosses the web-page → extension boundary, so a
  compromised SaaS page (XSS) or a spoofed sender origin could leak or inject tokens;
  origin validation and single-use handoff are mandatory. Short lifetime bounds replay.
- **CWS implications:** no new permissions; the `externally_connectable` addition is declarative.
- **Secrets shipped:** none (same public values as A).
- **Backend unchanged:** yes.

### Option C — Custom `useAuth` adapter over a self-managed session (mechanism, not a source)

- `ConvexProviderWithClerk` accepts any object matching its `UseAuth` shape, and `setAuth`
  accepts any `AuthTokenFetcher`. So once a session exists (via A or B), a minimal adapter
  is trivial. This is **not** a third way to log in — session establishment still requires
  A or B. Documented here only to prevent reinventing token plumbing: reuse
  `ConvexProviderWithClerk`, do not hand-roll Convex auth headers.

## 4. Rejected / insecure approaches

- **`AGENT_SERVICE_KEY` in extension code:** the key is a server-to-server secret and the
  `requireServiceUser` path lets the caller *name any user*. Shipping it makes every install
  able to impersonate any user. Never.
- **`CLERK_SECRET_KEY` or `DECART_API_KEY` in extension code:** shipped bundles are public;
  either key would be extractable in minutes. Never.
- **Client-supplied `userId`/`clerkUserId` as proof of identity:** self-asserted and
  spoofable. The backend deliberately ignores client identity claims (`identity.subject`
  only). Would require weakening the backend — rejected.
- **Permanent custom shared token (static bearer):** no expiry, no rotation, no revocation
  story; equivalent to a password every install shares. Rejected in favor of short-lived
  Clerk JWTs with native refresh (A).
- **Reading Clerk session cookies from the SaaS/Clerk domain:** requires `cookies` plus
  host permissions for the Clerk domain; the session cookies are HTTP-only and therefore
  unreadable by design; manual cookie handling is fragile and a CWS red flag. Rejected
  unless an official Clerk integration explicitly requires it (none in the installed
  packages does).
- **Embedding the SaaS session in an extension webview/iframe:** inherits the site's XSS
  surface inside the extension's privilege boundary and breaks storage partitioning
  expectations. Rejected.

## 5. Recommended architecture

**Option A: first-party Clerk session inside the extension (`@clerk/chrome-extension`),
Convex client authenticated via its `useAuth`, `authorizeLiveMirror` called unchanged.**

Why: it is the only approach where login, session storage, refresh, logout, and account
switch are all owned by Clerk's own code; it ships zero secrets; it satisfies the installed
`ConvexProviderWithClerk` contract verbatim; and it leaves the backend (including all
billing gates and the no-args action) untouched. Token lifetime and refresh are Clerk's
problem, not ours. Option B remains a documented fallback if the extension package proves
unsuitable at implementation time, at the cost of manual re-linking and a weaker refresh
story.

Target steady state: the room tab (`tabs/room.html`) hosts `ClerkProvider` +
`ConvexProviderWithClerk`, calls `authorizeLiveMirror` directly, and receives the
short-lived Decart token exactly as today — except minted server-side. The background
worker's `token`/`test-key` handlers and the `chrome.storage.local` Decart key are removed
only after the tests in §13 pass. The background keeps its image-download role (unchanged).

## 6. Exact token flow (recommended)

```
1. User opens extension auth UI (options page or room tab, NOT the service worker).
2. @clerk/chrome-extension starts OAuth via chrome.identity.launchWebAuthFlow
   → Clerk accounts URL → user signs in (same Clerk account as the SaaS).
3. Clerk returns to the allowlisted extension redirect URI; the package persists the
   session in chrome.storage (isolated from the web session).
4. Extension mounts ConvexProviderWithClerk(client, useAuth from the extension package).
5. On each Convex call, the client invokes getToken({ template: "convex", skipCache }).
6. Clerk mints a short-lived JWT (issuer = CLERK_JWT_ISSUER_DOMAIN, aud/application = convex).
7. Convex validates signature/issuer/aud identically to web traffic; no code path differs.
8. authorizeLiveMirror: getUserIdentity() → subject = Clerk user id → checkEntitlement
   (plan + fresh billing from the users row provisioned by users.ensure) → Decart token.
9. Room uses the Decart token (60 s, lucy-vton-latest, server session cap) as today.
10. Expiry/refresh: Convex rejects → client re-fetches with forceRefreshToken →
    Clerk refreshes or, if the session died, the UI returns to step 1.
```

## 7. Required extension permissions (future change, NOT this audit)

- **Add** `"identity"` to manifest `permissions` (required by the OAuth return flow).
- **No** new host permissions (existing `https://*/*` covers Clerk + Convex endpoints).
- **No** `cookies`, `tabs`, or broadened `scripting` for auth.
- If Option B were chosen instead: add the SaaS origin to `externally_connectable.matches`
  (not needed for Option A).
- The `chrome-extension://<id>` redirect URI allowlisting happens in the **Clerk dashboard**,
  not the manifest (see §8). A stable extension ID (CWS listing or `key` in development)
  should be settled before configuring it.

## 8. Required Clerk configuration (dashboard/manual, NOT this audit)

- **Nothing new for tokens:** the `template: "convex"` JWT template already exists and is
  already consumed by `src/lib/auth.ts` — reuse it verbatim so web and extension JWTs are
  indistinguishable to Convex.
- **Allowlist the extension redirect/origin** per Clerk's current Chrome-extension guide
  (exact dashboard field names to confirm at implementation time — the installed packages
  contain no extension-specific guidance to quote).
- **Publishable key:** the existing `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (`pk_*`) is bundled
  in the extension. This is by design (it already ships in the web bundle). Never ship
  `sk_*`.
- **Optional hardening to consider later:** shortest acceptable JWT-template lifetime that
  still avoids refresh churn during a fitting session.

## 9. Required Convex changes

**None for authentication.** `ctx.auth.getUserIdentity()`, `requireUser`, and
`authorizeLiveMirror` (no args) work unchanged for extension-originated calls, because
verification depends only on the JWT, not the caller. No new functions, no schema change,
no CORS/origin allowlist (Convex actions travel over the Convex transport, not browser HTTP).

## 10. Account switching / logout behavior (recommended approach)

- **Logout (extension):** `signOut()` clears the extension session store; UI calls the
  Convex client's `clearAuth()` (or relies on `isAuthenticated === false`); the room returns
  to the signed-out state. Web session untouched.
- **Logout (web):** does not propagate to the extension (independent sessions). Accept and
  document in UX copy; do not build cross-surface logout.
- **Account switch:** Clerk's switcher changes the active session → `sessionId` changes →
  `ConvexProviderWithClerk` re-fetches the token (it already watches `sessionId`) → subsequent
  `authorizeLiveMirror` calls resolve to the new `identity.subject` → entitlement re-evaluated.
  No stale-user window beyond one in-flight call.
- **Stale/free after switch:** the backend denies with the existing codes
  (`FEATURE_LOCKED`, `SUBSCRIPTION_REFRESH_REQUIRED`); the room must surface these exactly
  as it will for the initial link (see §13).

## 11. Security properties (recommended approach)

- **Zero secrets in shipped code:** only `pk_*` publishable key + Convex URL (public).
  `AGENT_SERVICE_KEY`, `CLERK_SECRET_KEY`, `DECART_API_KEY` never enter the bundle.
- **Short-lived, narrowly scoped credentials at every hop:** Clerk JWT (minutes, convex-aud)
  → Decart client token (60 s, lucy-only, server session cap).
- **Server-derived identity only:** `identity.subject` from a verified JWT; no client
  identity claims exist anywhere in the call chain.
- **CSP-compatible:** Clerk ships as a bundled npm dependency; `script-src 'self'` stays intact.
- **Least privilege:** one added permission (`identity`); message listener keeps its
  extension-page-only sender check; no cookie access, no broadened scripting.
- **Residual risks (accepted, bounded):** bearer JWTs at rest in `chrome.storage.local`
  (local-compromise threat only, short lifetime); extension-update supply chain (same as
  today; CWS review + pinned deps); phishing-grade UX confusion between web/extension
  sessions (mitigated by explicit "signed in as … in the extension" UI).

## 12. Minimal implementation sequence (future work, in order)

1. Confirm `@clerk/chrome-extension` API/version against current Clerk docs; add as an
   extension dependency (bundled, not CDN).
2. Add `"identity"` to the extension manifest; settle a stable extension ID; allowlist its
   redirect URI in the Clerk dashboard. Bundle the existing publishable key + Convex URL.
3. Add a `ConvexReactClient` + `ConvexProviderWithClerk` (extension package's `useAuth`)
   to the room tab; add sign-in/sign-out UI to options/popup.
4. Call `authorizeLiveMirror` (unchanged backend) from the room tab; keep the background
   `token` path as fallback during the transition.
5. Run the full test matrix in §13 against the real extension + dev Convex deployment.
6. Only then: delete the `chrome.storage.local` Decart key, remove `token`/`test-key`
   handlers and key UI, and cut a release. Key removal is the last step, not the first.

## 13. Tests required before removing the local Decart key

Mirror the server matrix end-to-end through the real extension client (mocked Decart,
real Clerk + Convex dev deployment). All must pass with the background `token` path
disabled:

- Signed-out room → `authorizeLiveMirror` rejected `UNAUTHENTICATED`; room shows sign-in,
  never a Decart call.
- Signed-in **free** user → `FEATURE_LOCKED`; no token minted.
- Signed-in paid user with **stale** billing snapshot → `SUBSCRIPTION_REFRESH_REQUIRED`
  (then `users.ensure`/`subscriptions.refresh` path recovers exactly as the web app does).
- Signed-in paid user, fresh billing → token returned with the exact contract
  `{ token, expiresIn: 60, sessionSeconds: <server cap>, model: "lucy-vton-latest" }`;
  assert the outgoing Decart request is unchanged (POST, `X-API-KEY` from server env,
  fixed body) — the extension must not be able to alter model, lifetime, or cap.
- JWT expiry mid-session → Convex rejects → client refreshes silently → session continues;
  forced-failure case returns the user to sign-in without crashing the room.
- Logout in extension → subsequent calls unauthenticated; stored session gone.
- Account switch → next call resolves to the new user's entitlement (paid→free switch
  denies; free→paid switch allows).
- Decart outage/non-200/malformed body → `UPSTREAM_FAILED`, no token, no key material in
  any error surfaced to the room.
- Response-shape lockdown: assert the public result contains no server key and no extra
  fields (regression guard against future backend drift).
- No-network-provider test: with Decart unreachable, everything above still fails closed
  without hanging the room past the existing timeout.

**Status (Step 2D):** every case above is now covered automatically in
`extension/tests/live-mirror-secure.test.mjs` (35 tests, real `ConvexError` shape, no network)
and `extension/tests/live-mirror.test.mjs` (25 tests). The remaining gate is the manual run against
a real Clerk + Convex dev deployment: see **`docs/LIVE_MIRROR_E2E_TEST.md`**, which carries the
ten-case walkthrough, the error contract table, the accepted residual risks, and the Fast Mode
provider-cost blocker that must be decided before the local Decart key is deleted.

---

## Report

- **Recommended approach:** Option A — `@clerk/chrome-extension` owns the extension session;
  `ConvexProviderWithClerk` (already the web app's pattern) binds it to a `ConvexReactClient`
  in the room tab; `authorizeLiveMirror` is called unchanged.
- **Why:** it is the only first-party option (login, storage, refresh, logout, switch all
  Clerk-owned); it ships zero secrets; it satisfies the installed `ConvexProviderWithClerk`
  `useAuth` contract verbatim; it needs no Convex/backend change; and its failure modes
  (expiry, logout, switch) already have handling in the installed Convex client.
- **Files that would need changes (future, not touched):**
  `extension/package.json` (new dep), extension manifest permissions + stable ID,
  new/existing room-tab provider wiring (`tabs/room.*`), `popup.tsx`/`options.tsx`
  (sign-in/out UI), later removal of the `token`/`test-key` path in `background.ts` and the
  key UI in `options.tsx`/`popup.tsx` plus `lib/settings.ts` key storage. No `convex/**`,
  no `src/**`, no tsconfig/eslint changes for auth itself.
- **Dashboard/manual configuration needed:** allowlist the extension redirect URI in Clerk;
  reuse the existing `convex` JWT template (verify its lifetime); stable extension ID.
- **Unresolved questions:**
  1. Exact `@clerk/chrome-extension` API and its compatibility with installed Clerk 7.9.7 —
     the package is not in `node_modules` and cannot be verified offline here.
  2. Exact Clerk-dashboard field names for the extension redirect allowlist.
  3. The configured lifetime of the `convex` JWT template (drives refresh cadence).
  4. Whether the OAuth return flow must complete in a full extension tab vs. the popup
     (popup windows can close mid-flow; prefer options/room tab — to confirm with the
     package docs).
  5. CWS review posture on adding `identity` alongside the existing broad host permissions.

## Sources read

`AGENTS.md`, root `package.json`, `convex/auth.config.ts`, `convex/lib/auth.ts`,
`convex/liveMirror.ts`, `src/lib/auth.ts`, `src/components/providers/app-providers.tsx`,
`src/components/providers/store-user.tsx`, `src/proxy.ts`, `extension/package.json`,
`extension/background.ts`, `extension/content.tsx`, `extension/popup.tsx`,
`extension/options.tsx`, `extension/lib/settings.ts`, `src/lib/env.ts`;
installed: `convex@1.46.0` (`src/react-clerk/ConvexProviderWithClerk.tsx`,
`src/browser/sync/authentication_manager.ts`, `src/browser/sync/client.ts`),
`@clerk/nextjs@7.9.7`, `@clerk/react@6.17.2`, `@clerk/shared@4.36.0`,
`@clerk/backend@3.18.1` (presence/versions only). No code modified, nothing installed,
no settings changed, nothing committed.
