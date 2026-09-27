"use client";

import { Activity, ArrowUpRight, Check, Clock3, ScanLine, Shirt } from "lucide-react";
import Link from "next/link";
import { jobProgress } from "@/components/common/job-progress";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useActiveJobs, useJobCompletionToasts } from "@/hooks/use-active-jobs";
import { pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** Running jobs at a glance from anywhere in the app; also owns the completion toasts. */
export function ActivityPopover({ className }: { className?: string }) {
  const { jobs, count } = useActiveJobs();
  useJobCompletionToasts();
  const photos = jobs?.filter((job) => job.type === "ingest").length ?? 0;
  const renders = count - photos;
  const counts = [photos ? pluralize(photos, "photo") : "", renders ? pluralize(renders, "try-on request") : ""]
    .filter(Boolean)
    .join(" · ");
  const running = jobs?.some((job) => job.steps.some((step) => step.status === "running"));

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn("relative size-11 sm:size-8", className)}
            aria-label={count ? `Activity: ${counts} in progress` : "Activity"}
          />
        }
      >
        {running ? (
          <Spinner className="size-4 motion-reduce:animate-none" />
        ) : count ? (
          <Clock3 className="size-4" />
        ) : (
          <Activity className="size-4" />
        )}
        {count ? (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(360px,calc(100vw-24px))] gap-0 overflow-hidden p-0 motion-reduce:animate-none"
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <h2 className="font-mono text-[10px] tracking-[0.16em] uppercase">In the studio</h2>
          <span className="text-[10px] text-muted-foreground tabular-nums">{count ? counts : "Activity"}</span>
        </div>
        {jobs === undefined ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Spinner className="size-3.5 motion-reduce:animate-none" /> Checking your activity…
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex items-start gap-3 p-4">
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <div className="space-y-1">
              <p className="text-sm font-medium">All caught up.</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Your scans and try-ons will appear here while they’re processing.
              </p>
            </div>
          </div>
        ) : (
          <>
            <ul className="max-h-[min(420px,60svh)] divide-y overflow-y-auto overscroll-contain">
              {jobs.map((job) => {
                const view = jobProgress(job);
                const queued = job.status === "queued" || !job.steps.some((step) => step.status === "running");
                return (
                  <li key={job._id}>
                    <Link
                      href={
                        job.type === "ingest"
                          ? routes.add
                          : job.outfitIds?.[0]
                            ? routes.outfit(job.outfitIds[0])
                            : routes.lookbook
                      }
                      className="group/activity flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] motion-reduce:transition-none"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center bg-muted/60">
                        {job.type === "ingest" ? <ScanLine className="size-4" /> : <Shirt className="size-4" />}
                      </span>
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="flex items-center gap-1.5 text-xs font-medium">
                          {queued ? (
                            <Clock3 className="size-3 text-muted-foreground" />
                          ) : (
                            <Spinner className="size-3 motion-reduce:animate-none" />
                          )}
                          {view.title}
                        </span>
                        <span className="block text-[11px] text-muted-foreground tabular-nums">
                          {view.countLabel ??
                            (job.type === "ingest" ? "1 photo · review before importing" : "Preparing your try-ons")}
                        </span>
                      </span>
                      <ArrowUpRight
                        className="mt-1 size-3.5 shrink-0 text-muted-foreground group-hover/activity:text-foreground"
                        aria-hidden
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
            <p className="border-t bg-muted/25 px-4 py-2.5 text-[10px] text-muted-foreground">
              Keep exploring. We’ll let you know when it’s ready.
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
