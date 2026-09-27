"use client";

import { AlertCircle, Check, RotateCw, X } from "lucide-react";
import { ItemImage } from "@/components/common/item-image";
import { uploadPercent } from "@/components/common/job-progress";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/lib/format";

export type PendingFile = {
  key: string;
  name: string;
  sizeBytes: number;
  previewUrl: string;
  error?: string;
  acceptedBatchId?: string;
};

type PendingTileProps = {
  file: PendingFile;
  progress: number;
  /** Retries this photo, reusing its stored blob if only registration failed. */
  onRetry?: () => void;
  onDismiss?: () => void;
  disabled?: boolean;
};

/** Local preview and actual bytes uploaded, before a scan has been registered. */
export function PendingTile({ file, progress, onRetry, onDismiss, disabled }: PendingTileProps) {
  const percent = uploadPercent(progress);
  const uploaded = !file.error && percent === 100;

  return (
    <article className="flex items-start gap-3 border-b py-3">
      <ItemImage
        src={file.previewUrl}
        alt={file.name}
        variant="photo"
        aspect="aspect-square"
        className="size-14 shrink-0 rounded-none"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="min-w-0 basis-full truncate text-xs font-medium sm:flex-1 sm:basis-auto">{file.name}</h3>
          <span className="text-[10px] text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
        </header>
        {file.error ? (
          <div className="space-y-2">
            <p className="flex items-start gap-1.5 text-xs leading-relaxed break-words text-destructive">
              <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden />
              {file.error}
            </p>
            {onRetry || onDismiss ? (
              <div className="flex flex-wrap gap-2">
                {onRetry ? (
                  <Button size="sm" variant="outline" onClick={onRetry} disabled={disabled}>
                    <RotateCw data-icon="inline-start" />
                    Retry upload
                  </Button>
                ) : null}
                {onDismiss ? (
                  <Button size="sm" variant="ghost" onClick={onDismiss} disabled={disabled}>
                    <X data-icon="inline-start" />
                    Dismiss
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {!uploaded ? (
              <Progress
                value={percent}
                aria-label={`Uploading ${file.name}`}
                className="[&_[data-slot=progress-indicator]]:motion-reduce:transition-none [&_[data-slot=progress-track]]:h-0.5 [&_[data-slot=progress-track]]:rounded-none"
              />
            ) : null}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground tabular-nums">
              {uploaded ? (
                <Check className="size-3 shrink-0 text-success" aria-hidden />
              ) : (
                <Spinner className="size-3 shrink-0 motion-reduce:animate-none" aria-hidden />
              )}
              <span>
                {uploaded
                  ? file.acceptedBatchId
                    ? "Uploaded · Scan queued"
                    : "Uploaded · Preparing your scan"
                  : `Uploading · ${percent}%`}
              </span>
            </div>
          </>
        )}
      </div>
    </article>
  );
}
