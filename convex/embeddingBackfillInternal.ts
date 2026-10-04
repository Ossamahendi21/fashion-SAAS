/**
 * Step 7 Phase C — the internal reads and the single write behind the BGE backfill.
 *
 * These live apart from `embeddingBackfill.ts` because that file is `"use node"` (it embeds over
 * HTTP), and a Node module may only export actions. Nothing here touches Node APIs, so this module
 * can run on Convex's normal runtime.
 *
 * Every function is internal: the operator-facing entrypoint is the key-guarded `runBackfill`
 * action, so no client can read wardrobe embedding text or write vectors by guessing a name.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { setItemEmbeddingBge } from "./model/items";
import { embeddingText } from "./shared/embeddingText";

/** Hard ceiling on one page, so a mistaken argument can never turn into a table-wide read. */
export const MAX_BACKFILL_PAGE_SIZE = 64;

export type BackfillRow = {
  embeddingId: Id<"itemEmbeddings">;
  itemId: Id<"items">;
  /** Reconstructed through `shared/embeddingText`, the same function ingest uses. */
  text: string;
  /** True when the row already had a BGE vector and is therefore skipped. */
  hasBge: boolean;
};

export const vBackfillRow = v.object({
  embeddingId: v.id("itemEmbeddings"),
  itemId: v.id("items"),
  text: v.string(),
  hasBge: v.boolean(),
});

/**
 * Rebuilds the embedding text for each row from the item doc, so the backfill embeds exactly the
 * string ingest would embed today. A row whose item has been deleted comes back with empty text: the
 * caller counts it as a failure and cannot write it, and no cursor ever stalls on it.
 */
async function buildRows(
  ctx: QueryCtx,
  docs: Doc<"itemEmbeddings">[],
): Promise<BackfillRow[]> {
  const rows: BackfillRow[] = [];
  for (const doc of docs) {
    const item = await ctx.db.get(doc.itemId);
    rows.push({
      embeddingId: doc._id,
      itemId: doc.itemId,
      text: item
        ? embeddingText({
            name: item.name,
            category: item.category,
            subcategory: item.subcategory,
            colours: item.colours,
            pattern: item.pattern,
            material: item.material,
            description: item.description,
          })
        : "",
      hasBge: Array.isArray(doc.embeddingBge) && doc.embeddingBge.length > 0,
    });
  }
  return rows;
}

/** One page of `itemEmbeddings` rows for a forward cursor walk of the table. */
export const backfillPage = internalQuery({
  args: { cursor: v.optional(v.string()), pageSize: v.optional(v.number()) },
  returns: v.object({
    rows: v.array(vBackfillRow),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ rows: BackfillRow[]; continueCursor: string | null; isDone: boolean }> => {
    const numItems = Math.min(Math.max(args.pageSize ?? 32, 1), MAX_BACKFILL_PAGE_SIZE);
    const page = await ctx.db
      .query("itemEmbeddings")
      .withIndex("by_item")
      .paginate({ cursor: args.cursor ?? null, numItems });
    return {
      rows: await buildRows(ctx, page.page),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * The rows for an explicit retry batch, built exactly like `backfillPage` builds them so a retried
 * row embeds the identical text. Ids with no `itemEmbeddings` doc are dropped: there is nothing to
 * patch.
 */
export const backfillRowsByIds = internalQuery({
  args: { itemIds: v.array(v.id("items")) },
  returns: v.object({ rows: v.array(vBackfillRow), isDone: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ rows: BackfillRow[]; isDone: boolean }> => {
    const docs: Doc<"itemEmbeddings">[] = [];
    for (const itemId of args.itemIds) {
      const doc = await ctx.db
        .query("itemEmbeddings")
        .withIndex("by_item", (q) => q.eq("itemId", itemId))
        .unique();
      if (doc !== null) docs.push(doc);
    }
    return { rows: await buildRows(ctx, docs), isDone: true };
  },
});

/** The only write the backfill performs, and it patches `embeddingBge` alone. */
export const writeEmbeddingBge = internalMutation({
  args: { itemId: v.id("items"), embeddingBge: v.array(v.float64()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await setItemEmbeddingBge(ctx, args.itemId, args.embeddingBge);
    return null;
  },
});

/**
 * Table-wide count of rows still missing `embeddingBge`, for cutover step E ("no missing rows").
 * Paged so a large wardrobe cannot blow a single read's limits.
 */
export const countMissingBge = internalQuery({
  args: v.object({}),
  returns: v.object({ missing: v.number(), total: v.number() }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let missing = 0;
    let total = 0;
    do {
      const page = await ctx.db
        .query("itemEmbeddings")
        .withIndex("by_item")
        .paginate({ cursor, numItems: MAX_BACKFILL_PAGE_SIZE });
      for (const row of page.page) {
        total += 1;
        if (!Array.isArray(row.embeddingBge) || row.embeddingBge.length === 0) missing += 1;
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    return { missing, total };
  },
});