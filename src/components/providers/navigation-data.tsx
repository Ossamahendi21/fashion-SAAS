"use client";

import { usePaginatedQuery, useQuery, type UsePaginatedQueryReturnType } from "convex/react";
import { createContext, useContext, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { useCurrentUser } from "@/hooks/use-current-user";

export const NAVIGATION_PAGE_SIZE = 24;

const OutfitsContext = createContext<UsePaginatedQueryReturnType<typeof api.outfits.list> | null>(null);
const RendersContext = createContext<UsePaginatedQueryReturnType<typeof api.renders.listMine> | null>(null);

export function NavigationDataProvider({ children }: { children: ReactNode }) {
  const { user } = useCurrentUser();

  // A matching stored user avoids protected queries racing first sign-in or an account switch.
  if (!user) return children;
  return <AuthenticatedNavigationData key={user._id}>{children}</AuthenticatedNavigationData>;
}

function AuthenticatedNavigationData({ children }: { children: ReactNode }) {
  // Ordinary queries share their live subscription with route-local hooks.
  useQuery(api.items.list, {});
  useQuery(api.items.hasAny, {});
  useQuery(api.avatars.list, {});
  useQuery(api.outfits.listSummaries, {});

  // Convex gives each usePaginatedQuery its own session id. Consumers must share these
  // hook results, not mount another "warm" pagination with a different cache key.
  const outfits = usePaginatedQuery(api.outfits.list, {}, { initialNumItems: NAVIGATION_PAGE_SIZE });
  const renders = usePaginatedQuery(api.renders.listMine, {}, { initialNumItems: NAVIGATION_PAGE_SIZE });

  return (
    <OutfitsContext value={outfits}>
      <RendersContext value={renders}>{children}</RendersContext>
    </OutfitsContext>
  );
}

export function useNavigationOutfits() {
  return useContext(OutfitsContext);
}

export function useNavigationRenders() {
  return useContext(RendersContext);
}
