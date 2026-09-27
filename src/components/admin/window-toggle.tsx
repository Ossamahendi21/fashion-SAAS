"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@convex/_generated/api";
import type { FunctionArgs } from "convex/server";

export type AdminWindow = FunctionArgs<typeof api.admin.overview>["days"];

const WINDOWS = [1, 7, 30] as const satisfies readonly AdminWindow[];

const LABELS: Record<AdminWindow, string> = { 1: "Today", 7: "7 days", 30: "30 days" };

export function WindowToggle({ value, onChange }: { value: AdminWindow; onChange: (next: AdminWindow) => void }) {
  return (
    <ToggleGroup
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="Reporting window"
      value={[String(value)]}
      onValueChange={(next) => {
        const picked = WINDOWS.find((option) => String(option) === next[0]);
        if (picked !== undefined) onChange(picked);
      }}
    >
      {WINDOWS.map((option) => (
        <ToggleGroupItem key={option} value={String(option)}>
          {LABELS[option]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
