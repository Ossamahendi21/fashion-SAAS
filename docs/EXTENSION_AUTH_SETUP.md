# Extension Auth Setup — manual steps (owner only)

The code foundation is in place (`@clerk/chrome-extension@3.1.87`,
`ExtensionAuthProvider`, Sync Host wiring). Nothing works until YOU complete the
steps below. No step involves committing a secret.

## 1. Enable the Native API (Clerk Dashboard)

Clerk Dashboard → **Native applications** → enable the **Native API**. Required for any
browser-extension integration. Without it, the extension provider fails to initialize.

## 2. Copy public keys (Clerk Dashboard → API keys)

API keys page → Quick Copy → select **Chrome Extension**. Copy:

- Publishable key (`pk_test_*` for dev, `pk_live_*` for production)
- Frontend API URL (`https://<name>.clerk.accounts.dev` or your custom Clerk domain)

Create `extension/.env.development` (gitignored — never commit):

```env
PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_FRONTEND_API=https://<name>.clerk.accounts.dev
PLASMO_PUBLIC_CLERK_SYNC_HOST=http://localhost:3000
PLASMO_PUBLIC_CONVEX_URL=https://<your-deployment>.convex.cloud
```

Values: `PLASMO_PUBLIC_CLERK_SYNC_HOST` is the Fitcheck web origin whose session the
extension syncs — dev: where `next dev` runs (`http://localhost:3000`); production: the
deployed SaaS origin. `PLASMO_PUBLIC_CONVEX_URL` is the same deployment the web app uses.
See `extension/.env.example` for the template.

For store builds, create `extension/.env.production` with the `pk_live_*` key, the
production Clerk Frontend API URL, the production SaaS origin, and the production Convex URL.

## 3. Fix a stable CRX ID (one time)

Unpacked builds get a rotating extension ID, which breaks Sync Host and the
`allowed_origins` entry below. Generate a keypair once:

1. Plasmo Itero keypair tool → Generate Keypairs.
2. Store the **private** key somewhere safe (password manager, never the repo).
3. Create `extension/.env.chrome` (gitignored) with the **public** key:
   `CRX_PUBLIC_KEY=<public key>`.
4. Add `"key": "$CRX_PUBLIC_KEY"` to the `manifest` object in `extension/package.json`
   (deliberately NOT done in code — a missing variable would break every build).
5. Rebuild, load unpacked, and confirm `chrome://extensions` shows the expected ID.

## 4. Allowlist the extension origin (needs your Secret Key, run locally only)

```bash
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" \
  -H "Content-type: application/json" \
  -d '{"allowed_origins": ["chrome-extension://<EXTENSION_ID>"]}'
```

Replace `<CLERK_SECRET_KEY>` with the matching instance secret (`sk_test_*` for dev,
`sk_live_*` for prod) and `<EXTENSION_ID>` with the stable ID from step 3. The secret
goes on this command line only — never in a file, never in the repo. Repeat for the
production instance with the production extension ID.

## 5. What was already decided in code (no action)

- Manifest `permissions` gained **`cookies`** only (required by Clerk for the extension
  session + Sync Host; verified against the official quickstart and manifest guides).
  No `identity` permission: the installed SDK's `ClerkProvider` (`publishableKey` +
  optional `syncHost`, verified in `dist/types/react/ClerkProvider.d.ts`) performs no
  `chrome.identity.launchWebAuthFlow` in this integration — sign-in happens on the
  Fitcheck web app, which the popup links to.
- `host_permissions` unchanged: the existing `https://*/*` + `http://*/*` already cover
  the Clerk Frontend API, the sync host, and the Convex URL.
- The installed provider accepts **no redirect-URL props** (`afterSignOutUrl` etc. do not
  exist on this version's type), so none are configured; `signOut()` flips local state.
- JWT template stays **`convex`** (already configured, already used by the web app).
  `convex/auth.config.ts` and `authorizeLiveMirror` are untouched.
- Without the env files above, the extension builds and runs exactly as before on the
  Decart-key path; auth UI appears only when public config is present.

## 6. Verify

1. `cd extension && npm run build`, load `build/chrome-mv3-prod` (or dev) unpacked.
2. Sign in on the Fitcheck web app (same browser, same Clerk account).
3. Open the extension popup → "Signed in as … · Convex connected".
4. Open the fitting room → status line shows the same; camera/Decart behavior unchanged.
5. Sign out (popup) → both surfaces return to signed-out; Decart path still works.
