import type { WorkflowId } from "@convex-dev/workflow";
import type { UserIdentity } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { dayKey, PLANS } from "../shared/credits";
import { ITEM_STATUSES } from "../shared/wardrobe";
import { workflow } from "../workflows/manager";
import { grantSignupBonus } from "./credits";
import { completeJob } from "./jobs";
import { bumpDailyStats, bumpSystemCounter } from "./stats";

type Ctx = QueryCtx | MutationCtx;
type UsageCounter = Doc<"usageCounters">["counter"];

/**
 * "content" is the self-serve wipe: everything the user made goes, the account (row, ledger,
 * credits, plan, role) stays. The internal "account" mode also removes accounting data.
 */
export type PurgeMode = "content" | "account";

export type UserProfileInput = {
  clerkId: string;
  email?: string;
  name?: string;
  imageUrl?: string;
  role?: Doc<"users">["role"];
};

export async function getByClerkId(ctx: Ctx, clerkId: string): Promise<Doc<"users"> | null> {
  return ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
    .unique();
}

export async function getById(ctx: Ctx, userId: Id<"users">): Promise<Doc<"users"> | null> {
  return ctx.db.get(userId);
}

/** Create or refresh a user from their verified identity or an authoritative Clerk SDK read. */
export async function upsertFromProfile(ctx: MutationCtx, profile: UserProfileInput): Promise<Doc<"users">> {
  const existing = await getByClerkId(ctx, profile.clerkId);
  if (existing) {
    const patch: Partial<Doc<"users">> = {};
    if (profile.email !== undefined && profile.email !== existing.email) patch.email = profile.email;
    if (profile.name !== undefined && profile.name !== existing.name) patch.name = profile.name;
    if (profile.imageUrl !== undefined && profile.imageUrl !== existing.imageUrl) patch.imageUrl = profile.imageUrl;
    if (profile.role !== undefined && profile.role !== existing.role) patch.role = profile.role;
    if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
    return { ...existing, ...patch };
  }
  const userId = await ctx.db.insert("users", {
    clerkId: profile.clerkId,
    email: profile.email,
    name: profile.name,
    imageUrl: profile.imageUrl,
    role: profile.role ?? "user",
    plan: "free",
    features: [...PLANS.free.features],
    planCredits: 0,
    packCredits: 0,
    dailySpend: { dayKey: "", credits: 0 },
    prefs: { presentation: "neutral", fit: "regular", avoidColours: [] },
    createdAt: Date.now(),
  });
  const created = await ctx.db.get(userId);
  if (!created) throw new Error("User insert failed");
  await bumpDailyStats(ctx, { newUsers: 1 });
  await bumpSystemCounter(ctx, "users_total", 1);
  await grantSignupBonus(ctx, created);
  const withBonus = await ctx.db.get(userId);
  return withBonus ?? created;
}

/** The only place the `users` row is removed, so the all-time user counter stays in step with it. */
export async function deleteUserRow(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) return;
  await ctx.db.delete("users", userId);
  await bumpSystemCounter(ctx, "users_total", -1);
}

export function profileFromIdentity(identity: UserIdentity): UserProfileInput {
  return {
    clerkId: identity.subject,
    email: identity.email ?? undefined,
    name: identity.name ?? identity.nickname ?? undefined,
    imageUrl: identity.pictureUrl ?? undefined,
    role: roleFromClerkMetadata(identity.public_metadata ?? identity.metadata),
  };
}

export function roleFromClerkMetadata(publicMetadata: unknown): Doc<"users">["role"] {
  if (typeof publicMetadata === "object" && publicMetadata !== null && "role" in publicMetadata) {
    return (publicMetadata as { role?: unknown }).role === "admin" ? "admin" : "user";
  }
  return "user";
}

/**
 * Per-user, per-day counter for the free (text-only) work that still costs us money.
 * Throws RATE_LIMITED when the day's allowance is used up; returns what is left afterwards.
 */
export async function bumpUsageCounter(
  ctx: MutationCtx,
  userId: Id<"users">,
  counter: UsageCounter,
  limit: number,
  amount = 1,
): Promise<number> {
  const today = dayKey();
  const existing = await ctx.db
    .query("usageCounters")
    .withIndex("by_user_day_counter", (q) => q.eq("userId", userId).eq("dayKey", today).eq("counter", counter))
    .unique();
  const used = existing?.count ?? 0;
  if (used + amount > limit) {
    throw appError("RATE_LIMITED", `You've hit today's limit of ${limit}. Try again tomorrow.`, {
      counter,
      limit,
      used,
    });
  }
  if (existing) {
    await ctx.db.patch(existing._id, { count: used + amount });
  } else {
    await ctx.db.insert("usageCounters", { userId, dayKey: today, counter, count: amount });
  }
  return limit - (used + amount);
}

/** Documents deleted per purge transaction; the caller reschedules itself until `purgeUserBatch` returns true. */
const PURGE_BATCH = 200;

const ACTIVE_JOB_STATUSES = ["queued", "running"] as const;

/**
 * Stops anything still running for this user before their rows disappear underneath it: an
 * in-flight workflow would otherwise keep writing items and orphan storage files, and its
 * `onComplete` refund would throw on a deleted user. Cancelling runs that refund now, while the
 * ledger and (in "content" mode) the balance are still there.
 */
export async function cancelActiveJobs(ctx: MutationCtx, userId: Id<"users">): Promise<number> {
  const lists = await Promise.all(
    ACTIVE_JOB_STATUSES.map((status) =>
      ctx.db
        .query("jobs")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
        .take(PURGE_BATCH),
    ),
  );
  const active = lists.flat();
  for (const job of active) {
    if (job.workflowId) {
      try {
        await workflow.cancel(ctx, job.workflowId as WorkflowId);
      } catch (error) {
        // Already finished or cleaned up: the component throws rather than no-op'ing. The nested
        // call rolls back on its own, so the rest of the purge is unaffected.
        console.warn(`Could not cancel workflow ${job.workflowId} for job ${job._id}`, error);
      }
    }
    const current = await ctx.db.get(job._id);
    if (current && (current.status === "queued" || current.status === "running")) {
      await completeJob(ctx, job._id, { status: "cancelled", error: "Cancelled: the account's data was deleted." });
    }
  }
  return active.length;
}

/**
 * Deletes one transaction-sized slice of everything a user owns, files included.
 * Returns true once nothing is left. In "content" mode the ledger (and with it the credit balance,
 * plan and the welcome-bonus ref) is kept, so a wipe cannot re-mint the signup bonus.
 */
export async function purgeUserBatch(ctx: MutationCtx, userId: Id<"users">, mode: PurgeMode): Promise<boolean> {
  let budget = PURGE_BATCH;

  const renders = await ctx.db
    .query("renders")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(budget);
  for (const render of renders) {
    await deleteFile(ctx, render.storageId);
    await ctx.db.delete("renders", render._id);
  }
  budget -= renders.length;
  if (budget <= 0) return false;

  for (const status of ITEM_STATUSES) {
    const items = await ctx.db
      .query("items")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
      .take(budget);
    for (const item of items) {
      await deleteFile(ctx, item.storageId);
      await deleteFile(ctx, item.thumbStorageId);
      const embedding = await ctx.db
        .query("itemEmbeddings")
        .withIndex("by_item", (q) => q.eq("itemId", item._id))
        .unique();
      if (embedding) await ctx.db.delete("itemEmbeddings", embedding._id);
      await ctx.db.delete("items", item._id);
    }
    budget -= items.length;
    if (budget <= 0) return false;
  }

  const outfits = await ctx.db
    .query("outfits")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(budget);
  for (const outfit of outfits) await ctx.db.delete("outfits", outfit._id);
  budget -= outfits.length;
  if (budget <= 0) return false;

  const proposals = await ctx.db
    .query("proposals")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(budget);
  for (const proposal of proposals) await ctx.db.delete("proposals", proposal._id);
  budget -= proposals.length;
  if (budget <= 0) return false;

  const threads = await ctx.db
    .query("threads")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(budget);
  for (const thread of threads) await ctx.db.delete("threads", thread._id);
  budget -= threads.length;
  if (budget <= 0) return false;

  const uploads = await ctx.db
    .query("uploads")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(budget);
  for (const upload of uploads) {
    await deleteFile(ctx, upload.storageId);
    await ctx.db.delete("uploads", upload._id);
  }
  budget -= uploads.length;
  if (budget <= 0) return false;

  const avatars = await ctx.db
    .query("avatars")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(budget);
  for (const avatar of avatars) {
    await deleteFile(ctx, avatar.storageId);
    await ctx.db.delete("avatars", avatar._id);
  }
  budget -= avatars.length;
  if (budget <= 0) return false;

  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(budget);
  for (const job of jobs) await ctx.db.delete("jobs", job._id);
  budget -= jobs.length;
  if (budget <= 0) return false;

  // Kept in "content" mode: the ledger is the audit trail and carries the `signup:<clerkId>` ref
  // that stops the welcome credits being minted again by wiping and starting over.
  if (mode === "account") {
    const ledger = await ctx.db
      .query("creditLedger")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(budget);
    for (const line of ledger) await ctx.db.delete("creditLedger", line._id);
    budget -= ledger.length;
    if (budget <= 0) return false;
  }

  const counters = await ctx.db
    .query("usageCounters")
    .withIndex("by_user_day_counter", (q) => q.eq("userId", userId))
    .take(budget);
  for (const counter of counters) await ctx.db.delete("usageCounters", counter._id);
  budget -= counters.length;

  return budget > 0;
}

async function deleteFile(ctx: MutationCtx, storageId: Id<"_storage"> | undefined): Promise<void> {
  if (!storageId) return;
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // The file may already be gone (retried purge, manual cleanup); the document delete still has to happen.
  }
}
