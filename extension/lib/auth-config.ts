// Public auth configuration for the OpenWear extension.
//
// ONLY public values may live here: the Clerk publishable key (pk_*), the Sync Host
// value, the Fitcheck web app origin, and the Convex deployment URL. All are already
// public in the Fitcheck web bundle. NEVER add CLERK_SECRET_KEY, DECART_API_KEY, or AGENT_SERVICE_KEY.
//
// Values arrive via Plasmo build-time env. Plasmo/Parcel only replaces DIRECT static
// process.env.PLASMO_PUBLIC_* references, so the default env object below must spell
// each variable out literally — never process.env[name] and never a passed-through
// env.* object. In tests a custom env is injected explicitly, so no browser or build
// is needed to validate this module.

/**
 * Build-time env with static references Plasmo can replace at compile time.
 * This is the ONLY place process.env may be read in client auth code.
 */
const BUILD_ENV: Record<string, string | undefined> = {
  PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  PLASMO_PUBLIC_CONVEX_URL: process.env.PLASMO_PUBLIC_CONVEX_URL,
  PLASMO_PUBLIC_CLERK_SYNC_HOST: process.env.PLASMO_PUBLIC_CLERK_SYNC_HOST,
  PLASMO_PUBLIC_FITCHECK_APP_URL: process.env.PLASMO_PUBLIC_FITCHECK_APP_URL,
}

export type ExtensionAuthConfig = {
  /** Clerk publishable key for the Chrome Extension instance (pk_test_* / pk_live_*). */
  clerkPublishableKey: string
  /** Origin of the Fitcheck web app to sync the session from. Null = extension-only auth. */
  clerkSyncHost: string | null
  /** Convex deployment URL (https://<name>.convex.cloud). */
  convexUrl: string
  /** Fitcheck web app origin used for user-facing links (sign-in). Separate from Sync Host. */
  fitcheckAppUrl: string
}

export type ExtensionAuthStatus =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "signed-in"; convexAuthenticated: boolean }

/** Fails with a clear, actionable message naming the exact missing variable. */
export function getAuthConfig(env: Record<string, string | undefined> = BUILD_ENV): ExtensionAuthConfig {
  const clerkPublishableKey = (env.PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY || "").trim()
  if (!clerkPublishableKey) {
    throw new Error(
      "PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set. Copy the Chrome Extension publishable key " +
      "from the Clerk Dashboard API keys page into extension/.env.development (see extension/.env.example)."
    )
  }
  if (!clerkPublishableKey.startsWith("pk_")) {
    throw new Error("PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY must be a Clerk publishable key (pk_test_* or pk_live_*). Never put a secret key (sk_*) in extension code.")
  }
  const convexUrl = (env.PLASMO_PUBLIC_CONVEX_URL || "").trim()
  if (!convexUrl) {
    throw new Error(
      "PLASMO_PUBLIC_CONVEX_URL is not set. Copy the deployment URL from the Clerk/Fitcheck setup " +
      "into extension/.env.development (see extension/.env.example)."
    )
  }
  // Sync Host is optional: without it the extension authenticates standalone instead of
  // syncing the web app session. Production should always set it. It identifies the sync
  // counterpart to Clerk — it is NOT the user-facing web app URL (see fitcheckAppUrl).
  const clerkSyncHost = (env.PLASMO_PUBLIC_CLERK_SYNC_HOST || "").trim() || null
  // The user-facing Fitcheck origin. Required whenever auth is enabled: signed-out UI
  // links here, and building it from the Sync Host value is wrong (dev Sync Host is
  // bare http://localhost, which serves nothing — hence ERR_CONNECTION_REFUSED).
  const fitcheckAppUrl = (env.PLASMO_PUBLIC_FITCHECK_APP_URL || "").trim().replace(/\/+$/, "")
  let appOrigin: URL
  try {
    appOrigin = new URL(fitcheckAppUrl)
  } catch {
    throw new Error(
      "PLASMO_PUBLIC_FITCHECK_APP_URL is not set or not a valid URL. Set it to the Fitcheck web app origin " +
      "(http://localhost:3000 for development) in extension/.env.development (see extension/.env.example)."
    )
  }
  if (!["http:", "https:"].includes(appOrigin.protocol)) {
    throw new Error("PLASMO_PUBLIC_FITCHECK_APP_URL must be an http(s) URL.")
  }
  return { clerkPublishableKey, clerkSyncHost, convexUrl, fitcheckAppUrl: appOrigin.origin }
}

/** Web sign-in URL for signed-out UI. Single place so links never drift back to syncHost. */
export function fitcheckSignInUrl(config: ExtensionAuthConfig): string {
  return `${config.fitcheckAppUrl}/sign-in`
}

/** Whether the extension can mount Clerk auth. False = fail closed with a setup error. */
export function isAuthConfigured(env: Record<string, string | undefined> = BUILD_ENV): boolean {
  try { getAuthConfig(env); return true } catch { return false }
}

/**
 * Single place that maps Clerk + Convex flags to UI state. The signed-in branch is
 * reachable ONLY when Clerk reports a loaded, signed-in session, so a signed-out user
 * can never present as authenticated no matter what the Convex flag says.
 */
export function deriveAuthStatus(input: {
  clerkLoaded: boolean
  isSignedIn: boolean | undefined
  convexAuthenticated: boolean
}): ExtensionAuthStatus {
  if (!input.clerkLoaded) return { state: "loading" }
  if (!input.isSignedIn) return { state: "signed-out" }
  return { state: "signed-in", convexAuthenticated: input.convexAuthenticated }
}
