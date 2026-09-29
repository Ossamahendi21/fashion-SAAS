import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { readShoppingImportStatus, registerShoppingImport } from "./model/shoppingImports";

/**
 * Shopping imports: the extension's "Save to wardrobe" path. Authenticated Convex functions
 * only — no HTTP endpoint. Saving needs a signed-in user but no paid plan and no Live Mirror
 * session; extraction spends the normal wardrobe credits through the existing pipeline.
 */

export const vShoppingImportState = v.union(
  v.literal("processing"),
  v.literal("ready"),
  v.literal("needs_credits"),
  v.literal("no_item"),
  v.literal("failed"),
);

export const vShoppingImportStatus = v.object({
  state: vShoppingImportState,
  uploadId: v.id("uploads"),
  jobId: v.optional(v.id("jobs")),
  itemId: v.optional(v.id("items")),
  itemName: v.optional(v.string()),
  itemUrl: v.optional(v.string()),
  duplicateOfId: v.optional(v.id("items")),
});

/**
 * Registers one shopping image for import. Idempotent per (authenticated user, clientImportId):
 * a retry returns the existing upload/job instead of starting another import. All metadata is
 * untrusted and validated server-side; only the uploaded Convex storage blob is processed.
 */
export const register = mutation({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    productTitle: v.optional(v.string()),
    sourcePageUrl: v.optional(v.string()),
    clientImportId: v.string(),
  },
  returns: v.object({ uploadId: v.id("uploads"), jobId: v.id("jobs"), deduped: v.boolean() }),
  handler: async (ctx, args) => registerShoppingImport(ctx, await requireUser(ctx), args),
});

/** Small product-focused import status. Ownership enforced; provider internals never exposed. */
export const status = query({
  args: { uploadId: v.id("uploads") },
  returns: vShoppingImportStatus,
  handler: async (ctx, { uploadId }) =>
    readShoppingImportStatus(ctx, await requireUser(ctx), uploadId),
});
