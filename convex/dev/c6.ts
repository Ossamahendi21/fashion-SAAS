import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { optionalEnv } from "../lib/env";
import { appError } from "../lib/errors";
import type { ItemAttributes } from "../model/items";
import { purgeUserBatch } from "../model/users";

/**
 * Step 7 Phase C6 — deterministic fixtures for the zero-model end-to-end run.
 *
 * These are `internal*` (CLI/dashboard only, never a browser route) and refuse unless
 * ALLOW_DEV_SMOKE=1 is set on the deployment, exactly like `dev/smoke.ts`. They create a single
 * isolated test user, a fixed wardrobe and one thread, and delete them again by `clerkId`, so the
 * harness never touches a human's real wardrobe and always leaves the deployment as it found it.
 *
 * The wardrobe is deliberately fixed rather than caller-supplied: it keeps the CLI payload tiny and
 * the run reproducible. It covers tops/bottoms/dress/outerwear/shoes plus two accessory categories,
 * three formalities and the `navy`/`white` colour tokens the language layer recognises.
 */

const ALLOW_DEV_SMOKE = "ALLOW_DEV_SMOKE";

function assertEnabled(): void {
  if (optionalEnv(ALLOW_DEV_SMOKE) !== "1") {
    throw appError("FORBIDDEN", "C6 fixtures are disabled. Set ALLOW_DEV_SMOKE=1 on this deployment.");
  }
}

function attrs(
  name: string,
  category: ItemAttributes["category"],
  subcategory: string,
  colour: string,
  formality: ItemAttributes["formality"],
  season: ItemAttributes["season"],
): ItemAttributes {
  return {
    name,
    category,
    subcategory,
    colours: { primary: colour, secondary: [], hex: [] },
    pattern: "solid",
    material: "cotton",
    season,
    formality,
    description: `${colour} ${subcategory}`,
  };
}

export const C6_WARDROBE: readonly ItemAttributes[] = [
  attrs("White Tee", "top", "t-shirt", "white", "casual", ["summer", "spring"]),
  attrs("Navy Polo", "top", "polo", "navy", "smart-casual", ["summer", "spring"]),
  attrs("Black Dress Shirt", "top", "shirt", "black", "formal", ["autumn", "winter", "spring"]),
  attrs("Indigo Jeans", "bottom", "jeans", "indigo", "casual", ["autumn", "winter", "spring", "summer"]),
  attrs("Beige Chinos", "bottom", "chinos", "beige", "smart-casual", ["spring", "summer", "autumn"]),
  attrs("Black Wrap Dress", "dress", "dress", "black", "formal", ["autumn", "winter", "spring"]),
  attrs("Camel Coat", "outerwear", "coat", "camel", "smart-casual", ["autumn", "winter"]),
  attrs("Black Suit Jacket", "outerwear", "jacket", "black", "formal", ["autumn", "winter", "spring"]),
  attrs("White Sneakers", "shoes", "sneakers", "white", "casual", ["spring", "summer"]),
  attrs("Brown Boots", "shoes", "boots", "brown", "smart-casual", ["autumn", "winter"]),
  attrs("Olive Tote Bag", "bag", "tote", "olive", "casual", ["spring", "summer", "autumn"]),
  attrs("Tan Leather Belt", "accessory", "belt", "tan", "smart-casual", ["spring", "summer", "autumn"]),
];

/** Deterministic test user + fixed wardrobe + one thread. Idempotent: purges any prior content. */
export const seed = internalMutation({
  args: {
    clerkId: v.string(),
    /** false seeds a user and thread but no wardrobe, for the empty-wardrobe scenario. */
    withWardrobe: v.optional(v.boolean()),
  },
  returns: v.object({
    userId: v.id("users"),
    threadId: v.id("threads"),
    itemIds: v.array(v.id("items")),
    items: v.array(v.object({ id: v.id("items"), name: v.string(), category: v.string() })),
  }),
  handler: async (ctx, { clerkId, withWardrobe }) => {
    assertEnabled();
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique();
    if (existing) {
      while (!(await purgeUserBatch(ctx, existing._id, "content"))) {
        /* Bounded fixtures only. */
      }
      await ctx.db.delete("users", existing._id);
    }

    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      clerkId,
      email: `${clerkId}@example.test`,
      name: "C6 Fixture",
      role: "user",
      plan: "free",
      features: [],
      planCredits: 0,
      packCredits: 100,
      dailySpend: { dayKey: "", credits: 0 },
      onboardedAt: now,
      prefs: { presentation: "neutral", fit: "regular", avoidColours: [] },
      createdAt: now,
    });

    const rows: { id: Id<"items">; name: string; category: string }[] = [];
    const itemIds: Id<"items">[] = [];
    for (const attributes of withWardrobe === false ? [] : C6_WARDROBE) {
      const id = await ctx.db.insert("items", {
        userId,
        ...attributes,
        searchText: `${attributes.name} ${attributes.subcategory} ${attributes.colours.primary}`.toLowerCase(),
        status: "ready",
        wearCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      itemIds.push(id);
      rows.push({ id, name: attributes.name, category: attributes.category });
    }

    const threadId = await ctx.db.insert("threads", {
      userId,
      title: "c6-zero-model-e2e",
      lastMessageAt: now,
      createdAt: now,
    });

    return { userId, threadId, itemIds, items: rows };
  },
});

/**
 * Stores the avatar blob and inserts its row. An action only because `ctx.storage.store` is an
 * action API; it does the file write, then the insert through `attachAvatar`.
 */
export const seedAvatar = internalAction({
  args: { clerkId: v.string() },
  returns: v.object({ avatarId: v.id("avatars") }),
  handler: async (ctx, { clerkId }): Promise<{ avatarId: Id<"avatars"> }> => {
    assertEnabled();
    const user: { userId: Id<"users"> } | null = await ctx.runQuery(internal.dev.c6.findUserByClerkId, {
      clerkId,
    });
    if (!user) throw appError("NOT_FOUND", "Seed the C6 user before its avatar.");
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const storageId: Id<"_storage"> = await ctx.storage.store(new Blob([bytes], { type: "image/png" }));
    const avatarId: Id<"avatars"> = await ctx.runMutation(internal.dev.c6.attachAvatar, {
      userId: user.userId,
      storageId,
      label: "C6 Avatar",
    });
    return { avatarId };
  },
});

export const attachAvatar = internalMutation({
  args: { userId: v.id("users"), storageId: v.id("_storage"), label: v.string() },
  returns: v.id("avatars"),
  handler: async (ctx, { userId, storageId, label }) => {
    assertEnabled();
    return ctx.db.insert("avatars", {
      userId,
      storageId,
      label,
      isDefault: true,
      createdAt: Date.now(),
    });
  },
});

export const findUserByClerkId = internalQuery({
  args: { clerkId: v.string() },
  returns: v.union(v.object({ userId: v.id("users") }), v.null()),
  handler: async (ctx, { clerkId }) => {
    assertEnabled();
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique();
    return user ? { userId: user._id } : null;
  },
});

/** Deletes exactly the C6 fixture rows for a clerkId. Returns what was removed, for the report. */
export const cleanup = internalMutation({
  args: { clerkId: v.string() },
  returns: v.object({ removed: v.boolean(), batches: v.number() }),
  handler: async (ctx, { clerkId }) => {
    assertEnabled();
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique();
    if (!user) return { removed: false, batches: 0 };

    let batches = 0;
    while (!(await purgeUserBatch(ctx, user._id, "content"))) {
      batches += 1;
      if (batches > 50) throw appError("CONFLICT", "C6 content purge did not converge.");
    }
    while (!(await purgeUserBatch(ctx, user._id, "account"))) {
      batches += 1;
      if (batches > 50) throw appError("CONFLICT", "C6 account purge did not converge.");
    }
    await ctx.db.delete("users", user._id);
    return { removed: true, batches };
  },
});

/** Post-cleanup verification: rows still present for the fixture's clerkId (expected all zero). */
export const inspect = internalQuery({
  args: { clerkId: v.string() },
  returns: v.object({
    userExists: v.boolean(),
    counts: v.object({
      items: v.number(),
      avatars: v.number(),
      outfits: v.number(),
      proposals: v.number(),
      threads: v.number(),
      renders: v.number(),
      jobs: v.number(),
    }),
    total: v.number(),
  }),
  handler: async (ctx, { clerkId }) => {
    assertEnabled();
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique();
    if (!user) {
      return {
        userExists: false,
        counts: { items: 0, avatars: 0, outfits: 0, proposals: 0, threads: 0, renders: 0, jobs: 0 },
        total: 0,
      };
    }
    const items = await ctx.db
      .query("items")
      .withIndex("by_user_status", (q) => q.eq("userId", user._id).eq("status", "ready"))
      .take(200);
    const avatars = await ctx.db
      .query("avatars")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(200);
    const outfits = await ctx.db
      .query("outfits")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(200);
    const proposals = await ctx.db
      .query("proposals")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(200);
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(200);
    const renders = await ctx.db
      .query("renders")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(200);
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(200);
    const counts = {
      items: items.length,
      avatars: avatars.length,
      outfits: outfits.length,
      proposals: proposals.length,
      threads: threads.length,
      renders: renders.length,
      jobs: jobs.length,
    };
    const total =
      counts.items + counts.avatars + counts.outfits + counts.proposals + counts.threads + counts.renders + counts.jobs;
    return { userExists: true, counts, total };
  },
});