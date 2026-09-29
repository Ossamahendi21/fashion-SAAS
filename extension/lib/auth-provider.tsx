// Reusable Clerk + Convex auth foundation for OpenWear extension pages.
//
// - ClerkProvider comes from @clerk/chrome-extension (bundled by Plasmo, never a CDN,
//   per the extension CSP which only allows script-src 'self').
// - syncHost enables Clerk Sync Host: the extension recognizes the Fitcheck web session
//   instead of a custom token bridge. No raw JWTs are stored; no cookies are copied.
// - ConvexProviderWithClerk binds the extension Clerk session to Convex with the SAME
//   "convex" JWT template the web app uses. No new template, no backend change.
// - getAuthConfig() throws clearly when public config is missing, so pages fail closed with
//   a setup error when isAuthConfigured() is false. There is no unauthenticated mode.

import { ClerkProvider, useAuth as useClerkAuth } from "@clerk/chrome-extension"
import { ConvexReactClient } from "convex/react"
import { useConvexAuth } from "convex/react"
import { ConvexProviderWithClerk } from "convex/react-clerk"
import { useMemo, type ReactNode } from "react"
import { deriveAuthStatus, getAuthConfig, type ExtensionAuthStatus } from "./auth-config"

let convex: ConvexReactClient | null = null

/** Mounts Clerk + authenticated Convex for an extension page. Requires public config. */
export function ExtensionAuthProvider({ children }: { children: ReactNode }) {
  const config = useMemo(() => getAuthConfig(), [])
  const client = useMemo(() => {
    if (!convex || convex.url !== config.convexUrl) convex = new ConvexReactClient(config.convexUrl)
    return convex
  }, [config.convexUrl])
  if (!config.clerkSyncHost) {
    console.warn("OpenWear auth: PLASMO_PUBLIC_CLERK_SYNC_HOST is not set; the extension will authenticate standalone instead of syncing the Fitcheck web session.")
  }
  // Note: the installed @clerk/chrome-extension@3 ClerkProvider accepts publishableKey
  // (+ optional syncHost) only — no redirect-URL props. Sign-in happens on the Fitcheck
  // web app (see popup AuthSection) and signOut() simply flips local state, so no
  // in-extension navigation handling is needed.
  return (
    <ClerkProvider
      publishableKey={config.clerkPublishableKey}
      {...(config.clerkSyncHost ? { syncHost: config.clerkSyncHost } : {})}
    >
      <ConvexProviderWithClerk client={client} useAuth={useClerkAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  )
}

/**
 * Tiny auth-state hook for extension UI. Returns the derived status (never "signed-in"
 * unless Clerk reports a loaded session) plus the raw Clerk user for identity display.
 * Must be rendered inside <ExtensionAuthProvider>. Exposes no tokens.
 */
export function useExtensionAuthStatus(): ExtensionAuthStatus {
  const { isLoaded, isSignedIn } = useClerkAuth()
  const { isAuthenticated } = useConvexAuth()
  return useMemo(
    () => deriveAuthStatus({ clerkLoaded: isLoaded, isSignedIn: isSignedIn ?? false, convexAuthenticated: isAuthenticated }),
    [isLoaded, isSignedIn, isAuthenticated]
  )
}
