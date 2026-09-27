import type { FunctionReturnType } from "convex/server";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { api, convex, serviceArgs } from "../lib/convex";

type Output = FunctionReturnType<typeof api.agent.gapAnalysis>;

export default defineTool({
  description:
    "What this wardrobe cannot dress: how many items sit in each category, which seasons and " +
    "formality levels are covered, how the colours are spread, and a plain list of concrete gaps " +
    "such as 'no shoes' or 'no outerwear for winter'. Call it when the user asks what they are " +
    "missing or what to buy next, or when a brief cannot be met from what they own — so you can " +
    "name the missing piece instead of suggesting something they do not have.",
  inputSchema: z.object({}),
  label: {
    start: () => "Checking wardrobe gaps",
    complete: (_input, output: Output) =>
      output.gaps.length === 0
        ? "No obvious gaps"
        : `Found ${output.gaps.length} ${output.gaps.length === 1 ? "gap" : "gaps"}`,
  },
  async execute(_input, ctx): Promise<Output> {
    return convex().query(api.agent.gapAnalysis, serviceArgs(ctx));
  },
});
