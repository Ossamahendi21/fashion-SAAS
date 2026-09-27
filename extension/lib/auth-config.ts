// Public auth configuration for the OpenWear extension.
//
// ONLY public values may live here: the Clerk publishable key (pk_*), the Sync Host
// origin, and the Convex deployment URL. All three are already public in the Fitcheck
// web bundle. NEVER add CLERK_SECRET_KEY, DECART_API_KEY, or AGENT_SERVICE_KEY.
//
// Values arrive via Plasmo build-time env (process.env.PLASMO_PUBLIC_*). In tests they
// are passed explicitly, so no browser or build is needed to validate this module.

export type ExtensionAuthConfig = {
  /** Clerk publishable key for the Chrome Extension instance (pk_test_* / pk_live_*). */
  clerkPublishableKey: string
  /** Origin of the Fitcheck web app to sync the session from. Null = extension-only auth. */
  clerkSyncHost: string | null
  /** Convex deployment URL (https://<name>.convex.cloud). */
  convexUrl: string
}

export type ExtensionAuthStatus =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "signed-in"; convexAuthenticated: boolean }

/** Fails with a clear, actionable message naming the exact missing variable. */
export function getAuthConfig(env: Record<string, string | undefined> = process.env): ExtensionAuthConfig {
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
  // syncing the web app session. Production should always set it.
  const clerkSyncHost = (env.PLASMO_PUBLIC_CLERK_SYNC_HOST || "").trim() || null
  return { clerkPublishableKey, clerkSyncHost, convexUrl }
}

/** Whether the extension can mount Clerk auth. False = Decart-key path only, unchanged. */
export function isAuthConfigured(env: Record<string, string | undefined> = process.env): boolean {
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
