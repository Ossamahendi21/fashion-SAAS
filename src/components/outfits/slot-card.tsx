"use client";

import { Plus, X } from "lucide-react";
import { ItemImage } from "@/components/common/item-image";
import type { Item as WardrobeItem } from "@/hooks/use-items";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { SLOT_LABELS, type Slot } from "@convex/shared/wardrobe";

type SlotCardProps = {
  slot: Slot;
  items: WardrobeItem[];
  multiple?: boolean;
  onOpen: () => void;
  onRemove: (itemId: Id<"items">) => void;
  className?: string;
  compact?: boolean;
};

export function SlotCard({
  slot,
  items,
  multiple = false,
  onOpen,
  onRemove,
  className,
  compact = false,
}: SlotCardProps) {
  const label = SLOT_LABELS[slot];
  return (
    <div
      className={cn(
        "group/piece relative min-h-0 min-w-0",
        compact &&
          "border border-foreground/10 transition-colors focus-within:border-foreground focus-within:bg-muted/50 hover:border-foreground/45 hover:bg-muted/50",
        className,
      )}
    >
      {items.length === 0 ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Choose ${label.toLowerCase()}`}
          className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          <Plus className="size-4" strokeWidth={1} />
          <span className="text-[9px] tracking-[0.12em] uppercase sm:text-[10px]">{label}</span>
        </button>
      ) : multiple ? (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          {items.map((item) => (
            <div key={item._id} className="relative min-h-0 w-full max-w-24 flex-1">
              <button
                type="button"
                onClick={onOpen}
                aria-label={`Change ${item.name}`}
                className="block size-full focus-visible:outline-2"
              >
                <ItemImage
                  src={item.url}
                  alt={item.name}
                  aspect="aspect-auto"
                  className="size-full rounded-none bg-transparent p-0 dark:bg-transparent"
                />
              </button>
              <RemoveButton label={`Remove ${item.name}`} onClick={() => onRemove(item._id)} />
            </div>
          ))}
          <button
            type="button"
            onClick={onOpen}
            className="flex shrink-0 items-center gap-1 py-2 text-[10px] tracking-wide text-muted-foreground uppercase hover:text-foreground"
          >
            <Plus className="size-3" /> Add
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Change ${label.toLowerCase()}: ${items[0].name}`}
            className="block size-full pb-5 focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            <ItemImage
              src={items[0].url}
              alt={items[0].name}
              aspect="aspect-auto"
              className="size-full rounded-none bg-transparent p-1 dark:bg-transparent"
            />
          </button>
          <RemoveButton label={`Remove ${items[0].name}`} onClick={() => onRemove(items[0]._id)} />
          <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate text-center text-[9px] tracking-[0.1em] text-muted-foreground uppercase sm:text-[10px]">
            {label}
          </span>
        </>
      )}
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="absolute top-1 right-1 z-10 flex size-8 items-center justify-center rounded-full bg-foreground text-background ring-1 ring-background/30 transition-opacity hover:bg-foreground/80 focus-visible:outline-2 focus-visible:outline-offset-2 sm:opacity-0 sm:group-focus-within/piece:opacity-100 sm:group-hover/piece:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100"
    >
      <X className="size-4" />
    </button>
  );
}
