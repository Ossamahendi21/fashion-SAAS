import { Skeleton } from "@/components/ui/skeleton";

export function AddClothesSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading add clothes">
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-12 w-60" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-8 border-t pt-6 lg:grid-cols-[minmax(280px,0.7fr)_minmax(0,1.3fr)] lg:gap-10">
        <div className="space-y-5 lg:border-r lg:pr-10">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-56 rounded-none" />
          <Skeleton className="h-8" />
          <div className="space-y-4 border-t pt-5">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-10" />
            ))}
          </div>
        </div>
        <div className="space-y-5">
          <Skeleton className="h-7 w-64" />
          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((item) => (
              <Skeleton key={item} className="aspect-[3/4] rounded-none" />
            ))}
          </div>
          <Skeleton className="h-16" />
          <Skeleton className="h-14" />
        </div>
      </div>
    </div>
  );
}
