import { Skeleton } from "@/components/ui/skeleton";

export function SettingsSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6" aria-busy="true" aria-label="Loading settings">
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="flex gap-5">
        {[0, 1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-4 w-24" />
        ))}
      </div>
      {[0, 1, 2, 3].map((section) => (
        <div key={section} className="grid gap-6 border-t py-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
          <div className="space-y-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-10" />
          </div>
          <div className="grid grid-cols-2 gap-5">
            {[0, 1].map((item) => (
              <Skeleton
                key={item}
                className={section === 0 ? "aspect-[2/3] max-h-80 rounded-none" : "h-24 rounded-none"}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
