"use node";

/**
 * Step 7 Phase C — the local BGE backfill for the additive `embeddingBge` migration.
 *
 * Purpose: give every item that already has an `itemEmbeddings` row a 384-d local BGE vector, so
 * `by_embeddingBge` can be switched on for shopping similarity without paying OpenAI to keep the
 * legacy index current. Cutover step D in `docs/COMBINED_ARCHITECTURE_AUDIT.md`.
 *
 * Contract, and the reasons for each part:
 *   - It embeds through `localEmbed` DIRECTLY. It never reads `EMBEDDING_PROVIDER` and never calls
 *     `embedText`, so no env value can route a backfill onto the OpenAI branch: the backfill is $0 by
 *     construction, not by configuration.
 *   - It only ever writes `embeddingBge` (via `setItemEmbeddingBge`, which asserts 384 dims and never
 *     touches `duplicateOfId` or the legacy `embedding`). Existing legacy vectors, `by_embedding` and
 *     every `duplicateOfId` value are left exactly as they are.
 *   - It is resumable and idempotent. Rows that already carry `embeddingBge` are skipped, so re-running
 *     a page is a no-op and an interrupted run continues from the cursor it returned.
 *   - It is bounded: a page of rows, bounded concurrency against the gateway (which serves one
 *     inference at a time anyway), and a bounded retry batch.
 *   - A page cursor only moves forward, so a row that failed keeps no claim on the cursor: every
 *     failure is reported by id in `failedItemIds`, and `retryItemIds` embeds exactly those rows again.
 *     That is what makes a failed row recoverable instead of silently stranded behind the cursor.
 *   - `remaining` is only exact when the caller asks for the full-table verification pass
 *     (`countRemaining`), because counting it otherwise means scanning the whole table on every page.
 *
 * Auth: a dedicated `EMBEDDING_BACKFILL_KEY` compared in constant time. Deliberately NOT
 * `AGENT_SERVICE_KEY` — this writes vectors into every user's wardrobe and must not be reachable with
 * stylist-agent credentials.
 *
 * The reads and the single write are in `./embeddingBackfillInternal.ts`: this module is `"use node"`
 * (it embeds over HTTP) and a Node module may only export actions.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";
import {
  EmbeddingError,
  localEmbed,
  localEmbeddingConfig,
  validateEmbeddingVector,
  type EmbedResult,
} from "./ai/embedding";
import { requireEnv } from "./lib/env";
import { appError } from "./lib/errors";
import type { BackfillRow } from "./embeddingBackfillInternal";

/** Hard ceilings on a single call, so a mistaken argument can never turn into a table-wide run. */
export const MAX_BACKFILL_CONCURRENCY = 4;
export const MAX_BACKFILL_RETRY_BATCH = 64;
/** Text longer than this is refused rather than silently truncated by the model's 512-token window. */
export const MAX_BACKFILL_TEXT_CHARS = 4000;

/**
 * Runs one bounded page of the backfill (or one bounded retry batch) and reports counts.
 *
 * This is a PUBLIC action, not an internal one, because an operator has to be able to drive the
 * migration from outside Convex (CLI, dashboard, or HTTP) while holding the dedicated key. It stays
 * safe because the key is checked first and every other input is hard-bounded.
 *
 * Page mode: call it repeatedly, passing the returned `nextCursor`, until `done` is true. Safe to
 * call twice on the same cursor: the second call skips everything the first one embedded. Rows that
 * failed come back in `failedItemIds`; a page cursor never revisits them.
 * Retry mode: pass `retryItemIds` (from a previous `failedItemIds`) and those exact rows are
 * re-embedded. `nextCursor` is null in retry mode, so a retry never silently continues a page.
 */
export const runBackfill = action({
  args: {
    /** Dedicated `EMBEDDING_BACKFILL_KEY`. Compared in constant time; never logged. */
    backfillKey: v.string(),
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
    concurrency: v.optional(v.number()),
    /** Set on the final verification pass to report an exact table-wide `remaining`. */
    countRemaining: v.optional(v.boolean()),
    /** Ids from a previous `failedItemIds`, to re-embed exactly those rows. */
    retryItemIds: v.optional(v.array(v.id("items"))),
  },
  returns: v.object({
    scanned: v.number(),
    embedded: v.number(),
    skipped: v.number(),
    failed: v.number(),
    remaining: v.union(v.number(), v.null()),
    done: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
    /** Item ids whose embedding failed this call; feed them back as `retryItemIds`. */
    failedItemIds: v.array(v.id("items")),
    /** Provider-side spend for this page. Always exactly 0: the local gateway is not billed. */
    costUsd: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    scanned: number;
    embedded: number;
    skipped: number;
    failed: number;
    remaining: number | null;
    done: boolean;
    nextCursor: string | null;
    failedItemIds: Id<"items">[];
    costUsd: number;
  }> => {
    if (!safeEqual(args.backfillKey, requireEnv("EMBEDDING_BACKFILL_KEY"))) {
      throw appError("FORBIDDEN", "Invalid backfill key.");
    }
    const retryIds = args.retryItemIds ?? [];
    if (retryIds.length > MAX_BACKFILL_RETRY_BATCH) {
      throw appError(
        "INVALID_INPUT",
        `retryItemIds accepts at most ${MAX_BACKFILL_RETRY_BATCH} ids.`,
      );
    }
    if (retryIds.length > 0 && args.cursor !== undefined) {
      throw appError("INVALID_INPUT", "Pass either cursor or retryItemIds, not both.");
    }
    const config = localEmbeddingConfig();
    const concurrency = Math.min(
      Math.max(args.concurrency ?? 2, 1),
      MAX_BACKFILL_CONCURRENCY,
    );
    const rows: BackfillRow[] = [];
    let isDone = false;
    let continueCursor: string | null = null;
    if (retryIds.length > 0) {
      const retryPage = await ctx.runQuery(internal.embeddingBackfillInternal.backfillRowsByIds, {
        itemIds: retryIds,
      });
      rows.push(...retryPage.rows);
      isDone = retryPage.isDone;
    } else {
      const forwardPage = await ctx.runQuery(internal.embeddingBackfillInternal.backfillPage, {
        cursor: args.cursor,
        pageSize: args.pageSize,
      });
      rows.push(...forwardPage.rows);
      isDone = forwardPage.isDone;
      continueCursor = forwardPage.continueCursor;
    }

    let scanned = 0;
    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    const failedItemIds: Id<"items">[] = [];
    let costUsd = 0;

    const pending: BackfillRow[] = [];
    for (const row of rows) {
      scanned += 1;
      if (row.hasBge) skipped += 1;
      else pending.push(row);
    }

    // Bounded concurrency: the gateway serves a single inference at a time, so a small pool just
    // avoids queueing a whole page behind one slow request. Results are consumed in page order so the
    // counts stay deterministic regardless of completion order.
    const results: Array<EmbedResult | Error | null> = new Array(pending.length).fill(null);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, pending.length) },
      async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= pending.length) return;
          const row = pending[index];
          try {
            if (row.text.trim().length === 0) {
              throw new EmbeddingError("local", "invalid-input", "Item has no embedding text.");
            }
            if (row.text.length > MAX_BACKFILL_TEXT_CHARS) {
              throw new EmbeddingError(
                "local",
                "invalid-input",
                "Embedding text is longer than the backfill limit.",
              );
            }
            results[index] = await localEmbed({ text: row.text }, config);
          } catch (error) {
            results[index] = error instanceof Error ? error : new Error(String(error));
          }
        }
      },
    );
    await Promise.all(workers);

    for (let index = 0; index < pending.length; index += 1) {
      const row = pending[index];
      const outcome = results[index];
      if (outcome === null || outcome instanceof Error) {
        // The cursor advances past failures so one bad item can never wedge the backfill, which means
        // the row must be handed back by id: `retryItemIds` is the only way it is ever re-embedded.
        failed += 1;
        failedItemIds.push(row.itemId);
        continue;
      }
      costUsd += outcome.costUsd;
      await ctx.runMutation(internal.embeddingBackfillInternal.writeEmbeddingBge, {
        itemId: row.itemId,
        // Re-asserts exactly 384 dims (from the static EMBEDDING_MODELS table) plus finiteness and
        // unit norm before the value reaches the mutation that writes it to by_embeddingBge.
        embeddingBge: validateEmbeddingVector("local", outcome.vector),
      });
      embedded += 1;
    }

    const remaining =
      args.countRemaining === true
        ? (await ctx.runQuery(internal.embeddingBackfillInternal.countMissingBge, {})).missing
        : null;
    return {
      scanned,
      embedded,
      skipped,
      failed,
      remaining,
      done: isDone,
      nextCursor: continueCursor,
      failedItemIds,
      costUsd,
    };
  },
});

/** Constant-time string comparison, the same shape as `lib/auth.ts` `safeEqual`. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}