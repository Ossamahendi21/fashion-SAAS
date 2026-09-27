"use client";

import { ArrowLeft, ChevronDown, Copy, ImageIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ItemImage } from "@/components/common/item-image";
import { OutfitCollage } from "@/components/common/outfit-collage";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { useDismissDuplicate, useItem } from "@/hooks/use-items";
import { reportError } from "@/lib/errors";
import { formatDate, formatRelative } from "@/lib/format";
import { routes } from "@/lib/routes";
import { CATEGORY_LABELS } from "@convex/shared/wardrobe";
import { ItemActions } from "./item-actions";
import { ItemDetailSkeleton } from "./item-detail-skeleton";
import { ItemForm } from "./item-form";

/** `itemId` comes straight from the route; the query normalises it and answers `null` when it is not a real item. */
export function ItemDetail({ itemId }: { itemId: string }) {
  const data = useItem(itemId);
  const dismissDuplicate = useDismissDuplicate();
  const [dismissing, setDismissing] = useState(false);

  if (data === undefined) return <ItemDetailSkeleton />;
  if (data === null) notFound();

  const { item, outfits, sourceUrl, duplicateOf } = data;

  async function handleKeepBoth() {
    setDismissing(true);
    try {
      await dismissDuplicate({ itemId: item._id });
      toast.success("Kept as a separate item.");
    } catch (error) {
      reportError(error);
    } finally {
      setDismissing(false);
    }
  }

  return (
    <div className="space-y-6">
      <BackLink />

      <PageHeader
        eyebrow={CATEGORY_LABELS[item.category]}
        title={item.name}
        description={[item.subcategory, item.colours.primary, item.material].filter(Boolean).join(" · ")}
        actions={item.status === "hidden" ? <Badge variant="outline">Hidden</Badge> : null}
      />

      {duplicateOf ? (
        <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4 sm:flex-row sm:items-center">
          <ItemImage
            src={duplicateOf.url}
            alt={duplicateOf.name}
            aspect="aspect-square"
            className="size-14 shrink-0 rounded-lg p-1.5"
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Copy className="size-4 shrink-0" aria-hidden />
              Possible duplicate
            </p>
            <p className="text-sm text-muted-foreground">
              This looks a lot like{" "}
              <Link href={routes.item(duplicateOf._id)} className="font-medium underline underline-offset-4">
                {duplicateOf.name}
              </Link>
              . Nothing was merged — you decide.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleKeepBoth} disabled={dismissing} className="shrink-0">
            {dismissing ? <Spinner data-icon="inline-start" /> : null}
            Keep both
          </Button>
        </div>
      ) : null}

      <div className="grid gap-8 border-t border-border pt-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-14">
        <div className="space-y-6 lg:sticky lg:top-24">
          <ItemImage
            src={item.url}
            alt={item.name}
            aspect="aspect-square"
            className="rounded-lg p-10 sm:p-14"
            priority
          />
          <ItemActions item={item} />

          {item.status === "extracting" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" aria-hidden />
              Still cutting this one out. The image appears here when it lands.
            </p>
          ) : item.status === "needsCredits" ? (
            <p className="text-sm text-muted-foreground">
              Extraction paused — you ran out of credits.{" "}
              <Link href={`${routes.billing}#plans`} className="font-medium underline underline-offset-4">
                View your plan
              </Link>{" "}
              and resume from Add clothes when credits are available.
            </p>
          ) : item.status === "failed" ? (
            <p className="text-sm text-destructive">Extraction failed. Try &ldquo;Re-extract&rdquo; to run it again.</p>
          ) : null}

          {item.colours.hex.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Colours</p>
              <ul className="flex flex-wrap gap-2">
                {item.colours.hex.map((hex) => (
                  <li key={hex} className="flex items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-1">
                    <span
                      className="size-4 rounded-full ring-1 ring-foreground/15"
                      style={{ backgroundColor: hex }}
                      aria-hidden
                    />
                    <span className="font-mono text-[11px] text-muted-foreground uppercase">{hex}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <section aria-label="Wear history" className="grid grid-cols-3 gap-3 border-y border-border py-5">
            <Stat label="Worn" value={item.wearCount === 0 ? "Never" : `${item.wearCount}×`} />
            <Stat label="Last worn" value={item.lastWornAt ? formatRelative(item.lastWornAt) : "—"} />
            <Stat label="Added" value={formatDate(item.createdAt)} />
          </section>

          <section className="space-y-4">
            <h2 className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">Worn together</h2>
            <div>
              {outfits.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not in an outfit yet. Build one and it shows up here.</p>
              ) : (
                <ul className="space-y-3">
                  {outfits.map((outfit) => (
                    <li key={outfit._id}>
                      <Link
                        href={routes.outfit(outfit._id)}
                        className="flex items-center gap-3 rounded-lg p-1 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <OutfitCollage items={outfit.items} tile="size-10" max={4} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{outfit.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <Collapsible>
            <CollapsibleTrigger
              render={
                <Button variant="ghost" size="sm" className="w-full justify-between">
                  <span className="flex items-center gap-1.5">
                    <ImageIcon className="size-3.5" aria-hidden />
                    Source photo
                  </span>
                  <ChevronDown
                    className="size-3.5 transition-transform group-data-[panel-open]/button:rotate-180"
                    aria-hidden
                  />
                </Button>
              }
            />
            <CollapsibleContent className="pt-3">
              {sourceUrl ? (
                <ItemImage
                  src={sourceUrl}
                  alt={`Photo ${item.name} was cut out of`}
                  variant="photo"
                  aspect="aspect-[4/3]"
                />
              ) : (
                <p className="text-sm text-muted-foreground">The original photo has been deleted.</p>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <div className="space-y-6">
          <div className="flex items-baseline justify-between gap-3 border-b border-border pb-4">
            <h2 className="text-xl font-medium tracking-tight">The details</h2>
            <span className="text-xs text-muted-foreground">Make it your own</span>
          </div>
          <ItemForm key={item._id} item={item} />
          {item.description ? <p className="text-sm text-muted-foreground">{item.description}</p> : null}
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 w-fit"
      nativeButton={false}
      render={<Link href={routes.wardrobe} />}
    >
      <ArrowLeft data-icon="inline-start" />
      Wardrobe
    </Button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}
