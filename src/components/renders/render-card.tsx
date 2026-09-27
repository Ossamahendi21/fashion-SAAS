"use client";

import {
  AlertCircle,
  Clock3,
  ScanLine,
  Download,
  EllipsisVertical,
  Link2,
  Lock,
  Maximize2,
  RefreshCw,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ItemImage } from "@/components/common/item-image";
import { pendingRenderProgress, typicalDuration } from "@/components/common/job-progress";
import { RenderLightbox } from "@/components/renders/render-lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useJob, type JobView } from "@/hooks/use-active-jobs";
import { useClerkPlan } from "@/hooks/use-clerk-plan";
import { useElapsed, useRenderActions, useRenderDownload, type Render } from "@/hooks/use-renders";
import { formatCredits, formatDuration, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { api } from "@convex/_generated/api";
import { CREDIT_COSTS } from "@convex/shared/credits";
import { isTerminalJobStatus } from "@convex/shared/jobs";

type RenderCardProps = {
  render: Render;
  /** Adds the outfit name under the tile — on for the lookbook, off on an outfit's own page. */
  showOutfit?: boolean;
  regenerateDisabled?: boolean;
  className?: string;
};

/**
 * One render tile. Shared by the outfit page and the lookbook, so it owns every per-render
 * action: open, download, share, regenerate and delete.
 */
export function RenderCard({ render, showOutfit = false, regenerateDisabled = false, className }: RenderCardProps) {
  const { canShare } = useClerkPlan();
  const actions = useRenderActions();
  const { download, pendingRenderId } = useRenderDownload();
  const removeRender = useMutation(api.renders.remove);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Only a waiting tile needs the running averages; finished ones do not subscribe at all.
  const estimates = useQuery(api.jobs.stepEstimates, render.status === "pending" ? {} : "skip");

  const renderJob = useJob(render.status !== "done" ? render.jobId : null);
  const settling = renderJob === undefined || (renderJob !== null && !isTerminalJobStatus(renderJob.status));

  const regenerateCost = CREDIT_COSTS.render[render.quality];
  const downloading = pendingRenderId === render._id;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setDismissing(true);
    try {
      await actions.remove(render._id);
    } finally {
      setDismissing(false);
    }
  }

  return (
    <figure className={cn("group/render flex flex-col gap-3", className)}>
      <div className="relative">
        {render.status === "pending" ? (
          <PendingTile
            renderId={render._id}
            createdAt={render.createdAt}
            job={renderJob}
            estimateMs={estimates?.render}
          />
        ) : render.status === "failed" ? (
          <FailedTile
            error={render.error}
            busy={busy}
            dismissing={dismissing}
            settling={settling}
            regenerateDisabled={regenerateDisabled}
            onRetry={() => void run(() => actions.regenerate(render._id))}
            onDismiss={() => void dismiss()}
          />
        ) : (
          <>
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              aria-label={`Open ${render.outfitName}`}
              className="relative block w-full rounded-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ItemImage src={render.url} alt={render.outfitName} variant="render" className="rounded-none" />
              <span className="absolute right-3 bottom-3 flex items-center gap-2 bg-background/90 px-3 py-2 text-[10px] transition-opacity motion-reduce:transition-none sm:opacity-0 sm:group-focus-within/render:opacity-100 sm:group-hover/render:opacity-100">
                <Maximize2 className="size-3" />
                View full size
              </span>
            </button>
            {render.shareToken ? (
              <Badge
                variant="secondary"
                className="absolute top-3 left-3 rounded-none bg-background/85 font-mono text-[9px] tracking-wider uppercase"
              >
                <Link2 aria-hidden />
                Shared
              </Badge>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    className="absolute top-3 right-3 rounded-none bg-background/85 shadow-none"
                    aria-label="Render options"
                  />
                }
              >
                {busy || downloading ? <Spinner className="size-3.5" /> : <EllipsisVertical />}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setLightboxOpen(true)}>
                  <Maximize2 />
                  Open
                </DropdownMenuItem>
                <DropdownMenuItem
                  closeOnClick={false}
                  disabled={!render.url || downloading}
                  onClick={() => void download(render)}
                >
                  {downloading ? <Spinner className="size-4" /> : <Download />}
                  {downloading ? "Saving…" : "Download"}
                </DropdownMenuItem>

                {render.shareToken ? (
                  <>
                    <DropdownMenuItem onClick={() => void actions.copyShareLink(render.shareToken ?? "")}>
                      <Link2 />
                      Copy share link
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void run(() => actions.unshare(render._id))}>
                      <Lock />
                      Stop sharing
                    </DropdownMenuItem>
                  </>
                ) : canShare ? (
                  <DropdownMenuItem onClick={() => void run(() => actions.shareAndCopy(render._id))}>
                    <Share2 />
                    Share
                  </DropdownMenuItem>
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={<span className="block" />}>
                      <DropdownMenuItem disabled>
                        <Lock />
                        Share
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    <TooltipContent side="left">Pro plan</TooltipContent>
                  </Tooltip>
                )}

                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={regenerateDisabled}
                  onClick={() => void run(() => actions.regenerate(render._id))}
                >
                  <RefreshCw />
                  {regenerateDisabled ? "Save outfit edits first" : "Regenerate"}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {formatCredits(regenerateCost)}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {showOutfit ? (
        <figcaption className="space-y-1 border-b border-foreground/15 pb-4">
          <p className="line-clamp-1 text-base font-medium tracking-tight">{render.outfitName}</p>
          <p className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase tabular-nums">
            {formatRelative(render.completedAt ?? render.createdAt)}
          </p>
        </figcaption>
      ) : null}

      <RenderLightbox render={render} open={lightboxOpen} onOpenChange={setLightboxOpen} />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this render?"
        description="The image is removed for good. Credits already spent are not refunded."
        confirmLabel="Delete"
        destructive
        // The raw mutation, not the toast-and-swallow wrapper: ConfirmDialog keeps itself open and
        // reports the error when this rejects.
        onConfirm={() => removeRender({ renderId: render._id })}
      />
    </figure>
  );
}

function PendingTile({
  renderId,
  createdAt,
  job,
  estimateMs,
}: {
  renderId: string;
  createdAt: number;
  job: JobView | null | undefined;
  estimateMs: number | undefined;
}) {
  const state = pendingRenderProgress(job, renderId);
  const elapsed = useElapsed(state.startedAt ?? createdAt);
  const usual = state.running ? typicalDuration(estimateMs) : null;
  return (
    <div className="relative flex aspect-[2/3] flex-col items-center justify-center overflow-hidden bg-muted/35 p-4 text-center">
      <div className="pointer-events-none absolute inset-4 border border-foreground/10" aria-hidden />
      <span className="absolute top-7 left-7 font-mono text-[8px] tracking-[0.2em] text-muted-foreground uppercase">
        Fitting room
      </span>
      <ScanLine className="mb-5 size-8 stroke-1 text-foreground/35" aria-hidden />
      <div className="relative space-y-2" role="status">
        <p className="flex items-center justify-center gap-2 text-xs font-medium">
          {state.running ? (
            <Spinner className="size-3.5 motion-reduce:animate-none" aria-hidden />
          ) : (
            <Clock3 className="size-3.5" aria-hidden />
          )}
          {state.title}
        </p>
        <p className="mx-auto max-w-44 text-[11px] leading-relaxed text-muted-foreground">
          {state.settled
            ? "This request is no longer processing."
            : usual
              ? `Usually ${usual} per image.`
              : "Your image will appear here automatically."}
        </p>
      </div>
      <p className="absolute right-5 bottom-7 left-5 text-[10px] text-muted-foreground tabular-nums">
        {state.settled
          ? "Request finished"
          : elapsed >= 1000
            ? `${formatDuration(elapsed)} ${state.startedAt ? "elapsed" : "since requested"}`
            : "Getting things ready"}
      </p>
    </div>
  );
}

function FailedTile({
  error,
  busy,
  dismissing,
  settling,
  regenerateDisabled,
  onRetry,
  onDismiss,
}: {
  error: string | undefined;
  busy: boolean;
  dismissing: boolean;
  settling: boolean;
  regenerateDisabled: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex aspect-[2/3] flex-col items-center justify-center gap-2 border border-destructive/30 bg-destructive/5 p-3 text-center">
      <AlertCircle className="size-5 text-destructive" aria-hidden />
      <p className="line-clamp-3 text-xs text-destructive">{error ?? "This render failed."}</p>
      {settling ? (
        <p className="text-xs text-muted-foreground" role="status">
          Finishing this request…
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          onClick={onRetry}
          disabled={busy || dismissing || settling || regenerateDisabled}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          {regenerateDisabled ? "Save outfit edits first" : "Retry"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          onClick={onDismiss}
          disabled={busy || dismissing || settling}
        >
          {dismissing ? <Spinner data-icon="inline-start" /> : <X data-icon="inline-start" />}
          {dismissing ? "Dismissing…" : "Dismiss"}
        </Button>
      </div>
    </div>
  );
}
