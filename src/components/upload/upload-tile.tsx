"use client";

import { Coins, RotateCw } from "lucide-react";
import Link from "next/link";
import { CreditQuote } from "@/components/common/credit-quote";
import { ItemImage } from "@/components/common/item-image";
import { JobStepper } from "@/components/common/job-stepper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useCreditQuote } from "@/hooks/use-credits";
import { useUploadItems, type Item } from "@/hooks/use-items";
import { formatBytes, pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { ImportReview } from "./import-review";
import { UploadStatusBadge, type UploadRow } from "./upload-status";

type UploadTileProps = {
  row: UploadRow;
  onResume: (uploadId: Id<"uploads">) => void;
  resuming: boolean;
};

/** One photo in the batch: its job, what was found in it and the cutouts as they land. */
export function UploadTile({ row, onResume, resuming }: UploadTileProps) {
  const { upload, job } = row;
  const detected = upload.detectedCount;
  const selectedCount = upload.selectedIndices?.length ?? detected;
  const quote = useCreditQuote(selectedCount && selectedCount > 0 ? { kind: "extract", items: selectedCount } : null);
  const items = useUploadItems(upload._id) ?? [];
  const blocked = items.filter((item) => item.status === "needsCredits");
  const stillCosts = upload.status !== "done" && upload.status !== "failed" && upload.status !== "awaiting_selection";

  return (
    <article className="space-y-4 border-b pb-6">
      <header>
        <div className="flex items-center gap-3">
          <ItemImage
            src={upload.url}
            alt={upload.fileName}
            variant="photo"
            aspect="aspect-square"
            className="size-20 shrink-0 rounded-none"
          />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-medium">{upload.fileName}</h3>
            <p className="text-xs text-muted-foreground">{formatBytes(upload.sizeBytes)}</p>
          </div>
          <UploadStatusBadge status={upload.status} />
        </div>
      </header>

      {upload.status === "awaiting_selection" ? (
        <ImportReview upload={upload} />
      ) : (
        <div className="space-y-4">
          {job ? <JobStepper job={job} /> : <p className="text-sm text-muted-foreground">Waiting for a slot…</p>}

          {detected !== undefined ? (
            <p className="text-sm">
              {detected === 0 ? (
                <span className="text-muted-foreground">No clothes found in this photo.</span>
              ) : (
                <>
                  Found <span className="font-medium tabular-nums">{pluralize(detected, "item")}</span>
                  {upload.selectedIndices ? ` · ${upload.selectedIndices.length} selected for your wardrobe` : null}
                </>
              )}
            </p>
          ) : null}

          {detected !== undefined && detected > 0 && stillCosts ? (
            <CreditQuote quote={quote} label={pluralize(selectedCount ?? detected, "selected cutout")} />
          ) : null}

          {items.length > 0 ? (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {items.map((item) => (
                <li key={item._id}>
                  <ItemCutout item={item} />
                </li>
              ))}
            </ul>
          ) : null}

          {blocked.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-credit/40 bg-credit/5 p-3">
              <p className="flex items-center gap-2 text-sm">
                <Coins className="size-4 shrink-0 text-credit" aria-hidden />
                {pluralize(blocked.length, "item")} paused — you ran out of credits mid-extraction.
              </p>
              <Button size="sm" className="w-fit" onClick={() => onResume(upload._id)} disabled={resuming}>
                {resuming ? <Spinner data-icon="inline-start" /> : <RotateCw data-icon="inline-start" />}
                Resume extraction
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </article>
  );
}

function ItemCutout({ item }: { item: Item }) {
  const paused = item.status === "needsCredits";
  const failed = item.status === "failed";
  const extracting = item.status === "extracting";

  const tile = (
    <>
      <ItemImage
        src={item.url}
        alt={item.name}
        aspect="aspect-square"
        className={cn(
          "rounded-none p-2 ring-1 transition-colors",
          paused ? "ring-credit/50" : failed ? "ring-destructive/50" : "ring-transparent group-hover/cutout:ring-ring",
        )}
      />
      <span className="mt-1 block truncate text-[11px] text-muted-foreground">{item.name}</span>
    </>
  );

  if (paused || failed || extracting) {
    return (
      <div className="group/cutout block" title={item.name}>
        {tile}
        <Badge variant={failed ? "destructive" : "outline"} className="mt-1 h-4 px-1.5 text-[10px]">
          {failed ? "Failed" : paused ? "Needs credits" : "Extracting"}
        </Badge>
      </div>
    );
  }

  return (
    <Link
      href={routes.item(item._id)}
      className="group/cutout block rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {tile}
    </Link>
  );
}
