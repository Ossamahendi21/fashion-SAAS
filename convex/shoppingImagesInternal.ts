import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { appError } from "./lib/errors";
import { getByClerkId } from "./model/users";

/**
 * Non-Node counterparts of shoppingImages (the "use node" file holds actions only):
 * the auth step and the blob-reference check that must run in a mutation/query.
 */

export const resolveFetchUser = internalQuery({
  args: { clerkId: v.string() },
  returns: v.object({ userId: v.id("users") }),
  handler: async (ctx, { clerkId }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    return { userId: user._id };
  },
});

export const discardUnreferenced = internalMutation({
  args: { clerkId: v.string(), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { clerkId, storageId }) => {
    const user = await getByClerkId(ctx, clerkId);
    if (!user) throw appError("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
    const referencing = await ctx.db
      .query("uploads")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first();
    if (!referencing) await ctx.storage.delete(storageId).catch(() => {});
    return null;
  },
});