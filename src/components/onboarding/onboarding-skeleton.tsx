import { Skeleton } from "@/components/ui/skeleton";

export function OnboardingSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8" aria-busy="true" aria-label="Loading setup">
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-12 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-6 border-b pb-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-12">
        <Skeleton className="h-56 rounded-none" />
        <div className="grid grid-cols-2 gap-5">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-24 rounded-none" />
          ))}
        </div>
      </div>
      <div className="flex justify-end border-t pt-5">
        <Skeleton className="h-11 w-32 rounded-sm" />
      </div>
    </div>
  );
}
