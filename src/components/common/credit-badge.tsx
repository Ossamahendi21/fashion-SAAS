"use client";

import { Coins } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBalance } from "@/hooks/use-credits";
import { formatCredits, formatDate, formatNumber } from "@/lib/format";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useClerkPlan } from "@/hooks/use-clerk-plan";

/** Topbar balance. Turns amber when low; click goes to billing. */
export function CreditBadge({ className }: { className?: string }) {
  const { balance, isLow } = useBalance();
  const { plan } = useClerkPlan();
  if (!balance) return <Skeleton className={cn("h-7 w-14 rounded-full sm:w-24", className)} />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={routes.billing}
            className="flex min-h-11 items-center"
            aria-label={`${formatCredits(balance.total)} available. Open billing.`}
          />
        }
      >
        <Badge
          variant={isLow ? "destructive" : "secondary"}
          className={cn("h-7 gap-1.5 rounded-full px-2.5 text-xs tabular-nums", !isLow && "text-foreground", className)}
        >
          <Coins className={cn("size-3.5", isLow ? "" : "text-credit")} aria-hidden />
          <span className="sm:hidden">{formatNumber(balance.total)}</span>
          <span className="hidden sm:inline">{formatCredits(balance.total)}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="space-y-1 text-xs">
        <div className="font-medium">{plan.name} plan</div>
        <div className="tabular-nums">Plan credits: {formatNumber(balance.planCredits)}</div>
        <div className="tabular-nums">Non-expiring credits: {formatNumber(balance.packCredits)}</div>
        {balance.planPeriodEnd ? <div>Renews {formatDate(balance.planPeriodEnd)}</div> : null}
        {isLow ? (
          <div className="text-warning">Running low. View your plan and credit allowance in Billing.</div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
