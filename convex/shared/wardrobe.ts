export const CATEGORIES = ["top", "bottom", "outerwear", "dress", "shoes", "accessory", "bag", "headwear"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  top: "Tops",
  bottom: "Bottoms",
  outerwear: "Outerwear",
  dress: "Dresses",
  shoes: "Shoes",
  accessory: "Accessories",
  bag: "Bags",
  headwear: "Headwear",
};

export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type Season = (typeof SEASONS)[number];

export const FORMALITY = ["casual", "smart-casual", "formal"] as const;
export type Formality = (typeof FORMALITY)[number];

export const FORMALITY_LABELS: Record<Formality, string> = {
  casual: "Casual",
  "smart-casual": "Smart casual",
  formal: "Formal",
};

export const FITS = ["slim", "regular", "relaxed", "oversized"] as const;
export type Fit = (typeof FITS)[number];

export const PRESENTATIONS = ["masculine", "feminine", "neutral"] as const;
export type Presentation = (typeof PRESENTATIONS)[number];

/** Builder slots. `dress` replaces top + bottom when set. */
export const SLOTS = ["outerwear", "top", "bottom", "dress", "shoes", "accessories"] as const;
export type Slot = (typeof SLOTS)[number];

export const SLOT_LABELS: Record<Slot, string> = {
  outerwear: "Outerwear",
  top: "Top",
  bottom: "Bottom",
  dress: "Dress",
  shoes: "Shoes",
  accessories: "Accessories",
};

/** Which categories may fill each slot. */
export const SLOT_CATEGORIES: Record<Slot, readonly Category[]> = {
  outerwear: ["outerwear"],
  top: ["top"],
  bottom: ["bottom"],
  dress: ["dress"],
  shoes: ["shoes"],
  accessories: ["accessory", "bag", "headwear"],
};

/** Order garments are layered when rendering, inner to outer. */
export const LAYER_ORDER: readonly Slot[] = ["dress", "top", "bottom", "shoes", "outerwear", "accessories"];

export const ITEM_STATUSES = ["extracting", "ready", "failed", "hidden", "needsCredits"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ACCEPTED_IMAGE_TYPES: Record<string, readonly string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};
// HEIC/HEIF are deliberately absent: gpt-image-2 rejects them, and browsers can't transcode client-side.

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

export function slotForCategory(category: Category): Slot {
  const entry = (Object.entries(SLOT_CATEGORIES) as Array<[Slot, readonly Category[]]>).find(([, cats]) =>
    cats.includes(category),
  );
  // Every category maps to exactly one slot by construction of SLOT_CATEGORIES.
  return entry ? entry[0] : "accessories";
}
