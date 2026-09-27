import { v } from "convex/values";
import type { UserIdentity } from "convex/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { optionalEnv } from "../lib/env";
import { appError, isAppError, type ErrorCode } from "../lib/errors";
import { deleteUserRow, getByClerkId, profileFromIdentity, purgeUserBatch, upsertFromProfile } from "../model/users";
import {
  assertFreshBilling,
  adminAdjust,
  getBalance,
  grantSignupBonus,
  reconcileSubscription,
  refund,
  reserve,
} from "../model/credits";
import { createAvatar, listForUser as listAvatars, removeAvatar, replaceAvatar } from "../model/avatars";
import { createJob } from "../model/jobs";
import { dayKey } from "../shared/credits";
import { createBatch } from "../model/uploads";
import { startRenderJob } from "../model/renders";
import { createOutfit } from "../model/outfits";
import { toJobView, vJob } from "../jobs";
import { vItemView } from "../views";
import { listByUpload, toItemViews } from "../model/items";
import { listByJob } from "../model/renders";
import { vRenderQuality } from "../shared/validators";

/**
 * Dev-only helpers for exercising the pipelines without a browser or Clerk session.
 * They are `internal*`, so only the CLI / dashboard can call them:
 *
 *   npx convex run dev/smoke:seedUser '{"clerkId":"smoke"}'
 *   npx convex run dev/smoke:uploadUrl            → POST the photo there, keep the storageId
 *   npx convex run dev/smoke:ingest '{"clerkId":"smoke","storageId":"...","fileName":"a.png","mimeType":"image/png","sizeBytes":123}'
 *   npx convex run dev/smoke:job '{"jobId":"..."}'  (repeat until status is terminal)
 *
 * They spend real credits and real OpenAI money, and `seedUser` can mint an admin, so every one of
 * them refuses unless ALLOW_DEV_SMOKE=1 is set on the deployment. Production never sets it.
 */

const ALLOW_DEV_SMOKE = "ALLOW_DEV_SMOKE";

function assertSmokeEnabled(): void {
  if (optionalEnv(ALLOW_DEV_SMOKE) !== "1") {
    throw appError("FORBIDDEN", "Dev smoke helpers are disabled. Set ALLOW_DEV_SMOKE=1 on this deployment.");
  }
}

export const seedUser = internalMutation({
  args: { clerkId: v.string(), admin: v.optional(v.boolean()) },
  returns: v.id("users"),
  handler: async (ctx, { clerkId, admin }) => {
    assertSmokeEnabled();
    const user = await upsertFromProfile(ctx, {
      clerkId,
      email: `${clerkId}@example.test`,
      name: `Smoke ${clerkId}`,
      role: admin ? "admin" : "user",
    });
    if (!user.onboardedAt) await ctx.db.patch(user._id, { onboardedAt: Date.now() });
    return user._id;
  },
});

export const uploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    assertSmokeEnabled();
    return ctx.storage.generateUploadUrl();
  },
});

export const addAvatar = internalMutation({
  args: { clerkId: v.string(), storageId: v.id("_storage") },
  returns: v.id("avatars"),
  handler: async (ctx, { clerkId, storageId }) => {
    assertSmokeEnabled();
    const user = await requireSmokeUser(ctx, clerkId);
    const avatarId = await ctx.db.insert("avatars", {
      userId: user._id,
      storageId,
      label: "Smoke",
      isDefault: true,
      createdAt: Date.now(),
    });
    await ctx.db.patch(user._id, { defaultAvatarId: avatarId });
    return avatarId;
  },
});

export const ingest = internalMutation({
  args: {
    clerkId: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
  },
  returns: v.object({
    batchId: v.string(),
    uploads: v.array(v.object({ uploadId: v.id("uploads"), jobId: v.id("jobs") })),
  }),
  handler: async (ctx, { clerkId, ...file }) => {
    assertSmokeEnabled();
    const user = await requireSmokeUser(ctx, clerkId);
    return createBatch(ctx, user, [file]);
  },
});

export const job = internalQuery({
  args: { jobId: v.id("jobs") },
  returns: v.union(vJob, v.null()),
  handler: async (ctx, { jobId }) => {
    assertSmokeEnabled();
    const doc = await ctx.db.get(jobId);
    return doc ? toJobView(doc) : null;
  },
});

export const itemsOfUpload = internalQuery({
  args: { uploadId: v.id("uploads") },
  returns: v.array(vItemView),
  handler: async (ctx, { uploadId }) => {
    assertSmokeEnabled();
    return toItemViews(ctx, await listByUpload(ctx, uploadId));
  },
});

/** Builds an outfit from the given items and renders it on the user's default avatar. */
export const render = internalMutation({
  args: {
    clerkId: v.string(),
    itemIds: v.array(v.id("items")),
    count: v.optional(v.number()),
    quality: v.optional(vRenderQuality),
  },
  returns: v.object({ outfitId: v.id("outfits"), jobId: v.id("jobs"), renderIds: v.array(v.id("renders")) }),
  handler: async (ctx, { clerkId, itemIds, count, quality }) => {
    assertSmokeEnabled();
    const user = await requireSmokeUser(ctx, clerkId);
    const items = await Promise.all(itemIds.map((id) => ctx.db.get(id)));
    const slots = { accessories: [] as Id<"items">[] } as Parameters<typeof createOutfit>[2]["slots"];
    for (const item of items) {
      if (!item) continue;
      if (item.category === "outerwear" && !slots.outerwear) slots.outerwear = item._id;
      else if (item.category === "top" && !slots.top) slots.top = item._id;
      else if (item.category === "bottom" && !slots.bottom) slots.bottom = item._id;
      else if (item.category === "dress" && !slots.dress) slots.dress = item._id;
      else if (item.category === "shoes" && !slots.shoes) slots.shoes = item._id;
      else slots.accessories.push(item._id);
    }
    const outfitId = await createOutfit(ctx, user, { name: "Smoke outfit", slots });
    const started = await startRenderJob(ctx, user, {
      outfitIds: [outfitId],
      count: count ?? 1,
      quality: quality ?? "standard",
    });
    return { outfitId, ...started };
  },
});

export const rendersOfJob = internalQuery({
  args: { jobId: v.id("jobs") },
  returns: v.array(
    v.object({
      renderId: v.id("renders"),
      status: v.string(),
      url: v.union(v.string(), v.null()),
      costUsd: v.optional(v.number()),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { jobId }) => {
    assertSmokeEnabled();
    const renders = await listByJob(ctx, jobId);
    return Promise.all(
      renders.map(async (render) => ({
        renderId: render._id,
        status: render.status,
        url: render.storageId ? await ctx.storage.getUrl(render.storageId) : null,
        costUsd: render.costUsd,
        error: render.error,
      })),
    );
  },
});

async function requireSmokeUser(ctx: Parameters<typeof getByClerkId>[0], clerkId: string) {
  const user = await getByClerkId(ctx, clerkId);
  if (!user)
    throw appError("NOT_FOUND", `Seed the user first: npx convex run dev/smoke:seedUser '{"clerkId":"${clerkId}"}'`);
  return user;
}

/** Forces a share token onto a render so the public /share/[token] page can be exercised without a plan. */
export const share = internalMutation({
  args: { renderId: v.id("renders") },
  returns: v.string(),
  handler: async (ctx, { renderId }) => {
    assertSmokeEnabled();
    const render = await ctx.db.get(renderId);
    if (!render) throw appError("NOT_FOUND", "Render not found.");
    const token = render.shareToken ?? crypto.randomUUID();
    await ctx.db.patch(renderId, { shareToken: token });
    return token;
  },
});

/** Deterministic backend checks. No AI or payment requests; fixtures and aggregate changes are cleaned up. */
export const runRegressions = internalAction({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx): Promise<string[]> => {
    assertSmokeEnabled();
    const image = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1cAAAAASUVORK5CYII="),
      (char) => char.charCodeAt(0),
    );
    const storageIds: Id<"_storage">[] = [];
    try {
      storageIds.push(await ctx.storage.store(new Blob([image], { type: "image/png" })));
      storageIds.push(await ctx.storage.store(new Blob([image], { type: "image/png" })));
      storageIds.push(await ctx.storage.store(new Blob(["not an image"], { type: "text/plain" })));
      const [originalId, replacementId, invalidId] = storageIds;
      if (!originalId || !replacementId || !invalidId) throw new Error("Regression image setup failed");
      return await ctx.runMutation(internal.dev.smoke.regressions, { originalId, replacementId, invalidId });
    } finally {
      for (const storageId of storageIds) {
        if (await ctx.storage.get(storageId)) await ctx.storage.delete(storageId);
      }
    }
  },
});

export const regressions = internalMutation({
  args: { originalId: v.id("_storage"), replacementId: v.id("_storage"), invalidId: v.id("_storage") },
  returns: v.array(v.string()),
  handler: async (ctx, { originalId, replacementId, invalidId }) => {
    assertSmokeEnabled();
    const now = Date.now();
    const today = dayKey(now);
    const statsBefore = await ctx.db
      .query("dailyStats")
      .withIndex("by_day", (q) => q.eq("dayKey", today))
      .unique();
    const counterBefore = await ctx.db
      .query("systemCounters")
      .withIndex("by_day_key", (q) => q.eq("dayKey", today).eq("key", "credits_reserved"))
      .unique();
    const usersBefore = await ctx.db
      .query("systemCounters")
      .withIndex("by_day_key", (q) => q.eq("dayKey", "").eq("key", "users_total"))
      .unique();
    const checks: string[] = [];
    const check = (condition: boolean, label: string) => {
      if (!condition) throw new Error(`Regression failed: ${label}`);
      checks.push(label);
    };
    const clerkId = `regression-${crypto.randomUUID()}`;
    const created = await upsertFromProfile(ctx, { clerkId });
    const current = () => requireSmokeUser(ctx, clerkId);
    const signupAgain = await upsertFromProfile(ctx, { clerkId });
    check(
      signupAgain.packCredits === 25 && !(await grantSignupBonus(ctx, signupAgain)),
      "Signup bonus is granted once",
    );
    const snapshot = {
      plan: "pro" as const,
      features: ["sharing" as const],
      periodStart: now - 86_400_000,
      periodEnd: now + 86_400_000,
      readStartedAt: now - 30_000,
    };
    check(
      await reconcileSubscription(ctx, await current(), snapshot),
      "Verified current subscription grants the allowance",
    );
    const jobId = await createJob(ctx, await current(), { type: "render", steps: [] });
    const first = await reserve(ctx, await current(), 5, jobId);
    const retry = await reserve(ctx, await current(), 5, jobId);
    check(
      first.granted === 5 && retry.granted === 5 && (await current()).planCredits === 145,
      "Reservation retry does not charge twice",
    );
    check(
      !(await reconcileSubscription(ctx, await current(), { ...snapshot, readStartedAt: now - 20_000 })) &&
        (await current()).planCredits === 145,
      "Duplicate subscription read does not refill spent credits",
    );
    check(
      !(await reconcileSubscription(ctx, await current(), {
        plan: "free",
        features: [],
        readStartedAt: now - 25_000,
      })) && (await current()).plan === "pro",
      "A slower older SDK read cannot downgrade a newer snapshot",
    );
    const chargedJob = await ctx.db.get(jobId);
    if (!chargedJob) throw new Error("Missing regression job");
    check(
      (await refund(ctx, chargedJob, 5)) === 5 && (await refund(ctx, chargedJob, 5)) === 0,
      "Repeated refund with the same reservation state does not duplicate credits",
    );
    check(
      (await current()).planCredits === 150 && (await current()).packCredits === 25,
      "Refund restores the original credit buckets",
    );
    await reconcileSubscription(ctx, await current(), { ...snapshot, periodEnd: now - 1, readStartedAt: now - 10_000 });
    check(
      (await current()).plan === "free" && (await current()).planCredits === 0 && (await current()).packCredits === 25,
      "Expired subscription removes plan credits and preserves welcome credits",
    );
    check(
      !(await reconcileSubscription(ctx, await current(), { ...snapshot, readStartedAt: now - 15_000 })) &&
        (await current()).plan === "free",
      "An older paid SDK read cannot restore an expired subscription",
    );
    await reconcileSubscription(ctx, await current(), {
      ...snapshot,
      plan: "plus",
      features: ["hq_renders"],
      readStartedAt: now - 5_000,
    });
    await adminAdjust(ctx, await current(), -298, "plan", `${clerkId}:adjust`, "Regression split reservation");
    const splitJobId = await createJob(ctx, await current(), { type: "render", steps: [] });
    const split = await reserve(ctx, await current(), 5, splitJobId);
    check(
      split.reservation.plan === 2 && split.reservation.pack === 3,
      "Spending uses plan credits before non-expiring credits",
    );
    const splitJob = await ctx.db.get(splitJobId);
    if (!splitJob) throw new Error("Missing split regression job");
    await refund(ctx, splitJob, 2);
    check(
      (await current()).planCredits === 0 && (await current()).packCredits === 24,
      "Partial refund returns non-expiring credits first",
    );
    const remainingJob = await ctx.db.get(splitJobId);
    if (!remainingJob) throw new Error("Missing split regression job");
    await refund(ctx, remainingJob, 99);
    check(
      (await current()).planCredits === 2 && (await current()).packCredits === 25,
      "Refund cannot exceed the original reservation",
    );
    check(
      await adminAdjust(ctx, await current(), 50, "pack", `${clerkId}:bonus`, "Regression non-expiring credits"),
      "Admin adjustment grants non-expiring credits",
    );
    check(
      !(await adminAdjust(ctx, await current(), 50, "pack", `${clerkId}:bonus`, "Regression non-expiring credits")) &&
        (await current()).packCredits === 75,
      "Admin adjustment retry does not grant twice",
    );
    const staleUser = { ...(await current()), billingCheckedAt: now - 61_000 };
    await expectCode(async () => assertFreshBilling(staleUser, now), "SUBSCRIPTION_REFRESH_REQUIRED");
    checks.push("Paid writes reject an SDK snapshot older than sixty seconds");
    const expiredUser = { ...(await current()), planPeriodEnd: now - 1 };
    const expiredView = getBalance(expiredUser, now);
    const expiredJobId = await createJob(ctx, await current(), { type: "render", steps: [] });
    await expectCode(() => reserve(ctx, expiredUser, 1, expiredJobId), "SUBSCRIPTION_REFRESH_REQUIRED");
    checks.push("Expired plan credits cannot be reserved");
    check(
      expiredView.plan === "free" &&
        expiredView.planCredits === 0 &&
        expiredView.features.length === 0 &&
        expiredView.total === 75,
      "Expired paid entitlements are hidden from balance reads",
    );

    await reconcileSubscription(ctx, await current(), { plan: "free", features: [], readStartedAt: now });
    await adminAdjust(ctx, await current(), 3, "plan", `${clerkId}:expired-refund`, "Simulate a late plan refund");
    const freeReservation = await reserve(ctx, await current(), 1, expiredJobId);
    check(
      freeReservation.reservation.plan === 0 && freeReservation.reservation.pack === 1,
      "Free accounts cannot spend late refunds from an expired plan",
    );
    const freeJob = await ctx.db.get(expiredJobId);
    if (!freeJob) throw new Error("Missing free reservation job");
    await refund(ctx, freeJob, 1);
    const avatarId = await createAvatar(ctx, await current(), { storageId: originalId, label: "Original" });
    await ctx.db.patch(created._id, { onboardedAt: now });
    await expectCode(() => createAvatar(ctx, signupAgain, { storageId: replacementId }), "FEATURE_LOCKED");
    await expectCode(() => removeAvatar(ctx, { ...signupAgain, onboardedAt: now }, avatarId), "INVALID_INPUT");
    await expectCode(() => replaceAvatar(ctx, signupAgain, { avatarId, storageId: invalidId }), "INVALID_INPUT");
    check((await ctx.db.get(avatarId))?.storageId === originalId, "Invalid replacement preserves the original avatar");
    const busyOutfitId = await ctx.db.insert("outfits", {
      userId: created._id,
      name: "Busy avatar",
      slots: { accessories: [] },
      source: "manual",
      wornOn: [],
      createdAt: now,
      updatedAt: now,
    });
    const busyJobId = await createJob(ctx, await current(), { type: "render", steps: [] });
    const busyRenderId = await ctx.db.insert("renders", {
      userId: created._id,
      outfitId: busyOutfitId,
      avatarId,
      jobId: busyJobId,
      quality: "standard",
      status: "pending",
      prompt: "Regression",
      creditsCharged: 0,
      createdAt: now,
    });
    await expectCode(() => replaceAvatar(ctx, signupAgain, { avatarId, storageId: replacementId }), "CONFLICT");
    check((await ctx.db.get(avatarId))?.storageId === originalId, "Pending renders keep their original avatar photo");
    await ctx.db.patch(busyRenderId, { status: "failed" });
    await ctx.db.patch(busyJobId, { status: "cancelled" });
    const stranger = await upsertFromProfile(ctx, { clerkId: `${clerkId}-other` });
    await expectCode(() => replaceAvatar(ctx, stranger, { avatarId, storageId: replacementId }), "NOT_FOUND");
    checks.push("Avatar replacement rejects another user's photo ID");
    await replaceAvatar(ctx, await current(), { avatarId, storageId: replacementId, label: "Replacement" });
    check(
      (await listAvatars(ctx, created._id)).length === 1 &&
        (await ctx.db.get(avatarId))?.storageId === replacementId &&
        (await current()).defaultAvatarId === avatarId &&
        (await current()).onboardedAt === now,
      "Free user replaces the only avatar while retaining default and onboarding",
    );
    check((await ctx.db.system.get("_storage", originalId)) === null, "Avatar replacement deletes the obsolete image");

    const threadId = await ctx.db.insert("threads", {
      userId: created._id,
      title: "Regression",
      lastMessageAt: now,
      createdAt: now,
    });
    const orphanThread = await ctx.db.insert("threads", {
      userId: created._id,
      title: "Orphan",
      lastMessageAt: now,
      createdAt: now,
    });
    const outfitId = await ctx.db.insert("outfits", {
      userId: created._id,
      name: "Regression",
      slots: { accessories: [] },
      source: "agent",
      wornOn: [],
      createdAt: now,
      updatedAt: now,
    });
    for (let index = 0; index < 501; index += 1)
      await ctx.db.insert("proposals", { userId: created._id, threadId, outfitId, createdAt: now });
    await ctx.db.insert("proposals", { userId: created._id, threadId: orphanThread, outfitId, createdAt: now });
    await ctx.db.delete(orphanThread);
    const creditsBeforePurge = (await current()).packCredits;
    let batches = 0;
    while (!(await purgeUserBatch(ctx, created._id, "content"))) {
      batches += 1;
      if (batches > 20) throw new Error("Content purge did not converge");
    }
    check(
      batches >= 2 &&
        (
          await ctx.db
            .query("proposals")
            .withIndex("by_user", (q) => q.eq("userId", created._id))
            .take(1)
        ).length === 0,
      "Content purge removes more than 500 proposals and pre-existing orphans",
    );
    check(
      (await current()).packCredits === creditsBeforePurge && !(await grantSignupBonus(ctx, await current())),
      "Content purge preserves credits and cannot mint another signup bonus",
    );
    for (const userId of [created._id, stranger._id]) {
      while (!(await purgeUserBatch(ctx, userId, "account"))) {
        /* Bounded fixtures only. */
      }
      await deleteUserRow(ctx, userId);
    }
    await restoreRegressionStats(ctx, today, statsBefore, counterBefore, usersBefore);
    checks.push("Regression fixtures and aggregate counters were cleaned up");
    return checks;
  },
});

async function expectCode(operation: () => Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (isAppError(error) && error.data.code === code) return;
    throw error;
  }
  throw new Error(`Expected ${code}`);
}

export const identityRegressions = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async () => {
    assertSmokeEnabled();
    const base: UserIdentity = {
      subject: "regression-identity",
      issuer: "https://clerk.example.test",
      tokenIdentifier: "regression-identity",
    };
    if (profileFromIdentity({ ...base, public_metadata: { role: "admin" } }).role !== "admin")
      throw new Error("Verified public_metadata admin claim was not recognized");
    if (profileFromIdentity({ ...base, metadata: { role: "admin" } }).role !== "admin")
      throw new Error("Verified metadata admin claim was not recognized");
    for (const metadata of [undefined, null, "admin", [], { role: "owner" }, { role: true }]) {
      if (profileFromIdentity({ ...base, public_metadata: metadata }).role !== "user")
        throw new Error("Unknown or malformed metadata granted admin access");
    }
    return [
      "Verified public_metadata admin role is recognized",
      "Verified metadata admin role is recognized",
      "Missing, malformed and unknown roles default to user",
    ];
  },
});

async function restoreRegressionStats(
  ctx: MutationCtx,
  today: string,
  statsBefore: Doc<"dailyStats"> | null,
  counterBefore: Doc<"systemCounters"> | null,
  usersBefore: Doc<"systemCounters"> | null,
): Promise<void> {
  const stats = await ctx.db
    .query("dailyStats")
    .withIndex("by_day", (q) => q.eq("dayKey", today))
    .unique();
  if (stats && statsBefore) {
    const { _id, _creationTime, ...values } = statsBefore;
    void _creationTime;
    await ctx.db.replace(_id, values);
  } else if (stats) await ctx.db.delete(stats._id);
  for (const [key, day, before] of [
    ["credits_reserved", today, counterBefore],
    ["users_total", "", usersBefore],
  ] as const) {
    const counter = await ctx.db
      .query("systemCounters")
      .withIndex("by_day_key", (q) => q.eq("dayKey", day).eq("key", key))
      .unique();
    if (counter && before) await ctx.db.patch(counter._id, { value: before.value });
    else if (counter) await ctx.db.delete(counter._id);
  }
}
