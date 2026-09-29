import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, query } from "./_generated/server";
import { requireEnv } from "./lib/env";
import { appError } from "./lib/errors";
import { getByClerkId } from "./model/users";
import { vPlanId } from "./shared/validators";
import {
  clientTokenRequestBody,
  DECART_API_BASE,
  DECART_CLIENT_TOKENS_PATH,
  DECART_REQUEST_TIMEOUT_MS,
  LIVE_MIRROR_TOKEN_EXPIRES_IN_SECONDS,
  parseClientTokenResponse,
} from "./liveMirror/decart";
import {
  finalizeLiveMirrorSession as finalizeUsage,
  readLiveMirrorStatus,
  reserveLiveMirrorUsage,
} from "./model/liveMirror";

export const vLiveMirrorAuthorization = v.object({
  token: v.string(),
  expiresIn: v.number(),
  sessionSeconds: v.number(),
  model: v.string(),
  sessionId: v.id("liveMirrorSessions"),
  monthlyAllowanceSessions: v.number(),
  remainingSessions: v.number(),
});

export const vLiveMirrorStatus = v.object({
  plan: vPlanId,
  monthlyAllowanceSessions: v.number(),
  usedSessions: v.number(),
  remainingSessions: v.number(),
  sessionMaxSeconds: v.number(),
  periodEnd: v.optional(v.number()),
});

type LiveMirrorAuthorization = Infer<typeof vLiveMirrorAuthorization>;

/**
 * Internal reservation step. The public action passes the verified Clerk id explicitly because
 * scheduler-invoked functions cannot rely on propagated session auth. No client-supplied user,
 * plan, period, model, duration, or usage value is accepted here.
 */
export const reserveLiveMirrorSession = internalMutation({
  args: { clerkId: v.string() },
  returns: v.object({
    sessionId: v.id("liveMirrorSessions"),
    userId: v.id("users"),
    sessionSeconds: v.number(),
    model: v.string(),
  }),
  handler: async (ctx, { clerkId }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    return reserveLiveMirrorUsage(ctx, user);
  },
});

/**
 * Internal settlement step. Provider failure releases quota and global seconds exactly once;
 * a minted token keeps both consumed. Internal only: the public action supplies the outcome.
 */
export const finalizeLiveMirrorSession = internalMutation({
  args: {
    sessionId: v.id("liveMirrorSessions"),
    outcome: v.union(v.literal("authorized"), v.literal("provider_failed")),
  },
  returns: v.object({
    released: v.boolean(),
    plan: vPlanId,
    monthlyAllowanceSessions: v.number(),
    usedSessions: v.number(),
    remainingSessions: v.number(),
    periodEnd: v.optional(v.number()),
  }),
  handler: async (ctx, { sessionId, outcome }) => finalizeUsage(ctx, sessionId, outcome),
});

/**
 * Safe allowance status for later UI. Authenticated, read-only, no provider call and no token
 * mint. `authorizeLiveMirror` remains the authoritative quota decision.
 */
export const status = query({
  args: {},
  returns: vLiveMirrorStatus,
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("UNAUTHENTICATED", "Sign in to continue.");
    const user = await getByClerkId(ctx, identity.subject);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    return readLiveMirrorStatus(ctx, user);
  },
});

/**
 * Mint a narrowly scoped Decart client token for a paid Fitcheck user with remaining monthly
 * sessions. Takes no arguments: identity comes from the verified Clerk session and every token
 * restriction (model, lifetime, session cap) is a server constant. Monthly usage is consumed
 * when a usable token is returned. The permanent DECART_API_KEY is read from server env only
 * and is never returned, logged, or stored.
 *
 * Transport note: this is a Convex action, not an HTTP route. Calls travel over the
 * Convex client transport with the Clerk JWT, so there is no browser CORS surface and no
 * extension-origin allowlist is needed for this step.
 */
export const authorizeLiveMirror = action({
  args: {},
  returns: vLiveMirrorAuthorization,
  handler: async (ctx): Promise<LiveMirrorAuthorization> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("UNAUTHENTICATED", "Sign in to continue.");
    // Reservation runs before any provider call so billing, quota, config, or global-cap
    // failures never mint a token.
    const reservation = await ctx.runMutation(internal.liveMirror.reserveLiveMirrorSession, {
      clerkId: identity.subject,
    });
    // Config errors stay loud (plain Error, the requireEnv convention) and fail closed. The
    // reservation is provider-independent; a missing DECART_API_KEY is a deployment defect, not
    // a consumed session, so release exactly as for any pre-token failure below.
    const apiKey = requireEnv("DECART_API_KEY");
    const releaseReservation = () =>
      ctx.runMutation(internal.liveMirror.finalizeLiveMirrorSession, {
        sessionId: reservation.sessionId,
        outcome: "provider_failed",
      });
    let response: Response;
    try {
      response = await fetch(`${DECART_API_BASE}${DECART_CLIENT_TOKENS_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
        body: clientTokenRequestBody(reservation.sessionSeconds),
        signal: AbortSignal.timeout(DECART_REQUEST_TIMEOUT_MS),
      });
    } catch {
      await releaseReservation();
      throw appError("UPSTREAM_FAILED", "Live Mirror is temporarily unavailable. Please try again.");
    }
    if (!response.ok) {
      await releaseReservation();
      throw appError("UPSTREAM_FAILED", "Live Mirror is temporarily unavailable. Please try again.");
    }
    let token: string;
    try {
      token = parseClientTokenResponse(await response.json().catch(() => null));
    } catch (error) {
      await releaseReservation();
      throw error;
    }
    const completed = await ctx.runMutation(internal.liveMirror.finalizeLiveMirrorSession, {
      sessionId: reservation.sessionId,
      outcome: "authorized",
    });
    return {
      token,
      expiresIn: LIVE_MIRROR_TOKEN_EXPIRES_IN_SECONDS,
      sessionSeconds: reservation.sessionSeconds,
      model: reservation.model,
      sessionId: reservation.sessionId,
      monthlyAllowanceSessions: completed.monthlyAllowanceSessions,
      remainingSessions: completed.remainingSessions,
    };
  },
});
