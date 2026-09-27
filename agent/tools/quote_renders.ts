import { defineTool } from "eve/tools";
import { z } from "zod";
import { RENDER_QUALITIES } from "../../convex/shared/credits";
import { api, convex, serviceArgs, type Id } from "../lib/convex";

export default defineTool({
  description:
    "What rendering these outfits on the user's avatar would cost in credits, and whether they can " +
    "afford it right now. Always call this before start_renders, and tell the user the number in " +
    "plain words before you ask them to approve the spend. `blockers` lists anything that would stop " +
    "the render (no avatar, HQ without the plan, too many jobs running, not enough credits) — if it " +
    "is not empty, say so and offer the cheaper shape instead of calling start_renders.",
  inputSchema: z.object({
    outfitIds: z.array(z.string().min(1)).min(1).max(3).describe("Outfit ids returned by compose_outfits."),
    perOutfit: z.number().int().min(1).max(4).describe("Images per outfit."),
    quality: z.enum(RENDER_QUALITIES).describe("`hq` costs 3 credits an image and needs the hq_renders feature."),
  }),
  label: { start: ({ outfitIds, perOutfit }) => `Quoting ${outfitIds.length * perOutfit} images` },
  async execute({ outfitIds, perOutfit, quality }, ctx) {
    await convex().action(api.subscriptions.refreshForAgent, serviceArgs(ctx));
    const quote = await convex().query(api.agent.quoteRenders, {
      ...serviceArgs(ctx),
      outfitIds: outfitIds as Id<"outfits">[],
      perOutfit,
      quality,
    });
    return { ...quote, images: new Set(outfitIds).size * perOutfit, quality };
  },
});
