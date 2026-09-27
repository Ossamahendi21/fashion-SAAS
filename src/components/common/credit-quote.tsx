import { Coins } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import type { CreditQuote as Quote } from "@/hooks/use-credits";
import { formatCredits } from "@/lib/format";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type CreditQuoteProps = {
  quote: Quote | undefined;
  /** What the credits buy, e.g. "4 images". */
  label?: string;
  className?: string;
};

/** The number the user sees before anything is charged. Same component in the builder, upload and stylist. */
export function CreditQuote({ quote, label, className }: CreditQuoteProps) {
  if (!quote) return <Skeleton className={cn("h-12 w-full rounded-lg", className)} />;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-sm",
        quote.canAfford ? "border-border bg-muted/40" : "border-destructive/40 bg-destructive/5",
        className,
      )}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Coins className={cn("size-4 shrink-0", quote.canAfford ? "text-credit" : "text-destructive")} aria-hidden />
        <span className="font-medium whitespace-nowrap tabular-nums">{formatCredits(quote.credits)}</span>
        {label ? <span className="text-muted-foreground">for {label}</span> : null}
      </div>
      <div className="text-right text-xs text-muted-foreground tabular-nums">
        {quote.canAfford ? (
          <span>{formatCredits(quote.available)} available today</span>
        ) : quote.reason === "daily_cap" ? (
          <span className="text-destructive">Daily allowance reached. Try fewer pieces or come back tomorrow.</span>
        ) : quote.reason === "feature_locked" ? (
          <Link href={routes.billing} className="underline underline-offset-2">
            Upgrade for this quality
          </Link>
        ) : (
          <span className="text-destructive">
            Short by {formatCredits(quote.shortfall)} ·{" "}
            <Link href={`${routes.billing}#plans`} className="underline underline-offset-2">
              View plans
            </Link>
          </span>
        )}
      </div>
    </div>
  );
}
