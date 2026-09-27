import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import {
  createAvatar,
  listForUser,
  removeAvatar,
  replaceAvatar,
  setDefaultAvatar,
  toAvatarView,
} from "./model/avatars";
import { vAvatarView } from "./views";

/** All of the user's avatar photos, default first. */
export const list = query({
  args: {},
  returns: v.array(vAvatarView),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const avatars = await listForUser(ctx, user._id);
    return Promise.all(avatars.map((avatar) => toAvatarView(ctx, avatar)));
  },
});

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requireUser(ctx);
    return ctx.storage.generateUploadUrl();
  },
});

/** Creates an avatar from an uploaded photo. Enforces PLANS[plan].maxAvatars. First avatar becomes default. */
export const create = mutation({
  args: { storageId: v.id("_storage"), label: v.optional(v.string()) },
  returns: v.id("avatars"),
  handler: async (ctx, { storageId, label }) => {
    const user = await requireUser(ctx);
    return createAvatar(ctx, user, { storageId, label });
  },
});

export const setDefault = mutation({
  args: { avatarId: v.id("avatars") },
  returns: v.null(),
  handler: async (ctx, { avatarId }) => {
    const user = await requireUser(ctx);
    await setDefaultAvatar(ctx, user, avatarId);
    return null;
  },
});

export const replace = mutation({
  args: { avatarId: v.id("avatars"), storageId: v.id("_storage"), label: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await replaceAvatar(ctx, user, args);
    return null;
  },
});

/** Deletes the avatar and its file. Refuses to delete the last avatar of an onboarded user. */
export const remove = mutation({
  args: { avatarId: v.id("avatars") },
  returns: v.null(),
  handler: async (ctx, { avatarId }) => {
    const user = await requireUser(ctx);
    await removeAvatar(ctx, user, avatarId);
    return null;
  },
});
