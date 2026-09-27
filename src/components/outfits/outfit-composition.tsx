import { ItemImage } from "@/components/common/item-image";
import type { OutfitItems } from "@/hooks/use-outfits";
import { cn } from "@/lib/utils";
import type { Slot } from "@convex/shared/wardrobe";

export const BOARD_SLOT_CLASS: Record<Slot, string> = {
  outerwear: "col-start-1 col-span-2 row-start-2 row-span-4",
  top: "col-start-3 col-span-3 row-start-1 row-span-3",
  bottom: "col-start-3 col-span-3 row-start-4 row-span-5",
  dress: "col-start-3 col-span-3 row-start-1 row-span-8",
  shoes: "col-start-1 col-span-2 row-start-7 row-span-2",
  accessories: "col-start-6 col-span-1 row-start-2 row-span-6",
};

export function OutfitComposition({ items, className }: { items: OutfitItems; className?: string }) {
  const hasLayer = Boolean(items.outerwear);
  const singleSlots = ["outerwear", "top", "bottom", "dress", "shoes"] as const;
  const positions: Record<(typeof singleSlots)[number], string> = {
    outerwear: "left-[3%] top-[8%] h-[52%] w-[51%]",
    top: hasLayer ? "right-[3%] top-[4%] h-[42%] w-[49%]" : "left-[16%] top-[4%] h-[43%] w-[68%]",
    bottom: "right-[8%] bottom-[5%] h-[53%] w-[53%]",
    dress: "right-[8%] top-[5%] h-[84%] w-[62%]",
    shoes: "left-[5%] bottom-[7%] h-[25%] w-[41%]",
  };
  return (
    <div className={cn("relative", className)}>
      {singleSlots.map((slot) => {
        const item = items[slot];
        return item ? (
          <ItemImage
            key={slot}
            src={item.url}
            alt={item.name}
            aspect="aspect-auto"
            className={cn("absolute rounded-none bg-transparent p-0 dark:bg-transparent", positions[slot])}
          />
        ) : null;
      })}
      {items.accessories.length > 0 ? (
        <div className="absolute top-[48%] left-[5%] flex h-[23%] w-[26%] items-center justify-center gap-1">
          {items.accessories.slice(0, 3).map((item) => (
            <ItemImage
              key={item._id}
              src={item.url}
              alt={item.name}
              aspect="aspect-square"
              className="min-w-0 flex-1 rounded-none bg-transparent p-0 dark:bg-transparent"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
