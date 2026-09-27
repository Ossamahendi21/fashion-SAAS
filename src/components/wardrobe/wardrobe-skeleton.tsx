import { LoadingGrid } from "@/components/common/loading-grid";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors /wardrobe: header, toolbar row, category rail and the tile grid. */
export function WardrobeSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading wardrobe">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-8 w-32 rounded-lg" />
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 min-w-48 flex-1 rounded-lg sm:max-w-sm" />
          <Skeleton className="h-8 w-24 rounded-lg" />
          <Skeleton className="h-8 w-40 rounded-lg" />
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 9 }, (_, index) => (
            <Skeleton key={index} className="h-7 w-20 rounded-lg" />
          ))}
        </div>
      </div>
      <LoadingGrid count={10} />
    </div>
  );
}
