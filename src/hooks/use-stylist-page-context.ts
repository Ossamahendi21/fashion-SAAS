"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import {
  createStylistItemContext,
  createStylistOutfitContext,
  createStylistPageContext,
  getStylistPageRoute,
  type StylistPageContext,
} from "@/lib/stylist-context";

export function useStylistPageContext({ enabled = true }: { enabled?: boolean } = {}): {
  context: StylistPageContext | null;
  isLoading: boolean;
} {
  const pathname = usePathname();
  const { isAuthenticated } = useConvexAuth();
  const route = useMemo(
    () => (enabled && isAuthenticated ? getStylistPageRoute(pathname) : null),
    [enabled, isAuthenticated, pathname],
  );
  const item = useQuery(api.items.get, route?.kind === "item" ? { itemId: route.itemId } : "skip");
  const outfit = useQuery(api.outfits.get, route?.kind === "outfit" ? { outfitId: route.outfitId } : "skip");
  const wardrobe = useQuery(api.items.list, route?.kind === "wardrobe" ? {} : "skip");

  return useMemo(() => {
    if (!route) return { context: null, isLoading: false };
    if (route.kind === "item")
      return {
        context: item?.item._id === route.itemId ? createStylistItemContext(route.path, item.item) : null,
        isLoading: item === undefined,
      };
    if (route.kind === "outfit")
      return {
        context: outfit?._id === route.outfitId ? createStylistOutfitContext(route.path, outfit) : null,
        isLoading: outfit === undefined,
      };
    if (route.kind === "wardrobe" && wardrobe === undefined) return { context: null, isLoading: true };
    return { context: createStylistPageContext(route, wardrobe), isLoading: false };
  }, [route, item, outfit, wardrobe]);
}
