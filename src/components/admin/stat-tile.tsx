import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type StatTileProps = {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "positive" | "negative";
  className?: string;
};

const TONES: Record<NonNullable<StatTileProps["tone"]>, string> = {
  default: "text-foreground",
  positive: "text-success",
  negative: "text-destructive",
};

/** One number with its label. Not a Card: these are figures, not objects. */
export function StatTile({ label, value, hint, icon: Icon, tone = "default", className }: StatTileProps) {
  return (
    <div className={cn("rounded-xl border bg-card/50 px-4 py-3", className)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
        {label}
      </div>
      <div className={cn("mt-1 text-xl font-semibold tracking-tight tabular-nums", TONES[tone])}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{hint}</div> : null}
    </div>
  );
}

export function StatTileSkeleton() {
  return (
    <div className="space-y-2 rounded-xl border bg-card/50 px-4 py-3">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-6 w-16" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}
