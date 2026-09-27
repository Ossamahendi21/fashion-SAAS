"use client";

import { AlertCircle, Check, ChevronDown, CircleSlash, Pause, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  activityGroupState,
  activityRetry,
  summarizeActivity,
  type ActivityState,
  type ActivityTool,
} from "./tool-activity-state";

const STATUS_LABELS: Record<ActivityState, string> = {
  running: "Working",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
  paused: "Paused",
  waiting: "Needs an answer",
};

type ToolActivityProps = {
  tools: readonly ActivityTool[];
  active: boolean;
  disabled: boolean;
  onRetry: (message: string) => Promise<void>;
};

export function ToolActivity({ tools, active, disabled, onRetry }: ToolActivityProps) {
  const rows = summarizeActivity(tools, active);
  const running = rows.find((row) => row.state === "running");
  const failures = tools.filter((tool) => tool.state === "output-error").length;
  const failed = failures > 0;
  const state = activityGroupState(rows.map((row) => row.state));
  const label =
    rows.length === 1
      ? rows[0].label
      : (running?.label ??
        (failed
          ? "Some steps need attention"
          : state === "waiting"
            ? "Waiting for your answer"
            : state === "paused"
              ? "Stylist paused"
              : state === "cancelled"
                ? rows.every((row) => row.state === "cancelled")
                  ? "Actions cancelled"
                  : "Some actions cancelled"
                : "Checks complete"));
  const retry = activityRetry(tools);
  const finishedCount = tools.filter((tool) => tool.state === "output-available" && !tool.partial).length;

  return (
    <div className="min-w-0 border-l-2 border-foreground/15 bg-muted/30 text-xs">
      <details className="group/activity" open={failed || undefined}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 outline-none select-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ActivityIcon state={state} />
          <span className="min-w-0 flex-1 leading-relaxed" aria-live="polite" aria-atomic="true">
            <span className={cn("font-medium", failed && "text-destructive")}>{label}</span>
            {tools.length > 1 ? (
              <span className="ml-2 text-[11px] whitespace-nowrap text-muted-foreground">
                {state === "running" ? `${finishedCount}/${tools.length}` : `${tools.length} steps`}
                {failed ? ` · ${failures} failed` : ""}
              </span>
            ) : null}
          </span>
          <span
            className={cn("shrink-0 text-[10px]", state === "error" ? "text-destructive" : "text-muted-foreground")}
          >
            {STATUS_LABELS[state]}
          </span>
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/activity:rotate-180 motion-reduce:transition-none"
            aria-hidden
          />
        </summary>
        <ul className="space-y-3 border-t border-foreground/5 px-3 py-3">
          {rows.map((row) => (
            <li key={row.key} className="flex items-start gap-2.5">
              <ActivityIcon state={row.state} />
              <div className="min-w-0 flex-1">
                <p className={cn("leading-relaxed", row.state === "error" && "text-destructive")}>
                  {row.label}
                  <span className="sr-only">. {STATUS_LABELS[row.state]}.</span>
                </p>
                {row.detail ? (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-pretty text-muted-foreground">{row.detail}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </details>
      {retry ? (
        <div className="px-3 pb-2">
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 rounded-none px-2 text-xs whitespace-normal"
            disabled={disabled}
            onClick={() => void onRetry(retry.message).catch(() => {})}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {retry.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ActivityIcon({ state }: { state: ActivityState }) {
  if (state === "running")
    return <Spinner className="mt-0.5 size-3.5 shrink-0 motion-reduce:animate-none" aria-hidden />;
  const Icon =
    state === "done"
      ? Check
      : state === "error"
        ? AlertCircle
        : state === "cancelled"
          ? CircleSlash
          : state === "paused"
            ? Pause
            : Sparkles;
  return (
    <Icon
      className={cn("mt-0.5 size-3.5 shrink-0", state === "error" ? "text-destructive" : "text-muted-foreground")}
      aria-hidden
    />
  );
}
