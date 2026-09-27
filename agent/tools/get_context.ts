import { defineTool } from "eve/tools";
import { z } from "zod";
import { api, convex, serviceArgs } from "../lib/convex";

export default defineTool({
  description:
    "The user's styling preferences (presentation, fit, colours they avoid, home city), how many " +
    "avatars they have set up, and their current credit balance. Call this once early in a " +
    "conversation so your suggestions respect their preferences and you know what renders will cost them.",
  inputSchema: z.object({}),
  label: { start: () => "Reading preferences" },
  async execute(_input, ctx) {
    const context = await convex().query(api.agent.getContext, serviceArgs(ctx));
    return {
      name: context.name,
      prefs: context.prefs,
      avatarCount: context.avatarCount,
      credits: {
        total: context.balance.total,
        remainingToday: context.balance.dailyRemaining,
        plan: context.balance.plan,
        hqRenders: context.balance.features.includes("hq_renders"),
      },
    };
  },
});
