"use client";

import { useQuery } from "convex/react";
import {
  Activity,
  Banknote,
  Coins,
  Flame,
  Gift,
  Images,
  ShieldOff,
  Shirt,
  TrendingUp,
  TriangleAlert,
  Undo2,
  UserPlus,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { formatCredits, formatNumber, formatPercent, formatUsd, formatUsdPrecise, pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { api } from "@convex/_generated/api";
import { UNIT_ECONOMICS } from "@convex/shared/credits";
import { AdjustCreditsForm } from "./adjust-credits-form";
import { AdminSkeleton, StatTilesSkeleton } from "./admin-skeleton";
import { JobsTable } from "./jobs-table";
import { StatTile } from "./stat-tile";
import { TopSpenders } from "./top-spenders";
import { WindowToggle, type AdminWindow } from "./window-toggle";

export function AdminDashboard() {
  const { user, isLoading } = useCurrentUser();
  const [days, setDays] = useState<AdminWindow>(7);

  if (isLoading) return <AdminSkeleton />;

  if (!user || user.role !== "admin") {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-8">
        <PageHeader title="Admin" description="Revenue, cost of goods and the state of the credit meter." />
        <EmptyState
          icon={ShieldOff}
          title="Admins only"
          description="This dashboard is limited to accounts with the admin role. The server enforces it too."
          action={
            <Button variant="outline" nativeButton={false} render={<Link href={routes.wardrobe} />}>
              Back to your wardrobe
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <PageHeader
        title="Admin"
        description="Revenue, cost of goods and the state of the credit meter."
        actions={<WindowToggle value={days} onChange={setDays} />}
      />
      <OverviewSection days={days} />
      <JobsTable />
      <TopSpenders days={days} />
      <AdjustCreditsForm />
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h2>;
}

function OverviewSection({ days }: { days: AdminWindow }) {
  const overview = useQuery(api.admin.overview, { days });

  if (overview === undefined) {
    return (
      <div className="space-y-6">
        <StatTilesSkeleton count={3} />
        <StatTilesSkeleton count={4} />
        <StatTilesSkeleton count={6} />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }

  const windowLabel = `last ${pluralize(overview.days, "day")}`;
  // A fraction, not a percentage: 0.45 is a 45% margin.
  const marginTone = overview.grossMargin < 0 ? "negative" : overview.grossMargin >= 0.5 ? "positive" : "default";

  const spendUsd = overview.todayCreditsReserved * UNIT_ECONOMICS.cogsUsdPerCredit;
  const cap = overview.dailySpendCapUsd;
  const capFraction = cap !== null && cap > 0 ? Math.min(spendUsd / cap, 1) : null;
  const killSwitch = cap !== null && cap > 0 && spendUsd >= cap;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading>Money · {windowLabel}</SectionHeading>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Revenue" value={formatUsd(overview.revenueUsd)} icon={Banknote} />
          <StatTile label="COGS" value={formatUsd(overview.cogsUsd)} icon={Flame} hint="From stored token usage" />
          <StatTile
            label="Gross margin"
            value={formatPercent(overview.grossMargin, 1)}
            icon={TrendingUp}
            tone={marginTone}
          />
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading>Credits · {windowLabel}</SectionHeading>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Sold" value={formatNumber(overview.creditsSold)} icon={Coins} />
          <StatTile label="Granted" value={formatNumber(overview.creditsGranted)} icon={Gift} />
          <StatTile label="Spent" value={formatNumber(overview.creditsSpent)} icon={Activity} />
          <StatTile label="Refunded" value={formatNumber(overview.creditsRefunded)} icon={Undo2} />
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading>Activity · {windowLabel}</SectionHeading>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Renders done" value={formatNumber(overview.rendersDone)} icon={Images} />
          <StatTile label="Items extracted" value={formatNumber(overview.itemsExtracted)} icon={Shirt} />
          <StatTile label="Users" value={formatNumber(overview.users)} icon={Users} />
          <StatTile label="New users" value={formatNumber(overview.newUsers)} icon={UserPlus} />
          <StatTile label="Jobs running" value={formatNumber(overview.jobsRunning)} icon={Activity} />
          <StatTile
            label="Jobs failed"
            value={formatNumber(overview.jobsFailed)}
            icon={TriangleAlert}
            tone={overview.jobsFailed > 0 ? "negative" : "default"}
          />
        </div>
      </section>

      <Card className={cn(killSwitch && "ring-destructive/40")}>
        <CardHeader className="border-b">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            Today&rsquo;s image spend
            {killSwitch ? (
              <Badge variant="destructive" className="gap-1">
                <TriangleAlert aria-hidden />
                Kill switch active
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            Credits reserved today, priced at {formatUsdPrecise(UNIT_ECONOMICS.cogsUsdPerCredit)} of image generation
            each, against MAX_DAILY_SPEND_USD.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span
              className={cn("text-2xl font-semibold tracking-tight tabular-nums", killSwitch && "text-destructive")}
            >
              {formatUsd(spendUsd)}
            </span>
            <span className="text-sm text-muted-foreground tabular-nums">
              {cap !== null ? `of ${formatUsd(cap)} daily cap` : "no cap configured"}
            </span>
          </div>
          {capFraction !== null ? (
            <Progress
              value={Math.round(capFraction * 100)}
              aria-label="Daily spend against the cap"
              className={cn(killSwitch && "[&_[data-slot=progress-indicator]]:bg-destructive")}
            />
          ) : null}
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatCredits(overview.todayCreditsReserved)} reserved today
            {capFraction !== null ? ` · ${formatPercent(capFraction)} of the cap` : null}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
