"use client";

import { Receipt } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingRows } from "@/components/common/loading-grid";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLedger, LEDGER_PAGE_SIZE, type LedgerKind, type LedgerLine } from "@/hooks/use-billing";
import { formatCredits, formatDateTime, formatNumber, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Keyed by the ledger `kind` union the server returns, so a new kind added there shows up here as a
 * type error rather than as a raw `plan_reset` in the table.
 */
const KIND_LABELS: Partial<Record<LedgerKind, string>> = {
  plan_grant: "Plan credits",
  plan_reset: "Cycle reset",
  signup_bonus: "Welcome credits",
  topup: "Credit purchase",
  reserve: "Used",
  refund: "Refund",
  admin: "Adjustment",
};

function kindLabel(kind: LedgerKind): string {
  return KIND_LABELS[kind] ?? titleCase(String(kind).replace(/_/g, "-"));
}

function LedgerRow({ line }: { line: LedgerLine }) {
  const positive = line.delta > 0;
  return (
    <TableRow>
      <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(line.createdAt)}</TableCell>
      <TableCell className="font-medium">{kindLabel(line.kind)}</TableCell>
      <TableCell className={cn("font-medium tabular-nums", positive ? "text-success" : "text-foreground")}>
        {formatCredits(line.delta, { signed: true })}
      </TableCell>
      <TableCell className="hidden text-muted-foreground sm:table-cell">
        {line.bucket === "plan" ? "Plan" : "Non-expiring"}
      </TableCell>
      <TableCell className="hidden max-w-[22ch] truncate text-muted-foreground md:table-cell" title={line.note}>
        {line.note ?? "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatNumber(line.balanceAfter)}</TableCell>
    </TableRow>
  );
}

export function LedgerTable() {
  const { results, status, loadMore } = useLedger();

  return (
    <section className="space-y-6" aria-labelledby="ledger-title">
      <div className="space-y-2">
        <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Account history</p>
        <h2 id="ledger-title" className="text-3xl font-medium tracking-[-0.045em]">
          Every credit, accounted for.
        </h2>
        <p className="text-sm text-muted-foreground">Credit grants, spending and refunds. Newest first.</p>
      </div>
      <div className="border-t border-foreground/20">
        {status === "LoadingFirstPage" ? (
          <LoadingRows count={6} className="py-4" />
        ) : results.length === 0 ? (
          <div>
            <EmptyState
              icon={Receipt}
              title="No credit activity yet"
              description="Welcome credits, plan allowances, try-ons and refunds appear here as they happen."
              action={
                <Button variant="outline" size="sm" nativeButton={false} render={<a href="#plans" />}>
                  View plans
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead className="hidden sm:table-cell">Bucket</TableHead>
                  <TableHead className="hidden md:table-cell">Note</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((line) => (
                  <LedgerRow key={line._id} line={line} />
                ))}
              </TableBody>
            </Table>
            {status !== "Exhausted" ? (
              <div className="flex justify-center pt-6">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={status === "LoadingMore"}
                  onClick={() => loadMore(LEDGER_PAGE_SIZE)}
                >
                  {status === "LoadingMore" ? <Spinner data-icon="inline-start" /> : null}
                  {status === "LoadingMore" ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
