"use client";

import Link from "next/link";
import { ItemImage } from "@/components/common/item-image";
import { Skeleton } from "@/components/ui/skeleton";
import { useWardrobe } from "@/hooks/use-items";
import { routes } from "@/lib/routes";

export function StylistWardrobeStrip() {
  const { items } = useWardrobe();
  const pieces = items?.slice(0, 3);

  if (pieces?.length === 0) {
    return (
      <p className="border-y py-5 text-sm text-muted-foreground">
        Start with a few pieces you love.{" "}
        <Link href={routes.add} className="text-foreground underline underline-offset-4">
          Add clothes to your wardrobe
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3 border-y py-4">
        {pieces === undefined
          ? Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="aspect-square rounded-none" />)
          : pieces.map((item) => (
              <Link
                key={item._id}
                href={routes.item(item._id)}
                className="group min-w-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                aria-label={`View ${item.name}`}
              >
                <ItemImage
                  src={item.url}
                  alt={item.name}
                  aspect="aspect-square"
                  className="rounded-none bg-transparent p-1 dark:bg-transparent"
                  imgClassName="transition-transform duration-200 group-hover:scale-105 motion-reduce:transform-none"
                />
              </Link>
            ))}
      </div>
      <p className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
        Your pieces. New possibilities.
      </p>
    </div>
  );
}
