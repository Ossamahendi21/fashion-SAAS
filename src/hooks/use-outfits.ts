"use client";

import { useConvexAuth, useMutation, usePaginatedQuery, useQuery, type UsePaginatedQueryResult } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMemo } from "react";
import { NAVIGATION_PAGE_SIZE, useNavigationOutfits } from "@/components/providers/navigation-data";
import { guardMutation, type ErrorSink } from "@/lib/errors";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export type Outfit = NonNullable<FunctionReturnType<typeof api.outfits.get>>;
export type OutfitSlots = Outfit["slots"];
export type OutfitItems = Outfit["items"];
export type OutfitSource = NonNullable<FunctionArgs<typeof api.outfits.list>["source"]>;
export type OutfitSummary = FunctionReturnType<typeof api.outfits.listSummaries>[number];

export const OUTFITS_PAGE_SIZE = NAVIGATION_PAGE_SIZE;

/** The saved outfits grid, a page at a time. Agent proposals only appear once the user saves them. */
export function useSavedOutfits(source?: OutfitSource): UsePaginatedQueryResult<Outfit> {
  const { isAuthenticated } = useConvexAuth();
  const shared = useNavigationOutfits();
  const useShared = source === undefined && shared !== null;
  const local = usePaginatedQuery(
    api.outfits.list,
    isAuthenticated && !useShared ? (source ? { source } : {}) : "skip",
    {
      initialNumItems: OUTFITS_PAGE_SIZE,
    },
  );
  return useShared ? shared : local;
}

/** Just ids and names — for filters and select menus that must not subscribe to every outfit. */
export function useOutfitSummaries(): OutfitSummary[] | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.outfits.listSummaries, isAuthenticated ? {} : "skip");
}

/** Takes the raw route param: the server returns `null` for a malformed, unknown or foreign id. */
export function useOutfit(outfitId: string | null | undefined): Outfit | null | undefined {
  return useQuery(api.outfits.get, outfitId ? { outfitId } : "skip");
}

export type OutfitActions = {
  create: (args: FunctionArgs<typeof api.outfits.create>, onError?: ErrorSink) => Promise<Id<"outfits"> | undefined>;
  update: (args: FunctionArgs<typeof api.outfits.update>, onError?: ErrorSink) => Promise<null | undefined>;
  remove: (outfitId: Id<"outfits">, onError?: ErrorSink) => Promise<null | undefined>;
  markWorn: (outfitId: Id<"outfits">, onError?: ErrorSink) => Promise<null | undefined>;
};

/** Outfit mutations wrapped so failures toast once and resolve to `undefined`. */
export function useOutfitActions(): OutfitActions {
  const create = useMutation(api.outfits.create);
  const update = useMutation(api.outfits.update);
  const remove = useMutation(api.outfits.remove);
  const markWorn = useMutation(api.outfits.markWorn);

  return useMemo<OutfitActions>(
    () => ({
      create: (args, onError) => guardMutation(() => create(args), onError),
      update: (args, onError) => guardMutation(() => update(args), onError),
      remove: (outfitId, onError) => guardMutation(() => remove({ outfitId }), onError),
      markWorn: (outfitId, onError) => guardMutation(() => markWorn({ outfitId, wornAt: Date.now() }), onError),
    }),
    [create, update, remove, markWorn],
  );
}
