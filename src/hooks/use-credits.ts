"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";

export type Balance = FunctionReturnType<typeof api.credits.balance>;
export type CreditQuote = FunctionReturnType<typeof api.credits.quote>;
export type QuoteRequest = FunctionArgs<typeof api.credits.quote>["request"];

export function useBalance(): { balance: Balance | undefined; isLow: boolean } {
  const { isAuthenticated } = useConvexAuth();
  const balance = useQuery(api.credits.balance, isAuthenticated ? {} : "skip");
  // The server owns the threshold (`LIMITS.lowBalanceThreshold`) and ships it as `lowBalance`.
  return { balance, isLow: balance?.lowBalance ?? false };
}

/** Live quote for an action; pass `null` to skip (e.g. while a sheet is closed). */
export function useCreditQuote(request: QuoteRequest | null): CreditQuote | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.credits.quote, isAuthenticated && request ? { request } : "skip");
}
