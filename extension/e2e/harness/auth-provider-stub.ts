// Test-only auth-provider stub for the E2E harness bundle.
//
// Replaces ../lib/auth-provider at harness BUNDLE time (esbuild onResolve in the
// assembly script) so the real Room can mount without Clerk or Convex: the badge hook
// reports a signed-in session and the provider passes children through. No network, no
// JWTs, no session sync — the harness drives auth state through Room props instead.
//
// Bundled ONLY into the test-extension overlay (e2e/.work). Never part of the
// production build — the bundle-content regression tests fail the run if any marker
// below ever appears in production output.
import type { ReactNode } from "react";
import type { ExtensionAuthStatus } from "../../lib/auth-config";

export function ExtensionAuthProvider({ children }: { children: ReactNode }): ReactNode {
  return children;
}

export function useExtensionAuthStatus(): ExtensionAuthStatus {
  return { state: "signed-in", convexAuthenticated: true };
}

export const E2E_AUTH_STUB_MARKER = "e2e-auth-provider-stub";
