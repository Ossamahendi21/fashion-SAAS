import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { ItemImage } from "@/components/common/item-image";
import { OutfitComposition } from "@/components/outfits/outfit-composition";
import type { Outfit } from "@/hooks/use-outfits";
import { pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

export function OutfitCard({ outfit, className }: { outfit: Outfit; className?: string }) {
  return (
    <Link
      href={routes.outfit(outfit._id)}
      className={cn("group block text-left focus-visible:outline-2 focus-visible:outline-offset-4", className)}
    >
      <div className="relative overflow-hidden bg-muted/35">
        {outfit.coverUrl ? (
          <ItemImage src={outfit.coverUrl} alt={outfit.name} variant="render" className="rounded-none" />
        ) : (
          <OutfitComposition items={outfit.items} className="aspect-[2/3]" />
        )}
        <span className="absolute top-3 left-3 bg-background/85 px-2 py-1 font-mono text-[9px] tracking-[0.12em] uppercase">
          {outfit.source === "agent" ? "Styled by Fitcheck" : "Your composition"}
        </span>
      </div>
      <div className="space-y-2 border-b border-foreground/15 py-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="line-clamp-2 text-base leading-snug font-medium tracking-tight sm:text-lg">{outfit.name}</h3>
          <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {outfit.occasion || (outfit.wornOn.length > 0 ? pluralize(outfit.wornOn.length, "wear") : "Ready to wear")}
          </span>
          {outfit.renderCount > 0 ? <span>{pluralize(outfit.renderCount, "try-on")}</span> : null}
        </div>
      </div>
    </Link>
  );
}
