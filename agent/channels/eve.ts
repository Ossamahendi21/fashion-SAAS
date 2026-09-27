import { verifyToken } from "@clerk/backend";
import { extractBearerToken, localDev, routeAuth, withAuthChallenges, type AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { api, convex, optionalEnv, requiredEnv, type Id } from "../lib/convex";
import { withSessionOwnership } from "../lib/session-ownership";
import type { SessionPrincipal } from "../lib/session-auth";

/**
 * Route auth for the browser. The chat UI sends the signed-in user's Clerk session token as a
 * bearer; we verify it against Clerk and carry the Clerk user id forward as the session principal,
 * which every tool re-reads from `ctx.session.auth.current` before touching Convex.
 *
 * `CLERK_SECRET_KEY` is read through `requiredEnv`, so a deployment missing it fails loudly on the
 * first authenticated request instead of quietly falling through to `localDev()` (which would make
 * every browser user act as `AGENT_DEV_CLERK_USER_ID` in dev, and 401 everyone in production).
 *
 * Local impersonation is an explicit development-only opt-in and never accepts a rejected bearer.
 */
function clerkAuth(): AuthFn<Request> {
  return withAuthChallenges(
    async (request: Request) => {
      const token = extractBearerToken(request.headers.get("authorization"));
      if (!token) return null;

      const secretKey = requiredEnv("CLERK_SECRET_KEY");
      // Clerk verifies the token's `azp` against this list when it is set, so a token minted for
      // another origin cannot be replayed at the agent. Optional: unset in local dev.
      const authorizedParties = optionalEnv("SITE_URL", "NEXT_PUBLIC_SITE_URL");

      try {
        const payload = await verifyToken(token, {
          secretKey,
          ...(authorizedParties ? { authorizedParties: [authorizedParties] } : {}),
        });
        return {
          attributes: { clerkUserId: payload.sub, threadId: request.headers.get("x-fitcheck-thread-id") ?? "" },
          authenticator: "clerk",
          issuer: payload.iss,
          principalId: payload.sub,
          principalType: "user",
          subject: payload.sub,
        };
      } catch {
        return null;
      }
    },
    [{ scheme: "Bearer" }],
  );
}

const devAuth = localDev();
const localUserAuth: AuthFn<Request> = async (request) => {
  if (request.headers.has("authorization")) return null;
  const clerkUserId = optionalEnv("AGENT_DEV_CLERK_USER_ID");
  if (!clerkUserId) return null;
  const principal = await devAuth(request);
  return principal
    ? {
        ...principal,
        attributes: {
          ...principal.attributes,
          clerkUserId,
          threadId: request.headers.get("x-fitcheck-thread-id") ?? "",
        },
      }
    : null;
};
const auth = [clerkAuth(), localUserAuth];

function callerArgs(caller: SessionPrincipal) {
  const clerkUserId = caller.authenticator === "clerk" ? caller.principalId : caller.attributes.clerkUserId;
  if (typeof clerkUserId !== "string" || !clerkUserId) throw new Error("The stylist needs a signed-in user.");
  return { serviceKey: requiredEnv("AGENT_SERVICE_KEY"), clerkUserId };
}

export default withSessionOwnership(eveChannel({ auth }), {
  authenticate: (request) => routeAuth(request, auth),
  canAccessThread: (caller, threadId) =>
    convex().query(api.agent.assertThreadAccess, { ...callerArgs(caller), threadId }),
  canAccessSession: (caller, eveSessionId) =>
    convex().query(api.agent.assertSessionAccess, { ...callerArgs(caller), eveSessionId }),
  bindSession: (caller, threadId, eveSessionId) =>
    convex().mutation(api.agent.bindSession, {
      ...callerArgs(caller),
      threadId: threadId as Id<"threads">,
      eveSessionId,
    }),
});
