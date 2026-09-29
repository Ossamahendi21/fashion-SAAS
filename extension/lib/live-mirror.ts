// Secure Live Mirror authorization boundary for the OpenWear fitting room.
//
// The room obtains its Decart client token ONLY from the server-side Convex action
// `liveMirror:authorizeLiveMirror` (convex/liveMirror.ts). That action takes NO arguments: it
// derives identity from the verified Clerk session, enforces paid-plan, fresh-billing, monthly
// session quota and daily operator-cap gates, and mints a short-lived token restricted to one
// model with a server-side session cap. The browser never reads the permanent Decart key, never
// chooses a model, and can never raise the server cap.
//
// Step 2E3 removed the legacy browser-stored-key fallback completely: without Clerk/Convex
// configuration plus an authenticated SaaS user, Live Mirror fails CLOSED. There is no local
// key, no direct provider authorization, and no Fast Mode — the secure grant is always
// standard speed.
//
// Pure module: every dependency (Convex action, billing refresh) is injected, so the whole
// decision tree is unit-testable with no browser, no Clerk and no Decart.

import { makeFunctionReference } from "convex/server"
import type { ExtensionAuthStatus } from "./auth-config"

/** Exactly the public return shape of the server action. No extra fields are trusted. */
export type LiveMirrorAuthorization = {
  token: string
  expiresIn: number
  sessionSeconds: number
  model: string
  sessionId: string
  monthlyAllowanceSessions: number
  remainingSessions: number
}

export type ResolvedLiveMirrorSession = {
  /** Short-lived server-minted Decart client token. The browser holds no other credential. */
  token: string
  /** Client-side countdown, already clamped to the server cap. */
  sessionSeconds: number
  /** Model id chosen by the server. */
  model: string
  /** Server ledger row for this minted authorization. Useful for support, never a secret. */
  sessionId: string
  /** Monthly allowance and remaining sessions after this authorization consumes one. */
  monthlyAllowanceSessions: number
  remainingSessions: number
}

export type AuthorizeDeps = {
  status: ExtensionAuthStatus | null
  /** Convex action wrapper. Called with no arguments, always. */
  authorize: (args: Record<string, never>) => Promise<LiveMirrorAuthorization>
  /** Authenticated billing refresh, used at most once per stale-billing authorization attempt. */
  refreshBilling?: () => Promise<unknown>
  /** Optional local auto-freeze: may only shorten the authorized session, never extend it. */
  autoFreezeSeconds: number
}

export type LiveMirrorFailure =
  | "PENDING" // still connecting the Clerk session to Convex — retryable, not a denial
  | "UNAUTHENTICATED"
  | "FEATURE_LOCKED"
  | "LIVE_MIRROR_LIMIT_REACHED"
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

/** Authenticated billing refresh used only for one automatic stale-billing retry. */
export const refreshSubscription = makeFunctionReference<"action", Record<string, never>, null>(
  "subscriptions:refresh"
)

/** Exactly the public return shape of the read-only allowance status query. No token is minted. */
export type LiveMirrorStatus = {
  plan: "free" | "pro" | "plus"
  monthlyAllowanceSessions: number
  usedSessions: number
  remainingSessions: number
  sessionMaxSeconds: number
  periodEnd?: number
}

/** Typed reference to the read-only allowance status query. Never mints a token. */
export const liveMirrorStatus = makeFunctionReference<"query", Record<string, never>, LiveMirrorStatus>(
  "liveMirror:status"
)

/** User-facing copy per server decision. Deliberately free of provider, plan and token detail. */
const MESSAGES: Record<LiveMirrorFailure, string> = {
  PENDING: "Still connecting to your Fitcheck account. Try again in a moment.",
  UNAUTHENTICATED: "Sign in to Fitcheck to use Live Mirror.",
  FEATURE_LOCKED: "Live Mirror is available on a paid plan.",
  LIVE_MIRROR_LIMIT_REACHED: "You've used your Live Mirror sessions for this billing cycle.",
  SUBSCRIPTION_REFRESH_REQUIRED: "Your subscription status needs refreshing before Live Mirror can start. Reopen Fitcheck to refresh it, then try again.",
  UPSTREAM_FAILED: "Live Mirror is temporarily unavailable. Please try again.",
  UNKNOWN: "Live Mirror couldn't start. Please try again."
}

export function liveMirrorMessage(failure: LiveMirrorFailure): string {
  return MESSAGES[failure]
}

/**
 * Human-facing quota display. Informational only: authorizeLiveMirror remains authoritative.
 * Never shows provider credits, costs, token lifetimes, or internal authorized-seconds counts.
 */
export function quotaStatusCopy(status: LiveMirrorStatus | null): string | null {
  if (!status) return null
  if (status.plan === "free") return MESSAGES.FEATURE_LOCKED
  if (!Number.isFinite(status.remainingSessions) || status.remainingSessions <= 0) {
    return "No Live Mirror sessions left this cycle."
  }
  return status.remainingSessions === 1
    ? "1 live session left this cycle"
    : `${status.remainingSessions} live sessions left this cycle`
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

/** Maps a thrown Convex/app error onto a safe failure class. Never surfaces the raw error. */
export function toLiveMirrorFailure(error: unknown): LiveMirrorFailure {
  const code = (error as { data?: { code?: unknown } } | null | undefined)?.data?.code
  switch (code) {
    case "UNAUTHENTICATED":
      return "UNAUTHENTICATED"
    case "FEATURE_LOCKED":
      return "FEATURE_LOCKED"
    case "LIVE_MIRROR_LIMIT_REACHED":
      return "LIVE_MIRROR_LIMIT_REACHED"
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
  const { token, expiresIn, sessionSeconds, model, sessionId, monthlyAllowanceSessions, remainingSessions } = record
  if (typeof token !== "string" || !token.trim()) throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  if (typeof model !== "string" || !model.trim()) throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  if (!Number.isFinite(sessionSeconds) || (sessionSeconds as number) < 1) throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  if (!Number.isFinite(monthlyAllowanceSessions) || (monthlyAllowanceSessions as number) < 0) {
    throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  }
  if (!Number.isFinite(remainingSessions) || (remainingSessions as number) < 0) {
    throw new LiveMirrorError("UNKNOWN", MESSAGES.UNKNOWN)
  }
  return {
    token,
    expiresIn: expiresIn as number,
    sessionSeconds: sessionSeconds as number,
    model,
    sessionId,
    monthlyAllowanceSessions: monthlyAllowanceSessions as number,
    remainingSessions: remainingSessions as number
  }
}

/**
 * The one place the room gets a Decart token: always the secure server action, never a local
 * key. Denials fail closed.
 */
export async function resolveLiveMirrorSession(deps: AuthorizeDeps): Promise<ResolvedLiveMirrorSession> {
  const status = deps.status
  if (!status || status.state === "loading") throw new LiveMirrorError("PENDING", MESSAGES.PENDING)
  // Signed out: ask for sign-in.
  if (status.state === "signed-out") throw new LiveMirrorError("UNAUTHENTICATED", MESSAGES.UNAUTHENTICATED)
  // Signed in but the Convex token is not attached yet: retryable.
  if (!status.convexAuthenticated) throw new LiveMirrorError("PENDING", MESSAGES.PENDING)

  let authorization: LiveMirrorAuthorization
  try {
    // No arguments: identity, plan, billing period, model, duration and the key stay server-side.
    authorization = parseAuthorization(await deps.authorize({}))
  } catch (error) {
    authorization = await maybeRefreshStaleBilling(deps, error)
  }

  return {
    token: authorization.token,
    // Fast Mode was removed with the legacy path: the secure grant is always standard speed.
    // The local auto-freeze setting may shorten the session, never extend it past the server cap.
    sessionSeconds: effectiveSessionSeconds(deps.autoFreezeSeconds, authorization.sessionSeconds),
    // The server picks the model; the browser may not substitute another one.
    model: authorization.model,
    sessionId: authorization.sessionId,
    monthlyAllowanceSessions: authorization.monthlyAllowanceSessions,
    remainingSessions: authorization.remainingSessions
  }
}

/**
 * Automatic stale-billing recovery: refresh once, retry authorization once, then stop. Other
 * failures never trigger a refresh.
 */
async function maybeRefreshStaleBilling(
  deps: AuthorizeDeps,
  error: unknown
): Promise<LiveMirrorAuthorization> {
  // Normalize transport errors first: the retry decision must see the same failure class the
  // room would otherwise surface, not the raw Convex/Decart throw.
  const normalized = error instanceof LiveMirrorError
    ? error
    : new LiveMirrorError(toLiveMirrorFailure(error), MESSAGES[toLiveMirrorFailure(error)])
  if (normalized.failure !== "SUBSCRIPTION_REFRESH_REQUIRED" || !deps.refreshBilling) throw normalized
  try {
    await deps.refreshBilling()
  } catch (refreshError) {
    if (refreshError instanceof LiveMirrorError) throw refreshError
    const failure = toLiveMirrorFailure(refreshError)
    throw new LiveMirrorError(failure, MESSAGES[failure])
  }
  try {
    // No arguments again: the retry must not carry anything the first attempt did not.
    return parseAuthorization(await deps.authorize({}))
  } catch (retryError) {
    if (retryError instanceof LiveMirrorError) throw retryError
    const failure = toLiveMirrorFailure(retryError)
    throw new LiveMirrorError(failure, MESSAGES[failure])
  }
}

/**
 * Single-flight wrapper: repeated drops or re-renders during one intended room start share the
 * same in-flight promise, including one automatic stale-billing refresh/retry, so concurrent
 * starts cannot duplicate billing refreshes or token mints. Nothing retries in the background —
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
