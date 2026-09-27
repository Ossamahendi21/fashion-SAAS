"use client";

import { AlertCircle, Check, CircleDashed, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type UploadRow = FunctionReturnType<typeof api.uploads.listBatch>[number];
export type UploadDoc = UploadRow["upload"];
export type UploadStatus = UploadDoc["status"];

const LABELS: Record<UploadStatus, string> = {
  queued: "Queued",
  detecting: "Scanning",
  awaiting_selection: "Choose pieces",
  extracting: "Cutting out",
  done: "Ready",
  partial: "Needs attention",
  failed: "Failed",
};

/** One compact badge for a photo's ingest state, used on the tiles and in recent uploads. */
export function UploadStatusBadge({ status }: { status: UploadStatus }) {
  const needsAttention = status === "partial" || status === "awaiting_selection";
  return (
    <Badge
      variant={status === "failed" ? "destructive" : needsAttention ? "outline" : "secondary"}
      className="shrink-0 gap-1.5 rounded-none px-2 py-1 text-[10px] font-medium"
    >
      {status === "failed" ? (
        <AlertCircle aria-hidden />
      ) : status === "done" ? (
        <Check className="text-success" aria-hidden />
      ) : needsAttention ? (
        <CircleDashed className="text-warning" aria-hidden />
      ) : status === "queued" ? (
        <Clock3 className="text-muted-foreground" aria-hidden />
      ) : (
        <Spinner className="size-3 motion-reduce:animate-none" aria-hidden />
      )}
      {LABELS[status]}
    </Badge>
  );
}
