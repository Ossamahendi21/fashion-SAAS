import { LoadingGrid } from "@/components/common/loading-grid";
import { Skeleton } from "@/components/ui/skeleton";

function HeaderSkeleton({ withActions = true }: { withActions?: boolean }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-64" />
      </div>
      {withActions ? <Skeleton className="h-8 w-32" /> : null}
    </div>
  );
}

/** Matches /outfits: header, filter chips, tile grid. */
export function OutfitsPageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading outfits">
      <HeaderSkeleton />
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-7 w-48 rounded-lg" />
          <Skeleton className="h-4 w-20" />
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

export function OutfitBuilderSkeleton() {
  return (
    <div
      className="grid gap-8 @3xl:grid-cols-[minmax(0,1fr)_240px] @3xl:gap-8"
      aria-busy="true"
      aria-label="Loading outfit"
    >
      <div className="space-y-4">
        <Skeleton className="h-4 w-36 rounded-none" />
        <Skeleton className="aspect-[5/4] rounded-none" />
      </div>
      <div className="space-y-8 border-t pt-4">
        <Skeleton className="h-4 w-32 rounded-none" />
        <Skeleton className="h-12 w-full rounded-none" />
        <Skeleton className="h-12 w-full rounded-none" />
        <Skeleton className="h-10 w-full rounded-none" />
      </div>
    </div>
  );
}

export function OutfitBuilderPageSkeleton() {
  return (
    <div className="space-y-6">
      <HeaderSkeleton />
      <OutfitBuilderSkeleton />
    </div>
  );
}
