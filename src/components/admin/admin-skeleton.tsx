import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTileSkeleton } from "./stat-tile";

export function StatTilesSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading figures">
      {Array.from({ length: count }, (_, index) => (
        <StatTileSkeleton key={index} />
      ))}
    </div>
  );
}

function TableCardSkeleton({ rows }: { rows: number }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-56" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full rounded-lg" />
        ))}
      </CardContent>
    </Card>
  );
}

/** Route-level skeleton: mirrors header → figures → spend cap → jobs → spenders → adjust. */
export function AdminSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8" aria-busy="true" aria-label="Loading admin">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-8 w-40 rounded-lg" />
      </div>
      <StatTilesSkeleton count={3} />
      <StatTilesSkeleton count={4} />
      <StatTilesSkeleton count={6} />
      <Skeleton className="h-28 w-full rounded-xl" />
      <TableCardSkeleton rows={5} />
      <TableCardSkeleton rows={4} />
    </div>
  );
}
