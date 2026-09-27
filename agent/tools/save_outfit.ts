import { defineTool } from "eve/tools";
import { z } from "zod";
import { api, convex, serviceArgs, type Id } from "../lib/convex";

export default defineTool({
  description:
    "Keep a proposed outfit in the user's saved outfits so it shows up outside this chat. " +
    "Use it when they ask to save or keep a look. Renaming is optional.",
  inputSchema: z.object({
    outfitId: z.string().min(1).describe("An outfit id returned by compose_outfits."),
    name: z.string().min(1).optional().describe("A new name, if the user asked for one."),
  }),
  label: { start: ({ name }) => (name ? `Saving "${name}"` : "Saving outfit") },
  async execute({ outfitId, name }, ctx) {
    await convex().mutation(api.agent.saveOutfit, {
      ...serviceArgs(ctx),
      outfitId: outfitId as Id<"outfits">,
      name,
    });
    return { outfitId, saved: true as const };
  },
});
