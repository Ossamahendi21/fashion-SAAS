"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { StudioEmpty } from "@/components/outfits/studio-empty";
import { PageHeader } from "@/components/common/page-header";
import { RenderGrid } from "@/components/renders/render-grid";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useOutfitSummaries } from "@/hooks/use-outfits";
import { RENDERS_PAGE_SIZE, useLookbookRenders } from "@/hooks/use-renders";
import { pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { Id } from "@convex/_generated/dataModel";

const ALL = "all";

/** Every render the user owns, newest first, filterable by outfit. */
export function Lookbook() {
  const outfits = useOutfitSummaries();
  const [outfitId, setOutfitId] = useState<Id<"outfits"> | null>(null);
  const { results, status, loadMore } = useLookbookRenders(outfitId);

  const loadingFirstPage = status === "LoadingFirstPage";
  const selectedName = outfits?.find((outfit) => outfit._id === outfitId)?.name;

  return (
    <div className="@container space-y-8">
      <PageHeader
        eyebrow="The fitting room archive"
        title="Lookbook"
        description="Your wardrobe, on you. Keep the looks worth coming back to."
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-foreground/15 py-3">
        <Select
          value={outfitId ?? ALL}
          onValueChange={(value) => {
            const match = outfits?.find((outfit) => outfit._id === value);
            setOutfitId(match ? match._id : null);
          }}
        >
          <SelectTrigger
            className="w-56 rounded-none border-0 bg-transparent shadow-none"
            aria-label="Filter by outfit"
          >
            <SelectValue>{(value: string) => (value === ALL ? "All outfits" : (selectedName ?? "Outfit"))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All outfits</SelectItem>
            {(outfits ?? []).map((outfit) => (
              <SelectItem key={outfit._id} value={outfit._id}>
                {outfit.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!loadingFirstPage ? (
          <span className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase tabular-nums">
            {pluralize(results.length, "image")}
            {status === "Exhausted" ? "" : "+"}
          </span>
        ) : null}
      </div>

      <RenderGrid
        renders={loadingFirstPage ? undefined : results}
        showOutfit
        skeletonCount={8}
        empty={
          outfitId ? (
            <StudioEmpty
              title="This look is waiting for its fitting."
              description="Open your outfit and choose Try on outfit. Your full-length previews will appear here."
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    className="h-11 rounded-none px-5"
                    nativeButton={false}
                    render={<Link href={routes.outfit(outfitId)} />}
                  >
                    Open outfit
                  </Button>
                  <Button variant="ghost" className="h-11 rounded-none" onClick={() => setOutfitId(null)}>
                    Show all images
                  </Button>
                </div>
              }
            />
          ) : (
            <StudioEmpty
              title="From an outfit to a whole look."
              description="Bring your pieces together in the outfit studio, then try them on. This is where your previews become a collection."
              action={
                <Button className="h-11 rounded-none px-5" nativeButton={false} render={<Link href={routes.outfits} />}>
                  Choose an outfit
                  <ArrowUpRight className="size-4" />
                </Button>
              }
            />
          )
        }
      />

      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            className="h-11 rounded-none px-8"
            onClick={() => loadMore(RENDERS_PAGE_SIZE)}
            disabled={status === "LoadingMore"}
          >
            {status === "LoadingMore" ? <Spinner data-icon="inline-start" /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
