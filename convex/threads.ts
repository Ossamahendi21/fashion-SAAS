import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { markOutfitSaved, requireOutfit, toOutfitView } from "./model/outfits";
import {
  createThread,
  linkSession as linkThreadSession,
  listForUser,
  listProposals,
  removeThread,
  requireThread,
  toThreadView,
} from "./model/threads";
import { vOutfitView, vThreadView } from "./views";

export const list = query({
  args: {},
  returns: v.array(vThreadView),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return (await listForUser(ctx, user._id)).map(toThreadView);
  },
});

/**
 * Takes the raw id from the URL: a malformed, unknown or foreign id returns `null` so the route can
 * render a not-found page instead of throwing a validator error at the error boundary.
 */
export const get = query({
  args: { threadId: v.string() },
  returns: v.union(vThreadView, v.null()),
  handler: async (ctx, { threadId }) => {
    const user = await requireUser(ctx);
    const id = ctx.db.normalizeId("threads", threadId);
    if (!id) return null;
    const thread = await ctx.db.get(id);
    if (!thread || thread.userId !== user._id) return null;
    return toThreadView(thread);
  },
});

export const create = mutation({
  args: { title: v.optional(v.string()) },
  returns: v.id("threads"),
  handler: async (ctx, { title }) => {
    const user = await requireUser(ctx);
    return createThread(ctx, user, { title });
  },
});

/** Persists only the cursor; the Eve server establishes the immutable session binding. */
export const linkSession = mutation({
  args: { threadId: v.id("threads"), eveSessionId: v.string(), streamIndex: v.number() },
  returns: v.null(),
  handler: async (ctx, { threadId, eveSessionId, streamIndex }) => {
    const user = await requireUser(ctx);
    const thread = await requireThread(ctx, user, threadId);
    await linkThreadSession(ctx, thread, eveSessionId, streamIndex);
    return null;
  },
});

export const rename = mutation({
  args: { threadId: v.id("threads"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId, title }) => {
    const user = await requireUser(ctx);
    const thread = await requireThread(ctx, user, threadId);
    await ctx.db.patch(thread._id, { title: title.trim() || thread.title });
    return null;
  },
});

export const remove = mutation({
  args: { threadId: v.id("threads") },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    const user = await requireUser(ctx);
    const thread = await requireThread(ctx, user, threadId);
    await removeThread(ctx, thread);
    return null;
  },
});

/** Outfits the stylist proposed in this thread, newest first, with any render job attached. */
export const proposals = query({
  args: { threadId: v.id("threads") },
  returns: v.array(
    v.object({
      _id: v.id("proposals"),
      outfit: vOutfitView,
      jobId: v.optional(v.id("jobs")),
      /** Set once the proposal has been kept, so the card can show "Saved" instead of the button. */
      savedAt: v.optional(v.number()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { threadId }) => {
    const user = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.userId !== user._id) return [];
    const rows = await listProposals(ctx, thread._id);
    const views = await Promise.all(
      rows.map(async (row) => {
        const outfit = await ctx.db.get(row.outfitId);
        if (!outfit || outfit.userId !== user._id) return null;
        return {
          _id: row._id,
          outfit: await toOutfitView(ctx, outfit),
          jobId: row.jobId,
          savedAt: outfit.savedAt,
          createdAt: row.createdAt,
        };
      }),
    );
    return views.filter((view): view is NonNullable<typeof view> => view !== null);
  },
});

/**
 * Keeps an agent proposal in /outfits. The stylist can do this itself through `agent.saveOutfit`;
 * this is the same step taken straight from the proposal card, so saving never costs a chat turn.
 */
export const saveProposal = mutation({
  args: { outfitId: v.id("outfits") },
  returns: v.null(),
  handler: async (ctx, { outfitId }) => {
    const user = await requireUser(ctx);
    const outfit = await requireOutfit(ctx, user, outfitId);
    await markOutfitSaved(ctx, outfit);
    return null;
  },
});
