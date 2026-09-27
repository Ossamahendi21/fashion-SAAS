import { ConvexHttpClient } from "convex/browser";
import type { SessionContext } from "eve/tools";
import { samePrincipal } from "./session-auth";

export { api } from "../../convex/_generated/api";
export type { Id } from "../../convex/_generated/dataModel";

/**
 * One HTTP client for the deployment the Next app talks to. Every call goes through
 * `convex/agent.ts`, whose functions take `{ serviceKey, clerkUserId }` and are scoped to that
 * user by `requireServiceKey` — the agent never gets an unscoped handle on the database.
 */
let client: ConvexHttpClient | undefined;

export function convex(): ConvexHttpClient {
  if (!client) client = new ConvexHttpClient(requiredEnv("NEXT_PUBLIC_CONVEX_URL"));
  return client;
}

export type ServiceArgs = { serviceKey: string; clerkUserId: string };

/**
 * The caller of the current turn, re-derived from the verified channel principal.
 * Approval is a gate, not authorization: executors call this rather than trusting tool input.
 */
export function serviceArgs(ctx: SessionContext): ServiceArgs {
  return { serviceKey: requiredEnv("AGENT_SERVICE_KEY"), clerkUserId: clerkUserId(ctx) };
}

/**
 * The Clerk user id the current turn acts for. Only two authenticators may ever produce one:
 * `clerk` (a verified bearer token, in `agent/channels/eve.ts`) and `local-dev` (the synthetic
 * `eve dev` principal). Anything else — a future OIDC or basic-auth route, a misconfigured channel —
 * would otherwise have its opaque `principalId` used as a Clerk id and silently read a stranger's
 * wardrobe or, worse, match nobody and fail deep inside a tool. Refuse it here instead.
 */
export function clerkUserId(ctx: SessionContext): string {
  const current = ctx.session.auth.current;
  if (!current) throw new Error("This tool needs a signed-in user; the session has no caller.");
  if (!samePrincipal(current, ctx.session.auth.initiator)) {
    throw new Error("Only the owner of this conversation can use its tools.");
  }

  if (current.authenticator === "clerk") {
    return current.principalId;
  }

  // `eve dev` authenticates a synthetic `local-dev` principal. Point it at a real row with
  // AGENT_DEV_CLERK_USER_ID so the tools have something to read locally.
  if (current.authenticator === "local-dev") {
    const override = process.env.AGENT_DEV_CLERK_USER_ID;
    if (override && override.length > 0) return override;
    throw new Error(
      "Local development has no Clerk user. Set AGENT_DEV_CLERK_USER_ID to a real Clerk user id in .env.local.",
    );
  }

  throw new Error(
    `The stylist only serves Clerk-authenticated callers; this session was authenticated by "${current.authenticator}".`,
  );
}

/** True for a caller eve authenticated through Clerk, as opposed to a local-dev principal. */
export function isClerkCaller(ctx: SessionContext): boolean {
  return ctx.session.auth.current?.authenticator === "clerk";
}

export function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (value === undefined) throw new Error(`Missing ${name}. Set it in .env.local.`);
  return value;
}

/** First non-empty value among `names`, or `undefined`. For settings that are allowed to be absent. */
export function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** `convex/lib/errors.ts` throws ConvexError with `{ code, message }`; unwrap it for the model. */
export function convexErrorMessage(error: unknown): { code: string; message: string } {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && "code" in data && "message" in data) {
    const { code, message } = data as { code: unknown; message: unknown };
    if (typeof code === "string" && typeof message === "string") return { code, message };
  }
  if (error instanceof Error) return { code: "UNKNOWN", message: error.message };
  return { code: "UNKNOWN", message: "Something went wrong talking to Fitcheck." };
}
