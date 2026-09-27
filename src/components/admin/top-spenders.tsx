"use client";

import { useQuery } from "convex/react";
import { Users } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingRows } from "@/components/common/loading-grid";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatUsd, pluralize } from "@/lib/format";
import { api } from "@convex/_generated/api";
import type { AdminWindow } from "./window-toggle";

export function TopSpenders({ days }: { days: AdminWindow }) {
  const result = useQuery(api.admin.topSpenders, { days, limit: 10 });
  const spenders = result?.rows;
  // The ranking comes from a bounded ledger window; the server says when it stopped short of it.
  const truncated = result?.truncated ?? false;

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Top spenders</CardTitle>
        <CardDescription>
          Credits spent over the last {pluralize(days, "day")}, with the image cost they actually cost us.
          {truncated ? " Ranked from the most recent ledger lines only, so the tail may be missing." : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {spenders === undefined ? (
          <LoadingRows count={5} className="px-(--card-spacing) py-2" />
        ) : spenders.length === 0 ? (
          <div className="px-(--card-spacing)">
            <EmptyState
              icon={Users}
              title="Nobody has spent a credit"
              description="Once renders and extractions run in this window, the biggest spenders show up here."
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="hidden sm:table-cell">Plan</TableHead>
                <TableHead className="text-right">Credits spent</TableHead>
                <TableHead className="text-right">COGS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {spenders.map((spender) => (
                <TableRow key={spender.userId}>
                  <TableCell className="max-w-[24ch] truncate font-medium" title={spender.email ?? spender.name}>
                    {spender.name ?? spender.email ?? "Unknown"}
                    {spender.name && spender.email ? (
                      <span className="ml-2 font-normal text-muted-foreground">{spender.email}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant="outline" className="capitalize">
                      {spender.plan}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatNumber(spender.creditsSpent)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {formatUsd(spender.cogsUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
