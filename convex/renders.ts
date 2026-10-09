import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOnboarded, requireUser } from "./lib/auth";
import { assertFreshBilling, hasCurrentFeature } from "./model/credits";
import { appError } from "./lib/errors";
import { layeredItems, toItemSummary, toOutfitView } from "./model/outfits";
import { assertJobFinished } from "./model/jobs";
import {
  findByShareToken,
  listByOutfit as listRendersByOutfit,
  removeRender,
  requireRender,
  startRenderJob,
  toRenderView,
} from "./model/renders";
import { vRenderQuality } from "./shared/validators";
import { vItemSummary, vOutfitView, vPaginated, vRenderView } from "./views";

/**
 * Quote → reserve → create `renders` rows (status pending) → start the render workflow.
 * Throws INSUFFICIENT_CREDITS / DAILY_CAP_REACHED / SPEND_KILL_SWITCH (via shortfallError) when the
 * full amount cannot be reserved, FEATURE_LOCKED for `hq` without the `hq_renders` feature,
 * INVALID_INPUT when count > LIMITS.maxRendersPerRequest or an outfit has no items.
 * `avatarId` defaults to the user's default avatar.
 */
export const start = mutation({
  args: {
    outfitIds: v.array(v.id("outfits")),
    avatarId: v.optional(v.id("avatars")),
    count: v.number(),
    quality: vRenderQuality,
  },
  returns: v.object({ jobId: v.id("jobs"), renderIds: v.array(v.id("renders")) }),
  handler: async (ctx, args) => {
    const user = await requireOnboarded(ctx);
    return startRenderJob(ctx, user, args);
  },
});

export const listByOutfit = query({
  args: { outfitId: v.id("outfits") },
  returns: v.array(vRenderView),
  handler: async (ctx, { outfitId }) => {
    const user = await requireUser(ctx);
    const outfit = await ctx.db.get(outfitId);
    if (!outfit || outfit.userId !== user._id) return [];
    const renders = await listRendersByOutfit(ctx, outfit._id);
    return Promise.all(renders.map((render) => toRenderView(ctx, render, outfit.name)));
  },
});

/** Lookbook: newest first, done and pending renders. */
export const listMine = query({
  args: { paginationOpts: paginationOptsValidator, outfitId: v.optional(v.id("outfits")) },
  returns: vPaginated(vRenderView),
  handler: async (ctx, { paginationOpts, outfitId }) => {
    const user = await requireUser(ctx);
    if (outfitId) {
      const outfit = await ctx.db.get(outfitId);
      if (!outfit || outfit.userId !== user._id) {
        return { page: [], isDone: true, continueCursor: "" };
      }
    }
    const result = outfitId
      ? await ctx.db
          .query("renders")
          .withIndex("by_outfit", (q) => q.eq("outfitId", outfitId))
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("renders")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .order("desc")
          .paginate(paginationOpts);
    return {
      page: await Promise.all(result.page.map((render) => toRenderView(ctx, render))),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const get = query({
  args: { renderId: v.id("renders") },
  returns: v.union(v.object({ render: vRenderView, outfit: vOutfitView }), v.null()),
  handler: async (ctx, { renderId }) => {
    const user = await requireUser(ctx);
    const render = await ctx.db.get(renderId);
    if (!render || render.userId !== user._id) return null;
    const outfit = await ctx.db.get(render.outfitId);
    if (!outfit) return null;
    return { render: await toRenderView(ctx, render, outfit.name), outfit: await toOutfitView(ctx, outfit) };
  },
});

/** One more image of the same outfit/avatar/quality (1 or 3 credits) in a new job. */
export const regenerate = mutation({
  args: { renderId: v.id("renders") },
  returns: v.object({ jobId: v.id("jobs"), renderId: v.id("renders") }),
  handler: async (ctx, { renderId }) => {
    const user = await requireOnboarded(ctx);
    const render = await requireRender(ctx, user, renderId);
    await assertJobFinished(ctx, render.jobId, "retry");
    const result = await startRenderJob(ctx, user, {
      outfitIds: [render.outfitId],
      avatarId: render.avatarId,
      count: 1,
      quality: render.quality,
    });
    const created = result.renderIds[0];
    if (!created) throw appError("UPSTREAM_FAILED", "Could not queue the render.");
    return { jobId: result.jobId, renderId: created };
  },
});

/** Requires the `sharing` feature. Returns the token; idempotent. */
export const share = mutation({
  args: { renderId: v.id("renders") },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, { renderId }) => {
    const user = await requireUser(ctx);
    assertFreshBilling(user);
    if (!hasCurrentFeature(user, "sharing")) {
      throw appError("FEATURE_LOCKED", "Sharing is part of the Pro plan.", { feature: "sharing" });
    }
    const render = await requireRender(ctx, user, renderId);
    if (render.status !== "done" || !render.storageId) {
      throw appError("INVALID_INPUT", "Wait for the render to finish before sharing it.");
    }
    if (render.shareToken) return { token: render.shareToken };
    const token = crypto.randomUUID();
    await ctx.db.patch(render._id, { shareToken: token });
    return { token };
  },
});

export const unshare = mutation({
  args: { renderId: v.id("renders") },
  returns: v.null(),
  handler: async (ctx, { renderId }) => {
    const user = await requireUser(ctx);
    const render = await requireRender(ctx, user, renderId);
    if (render.shareToken) await ctx.db.patch(render._id, { shareToken: undefined });
    return null;
  },
});

/** Public. Null when the token is unknown or revoked. */
export const getShared = query({
  args: { token: v.string() },
  returns: v.union(
    v.object({ url: v.string(), outfitName: v.string(), items: v.array(vItemSummary), createdAt: v.number() }),
    v.null(),
  ),
  handler: async (ctx, { token }) => {
    const render = await findByShareToken(ctx, token);
    if (!render || render.status !== "done" || !render.storageId) return null;
    const url = await ctx.storage.getUrl(render.storageId);
    if (!url) return null;
    const outfit = await ctx.db.get(render.outfitId);
    const layered = outfit ? await layeredItems(ctx, outfit.slots) : [];
    return {
      url,
      outfitName: outfit?.name ?? "Outfit",
      items: await Promise.all(layered.map(({ item }) => toItemSummary(ctx, item))),
      createdAt: render.createdAt,
    };
  },
});

export const remove = mutation({
  args: { renderId: v.id("renders") },
  returns: v.null(),
  handler: async (ctx, { renderId }) => {
    const user = await requireUser(ctx);
    const render = await requireRender(ctx, user, renderId);
    await removeRender(ctx, render);
    return null;
  },
});
