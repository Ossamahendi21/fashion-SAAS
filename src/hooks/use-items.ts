"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { Category, ItemStatus } from "@convex/shared/wardrobe";
import type { FunctionReturnType } from "convex/server";

export type Item = FunctionReturnType<typeof api.items.list>[number];
export type ItemDetail = NonNullable<FunctionReturnType<typeof api.items.get>>;

/** Below this the search index is noise, so the wardrobe falls back to the plain list. */
export const MIN_SEARCH_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 250;

export type WardrobeQuery = {
  /** Raw text from the search box; debounced here so callers can stay dumb. */
  query?: string;
  /** Defaults to the server's `ready` view. Pass `hidden` for the "show hidden" toggle. */
  status?: ItemStatus;
  category?: Category;
};

export type WardrobeResult = {
  items: Item[] | undefined;
  /** True when the list came from the search index rather than the plain list. */
  isSearching: boolean;
  /** True while the typed query has not reached the server yet. */
  isPending: boolean;
};

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);
  return debounced;
}

/**
 * The wardrobe list: full-text search once the query is long enough, otherwise the indexed list.
 * Search has no server-side filters, so status/category are applied here to keep both paths equal.
 *
 * One bounded subscription per view: the server caps the list at `LIMITS.maxItemsPerUser`, so colour,
 * season, formality and sort stay client-side rather than costing a query (and a re-signed URL set) each.
 */
export function useWardrobe({ query = "", status, category }: WardrobeQuery = {}): WardrobeResult {
  const { isAuthenticated } = useConvexAuth();
  const debouncedQuery = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const trimmed = debouncedQuery.trim();
  const isSearching = trimmed.length >= MIN_SEARCH_LENGTH;

  const listed = useQuery(api.items.list, !isAuthenticated || isSearching ? "skip" : { status, category });
  const found = useQuery(api.items.search, !isAuthenticated || !isSearching ? "skip" : { query: trimmed });

  const items = useMemo(() => {
    if (!isSearching) return listed;
    if (!found) return undefined;
    const wanted = status ?? "ready";
    return found.filter((item) => item.status === wanted && (!category || item.category === category));
  }, [category, found, isSearching, listed, status]);

  return { items, isSearching, isPending: query.trim() !== trimmed };
}

/** Items in one status, e.g. the `needsCredits` queue. */
export function useItemsByStatus(status: ItemStatus, enabled = true): Item[] | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.items.list, isAuthenticated && enabled ? { status } : "skip");
}

/**
 * Every item a single photo produced, in any status — one indexed subscription per upload tile
 * instead of one wardrobe-wide list per status.
 */
export function useUploadItems(uploadId: Id<"uploads"> | null | undefined): Item[] | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.items.listByUpload, isAuthenticated && uploadId ? { uploadId } : "skip");
}

/** One item with its outfits, source photo and flagged duplicate. `null` means it is gone or not yours. */
export function useItem(itemId: string | null | undefined): ItemDetail | null | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.items.get, isAuthenticated && itemId ? { itemId } : "skip");
}

/**
 * Hide / unhide with the grid updated before the round-trip: the wardrobe lists are keyed by status,
 * so the ids move between them and the detail view follows.
 */
export function useSetItemStatus() {
  return useMutation(api.items.setStatus).withOptimisticUpdate((localStore, { itemIds, status }) => {
    const ids = new Set<string>(itemIds);
    for (const { args, value } of localStore.getAllQueries(api.items.list)) {
      if (value === undefined) continue;
      const wanted: ItemStatus = args.status ?? "ready";
      const next = value
        .filter((item) => !ids.has(item._id) || wanted === status)
        .map((item) => (ids.has(item._id) ? { ...item, status } : item));
      localStore.setQuery(api.items.list, args, next);
    }
    // Search results carry every status and are filtered in `useWardrobe`, so they only need the new status.
    for (const { args, value } of localStore.getAllQueries(api.items.search)) {
      if (value === undefined) continue;
      localStore.setQuery(
        api.items.search,
        args,
        value.map((item) => (ids.has(item._id) ? { ...item, status } : item)),
      );
    }
    for (const { args, value } of localStore.getAllQueries(api.items.get)) {
      if (!value || !ids.has(value.item._id)) continue;
      localStore.setQuery(api.items.get, args, { ...value, item: { ...value.item, status } });
    }
  });
}

/** "Keep both" on a flagged duplicate: the banner and the tile badge go the moment it is tapped. */
export function useDismissDuplicate() {
  return useMutation(api.items.dismissDuplicate).withOptimisticUpdate((localStore, { itemId }) => {
    for (const { args, value } of localStore.getAllQueries(api.items.list)) {
      if (value === undefined) continue;
      localStore.setQuery(
        api.items.list,
        args,
        value.map((item) => (item._id === itemId ? { ...item, duplicateOfId: undefined } : item)),
      );
    }
    for (const { args, value } of localStore.getAllQueries(api.items.get)) {
      if (!value || value.item._id !== itemId) continue;
      localStore.setQuery(api.items.get, args, {
        ...value,
        item: { ...value.item, duplicateOfId: undefined },
        duplicateOf: null,
      });
    }
  });
}

/** Distinct swatches across a list of items, most common first — the wardrobe colour filter. */
export function colourOptions(items: readonly Item[]): Array<{ value: string; hex: string | null; count: number }> {
  const counts = new Map<string, { hex: string | null; count: number }>();
  for (const item of items) {
    const value = item.colours.primary;
    if (!value) continue;
    const existing = counts.get(value);
    if (existing) existing.count += 1;
    else counts.set(value, { hex: item.colours.hex[0] ?? null, count: 1 });
  }
  return [...counts.entries()]
    .map(([value, { hex, count }]) => ({ value, hex, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
