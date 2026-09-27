"use client";

import { useQuery } from "convex/react";
import { Download } from "lucide-react";
import { useState } from "react";
import { ItemImage } from "@/components/common/item-image";
import { JobStepper } from "@/components/common/job-stepper";
import { renderJobStatus } from "@/components/stylist/render-job-status";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useJob } from "@/hooks/use-active-jobs";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

type Lightbox = { url: string; label: string } | null;

/** The card a `start_renders` call leaves in the chat: live job progress, then the images. */
export function RenderJobCard({ jobId }: { jobId: Id<"jobs"> }) {
  const job = useJob(jobId);
  const [lightbox, setLightbox] = useState<Lightbox>(null);

  if (job === undefined) return <Skeleton className="h-28 w-full rounded-xl" />;
  if (job === null) {
    return <p className="text-xs text-muted-foreground">That render job is no longer available.</p>;
  }

  const outfitIds = job.outfitIds ?? [];
  const status = renderJobStatus(job);

  return (
    <div className="space-y-5 border-y py-5">
      <div className="flex items-center justify-between gap-2">
        <div role="status" aria-live="polite" aria-atomic="true" className="space-y-1">
          <h3 className="text-xl font-medium tracking-tight">{status.title}</h3>
          <p className="text-xs text-muted-foreground">{status.detail}</p>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">{formatRelative(job.createdAt)}</span>
      </div>

      {status.running ? <JobStepper job={job} /> : null}
      {!status.running && job.error ? <p className="text-xs text-destructive">{job.error}</p> : null}

      <div className="space-y-3">
        {outfitIds.map((outfitId) => (
          <OutfitRenders key={outfitId} outfitId={outfitId} jobId={jobId} onOpen={setLightbox} />
        ))}
      </div>

      <Dialog open={lightbox !== null} onOpenChange={(open) => !open && setLightbox(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <DialogTitle className="sr-only">{lightbox?.label ?? "Render"}</DialogTitle>
          {lightbox ? (
            <div className="space-y-3">
              <ItemImage src={lightbox.url} alt={lightbox.label} variant="render" priority />
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">{lightbox.label}</p>
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<a href={lightbox.url} download target="_blank" rel="noreferrer" />}
                >
                  <Download data-icon="inline-start" />
                  Download
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OutfitRenders({
  outfitId,
  jobId,
  onOpen,
}: {
  outfitId: Id<"outfits">;
  jobId: Id<"jobs">;
  onOpen: (lightbox: Lightbox) => void;
}) {
  const renders = useQuery(api.renders.listByOutfit, { outfitId });
  if (renders === undefined) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 2 }, (_, index) => (
          <Skeleton key={index} className="aspect-[2/3] rounded-xl" />
        ))}
      </div>
    );
  }

  const mine = renders.filter((render) => render.jobId === jobId);
  if (mine.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{mine[0].outfitName}</p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {mine.map((render) => {
          const label = `${render.outfitName} render`;
          const openable = render.status === "done" && render.url !== null;
          return (
            <button
              key={render._id}
              type="button"
              disabled={!openable}
              onClick={() => (openable && render.url ? onOpen({ url: render.url, label }) : undefined)}
              className={cn(
                "group relative outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                openable ? "cursor-zoom-in" : "cursor-default",
              )}
              aria-label={openable ? `Open ${label}` : `${label} — ${render.status}`}
            >
              <ItemImage src={render.url} alt={label} variant="render" className="rounded-none" />
              {render.status === "failed" ? (
                <span className="absolute inset-x-1 bottom-1 rounded-md bg-background/90 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                  Failed
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
