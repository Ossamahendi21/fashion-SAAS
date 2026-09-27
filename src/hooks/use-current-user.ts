"use client";

import { useAuth } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type CurrentUser = NonNullable<FunctionReturnType<typeof api.users.me>>;

/**
 * The signed-in user with their live balance.
 * `isLoading` covers both Clerk bootstrapping and the first Convex round-trip.
 */
export function useCurrentUser(): { user: CurrentUser | null; isLoading: boolean; isAuthenticated: boolean } {
  const { userId } = useAuth();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const result = useQuery(api.users.me, isAuthenticated ? {} : "skip");
  const isLoading = authLoading || (isAuthenticated && result === undefined);
  // Clerk may switch accounts before Convex replaces its previous live result.
  const user = isAuthenticated && result && result.clerkId === userId ? result : null;
  return { user, isLoading, isAuthenticated };
}
