import type { SendTurnOptions } from "eve/client";
import type { ItemView, OutfitView } from "@convex/views";

export const MAX_STYLIST_CONTEXT_ITEMS = 20;

type PageKind = "wardrobe" | "outfits" | "outfit-draft" | "add" | "lookbook" | "settings" | "billing";
type Page = { kind: PageKind; path: string; label: string; description: string };
export type StylistPageRoute =
  Page | { kind: "item"; path: string; itemId: string } | { kind: "outfit"; path: string; outfitId: string };

const PAGES: readonly Page[] = [
  {
    kind: "wardrobe",
    path: "/wardrobe",
    label: "Your wardrobe",
    description:
      "The user is browsing their wardrobe. Attached pieces are a bounded snapshot, not necessarily the current filtered or selected set.",
  },
  {
    kind: "outfits",
    path: "/outfits",
    label: "Saved outfits",
    description: "The user is browsing saved outfits. No particular outfit is selected.",
  },
  {
    kind: "outfit-draft",
    path: "/outfits/new",
    label: "New outfit",
    description: "The user is building a new outfit. Unsaved slots are not included in this page snapshot.",
  },
  {
    kind: "add",
    path: "/add",
    label: "Add clothes",
    description: "The user is uploading clothes or viewing scan progress. No scan status is included in this snapshot.",
  },
  {
    kind: "lookbook",
    path: "/lookbook",
    label: "Lookbook",
    description: "The user is browsing their rendered looks. No specific render is attached.",
  },
  {
    kind: "settings",
    path: "/settings",
    label: "Settings",
    description:
      "The user is viewing fitting photos, styling preferences, appearance or data settings. Account and photo data are not attached.",
  },
  {
    kind: "billing",
    path: "/billing",
    label: "Plans and credits",
    description:
      "The user is viewing plans and credits. No payment, subscription or balance data is attached; use verified tools for current values.",
  },
];

/** Only application pathnames are context: never query strings, share tokens or arbitrary URLs. */
export function getStylistPageRoute(pathname: string | null): StylistPageRoute | null {
  if (!pathname || /[?#%\\]/.test(pathname)) return null;
  const path = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const page = PAGES.find((candidate) => candidate.path === path);
  if (page) return page;
  const item = /^\/wardrobe\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
  if (item) return { kind: "item", path, itemId: item[1] };
  const outfit = /^\/outfits\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
  if (outfit) return { kind: "outfit", path, outfitId: outfit[1] };
  return null;
}

type ItemSource = Pick<
  ItemView,
  | "_id"
  | "name"
  | "category"
  | "subcategory"
  | "colours"
  | "pattern"
  | "material"
  | "season"
  | "formality"
  | "fit"
  | "brand"
  | "description"
  | "status"
>;

/** Whitelist fields so signed image URLs, upload metadata, notes and account data cannot hitch a ride. */
function projectItem(item: ItemSource) {
  return {
    _id: item._id,
    name: item.name.slice(0, 120),
    category: item.category,
    subcategory: item.subcategory.slice(0, 80),
    colours: {
      primary: item.colours.primary.slice(0, 80),
      secondary: item.colours.secondary.slice(0, 8).map((colour) => colour.slice(0, 80)),
      hex: item.colours.hex.slice(0, 8),
    },
    pattern: item.pattern.slice(0, 80),
    material: item.material.slice(0, 80),
    season: [...item.season],
    formality: item.formality,
    fit: item.fit ?? null,
    brand: item.brand?.slice(0, 80) ?? null,
    description: item.description.slice(0, 400),
    status: item.status,
  };
}

export type StylistContextItem = ReturnType<typeof projectItem>;
type StylistContextOutfit = {
  _id: OutfitView["_id"] | null;
  isDraft: boolean;
  name: string;
  occasion: string | null;
  slots: {
    outerwear: string | null;
    top: string | null;
    bottom: string | null;
    dress: string | null;
    shoes: string | null;
    accessories: string[];
  };
  items: Array<Pick<ItemView, "_id" | "name" | "category">>;
};

export type StylistPageContext = {
  kind: PageKind | "item" | "outfit" | "selection";
  path: string;
  label: string;
  description: string;
  item: StylistContextItem | null;
  outfit: StylistContextOutfit | null;
  items: StylistContextItem[];
  totalItems: number | null;
};

export function createStylistPageContext(page: Page, items: readonly ItemView[] = []): StylistPageContext {
  return {
    ...page,
    item: null,
    outfit: null,
    items: page.kind === "wardrobe" ? items.slice(0, MAX_STYLIST_CONTEXT_ITEMS).map(projectItem) : [],
    totalItems: page.kind === "wardrobe" ? items.length : null,
  };
}

export function createStylistItemContext(path: string, item: ItemView): StylistPageContext {
  return {
    kind: "item",
    path,
    label: item.name.slice(0, 120),
    description: "The user is viewing this wardrobe item. Verify it with wardrobe tools before composing an outfit.",
    item: projectItem(item),
    outfit: null,
    items: [],
    totalItems: null,
  };
}

export function createStylistOutfitContext(path: string, outfit: OutfitView): StylistPageContext {
  const { slots } = outfit;
  const items = [
    outfit.items.outerwear,
    outfit.items.top,
    outfit.items.bottom,
    outfit.items.dress,
    outfit.items.shoes,
    ...outfit.items.accessories,
  ].flatMap((item) => (item ? [{ _id: item._id, name: item.name.slice(0, 120), category: item.category }] : []));
  return {
    kind: "outfit",
    path,
    label: outfit.name.slice(0, 120),
    description:
      "The user is viewing this saved outfit. These are persisted slots; unsaved editor changes may differ. Verify IDs and ownership with tools before acting.",
    item: null,
    items: [],
    totalItems: null,
    outfit: {
      _id: outfit._id,
      isDraft: false,
      name: outfit.name.slice(0, 120),
      occasion: outfit.occasion?.slice(0, 200) ?? null,
      slots: {
        outerwear: slots.outerwear ?? null,
        top: slots.top ?? null,
        bottom: slots.bottom ?? null,
        dress: slots.dress ?? null,
        shoes: slots.shoes ?? null,
        accessories: [...slots.accessories],
      },
      items,
    },
  };
}

export type StylistDraftInput = {
  path: string;
  name: string;
  occasion?: string;
  slots: OutfitView["slots"];
  items: readonly ItemView[];
  dirty: boolean;
  savedOutfitId?: OutfitView["_id"];
};

/** The editor registers its current draft so a saved query cannot silently replace unsaved choices. */
export function createStylistDraftContext({
  path,
  name,
  occasion,
  slots,
  items,
  dirty,
  savedOutfitId,
}: StylistDraftInput): StylistPageContext | null {
  const route = getStylistPageRoute(path);
  if (route?.kind !== "outfit-draft" && route?.kind !== "outfit") return null;
  if (route.kind === "outfit" && route.outfitId !== savedOutfitId) return null;
  if (route.kind === "outfit-draft" && savedOutfitId) return null;
  const itemIds = new Set([slots.outerwear, slots.top, slots.bottom, slots.dress, slots.shoes, ...slots.accessories]);
  const selected = items.filter((item) => itemIds.has(item._id));
  const isDraft = dirty || !savedOutfitId;
  const label = name.trim().slice(0, 120) || "New outfit";
  return {
    kind: "outfit-draft",
    path,
    label: isDraft ? `Draft: ${label}` : label,
    description: isDraft
      ? "These are the current unsaved outfit editor choices, not necessarily the stored outfit. Do not render the saved outfit ID as if it contains these unsaved slots. Verify item ownership with tools before proposing a look."
      : "These are the current outfit editor choices, matching the saved outfit at the time of this snapshot. Verify current ownership and availability with tools.",
    item: null,
    items: selected.slice(0, MAX_STYLIST_CONTEXT_ITEMS).map(projectItem),
    totalItems: selected.length,
    outfit: {
      _id: savedOutfitId ?? null,
      isDraft,
      name: label,
      occasion: occasion?.trim().slice(0, 200) || null,
      slots: {
        outerwear: slots.outerwear ?? null,
        top: slots.top ?? null,
        bottom: slots.bottom ?? null,
        dress: slots.dress ?? null,
        shoes: slots.shoes ?? null,
        accessories: [...slots.accessories],
      },
      items: selected.map((item) => ({ _id: item._id, name: item.name.slice(0, 120), category: item.category })),
    },
  };
}

/** Call with rows already resolved by the authenticated wardrobe query, not arbitrary IDs from the browser. */
export function createStylistSelectionContext(
  items: readonly ItemView[],
  path = "/wardrobe",
): StylistPageContext | null {
  if (getStylistPageRoute(path)?.kind !== "wardrobe" || items.length === 0) return null;
  const unique = [...new Map(items.map((item) => [item._id, item])).values()];
  return {
    kind: "selection",
    path,
    label: `${unique.length} selected ${unique.length === 1 ? "piece" : "pieces"}`,
    description:
      unique.length > MAX_STYLIST_CONTEXT_ITEMS
        ? `The user selected ${unique.length} pieces; only the first ${MAX_STYLIST_CONTEXT_ITEMS} are attached. Ask them to narrow the selection if the missing pieces matter.`
        : "The user explicitly selected these wardrobe pieces as context for the stylist.",
    item: null,
    outfit: null,
    items: unique.slice(0, MAX_STYLIST_CONTEXT_ITEMS).map(projectItem),
    totalItems: unique.length,
  };
}

/** Eve's native ephemeral clientContext keeps the actual user message untouched. */
export function toStylistClientContext(
  context: StylistPageContext | null | undefined,
): SendTurnOptions["clientContext"] {
  if (!context || !getStylistPageRoute(context.path)) return undefined;
  return {
    source: "fitcheck-page",
    version: 1,
    trust: "untrusted_page_data",
    page: {
      kind: context.kind,
      path: context.path,
      label: context.label,
      description: context.description,
      item: context.item,
      outfit: context.outfit,
      items: context.items,
      totalItems: context.totalItems,
    },
  };
}
