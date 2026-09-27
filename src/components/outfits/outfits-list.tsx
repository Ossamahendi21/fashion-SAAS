"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { ArrowUpRight, Plus, Shirt } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { StudioEmpty } from "@/components/outfits/studio-empty";
import { LoadingGrid } from "@/components/common/loading-grid";
import { PageHeader } from "@/components/common/page-header";
import { OutfitCard } from "@/components/outfits/outfit-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { OUTFITS_PAGE_SIZE, useSavedOutfits, type OutfitSource } from "@/hooks/use-outfits";
import { pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import { api } from "@convex/_generated/api";

type Filter = "all" | OutfitSource;

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "manual", label: "Mine" },
  { value: "agent", label: "Stylist" },
];

/** The /outfits grid with its source filter. Header and page chrome live in the route file. */
export function OutfitsList() {
  const { isAuthenticated } = useConvexAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const { results, status, loadMore } = useSavedOutfits(filter === "all" ? undefined : filter);
  // One boolean instead of the whole wardrobe, only to pick the empty-state icon and copy.
  const hasItems = useQuery(api.items.hasAny, isAuthenticated ? {} : "skip");
  const reduceMotion = useReducedMotion();
  const loadingFirstPage = status === "LoadingFirstPage" || hasItems === undefined;
  const wardrobeEmpty = hasItems === false;

  // The source filter is applied to each page, so a page can arrive with nothing in it. Keep pulling
  // until this filter has something to show, or the list runs out — otherwise "Mine" can look empty
  // while the next page is full of manual outfits.
  useEffect(() => {
    if (status === "CanLoadMore" && results.length === 0) loadMore(OUTFITS_PAGE_SIZE);
  }, [status, results.length, loadMore]);

  return (
    <div className="@container space-y-8">
      <PageHeader
        eyebrow="The collection"
        title="Outfits"
        description="Your clothes, brought together. Save a look and see it on you."
        actions={
          hasItems === undefined ? null : (
            <Button
              className="h-11 rounded-none px-5"
              nativeButton={false}
              render={<Link href={wardrobeEmpty ? routes.add : routes.newOutfit} />}
            >
              {wardrobeEmpty ? <Shirt data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
              {wardrobeEmpty ? "Add clothes" : "New outfit"}
            </Button>
          )
        }
      />

      {!wardrobeEmpty || results.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-foreground/20">
          <ToggleGroup
            value={[filter]}
            onValueChange={(value) => {
              const next = value[0];
              if (next) setFilter(next as Filter);
            }}
            spacing={6}
            aria-label="Filter outfits by source"
          >
            {FILTERS.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className="h-12 rounded-none border-b-2 border-transparent px-1 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase hover:bg-transparent aria-pressed:border-foreground aria-pressed:bg-transparent aria-pressed:text-foreground"
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {!loadingFirstPage ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {pluralize(results.length, "outfit")}
              {status === "Exhausted" ? "" : "+"}
            </span>
          ) : null}
        </div>
      ) : null}

      {loadingFirstPage ? (
        <LoadingGrid
          count={6}
          aspect="aspect-[2/3]"
          className="grid-cols-2 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-4"
        />
      ) : results.length === 0 ? (
        <OutfitsEmpty filter={filter} wardrobeEmpty={wardrobeEmpty} onClearFilter={() => setFilter("all")} />
      ) : (
        <motion.div
          layout={!reduceMotion}
          className="grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-6 @2xl:grid-cols-3 @5xl:grid-cols-4"
        >
          <AnimatePresence initial={false}>
            {results.map((outfit) => (
              <motion.div
                key={outfit._id}
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.2 }}
              >
                <OutfitCard outfit={outfit} />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            className="h-11 rounded-none px-8"
            onClick={() => loadMore(OUTFITS_PAGE_SIZE)}
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

function OutfitsEmpty({
  filter,
  wardrobeEmpty,
  onClearFilter,
}: {
  filter: Filter;
  wardrobeEmpty: boolean;
  onClearFilter: () => void;
}) {
  const title = wardrobeEmpty
    ? "Your first look starts in the wardrobe."
    : filter === "agent"
      ? "A little styling inspiration?"
      : "Make something you want to wear.";
  const description = wardrobeEmpty
    ? "Add a few pieces you love. Then put them together in the outfit studio."
    : filter === "agent"
      ? "Tell Eve what you are dressing for. The suggestions you save will join your collection here."
      : "Choose a top, find its perfect pair, and add the finishing touches. Your saved outfits will live here.";
  const href = wardrobeEmpty ? routes.add : filter === "agent" ? routes.stylist : routes.newOutfit;
  const label = wardrobeEmpty ? "Add clothes" : filter === "agent" ? "Ask Eve" : "Create an outfit";
  return (
    <StudioEmpty
      title={title}
      description={description}
      action={
        <div className="flex flex-wrap gap-3">
          <Button className="h-11 rounded-none px-5" nativeButton={false} render={<Link href={href} />}>
            {label}
            <ArrowUpRight className="size-4" />
          </Button>
          {filter !== "all" ? (
            <Button variant="ghost" className="h-11 rounded-none" onClick={onClearFilter}>
              Show all outfits
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
