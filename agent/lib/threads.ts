import type { SessionContext } from "eve/tools";
import { api, convex, serviceArgs, type Id } from "./convex";

/**
 * Every eve session maps to one `threads` row, so proposals and render jobs land where the chat UI
 * is already subscribed. `ctx.session.id` is the durable session id the browser also persists.
 */
export async function resolveThreadId(ctx: SessionContext): Promise<Id<"threads">> {
  const threadId = ctx.session.auth.initiator?.attributes.threadId;
  if (typeof threadId !== "string" || !threadId) throw new Error("Start a new conversation from the Stylist page.");
  return convex().mutation(api.agent.resolveThread, {
    ...serviceArgs(ctx),
    eveSessionId: ctx.session.id,
    threadId: threadId as Id<"threads">,
  });
}
