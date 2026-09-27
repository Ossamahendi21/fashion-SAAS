"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { ArrowUpRight, X } from "lucide-react";
import { ItemImage } from "@/components/common/item-image";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { api } from "@convex/_generated/api";
import { pluralize } from "@/lib/format";
import { ImportReview } from "./import-review";

export function ImportQueue() {
  const { isAuthenticated } = useConvexAuth();
  const pending = useQuery(api.uploads.needsReview, isAuthenticated ? {} : "skip");
  if (!pending?.length) return null;
  return (
    <section className="space-y-3 border-y border-foreground/15 py-4" aria-label="Imports awaiting your selection">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Choose what to keep</h2>
        <span className="text-xs text-muted-foreground">
          {pluralize(pending.length, "photo")} ready for review · No credits used yet
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {pending.map(({ upload }) => (
          <Dialog key={upload._id}>
            <DialogTrigger
              render={
                <Button
                  variant="outline"
                  className="h-auto max-w-80 min-w-60 justify-start gap-3 rounded-lg bg-card p-2.5 text-left shadow-none"
                />
              }
            >
              <ItemImage
                src={upload.url}
                alt=""
                variant="photo"
                aspect="aspect-square"
                className="size-14 shrink-0 rounded-sm"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{upload.fileName}</span>
                <span className="mt-1 block text-[11px] font-normal text-muted-foreground">
                  Review {pluralize(upload.candidates?.length ?? 0, "piece")}
                </span>
              </span>
              <ArrowUpRight className="size-4 shrink-0" />
            </DialogTrigger>
            <DialogContent
              showCloseButton={false}
              className="flex h-[90dvh] max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:h-auto sm:max-w-3xl"
            >
              <DialogHeader className="shrink-0 flex-row items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
                <div className="min-w-0 space-y-1">
                  <DialogTitle>Review this photo</DialogTitle>
                  <DialogDescription className="truncate">{upload.fileName}</DialogDescription>
                </div>
                <DialogClose
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 rounded-full"
                      aria-label="Close photo review"
                    />
                  }
                >
                  <X aria-hidden />
                </DialogClose>
              </DialogHeader>
              <ImportReview upload={upload} inDialog />
            </DialogContent>
          </Dialog>
        ))}
      </div>
    </section>
  );
}
