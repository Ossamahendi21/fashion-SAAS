import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertOwner } from "../lib/auth";
import { appError } from "../lib/errors";
import type { ThreadView } from "../views";

type Ctx = QueryCtx | MutationCtx;

export const DEFAULT_THREAD_TITLE = "New chat";

export function toThreadView(thread: Doc<"threads">): ThreadView {
  return {
    _id: thread._id,
    title: thread.title,
    eveSessionId: thread.eveSessionId,
    streamIndex: thread.streamIndex,
    lastMessageAt: thread.lastMessageAt,
    createdAt: thread.createdAt,
  };
}

export async function listForUser(ctx: Ctx, userId: Id<"users">): Promise<Doc<"threads">[]> {
  const threads = await ctx.db
    .query("threads")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

export async function requireThread(ctx: Ctx, user: Doc<"users">, threadId: Id<"threads">): Promise<Doc<"threads">> {
  return assertOwner(await ctx.db.get(threadId), user, "conversation");
}

export async function createThread(
  ctx: MutationCtx,
  user: Doc<"users">,
  input: { title?: string; eveSessionId?: string } = {},
): Promise<Id<"threads">> {
  const now = Date.now();
  return ctx.db.insert("threads", {
    userId: user._id,
    title: input.title?.trim() || DEFAULT_THREAD_TITLE,
    eveSessionId: input.eveSessionId,
    lastMessageAt: now,
    createdAt: now,
  });
}

/** Only a service-authenticated Eve request may establish the session ownership binding. */
export async function bindSession(
  ctx: MutationCtx,
  user: Doc<"users">,
  threadId: Id<"threads">,
  eveSessionId: string,
): Promise<Id<"threads">> {
  const thread = await requireThread(ctx, user, threadId);
  if (!eveSessionId.trim()) throw appError("INVALID_INPUT", "A conversation session is required.");
  if (thread.eveSessionId && thread.eveSessionId !== eveSessionId) {
    throw appError("CONFLICT", "This conversation already has a session. Start a new chat.");
  }
  const matches = await ctx.db
    .query("threads")
    .withIndex("by_eveSessionId", (q) => q.eq("eveSessionId", eveSessionId))
    .take(2);
  if (matches.some((match) => match._id !== thread._id)) {
    throw appError("CONFLICT", "That session is already attached to another conversation.");
  }
  await ctx.db.patch(thread._id, {
    eveSessionId,
    sessionVerifiedAt: thread.sessionVerifiedAt ?? Date.now(),
    lastMessageAt: Date.now(),
  });
  return thread._id;
}

export async function canAccessSession(ctx: Ctx, user: Doc<"users">, eveSessionId: string): Promise<boolean> {
  const matches = await ctx.db
    .query("threads")
    .withIndex("by_eveSessionId", (q) => q.eq("eveSessionId", eveSessionId))
    .take(2);
  return matches.length === 1 && matches[0].userId === user._id && matches[0].sessionVerifiedAt !== undefined;
}

/** Bind the browser's existing thread before any proposals can be written. */
export async function resolveByEveSession(
  ctx: MutationCtx,
  user: Doc<"users">,
  eveSessionId: string,
  threadId: Id<"threads">,
): Promise<Id<"threads">> {
  return bindSession(ctx, user, threadId, eveSessionId);
}

export async function linkSession(
  ctx: MutationCtx,
  thread: Doc<"threads">,
  eveSessionId: string,
  streamIndex: number,
): Promise<void> {
  if (thread.sessionVerifiedAt === undefined || thread.eveSessionId !== eveSessionId) {
    throw appError("FORBIDDEN", "This session is not attached to your conversation.");
  }
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) {
    throw appError("INVALID_INPUT", "The conversation cursor must be a non-negative integer.");
  }
  await ctx.db.patch(thread._id, {
    streamIndex: Math.max(thread.streamIndex ?? 0, streamIndex),
    lastMessageAt: Date.now(),
  });
}

export async function removeThread(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  const proposals = await listProposals(ctx, thread._id);
  for (const proposal of proposals) await ctx.db.delete("proposals", proposal._id);
  await ctx.db.delete("threads", thread._id);
}

export async function listProposals(ctx: Ctx, threadId: Id<"threads">): Promise<Doc<"proposals">[]> {
  const proposals = await ctx.db
    .query("proposals")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .order("desc")
    .collect();
  return proposals.sort((a, b) => b.createdAt - a.createdAt);
}

export async function addProposal(
  ctx: MutationCtx,
  user: Doc<"users">,
  threadId: Id<"threads">,
  outfitId: Id<"outfits">,
): Promise<Id<"proposals">> {
  return ctx.db.insert("proposals", { threadId, userId: user._id, outfitId, createdAt: Date.now() });
}
