import type { FunctionReturnType } from "convex/server";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { CATEGORIES, SEASONS } from "../../convex/shared/wardrobe";
import { api, convex, serviceArgs } from "../lib/convex";

type Output = {
  count: number;
  items: FunctionReturnType<typeof api.agent.getWardrobe>;
  note?: string;
};

export default defineTool({
  description:
    "List the clothes the signed-in user actually owns, with their colours, material, season and formality. " +
    "Call this before naming any garment: every outfit must be built from the ids it returns. " +
    "Filter by category or season to keep the list short when the brief is narrow.",
  inputSchema: z.object({
    category: z.enum(CATEGORIES).optional().describe("Only return items in this category."),
    season: z.enum(SEASONS).optional().describe("Only return items suited to this season."),
  }),
  label: {
    start: ({ category, season }) =>
      category || season ? `Reading wardrobe (${[category, season].filter(Boolean).join(", ")})` : "Reading wardrobe",
    complete: (_input, output: Output) => `Read ${output.count} wardrobe ${output.count === 1 ? "item" : "items"}`,
  },
  async execute({ category, season }, ctx): Promise<Output> {
    const items = await convex().query(api.agent.getWardrobe, { ...serviceArgs(ctx), category, season });
    return {
      count: items.length,
      items,
      note:
        items.length === 0
          ? "This wardrobe is empty for that filter. Tell the user what is missing instead of inventing items."
          : undefined,
    };
  },
});
