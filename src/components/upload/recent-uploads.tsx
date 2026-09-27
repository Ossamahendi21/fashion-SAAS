"use client";

import { useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";
import { LoadingRows } from "@/components/common/loading-grid";
import { ItemImage } from "@/components/common/item-image";
import { Button } from "@/components/ui/button";
import { api } from "@convex/_generated/api";
import { formatRelative, pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import { UploadStatusBadge } from "./upload-status";

type RecentUploadsProps = {
  activeBatchId: string | null;
  onOpenBatch: (batchId: string) => void;
};

/** Keep recent scans in the workspace without pushing its other tools below the fold. */
export function RecentUploads({ activeBatchId, onOpenBatch }: RecentUploadsProps) {
  const { isAuthenticated } = useConvexAuth();
  const rows = useQuery(api.uploads.listRecent, isAuthenticated ? { limit: 12 } : "skip");

  if (rows?.length === 0) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3 border-b pb-3">
        <h2 className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Recent scans</h2>
        {!activeBatchId && rows ? (
          <Button
            variant="ghost"
            className="rounded-full px-4"
            nativeButton={false}
            render={<Link href={routes.wardrobe} />}
          >
            View wardrobe
          </Button>
        ) : null}
      </div>
      {rows === undefined ? (
        <LoadingRows count={3} />
      ) : (
        <ul className="max-h-64 divide-y overflow-y-auto overscroll-contain pr-1">
          {rows.map(({ upload }) => (
            <li key={upload._id} className="flex items-center gap-3 py-2.5 sm:gap-4">
              <ItemImage
                src={upload.url}
                alt={upload.fileName}
                variant="photo"
                aspect="aspect-square"
                className="size-14 shrink-0 rounded-none"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{upload.fileName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatRelative(upload.createdAt)}
                  {upload.selectedIndices
                    ? ` · ${upload.selectedIndices.length} selected`
                    : upload.detectedCount !== undefined
                      ? ` · ${pluralize(upload.detectedCount, "item")} found`
                      : ""}
                </p>
                <div className="mt-1.5">
                  <UploadStatusBadge status={upload.status} />
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-11 rounded-full px-3 sm:h-8"
                aria-label={`${upload.batchId === activeBatchId ? "Showing" : "Open"} ${upload.fileName}`}
                onClick={() => onOpenBatch(upload.batchId)}
                disabled={upload.batchId === activeBatchId}
              >
                {upload.batchId === activeBatchId ? "Showing" : "Open"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
