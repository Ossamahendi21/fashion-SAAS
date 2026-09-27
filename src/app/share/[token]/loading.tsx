import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14"
      aria-busy="true"
      aria-label="Loading shared render"
    >
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="aspect-[2/3] w-full rounded-2xl" />
      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <div className="flex gap-1.5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="size-14 rounded-lg" />
          ))}
        </div>
      </div>
    </main>
  );
}
