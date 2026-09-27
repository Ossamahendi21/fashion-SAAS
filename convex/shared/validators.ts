import { v, type VLiteral, type VUnion } from "convex/values";
import { FEATURES, PLAN_IDS, RENDER_QUALITIES } from "./credits";
import { JOB_STATUSES, JOB_TYPES, STEP_STATUSES } from "./jobs";
import { CATEGORIES, FITS, FORMALITY, ITEM_STATUSES, PRESENTATIONS, SEASONS } from "./wardrobe";

type LiteralUnion<T extends readonly string[]> = VUnion<T[number], VLiteral<T[number]>[]>;

/** Build a `v.union(v.literal(...))` validator from a readonly string tuple so enums live in one place. */
export function literals<const T extends readonly string[]>(values: T): LiteralUnion<T> {
  const members = values.map((value) => v.literal(value)) as VLiteral<T[number]>[];
  return v.union(...members) as unknown as LiteralUnion<T>;
}

export const vCategory = literals(CATEGORIES);
export const vSeason = literals(SEASONS);
export const vFormality = literals(FORMALITY);
export const vFit = literals(FITS);
export const vPresentation = literals(PRESENTATIONS);
export const vItemStatus = literals(ITEM_STATUSES);

export const vPlanId = literals(PLAN_IDS);
export const vFeature = literals(FEATURES);
export const vRenderQuality = literals(RENDER_QUALITIES);

export const vJobType = literals(JOB_TYPES);
export const vJobStatus = literals(JOB_STATUSES);
export const vStepStatus = literals(STEP_STATUSES);

export const vColours = v.object({
  primary: v.string(),
  secondary: v.array(v.string()),
  hex: v.array(v.string()),
});

export const vTokenUsage = v.object({
  inputTextTokens: v.number(),
  inputImageTokens: v.number(),
  outputTokens: v.number(),
});

export const vJobStep = v.object({
  key: v.string(),
  label: v.string(),
  status: vStepStatus,
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  error: v.optional(v.string()),
  meta: v.optional(v.record(v.string(), v.any())),
});

export const vReservation = v.object({ plan: v.number(), pack: v.number() });

export const vPrefs = v.object({
  presentation: vPresentation,
  fit: vFit,
  avoidColours: v.array(v.string()),
  homeCity: v.optional(v.string()),
});

export const vOutfitSlots = v.object({
  outerwear: v.optional(v.id("items")),
  top: v.optional(v.id("items")),
  bottom: v.optional(v.id("items")),
  dress: v.optional(v.id("items")),
  shoes: v.optional(v.id("items")),
  accessories: v.array(v.id("items")),
});

/** Attributes produced by detection and editable by the user. Shared by items and the detect action output. */
export const vItemAttributes = v.object({
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
  description: v.string(),
});

export const vDetectedItem = v.object({
  ...vItemAttributes.fields,
  bbox: v.array(v.number()),
});
