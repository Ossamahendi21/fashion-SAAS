"use client";

import { Download, Link2, X } from "lucide-react";
import { useRef } from "react";
import { ItemImage } from "@/components/common/item-image";
import { OutfitCollage } from "@/components/common/outfit-collage";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useRender, useRenderActions, useRenderDownload, type Render } from "@/hooks/use-renders";
import { formatCredits, formatDateTime } from "@/lib/format";

type RenderLightboxProps = { render: Render; open: boolean; onOpenChange: (open: boolean) => void };

export function RenderLightbox({ render, open, onOpenChange }: RenderLightboxProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const detail = useRender(open ? render._id : null);
  const actions = useRenderActions();
  const { download, pendingRenderId } = useRenderDownload();
  const outfit = detail?.outfit;
  const downloading = pendingRenderId === render._id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92dvh] gap-0 overflow-hidden rounded-none p-0 sm:max-w-4xl"
        showCloseButton={false}
        initialFocus={closeButton}
      >
        <DialogClose
          ref={closeButton}
          render={
            <Button
              variant="outline"
              size="icon"
              className="absolute top-2 right-2 z-10 size-11 rounded-none bg-background/95 shadow-sm"
            />
          }
          aria-label="Close image"
        >
          <X aria-hidden />
        </DialogClose>
        <div className="max-h-[92dvh] min-h-0 overflow-y-auto overscroll-contain">
          <div className="grid md:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex items-center justify-center bg-muted/35 p-5 sm:p-8">
              <ItemImage
                src={render.url}
                alt={`${render.outfitName} rendered on you`}
                variant="render"
                priority
                className="mx-auto w-full max-w-[min(500px,48vh)] rounded-none"
              />
            </div>
            <div className="flex flex-col p-6 pt-10">
              <DialogHeader className="space-y-4 text-left">
                <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                  A look from your wardrobe
                </p>
                <DialogTitle className="pr-3 text-3xl leading-tight font-medium tracking-[-0.05em]">
                  {render.outfitName}
                </DialogTitle>
                <DialogDescription className="text-xs leading-relaxed">
                  {formatDateTime(render.completedAt ?? render.createdAt)}
                </DialogDescription>
              </DialogHeader>
              <dl className="my-6 space-y-3 border-y border-foreground/15 py-4 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Quality</dt>
                  <dd>{render.quality === "hq" ? "High quality" : "Standard"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Credits used</dt>
                  <dd>{formatCredits(render.creditsCharged)}</dd>
                </div>
                {render.shareToken ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Visibility</dt>
                    <dd>Shared by link</dd>
                  </div>
                ) : null}
              </dl>
              <div className="space-y-3">
                <p className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">The pieces</p>
                {outfit ? (
                  <OutfitCollage items={outfit.items} tile="size-16" max={6} className="flex-wrap" />
                ) : detail === undefined ? (
                  <div className="flex gap-2">
                    {Array.from({ length: 3 }, (_, index) => (
                      <Skeleton key={index} className="size-16 rounded-none" />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Outfit details are no longer available.</p>
                )}
              </div>
              <div className="mt-auto space-y-2 pt-8">
                {render.url ? (
                  <Button
                    className="h-11 w-full rounded-none"
                    disabled={downloading}
                    onClick={() => void download(render)}
                  >
                    {downloading ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}
                    {downloading ? "Saving…" : "Download image"}
                  </Button>
                ) : null}
                {render.shareToken ? (
                  <Button
                    variant="outline"
                    className="h-11 w-full rounded-none"
                    onClick={() => void actions.copyShareLink(render.shareToken ?? "")}
                  >
                    <Link2 data-icon="inline-start" />
                    Copy share link
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
