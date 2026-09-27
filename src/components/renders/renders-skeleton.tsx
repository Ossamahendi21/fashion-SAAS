import { LoadingGrid } from "@/components/common/loading-grid";
import { Skeleton } from "@/components/ui/skeleton";

/** Matches /lookbook: header, outfit filter, captioned tile grid. */
export function LookbookPageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading lookbook">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
      </div>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-8 w-56 rounded-lg" />
          <Skeleton className="h-4 w-24" />
        </div>
        <LoadingGrid
          count={8}
          aspect="aspect-[2/3]"
          className="grid-cols-2 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-4"
        />
      </div>
    </div>
  );
}
