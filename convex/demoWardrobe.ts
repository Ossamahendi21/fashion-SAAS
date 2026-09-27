import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { requireEnv } from "./lib/env";
import { appError } from "./lib/errors";
import { needsDemoSeed, reconcileDemoItems } from "./model/demo_wardrobe";
import { DEMO_WARDROBE } from "./shared/demo_wardrobe";

const vWardrobe = v.union(v.literal("men"), v.literal("women"));
const vSeedResult = v.object({ added: v.number(), removed: v.number() });
type SeedResult = { added: number; removed: number };

export const needsSeed = internalQuery({
  args: { wardrobe: vWardrobe },
  returns: v.boolean(),
  handler: async (ctx, { wardrobe }): Promise<boolean> => needsDemoSeed(ctx, await requireUser(ctx), wardrobe),
});

export const insert = internalMutation({
  args: { wardrobe: vWardrobe, files: v.array(v.object({ key: v.string(), storageId: v.id("_storage") })) },
  returns: vSeedResult,
  handler: async (ctx, { wardrobe, files }): Promise<SeedResult> =>
    reconcileDemoItems(ctx, await requireUser(ctx), wardrobe, files),
});

export const seed = action({
  args: { wardrobe: vWardrobe },
  returns: vSeedResult,
  handler: async (ctx, { wardrobe }): Promise<SeedResult> => {
    if (!(await ctx.runQuery(internal.demoWardrobe.needsSeed, { wardrobe }))) return { added: 0, removed: 0 };
    const siteUrl = requireEnv("SITE_URL");
    const files: { key: string; storageId: Id<"_storage"> }[] = [];
    try {
      // A complete set lets concurrent switches reconcile atomically without mixing wardrobes.
      for (const sample of DEMO_WARDROBE.filter((item) => item.wardrobe === wardrobe)) {
        const response = await fetch(new URL(sample.imagePath, siteUrl), {
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw appError("UPSTREAM_FAILED", "Demo photos could not be loaded. Try again.");
        const image = await response.blob();
        if (!["image/png", "image/jpeg", "image/webp"].includes(image.type) || image.size > 5 * 1024 * 1024) {
          throw appError("UPSTREAM_FAILED", "A demo photo could not be loaded. Try again.");
        }
        files.push({ key: sample.key, storageId: await ctx.storage.store(image) });
      }
      return await ctx.runMutation(internal.demoWardrobe.insert, { wardrobe, files });
    } catch (error) {
      await Promise.allSettled(files.map((file) => ctx.storage.delete(file.storageId)));
      throw error;
    }
  },
});
