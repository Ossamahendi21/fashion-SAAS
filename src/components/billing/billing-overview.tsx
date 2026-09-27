"use client";

import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useClerk } from "@clerk/nextjs";
import { useAction } from "convex/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { reportError } from "@/lib/errors";
import { api } from "@convex/_generated/api";
import { useBalance } from "@/hooks/use-credits";
import { formatCredits, formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LIMITS } from "@convex/shared/credits";
import { useClerkPlan } from "@/hooks/use-clerk-plan";
import { SummaryCardsSkeleton } from "./billing-skeleton";

export function BillingOverview() {
  const { balance, isLow } = useBalance();
  const { plan } = useClerkPlan();
  const { session } = useClerk();
  const refreshSubscription = useAction(api.subscriptions.refresh);
  const [refreshing, setRefreshing] = useState(false);

  async function refreshPlan() {
    setRefreshing(true);
    try {
      await session?.reload();
      await refreshSubscription({});
    } catch (error) {
      reportError(error, "Could not refresh your plan. Try again.");
    } finally {
      setRefreshing(false);
    }
  }

  if (!balance) {
    return (
      <section className="space-y-4">
        <div className="h-12 w-52 animate-pulse rounded-lg bg-muted" />
        <SummaryCardsSkeleton />
      </section>
    );
  }

  return (
    <section className="grid border-y border-foreground/20 md:grid-cols-[1.1fr_1fr]" aria-label="Balance">
      <div className="flex flex-col justify-between gap-8 py-7 md:pr-10">
        <div>
          <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Available to create</p>
          <p className={cn("mt-4 flex items-baseline gap-3", isLow && "text-destructive")}>
            <span className="text-[5.5rem] leading-none font-medium tracking-[-0.075em] tabular-nums sm:text-[7rem]">
              {formatNumber(balance.total)}
            </span>
            <span className="text-sm text-muted-foreground">{balance.total === 1 ? "credit" : "credits"}</span>
          </p>
          {isLow ? (
            <p className="mt-3 text-xs text-destructive">
              {plan.monthlyCredits > 0
                ? "Running low. Plan credits refresh each billing cycle."
                : "Running low. Choose a plan for a monthly credit allowance."}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <p className="max-w-52 text-xs leading-relaxed text-muted-foreground">
            {formatCredits(balance.dailyRemaining)} left in today’s cap of {formatNumber(LIMITS.dailyCreditCap)}.
          </p>
          <Button variant="link" className="h-auto px-0" nativeButton={false} render={<a href="#plans" />}>
            View plans <ArrowUpRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
      <div className="space-y-6 border-t py-7 md:border-t-0 md:border-l md:pl-10">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Your membership</p>
            <p className="text-3xl font-medium tracking-tight">{plan.name}</p>
            <p className="max-w-64 text-xs leading-relaxed text-muted-foreground">{plan.blurb}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-none"
            disabled={refreshing}
            onClick={() => void refreshPlan()}
          >
            {refreshing ? <Spinner /> : <RefreshCw aria-hidden />} Refresh plan
          </Button>
        </div>
        <dl className="divide-y border-y text-sm">
          <div className="flex items-baseline justify-between gap-4 py-3">
            <dt className="text-muted-foreground">
              Plan credits <span className="text-[10px]">/ used first</span>
            </dt>
            <dd className="font-medium tabular-nums">{formatNumber(balance.planCredits)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-3">
            <dt className="text-muted-foreground">Non-expiring credits</dt>
            <dd className="font-medium tabular-nums">{formatNumber(balance.packCredits)}</dd>
          </div>
        </dl>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {plan.monthlyCredits > 0
            ? `${formatNumber(plan.monthlyCredits)} plan credits each cycle.`
            : "No monthly charge or cycle refill."}
          {balance.planPeriodEnd ? ` Current cycle ends ${formatDate(balance.planPeriodEnd)}.` : ""}
        </p>
      </div>
    </section>
  );
}
