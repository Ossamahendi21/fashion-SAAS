"use client";

import { usePaginatedQuery, type UsePaginatedQueryResult } from "convex/react";
import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type LedgerLine = FunctionReturnType<typeof api.credits.ledger>["page"][number];
/** The server's `kind` union, so labels and switches stay exhaustive. */
export type LedgerKind = LedgerLine["kind"];

export const LEDGER_PAGE_SIZE = 25;

/** Newest-first credit ledger for the signed-in user, paginated. */
export function useLedger(initialNumItems: number = LEDGER_PAGE_SIZE): UsePaginatedQueryResult<LedgerLine> {
  return usePaginatedQuery(api.credits.ledger, {}, { initialNumItems });
}
