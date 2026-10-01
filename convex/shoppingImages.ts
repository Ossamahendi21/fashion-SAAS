"use node";

import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";
import { appError } from "./lib/errors";
import { fetchRemoteImage, type ResolveHost } from "./lib/imageFetch";

/**
 * Server-side shopping-image fetch (Original Step 3, Requirement A).
 *
 * Replaces the background worker's retailer fetch. The browser supplies ONLY the remote
 * public URL; identity comes from the verified Clerk session, and every fetch runs
 * through the SSRF gate in lib/imageFetch (hostname checks + DNS classification of
 * every resolved address + manual redirect re-validation, size caps, raster-only MIME,
 * no cookies). No userId/plan input, no retailer auth, no forwarded headers, no
 * provider call, no credit/quota touch — pure image transport.
 *
 * Payload design: the fetched bytes are stored as a Convex storage blob and the action
 * returns the storage id + metadata + a bearer download URL (small return value, never
 * multi-megabyte inline payloads). The save path registers that SAME storage id with
 * shoppingImports:register, so no second upload and no second asset are created; the
 * try-on path downloads the bytes for local normalization. Blobs that are never
 * registered (try-on without save, failed save) are removed via discardFetch, which
 * deletes only blobs no uploads row references.
 */

export const vRemoteFetchResult = v.object({
  storageId: v.id("_storage"),
  mimeType: v.union(v.literal("image/jpeg"), v.literal("image/png"), v.literal("image/webp")),
  sizeBytes: v.number(),
  /** Bearer Convex storage URL for downloading the bytes (public retailer image bytes). */
  downloadUrl: v.string(),
});

export type RemoteFetchResult = Infer<typeof vRemoteFetchResult>;

/** Production DNS: every A/AAAA record, so one clean record cannot hide a dirty sibling. */
export const nodeResolveHost: ResolveHost = async (hostname) => {
  const { resolve4, resolve6 } = await import("node:dns/promises");
  const settled = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses: string[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") addresses.push(...result.value);
  }
  if (addresses.length === 0) {
    const first = settled.find((result) => result.status === "rejected");
    throw first && "reason" in first ? first.reason : new Error(`DNS lookup failed for ${hostname}`);
  }
  return addresses;
};

/** Fetch one remote shopping image into server-owned storage. Authenticated, meter-free. */
export const fetchRemote = action({
  args: { url: v.string() },
  returns: vRemoteFetchResult,
  handler: async (ctx, { url }): Promise<RemoteFetchResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("UNAUTHENTICATED", "Sign in to continue.");
    await ctx.runQuery(internal.shoppingImagesInternal.resolveFetchUser, { clerkId: identity.subject });
    let storageId: Id<"_storage"> | null = null;
    try {
      const fetched = await fetchRemoteImage(url, { resolveHost: nodeResolveHost });
      // Copy into a fresh Uint8Array over a plain ArrayBuffer: the typed array from fetch may
      // be a Uint8Array<ArrayBufferLike>, which the Blob constructor's typing rejects.
      const bytes = new Uint8Array(fetched.bytes);
      storageId = await ctx.storage.store(new Blob([bytes], { type: fetched.mimeType }));
      const downloadUrl = await ctx.storage.getUrl(storageId);
      if (!downloadUrl) throw appError("UPSTREAM_FAILED", "That image could not be stored. Try again.");
      return {
        storageId,
        mimeType: fetched.mimeType,
        sizeBytes: fetched.bytes.byteLength,
        downloadUrl,
      };
    } catch (error) {
      // A stored blob that never reaches a response is garbage by construction: remove it
      // now (mirror demoWardrobe.seed cleanup) so failures leave no orphans behind.
      if (storageId) await ctx.storage.delete(storageId).catch(() => {});
      throw error;
    }
  },
});

/**
 * Remove one server-fetched blob that was never registered. Deletes ONLY when no
 * uploads row references the storage id (see by_storage); a registered import (any
 * owner) is never touched, and an unknown id is a silent no-op (existence is not leaked).
 */
export const discardFetch = action({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { storageId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("UNAUTHENTICATED", "Sign in to continue.");
    await ctx.runMutation(internal.shoppingImagesInternal.discardUnreferenced, {
      clerkId: identity.subject,
      storageId,
    });
    return null;
  },
});
