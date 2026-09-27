"use client";

import { useState } from "react";
import { AlertCircle, Check } from "lucide-react";
import { ItemImage } from "@/components/common/item-image";
import { jobProgress } from "@/components/common/job-progress";
import { JobStepper } from "@/components/common/job-stepper";
import { RenderCard } from "@/components/renders/render-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useActiveJobs, useJob } from "@/hooks/use-active-jobs";
import type { Outfit } from "@/hooks/use-outfits";
import { useRendersForOutfit, type Render } from "@/hooks/use-renders";
import { formatCredits } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { isTerminalJobStatus } from "@convex/shared/jobs";

export function RenderPanel({
  outfit,
  draftDirty = false,
  startedJobId = null,
}: {
  outfit: Outfit;
  draftDirty?: boolean;
  startedJobId?: Id<"jobs"> | null;
}) {
  const renders = useRendersForOutfit(outfit._id);
  const pendingJobId = renders?.find((render) => render.status === "pending")?.jobId ?? null;
  const job = useJob(pendingJobId ?? startedJobId);
  const { jobs } = useActiveJobs();
  const activeJobs = jobs?.filter((active) => active.type === "render" && active.outfitIds?.includes(outfit._id)) ?? [];
  const visibleJobs = activeJobs.length > 0 ? activeJobs : job && !isTerminalJobStatus(job.status) ? [job] : [];
  const doneCount = renders?.filter((render) => render.status === "done").length ?? 0;
  const pendingCount = renders?.filter((render) => render.status === "pending").length ?? 0;
  const failedCount = renders?.filter((render) => render.status === "failed").length ?? 0;
  const settled = job && isTerminalJobStatus(job.status) ? jobProgress(job) : null;
  const refunded = job ? job.refunds.plan + job.refunds.pack : 0;

  return (
    <section className="min-w-0 space-y-3" aria-labelledby="outfit-try-ons-heading">
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-foreground/20 py-3">
        <h2 id="outfit-try-ons-heading" className="font-mono text-[10px] tracking-[0.16em] uppercase">
          Your try-ons
        </h2>
        {renders && renders.length > 0 ? (
          <p className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground" role="status">
            <span>{doneCount} ready</span>
            {pendingCount > 0 ? (
              <span className="flex items-center gap-1 text-foreground">
                <Spinner className="size-3 motion-reduce:animate-none" />
                {pendingCount} processing
              </span>
            ) : null}
            {failedCount > 0 ? <span>{failedCount} failed</span> : null}
          </p>
        ) : null}
      </div>
      {visibleJobs.length > 0 ? (
        <div className="space-y-3 border-l-2 border-foreground/70 bg-muted/30 px-3 py-3">
          {visibleJobs.length > 1 ? (
            <p className="font-mono text-[9px] tracking-wider text-muted-foreground uppercase">
              {visibleJobs.length} try-on requests in progress
            </p>
          ) : null}
          {visibleJobs.map((active) => (
            <JobStepper key={active._id} job={active} />
          ))}
        </div>
      ) : settled ? (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-foreground/20 bg-muted/25 px-3 py-2.5 text-[11px]"
          role="status"
        >
          <span className="flex items-center gap-1.5 font-medium">
            {job?.status === "done" ? (
              <Check className="size-3 text-success" aria-hidden />
            ) : (
              <AlertCircle className="size-3 text-warning" aria-hidden />
            )}
            {settled.title}
          </span>
          <span className="text-muted-foreground">
            {settled.countLabel}
            {refunded > 0 ? ` · ${formatCredits(refunded)} returned` : ""}
          </span>
        </div>
      ) : null}
      {renders === undefined ? (
        <Skeleton className="mx-auto aspect-[2/3] w-full max-w-[min(340px,36svh)] rounded-none" />
      ) : renders.length > 0 ? (
        <TryOnViewer key={outfit._id} renders={renders} regenerateDisabled={draftDirty} />
      ) : (
        <div className="space-y-3 border-b border-foreground/15 py-10">
          <h3 className="max-w-sm text-3xl leading-tight font-medium tracking-[-0.05em]">
            Your outfit.
            <br />
            On you.
          </h3>
          <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
            Choose Try on outfit to create a full-length preview. Your pieces and fit settings are ready.
          </p>
        </div>
      )}
      {draftDirty && doneCount > 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          These previews show a previously saved look. Save your changes before creating another.
        </p>
      ) : null}
    </section>
  );
}

function TryOnViewer({ renders, regenerateDisabled }: { renders: Render[]; regenerateDisabled: boolean }) {
  const [selectedId, setSelectedId] = useState(
    () => (renders.find((render) => render.status === "done") ?? renders[0])?._id,
  );
  const selected = renders.find((render) => render._id === selectedId) ?? renders[0];
  if (!selected) return null;
  if (selectedId !== selected._id) setSelectedId(selected._id);

  return (
    <div className={cn("grid items-start gap-3", renders.length > 1 && "grid-cols-[minmax(0,1fr)_56px]")}>
      <div className="flex justify-center bg-muted/25 p-3">
        <RenderCard
          key={selected._id}
          render={selected}
          regenerateDisabled={regenerateDisabled}
          className="w-full max-w-[min(340px,36svh)]"
        />
      </div>
      <div className="col-span-full flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>
          {selected.status === "done"
            ? "Click the image to view full size"
            : selected.status === "pending"
              ? "Your try-on is processing"
              : "This try-on needs attention"}
        </span>
        <span className="tabular-nums">
          {renders.findIndex((render) => render._id === selected._id) + 1} / {renders.length}
        </span>
      </div>
      {renders.length > 1 ? (
        <div
          className="col-start-2 row-start-1 flex max-h-[min(510px,54svh)] flex-col gap-2 overflow-y-auto p-1"
          aria-label="Choose a try-on preview"
        >
          {renders.map((render, index) => (
            <button
              key={render._id}
              type="button"
              onClick={() => setSelectedId(render._id)}
              aria-pressed={render._id === selected._id}
              aria-label={`Show try-on ${index + 1}, ${render.status === "done" ? "ready" : render.status === "pending" ? "processing" : "failed"}`}
              className={cn(
                "relative w-full shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2",
                render._id === selected._id
                  ? "ring-1 ring-foreground ring-offset-2 ring-offset-background"
                  : "opacity-65 hover:opacity-100",
              )}
            >
              {render.status === "done" ? (
                <ItemImage src={render.url} alt={`Try-on ${index + 1}`} variant="render" className="rounded-none" />
              ) : (
                <span className="flex aspect-[2/3] flex-col items-center justify-center gap-2 bg-muted/50 px-1">
                  {render.status === "pending" ? (
                    <Spinner className="size-4 motion-reduce:animate-none" />
                  ) : (
                    <AlertCircle className="size-4" />
                  )}
                  <span className="text-[8px]">{render.status === "pending" ? "Processing" : "Failed"}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
