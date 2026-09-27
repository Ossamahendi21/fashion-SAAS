import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalQuery } from "./_generated/server";
import { optionalEnv, requireEnv } from "./lib/env";
import { appError } from "./lib/errors";
import { getByClerkId } from "./model/users";
import { vPlanId } from "./shared/validators";
import {
  clientTokenRequestBody,
  DECART_API_BASE,
  DECART_CLIENT_TOKENS_PATH,
  DECART_REQUEST_TIMEOUT_MS,
  decideLiveMirrorEntitlement,
  LIVE_MIRROR_MODEL,
  LIVE_MIRROR_TOKEN_EXPIRES_IN_SECONDS,
  parseClientTokenResponse,
  parseSessionCap,
} from "./liveMirror/decart";

export const vLiveMirrorAuthorization = v.object({
  token: v.string(),
  expiresIn: v.number(),
  sessionSeconds: v.number(),
  model: v.string(),
});

type LiveMirrorAuthorization = Infer<typeof vLiveMirrorAuthorization>;

/**
 * Server-side Live Mirror entitlement. Internal only: the public action derives the Clerk
 * id from the verified session (never from client input), so callers cannot supply a user,
 * plan, model, or session duration. Auth is passed explicitly as an argument because
 * scheduler-invoked functions cannot rely on propagated session auth.
 */
export const checkEntitlement = internalQuery({
  args: { clerkId: v.string() },
  returns: v.object({ plan: vPlanId, sessionSeconds: v.number() }),
  handler: async (ctx, { clerkId }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    const { plan } = decideLiveMirrorEntitlement(user);
    const sessionSeconds = parseSessionCap(optionalEnv("LIVE_MIRROR_SESSION_MAX_SECONDS"));
    return { plan, sessionSeconds };
  },
});

/**
 * Mint a narrowly scoped Decart client token for a paid Fitcheck user. Takes no arguments:
 * identity comes from the verified Clerk session and every token restriction (model,
 * lifetime, session cap) is a server constant. The permanent DECART_API_KEY is read from
 * server env only and is never returned, logged, or stored.
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
    // Runs before any provider call so billing or config failures never mint a token.
    const { sessionSeconds }: { sessionSeconds: number } = await ctx.runQuery(
      internal.liveMirror.checkEntitlement,
      { clerkId: identity.subject },
    );
    // Config errors stay loud (plain Error, the requireEnv convention) and fail closed.
    const apiKey = requireEnv("DECART_API_KEY");
    let response: Response;
    try {
      response = await fetch(`${DECART_API_BASE}${DECART_CLIENT_TOKENS_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
        body: clientTokenRequestBody(sessionSeconds),
        signal: AbortSignal.timeout(DECART_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw appError("UPSTREAM_FAILED", "Live Mirror is temporarily unavailable. Please try again.");
    }
    if (!response.ok) {
      throw appError("UPSTREAM_FAILED", "Live Mirror is temporarily unavailable. Please try again.");
    }
    const token = parseClientTokenResponse(await response.json().catch(() => null));
    return {
      token,
      expiresIn: LIVE_MIRROR_TOKEN_EXPIRES_IN_SECONDS,
      sessionSeconds,
      model: LIVE_MIRROR_MODEL,
    };
  },
});
