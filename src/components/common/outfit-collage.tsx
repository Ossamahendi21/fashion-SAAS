import { ItemImage } from "@/components/common/item-image";
import { cn } from "@/lib/utils";
import type { ItemSummary, OutfitView } from "@convex/views";

type OutfitCollageProps = {
  /** Slot-shaped (outfit views) or a flat list (share payloads); both render in layer order. */
  items: OutfitView["items"] | readonly ItemSummary[];
  /** Tile size class for each garment, e.g. "size-16". */
  tile?: string;
  max?: number;
  className?: string;
};

/** Compact garment strip used on outfit cards, stylist proposals and the share page. */
export function OutfitCollage({ items, tile = "size-16", max = 5, className }: OutfitCollageProps) {
  const ordered = orderForDisplay(items);
  const shown = ordered.slice(0, max);
  const extra = ordered.length - shown.length;
  if (ordered.length === 0) {
    return (
      <div className={cn("rounded-lg border border-dashed p-3 text-xs text-muted-foreground", className)}>
        No items yet
      </div>
    );
  }
  return (
    <div
      className={cn("flex items-center gap-1.5", className)}
      role="img"
      aria-label={ordered.map((item) => item.name).join(", ")}
    >
      {shown.map((item) => (
        <ItemImage
          key={item._id}
          src={item.url}
          alt={item.name}
          aspect="aspect-square"
          className={cn("shrink-0 rounded-lg p-1.5", tile)}
        />
      ))}
      {extra > 0 ? <span className="text-xs text-muted-foreground tabular-nums">+{extra}</span> : null}
    </div>
  );
}

function isFlatList(items: OutfitCollageProps["items"]): items is readonly ItemSummary[] {
  return Array.isArray(items);
}

function orderForDisplay(items: OutfitCollageProps["items"]): ItemSummary[] {
  if (isFlatList(items)) return [...items];
  return [items.outerwear, items.dress, items.top, items.bottom, items.shoes, ...items.accessories].filter(
    (item): item is ItemSummary => Boolean(item),
  );
}
