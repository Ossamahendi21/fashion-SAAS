"use client";

import { Check, Search, Shirt } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { ItemImage } from "@/components/common/item-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { Item as WardrobeItem } from "@/hooks/use-items";
import { useIsMobile } from "@/hooks/use-mobile";
import { pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { SLOT_CATEGORIES, SLOT_LABELS, type Slot } from "@convex/shared/wardrobe";

type ItemPickerSheetProps = {
  /** The slot being filled, or null when the sheet is closed. */
  slot: Slot | null;
  items: WardrobeItem[] | undefined;
  selected: readonly Id<"items">[];
  multiple?: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (itemId: Id<"items">) => void;
  onClear: () => void;
};

/** Wardrobe picker for one slot: bottom sheet on phones, side sheet on desktop. */
export function ItemPickerSheet({
  slot,
  items,
  selected,
  multiple = false,
  onOpenChange,
  onToggle,
  onClear,
}: ItemPickerSheetProps) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");

  const candidates = useMemo(() => {
    if (!slot || !items) return undefined;
    const categories = SLOT_CATEGORIES[slot];
    return items.filter((item) => categories.includes(item.category));
  }, [items, slot]);

  const results = useMemo(() => {
    if (!candidates) return undefined;
    const needle = query.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter((item) => haystack(item).includes(needle));
  }, [candidates, query]);

  const label = slot ? SLOT_LABELS[slot] : "";

  return (
    <Sheet
      open={slot !== null}
      onOpenChange={(open) => {
        if (!open) setQuery("");
        onOpenChange(open);
      }}
    >
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className="flex flex-col gap-0 p-0 data-[side=bottom]:h-[85dvh] data-[side=bottom]:rounded-t-none data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="border-b border-foreground/15 p-6">
          <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">From your wardrobe</p>
          <SheetTitle className="text-3xl font-medium tracking-[-0.05em]">Choose {label.toLowerCase()}</SheetTitle>
          <SheetDescription>
            {candidates === undefined ? "Loading your wardrobe…" : pluralize(candidates.length, "piece")} to pick from.
          </SheetDescription>
          <div className="relative mt-3">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              aria-label={`Search ${label.toLowerCase()}`}
              className="h-11 rounded-none border-0 border-b bg-transparent pl-8 shadow-none"
            />
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {results === undefined ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
              {Array.from({ length: 9 }, (_, index) => (
                <Skeleton key={index} className="aspect-[3/4] rounded-none" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <EmptyState
              icon={Shirt}
              className="min-h-0 rounded-none border-0 py-8"
              title={query ? "Nothing matches that" : `No ${label.toLowerCase()} in your wardrobe`}
              description={
                query ? "Try a different word, or clear the search." : "Photograph a few pieces and they show up here."
              }
              action={
                query ? (
                  <Button variant="outline" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                ) : (
                  <Button nativeButton={false} render={<Link href={routes.add} />}>
                    Add clothes
                  </Button>
                )
              }
            />
          ) : (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
              {results.map((item) => {
                const isSelected = selected.includes(item._id);
                return (
                  <li key={item._id}>
                    <button
                      type="button"
                      onClick={() => onToggle(item._id)}
                      aria-pressed={isSelected}
                      className={cn(
                        "group relative block w-full p-0.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        isSelected ? "ring-2 ring-primary" : "ring-1 ring-transparent hover:ring-border",
                      )}
                    >
                      <ItemImage
                        src={item.url}
                        alt={item.name}
                        aspect="aspect-[3/4]"
                        className="rounded-none bg-muted/30 p-3"
                      />
                      {isSelected ? (
                        <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="size-3" aria-hidden />
                        </span>
                      ) : null}
                      <span className="mt-3 line-clamp-1 block text-xs">{item.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <SheetFooter className="flex-row items-center justify-between border-t border-foreground/15 p-6">
          <Button variant="ghost" className="rounded-none" onClick={onClear} disabled={selected.length === 0}>
            Clear {multiple ? "all" : label.toLowerCase()}
          </Button>
          <Button
            className="h-11 rounded-none px-8"
            variant={multiple ? "default" : "outline"}
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function haystack(item: WardrobeItem): string {
  return [
    item.name,
    item.category,
    item.subcategory,
    item.colours.primary,
    ...item.colours.secondary,
    item.pattern,
    item.material,
    item.brand ?? "",
    item.formality,
  ]
    .join(" ")
    .toLowerCase();
}
