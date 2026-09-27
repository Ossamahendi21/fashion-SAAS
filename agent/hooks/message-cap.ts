import { defineHook } from "eve/hooks";
import { api, convex, convexErrorMessage, serviceArgs } from "../lib/convex";
import { resolveThreadId } from "../lib/threads";

/**
 * Stylist reasoning is free but rate limited (LIMITS.stylistMessagesPerDay). One turn is one
 * message, so the counter lives here rather than inside a tool the model may or may not call.
 * A turn is a turn: answering an `ask_question` prompt or approving a spend resumes the agent and
 * therefore counts against the cap exactly like a typed message.
 *
 * Ownership and accounting must succeed before model work starts; a retryable outage must not
 * silently turn off the free-message cap.
 */
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      await resolveThreadId(ctx);
      try {
        await convex().mutation(api.agent.recordMessage, serviceArgs(ctx));
      } catch (error) {
        const { message } = convexErrorMessage(error);
        throw new Error(message);
      }
    },
  },
});
