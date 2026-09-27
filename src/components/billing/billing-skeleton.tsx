import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function SummaryCardsSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("grid gap-10 border-y py-7 md:grid-cols-2", className)}
      aria-busy="true"
      aria-label="Loading balance"
    >
      <div className="space-y-5">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-24 w-48 rounded-none" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="space-y-5">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-20 w-full rounded-none" />
      </div>
    </div>
  );
}

/** Route-level skeleton: mirrors header → balance → plans → ledger. */
export function BillingSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8" aria-busy="true" aria-label="Loading billing">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-12 w-52" />
        <SummaryCardsSkeleton />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}
