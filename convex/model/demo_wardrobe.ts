import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { DEMO_WARDROBE, type DemoWardrobeItem } from "../shared/demo_wardrobe";
import { buildSearchText, removeItems } from "./items";
import { listActive } from "./jobs";
import { slotItemIds } from "./outfits";

type Wardrobe = DemoWardrobeItem["wardrobe"];

async function listDemoItems(ctx: QueryCtx | MutationCtx, user: Doc<"users">): Promise<Doc<"items">[]> {
  return ctx.db
    .query("items")
    .withIndex("by_user_demoKey", (q) => q.eq("userId", user._id).gt("demoKey", ""))
    .take(100);
}

export async function needsDemoSeed(ctx: QueryCtx, user: Doc<"users">, wardrobe: Wardrobe): Promise<boolean> {
  const existing = await listDemoItems(ctx, user);
  const selected = DEMO_WARDROBE.filter((item) => item.wardrobe === wardrobe);
  return (
    selected.some((sample) => !existing.some((item) => item.demoKey === sample.key)) ||
    existing.some((item) => !selected.some((sample) => sample.key === item.demoKey))
  );
}

export async function reconcileDemoItems(
  ctx: MutationCtx,
  user: Doc<"users">,
  wardrobe: Wardrobe,
  files: { key: string; storageId: Id<"_storage"> }[],
): Promise<{ added: number; removed: number }> {
  const selected = DEMO_WARDROBE.filter((item) => item.wardrobe === wardrobe);
  if (
    files.length !== selected.length ||
    new Set(files.map((file) => file.key)).size !== selected.length ||
    files.some((file) => !selected.some((sample) => sample.key === file.key))
  ) {
    throw appError("INVALID_INPUT", "Choose a complete demo wardrobe.");
  }
  const existing = await listDemoItems(ctx, user);
  const previous = existing.filter((item) => !selected.some((sample) => sample.key === item.demoKey));
  if (previous.length > 0) {
    const removedIds = new Set(previous.map((item) => item._id));
    const jobs = (await listActive(ctx, user._id)).filter((job) => job.type === "render");
    const outfitIds = [...new Set(jobs.flatMap((job) => job.outfitIds ?? []))];
    const outfits = await Promise.all(outfitIds.map((id) => ctx.db.get(id)));
    if (
      previous.some((item) => item.pendingJobId) ||
      outfits.some((outfit) => outfit && slotItemIds(outfit.slots).some((id) => removedIds.has(id)))
    ) {
      throw appError("ITEM_BUSY", "Wait for your current render to finish before replacing demo items.");
    }
  }
  await removeItems(
    ctx,
    user,
    previous.map((item) => item._id),
  );

  let added = 0;
  const now = Date.now();
  for (const file of files) {
    const sample = selected.find((item) => item.key === file.key);
    if (!sample) throw appError("INVALID_INPUT", "Unknown demo wardrobe item.");
    const retained = existing.find((item) => item.demoKey === sample.key);
    if (retained) {
      // Concurrent requests may download the same sample; only one keeps its file.
      if (retained.storageId !== file.storageId) await ctx.storage.delete(file.storageId);
      continue;
    }
    await ctx.db.insert("items", {
      userId: user._id,
      demoKey: sample.key,
      storageId: file.storageId,
      ...sample.attributes,
      searchText: buildSearchText(sample.attributes),
      status: "ready",
      wearCount: 0,
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
    });
    added += 1;
  }
  return { added, removed: previous.length };
}
