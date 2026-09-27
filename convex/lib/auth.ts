import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireEnv } from "./env";
import { appError } from "./errors";
import { roleFromClerkMetadata } from "../model/users";

type Ctx = QueryCtx | MutationCtx;

export async function getCurrentUser(ctx: Ctx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();
}

/** The signed-in user's document. Throws UNAUTHENTICATED when signed out or not yet stored. */
export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw appError("UNAUTHENTICATED", "Sign in to continue.");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();
  if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
  return user;
}

export async function requireAdmin(ctx: Ctx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  const identity = await ctx.auth.getUserIdentity();
  const currentRole = roleFromClerkMetadata(identity?.public_metadata ?? identity?.metadata);
  if (user.role !== "admin" || currentRole !== "admin") throw appError("FORBIDDEN", "Admins only.");
  return user;
}

export async function requireOnboarded(ctx: Ctx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!user.onboardedAt) throw appError("ONBOARDING_REQUIRED", "Add an avatar photo first.");
  return user;
}

/** Service-to-service auth for the stylist agent: a shared secret plus the Clerk user id it acts for. */
export async function requireServiceUser(
  ctx: Ctx,
  args: { serviceKey: string; clerkUserId: string },
): Promise<Doc<"users">> {
  if (!safeEqual(args.serviceKey, requireEnv("AGENT_SERVICE_KEY"))) {
    throw appError("FORBIDDEN", "Invalid service key.");
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkUserId))
    .unique();
  if (!user) throw appError("NOT_FOUND", "Unknown user.");
  return user;
}

export function assertOwner<T extends { userId: Id<"users"> }>(doc: T | null, user: Doc<"users">, what = "item"): T {
  if (!doc || doc.userId !== user._id) throw appError("NOT_FOUND", `That ${what} doesn't exist.`);
  return doc;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
