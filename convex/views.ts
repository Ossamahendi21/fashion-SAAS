import { paginationResultValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import {
  vCategory,
  vColours,
  vDetectedItem,
  vFit,
  vFormality,
  vItemStatus,
  vOutfitSlots,
  vRenderQuality,
  vSeason,
} from "./shared/validators";

/**
 * Return-shape validators shared by public functions and the agent surface.
 * Frontends derive their types from these via `FunctionReturnType`; nothing else is a type source.
 */

export const vItemView = v.object({
  _id: v.id("items"),
  name: v.string(),
  category: vCategory,
  subcategory: v.string(),
  colours: vColours,
  pattern: v.string(),
  material: v.string(),
  season: v.array(vSeason),
  formality: vFormality,
  fit: v.optional(vFit),
  brand: v.optional(v.string()),
  notes: v.optional(v.string()),
  description: v.string(),
  status: vItemStatus,
  wearCount: v.number(),
  lastWornAt: v.optional(v.number()),
  duplicateOfId: v.optional(v.id("items")),
  uploadId: v.optional(v.id("uploads")),
  /** Signed URL of the cutout, null while extracting or failed. */
  url: v.union(v.string(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export type ItemView = Infer<typeof vItemView>;

/** Enough of an item to draw a collage tile without a second query. */
export const vItemSummary = v.object({
  _id: v.id("items"),
  name: v.string(),
  category: vCategory,
  url: v.union(v.string(), v.null()),
});
export type ItemSummary = Infer<typeof vItemSummary>;

export const vOutfitItems = v.object({
  outerwear: v.optional(vItemSummary),
  top: v.optional(vItemSummary),
  bottom: v.optional(vItemSummary),
  dress: v.optional(vItemSummary),
  shoes: v.optional(vItemSummary),
  accessories: v.array(vItemSummary),
});

export const vOutfitView = v.object({
  _id: v.id("outfits"),
  name: v.string(),
  slots: vOutfitSlots,
  items: vOutfitItems,
  occasion: v.optional(v.string()),
  brief: v.optional(v.string()),
  reasoning: v.optional(v.string()),
  source: v.union(v.literal("manual"), v.literal("agent")),
  threadId: v.optional(v.id("threads")),
  /** Listed in /outfits when set (manual outfits at creation, agent proposals when saved). */
  savedAt: v.optional(v.number()),
  wornOn: v.array(v.number()),
  renderCount: v.number(),
  /** Most recent finished render, for list covers. */
  coverUrl: v.union(v.string(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export type OutfitView = Infer<typeof vOutfitView>;

export const vRenderView = v.object({
  _id: v.id("renders"),
  outfitId: v.id("outfits"),
  outfitName: v.string(),
  avatarId: v.id("avatars"),
  jobId: v.id("jobs"),
  status: v.union(v.literal("pending"), v.literal("done"), v.literal("failed")),
  quality: vRenderQuality,
  url: v.union(v.string(), v.null()),
  creditsCharged: v.number(),
  shareToken: v.optional(v.string()),
  error: v.optional(v.string()),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
});
export type RenderView = Infer<typeof vRenderView>;

export const vAvatarView = v.object({
  _id: v.id("avatars"),
  label: v.string(),
  isDefault: v.boolean(),
  url: v.union(v.string(), v.null()),
  createdAt: v.number(),
});
export type AvatarView = Infer<typeof vAvatarView>;

export const vUploadView = v.object({
  _id: v.id("uploads"),
  batchId: v.string(),
  fileName: v.string(),
  mimeType: v.string(),
  sizeBytes: v.number(),
  status: v.union(
    v.literal("queued"),
    v.literal("detecting"),
    v.literal("awaiting_selection"),
    v.literal("extracting"),
    v.literal("done"),
    v.literal("failed"),
    v.literal("partial"),
  ),
  detectedCount: v.optional(v.number()),
  candidates: v.optional(v.array(vDetectedItem)),
  selectedIndices: v.optional(v.array(v.number())),
  selectionConfirmedAt: v.optional(v.number()),
  jobId: v.optional(v.id("jobs")),
  url: v.union(v.string(), v.null()),
  createdAt: v.number(),
});
export type UploadView = Infer<typeof vUploadView>;

export const vThreadView = v.object({
  _id: v.id("threads"),
  title: v.string(),
  eveSessionId: v.optional(v.string()),
  streamIndex: v.optional(v.number()),
  lastMessageAt: v.number(),
  createdAt: v.number(),
});
export type ThreadView = Infer<typeof vThreadView>;

/** Paginated return shape including Convex's `splitCursor`/`pageStatus`, so `usePaginatedQuery` can split pages. */
export const vPaginated = paginationResultValidator;
