import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type LoadingGridProps = {
  count?: number;
  /** Tailwind aspect class for each tile, e.g. "aspect-[3/4]". */
  aspect?: string;
  withCaption?: boolean;
  className?: string;
};

/** Skeleton grid that matches the wardrobe / lookbook tile layout. */
export function LoadingGrid({ count = 8, aspect = "aspect-[3/4]", withCaption = true, className }: LoadingGridProps) {
  return (
    <div
      className={cn("grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5", className)}
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-2">
          <Skeleton className={cn("w-full rounded-xl", aspect)} />
          {withCaption ? (
            <>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function LoadingRows({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}
