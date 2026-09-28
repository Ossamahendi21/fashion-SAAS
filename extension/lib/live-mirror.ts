// Secure Live Mirror authorization boundary for the OpenWear fitting room.
//
// When public Clerk/Convex config is present (`isAuthConfigured()`), the room must obtain
// its Decart client token from the server-side Convex action `liveMirror:authorizeLiveMirror`
// (convex/liveMirror.ts). That action takes NO arguments: it derives identity from the verified
// Clerk session, enforces the paid-plan and fresh-billing gates, and mints a 60-second token
// restricted to one model with a server-side session cap. The browser therefore never reads the
// permanent Decart key, never chooses a model, and can never raise the server cap.
//
// When the secure path denies, it fails CLOSED. There is no fallback to the browser-stored key,
// because falling back would bypass subscription enforcement. The legacy background `token` path
// is used only when auth is genuinely not configured (local demo / pre-migration builds).
//
// Pure module: every dependency (Convex action, legacy token, settings, SDK model lookup) is
// injected, so the whole decision tree is unit-testable with no browser, no Clerk and no Decart.

import { makeFunctionReference } from "convex/server"
import type { ExtensionAuthStatus } from "./auth-config"

/** Exactly the public return shape of the server action. No extra fields are trusted. */
export type LiveMirrorAuthorization = {
  token: string
  expiresIn: number
  sessionSeconds: number
  model: string
}

/** The legacy background `token` handler response, unchanged (still used when auth is absent). */
export type LegacyToken = { apiKey: string; fastMode: boolean; sessionSeconds: number }

export type LiveMirrorFailure =
  | "PENDING" // still connecting the Clerk session to Convex — retryable, not a denial
  | "UNAUTHENTICATED"
  | "FEATURE_LOCKED"
  | "SUBSCRIPTION_REFRESH_REQUIRED"
  | "UPSTREAM_FAILED"
  | "UNKNOWN"

/**
 * Carries a safe, user-facing failure class. `message` is always copy from this file, never from
 * the server error, the Decart response body or a stack, so provider internals can never reach
 * the room UI.
 */
export class LiveMirrorError extends Error {
  readonly failure: LiveMirrorFailure
  constructor(failure: LiveMirrorFailure, message: string) {
    super(message)
    this.name = "LiveMirrorError"
    this.failure = failure
  }
}

/** Typed reference to the no-args server action. The extension never imports the Convex backend. */
export const authorizeLiveMirror = makeFunctionReference<"action", Record<string, never>, LiveMirrorAuthorization>(
  "liveMirror:authorizeLiveMirror"
)

/** User-facing copy per server decision. Deliberately free of provider, plan and token detail. */
const MESSAGES: Record<LiveMirrorFailure, string> = {
  PENDING: "Still connecting to your Fitcheck account. Try again in a moment.",
  UNAUTHENTICATED: "Sign in to Fitcheck to use Live Mirror.",
  FEATURE_LOCKED: "Live Mirror is available on a paid plan.",
  SUBSCRIPTION_REFRESH_REQUIRED: "Your subscription status needs refreshing before Live Mirror can start. Reopen Fitcheck to refresh it, then try again.",
  UPSTREAM_FAILED: "Live Mirror is temporarily unavailable. Please try again.",
  UNKNOWN: "Live Mirror couldn't start. Please try again."
}

export function liveMirrorMessage(failure: LiveMirrorFailure): string {
  return MESSAGES[failure]
}

/**
 * The local setting may only SHORTEN the session the server authorized, never extend it. The
 * Decart token's own `maxSessionDuration` stays the authoritative provider-side bound.
 */
export function effectiveSessionSeconds(localRequested: number, serverAuthorized: number): number {
  if (!Number.isFinite(localRequested) || localRequested < 1) return serverAuthorized
  if (!Number.isFinite(serverAuthorized) || serverAuthorized < 1) return 1
  return Math.max(1, Math.min(Math.floor(localRequested), Math.floor(serverAuthorized)))
}

export type ResolvedLiveMirrorSession = {
  /** Decart client token: a short-lived server-minted value, or the legacy browser key. */
  token: string
  fastMode: boolean
  /** Client-side countdown, already clamped to the server cap. */
  sessionSeconds: number
  /** Model id chosen by the server, or null on the legacy path (caller keeps its default). */
  model: string | null
  source: "secure" | "legacy"
}

export type AuthorizeDeps = {
  authEnabled: boolean
  status: ExtensionAuthStatus | null
  /** Convex action wrapper. Called with no arguments, always. */
  authorize: (args: Record<string, never>) => Promise<LiveMirrorAuthorization>
  /** Legacy background `token` handler. Only ever called when authEnabled is false. */
  legacyToken: () => Promise<LegacyToken>
  localSessionSeconds: number
  fastMode: boolean
}

/** Maps a thrown Convex/app error onto a safe failure class. Never surfaces the raw error. */
export function toLiveMirrorFailure(error: unknown): LiveMirrorFailure {
  const code = (error as { data?: { code?: unknown } } | null | undefined)?.data?.code
  switch (code) {
    case "UNAUTHENTICATED":
      return "UNAUTHENTICATED"
    case "FEATURE_LOCKED":
      return "FEATURE_LOCKED"
    case "SUBSCRIPTION_REFRESH_REQUIRED":
      return "SUBSCRIPTION_REFRESH_REQUIRED"
    case "UPSTREAM_FAILED":
      return "UPSTREAM_FAILED"
    default:
      return "UNKNOWN"
  }
}

/** Rejects a malformed or unexpected authorization payload instead of using it. */
function parseAuthorization(value: unknown): LiveMirrorAuthorization {
  const record = (value ?? {}) as Record<string, unknown>
  const { token, expiresIn, sessionSeconds, model } = record
  if (typeof token !== "string" || !token.trim()) throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  if (typeof model !== "string" || !model.trim()) throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  if (!Number.isFinite(sessionSeconds) || (sessionSeconds as number) < 1) throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  return { token, expiresIn: expiresIn as number, sessionSeconds: sessionSeconds as number, model }
}

/**
 * The one place the room decides how to get a Decart token. Secure when auth is configured,
 * legacy only when it is not. Denials never fall back.
 */
export async function resolveLiveMirrorSession(deps: AuthorizeDeps): Promise<ResolvedLiveMirrorSession> {
  // Legacy development/demo builds: identical behaviour to before this module existed.
  if (!deps.authEnabled) {
    const legacy = await deps.legacyToken()
    return {
      token: legacy.apiKey,
      fastMode: legacy.fastMode,
      sessionSeconds: legacy.sessionSeconds,
      model: null,
      source: "legacy"
    }
  }

  const status = deps.status
  if (!status || status.state === "loading") throw new LiveMirrorError("PENDING", MESSAGES.PENDING)
  // Signed out: ask for sign-in. The legacy key handler is deliberately NOT called.
  if (status.state === "signed-out") throw new LiveMirrorError("UNAUTHENTICATED", MESSAGES.UNAUTHENTICATED)
  // Signed in but the Convex token is not attached yet: retryable, still no fallback.
  if (!status.convexAuthenticated) throw new LiveMirrorError("PENDING", MESSAGES.PENDING)

  let authorization: LiveMirrorAuthorization
  try {
    // No arguments: identity, plan, model, duration and the key all stay server-side.
    authorization = parseAuthorization(await deps.authorize({}))
  } catch (error) {
    if (error instanceof LiveMirrorError) throw error
    throw new LiveMirrorError(toLiveMirrorFailure(error), MESSAGES[toLiveMirrorFailure(error)])
  }

  return {
    token: authorization.token,
    // Fast Mode stays a local speed preference; the server does not and need not restrict it.
    fastMode: deps.fastMode,
    // The local setting may shorten the session, never extend it past the server cap.
    sessionSeconds: effectiveSessionSeconds(deps.localSessionSeconds, authorization.sessionSeconds),
    // The server picks the model; the browser may not substitute another one.
    model: authorization.model,
    source: "secure"
  }
}

/**
 * Single-flight wrapper: repeated drops or re-renders during one intended room start share the
 * same in-flight promise, so exactly one token is minted. Nothing retries in the background —
 * a retry only happens when the user acts again after seeing a failure.
 */
export function createLiveMirrorAuthorizer() {
  let inFlight: Promise<ResolvedLiveMirrorSession> | null = null
  return {
    get pending(): boolean {
      return inFlight !== null
    },
    acquire(deps: AuthorizeDeps): Promise<ResolvedLiveMirrorSession> {
      if (inFlight) return inFlight
      const current = resolveLiveMirrorSession(deps)
      inFlight = current
      const clear = () => {
        if (inFlight === current) inFlight = null
      }
      current.then(clear, clear)
      return current
    }
  }
}

export type LiveMirrorAuthorizer = ReturnType<typeof createLiveMirrorAuthorizer>

/**
 * Resolves the server-named model through the Decart SDK's own catalogue so an unknown or
 * retired model id fails closed instead of silently connecting to something else.
 */
export function resolveRealtimeModel<T>(modelId: string, lookup: (id: string) => T): T {
  try {
    return lookup(modelId)
  } catch {
    throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  }
}
