import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertOwner } from "../lib/auth";
import { appError } from "../lib/errors";
import { LIMITS, PLANS } from "../shared/credits";
import type { AvatarView } from "../views";
import { assertStoredImage } from "./uploads";
import { listActive } from "./jobs";
import { assertFreshBilling, hasCurrentPlan } from "./credits";

type Ctx = QueryCtx | MutationCtx;

export async function listForUser(ctx: Ctx, userId: Id<"users">): Promise<Doc<"avatars">[]> {
  const avatars = await ctx.db
    .query("avatars")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return avatars.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt);
}

export async function toAvatarView(ctx: Ctx, avatar: Doc<"avatars">): Promise<AvatarView> {
  return {
    _id: avatar._id,
    label: avatar.label,
    isDefault: avatar.isDefault,
    url: await ctx.storage.getUrl(avatar.storageId),
    createdAt: avatar.createdAt,
  };
}

/** The avatar to render with: the requested one, or the user's default. Both must exist and be theirs. */
export async function resolveAvatar(
  ctx: Ctx,
  user: Doc<"users">,
  avatarId: Id<"avatars"> | undefined,
): Promise<Doc<"avatars">> {
  const wanted = avatarId ?? user.defaultAvatarId;
  if (!wanted) throw appError("ONBOARDING_REQUIRED", "Add a photo of yourself before rendering outfits.");
  const avatar = await ctx.db.get(wanted);
  return assertOwner(avatar, user, "avatar");
}

export async function createAvatar(
  ctx: MutationCtx,
  user: Doc<"users">,
  input: { storageId: Id<"_storage">; label?: string },
): Promise<Id<"avatars">> {
  await assertStoredImage(ctx, input.storageId, input.label?.trim() || "That photo");
  const existing = await listForUser(ctx, user._id);
  assertFreshBilling(user);
  const max = PLANS[hasCurrentPlan(user) ? user.plan : "free"].maxAvatars;
  if (existing.length >= max) {
    throw appError(
      "FEATURE_LOCKED",
      `Your plan allows ${max} avatar${max === 1 ? "" : "s"}. Remove one or upgrade to add more.`,
      { max, plan: user.plan },
    );
  }
  const isDefault = existing.length === 0;
  const avatarId = await ctx.db.insert("avatars", {
    userId: user._id,
    storageId: input.storageId,
    label: input.label?.trim() || `Photo ${existing.length + 1}`,
    isDefault,
    createdAt: Date.now(),
  });
  if (isDefault) await ctx.db.patch(user._id, { defaultAvatarId: avatarId });
  return avatarId;
}

export async function setDefaultAvatar(ctx: MutationCtx, user: Doc<"users">, avatarId: Id<"avatars">): Promise<void> {
  const avatar = assertOwner(await ctx.db.get(avatarId), user, "avatar");
  const all = await listForUser(ctx, user._id);
  for (const candidate of all) {
    const shouldBeDefault = candidate._id === avatar._id;
    if (candidate.isDefault !== shouldBeDefault) await ctx.db.patch(candidate._id, { isDefault: shouldBeDefault });
  }
  await ctx.db.patch(user._id, { defaultAvatarId: avatar._id });
}

export async function removeAvatar(ctx: MutationCtx, user: Doc<"users">, avatarId: Id<"avatars">): Promise<void> {
  const avatar = assertOwner(await ctx.db.get(avatarId), user, "avatar");
  const all = await listForUser(ctx, user._id);
  if (user.onboardedAt && all.length <= 1) {
    throw appError("INVALID_INPUT", "You need at least one photo of yourself. Add another before removing this one.");
  }
  await assertAvatarAvailable(ctx, user, avatarId);
  await ctx.storage.delete(avatar.storageId);
  await ctx.db.delete("avatars", avatar._id);

  const remaining = all.filter((candidate) => candidate._id !== avatar._id);
  if (user.defaultAvatarId === avatar._id || avatar.isDefault) {
    const next = remaining[0];
    if (next) {
      if (!next.isDefault) await ctx.db.patch(next._id, { isDefault: true });
      await ctx.db.patch(user._id, { defaultAvatarId: next._id });
    } else {
      await ctx.db.patch(user._id, { defaultAvatarId: undefined });
    }
  }
}

/** Replaces in place, so a user at their plan limit can update their photo without losing the default. */
export async function replaceAvatar(
  ctx: MutationCtx,
  user: Doc<"users">,
  input: { avatarId: Id<"avatars">; storageId: Id<"_storage">; label?: string },
): Promise<void> {
  const avatar = assertOwner(await ctx.db.get(input.avatarId), user, "avatar");
  await assertStoredImage(ctx, input.storageId, input.label?.trim() || avatar.label);
  await assertAvatarAvailable(ctx, user, avatar._id);
  await ctx.db.patch(avatar._id, {
    storageId: input.storageId,
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
  });
  if (avatar.storageId !== input.storageId) await ctx.storage.delete(avatar.storageId);
}

async function assertAvatarAvailable(ctx: MutationCtx, user: Doc<"users">, avatarId: Id<"avatars">): Promise<void> {
  const jobs = await listActive(ctx, user._id);
  for (const job of jobs) {
    if (job.type !== "render") continue;
    const renders = await ctx.db
      .query("renders")
      .withIndex("by_job", (q) => q.eq("jobId", job._id))
      .take(LIMITS.maxOutfitsPerRenderRequest * LIMITS.maxRendersPerRequest);
    if (renders.some((render) => render.avatarId === avatarId && render.status === "pending")) {
      throw appError("CONFLICT", "Wait for the renders using this photo to finish before changing it.");
    }
  }
}
