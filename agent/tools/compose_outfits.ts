import type { FunctionReturnType } from "convex/server";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { api, convex, serviceArgs, type Id } from "../lib/convex";
import { resolveThreadId } from "../lib/threads";

type Output = {
  threadId: Id<"threads">;
  saved: number;
  results: FunctionReturnType<typeof api.agent.composeOutfits>;
};

const itemId = z.string().trim().describe("An exact item id returned by get_wardrobe; never a garment name.");
const optionalItemId = itemId.nullish().describe("An owned item id, or null when this slot is unused.");

const slots = z.object({
  outerwear: optionalItemId,
  top: optionalItemId,
  bottom: optionalItemId,
  dress: optionalItemId.describe("Usually null. Only set a dress when it replaces both top and bottom."),
  shoes: optionalItemId,
  accessories: z
    .array(itemId.nullable())
    .max(4)
    .nullish()
    .describe("Accessories, bags and headwear. Pass [] for none."),
});

export default defineTool({
  description:
    "Create one to three outfit proposals, respecting the user's requested number, so they appear as cards. Every id must come " +
    "from get_wardrobe. All individual slots are optional: a top, bottom and shoes need no dress. " +
    "Use null for unused slots and [] for no accessories. A dress replaces top and bottom. The result echoes " +
    "each outfit with the items it resolved and a `problems` list — if an outfit has problems it " +
    "was not saved, so fix the picks and call this again before telling the user about it.",
  inputSchema: z.object({
    brief: z.string().min(1).describe("The request in one line, e.g. 'Smart dinner in Lisbon, warm evening'."),
    outfits: z
      .array(
        z.object({
          name: z.string().min(1).describe("Short and memorable, e.g. 'Navy and stone'."),
          slots,
          reasoning: z.string().min(1).describe("One or two sentences on the colour pairing and the layering."),
          occasion: z.string().nullable().optional(),
        }),
      )
      .min(1)
      .max(3),
  }),
  label: {
    start: ({ outfits }) => `Putting together ${outfits.length} ${outfits.length === 1 ? "outfit" : "outfits"}`,
    complete: (_input, output: Output) =>
      output.saved === output.results.length
        ? `Proposed ${output.saved} ${output.saved === 1 ? "outfit" : "outfits"}`
        : `Proposed ${output.saved} of ${output.results.length} outfits`,
  },
  async execute({ brief, outfits }, ctx): Promise<Output> {
    const threadId = await resolveThreadId(ctx);
    let results: Output["results"];
    try {
      results = await convex().mutation(api.agent.composeOutfits, {
        ...serviceArgs(ctx),
        threadId,
        brief,
        outfits: outfits.map((outfit) => ({
          name: outfit.name,
          occasion: outfit.occasion?.trim() || undefined,
          reasoning: outfit.reasoning,
          slots: {
            ...optionalSlot("outerwear", outfit.slots.outerwear),
            ...optionalSlot("top", outfit.slots.top),
            ...optionalSlot("bottom", outfit.slots.bottom),
            ...optionalSlot("dress", outfit.slots.dress),
            ...optionalSlot("shoes", outfit.slots.shoes),
            accessories: (outfit.slots.accessories ?? [])
              .map((id) => id?.trim())
              .filter((id): id is Id<"items"> => Boolean(id)),
          },
        })),
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ArgumentValidationError")) throw error;
      results = outfits.map((outfit) => ({
        outfitId: null,
        name: outfit.name,
        items: [],
        problems: [
          "Nothing was saved because an item id was invalid. Call get_wardrobe and retry with its exact ids. Use null for unused slots; a dress is never required for an outfit with a top and bottom.",
        ],
      }));
    }

    return {
      threadId,
      saved: results.filter((result) => result.outfitId !== null).length,
      results,
    };
  },
});

function optionalSlot<K extends "outerwear" | "top" | "bottom" | "dress" | "shoes">(
  slot: K,
  value: string | null | undefined,
): Partial<Record<K, Id<"items">>> {
  const id = value?.trim();
  return id ? ({ [slot]: id as Id<"items"> } as Record<K, Id<"items">>) : {};
}
