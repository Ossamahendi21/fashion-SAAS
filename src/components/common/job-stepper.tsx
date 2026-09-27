"use client";

import { AlertCircle, Check, Clock3, Minus } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useStepEstimates, type JobView, type StepEstimates } from "@/hooks/use-active-jobs";
import { cn } from "@/lib/utils";
import { stepPrefix } from "@convex/shared/jobs";
import { jobProgress, typicalDuration, type ProgressPhase } from "./job-progress";

type JobStepperProps = {
  job: Pick<JobView, "steps" | "status" | "progress" | "error">;
  /** Collapse individual cutouts and try-ons into a phase with real item counts. */
  compact?: boolean;
  estimates?: StepEstimates;
  className?: string;
};

export function JobStepper({ job, compact = true, estimates, className }: JobStepperProps) {
  const shared = useStepEstimates();
  const view = jobProgress(job, compact);
  const active = job.steps.find((step) => step.status === "running");
  const prefix = active ? stepPrefix(active.key) : undefined;
  const usual = prefix && !view.terminal ? typicalDuration((estimates ?? shared)?.[prefix]) : null;
  const error = view.terminal && job.status !== "done" ? job.error : undefined;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs" role="status">
        <span className={cn("font-medium", job.status === "failed" && "text-destructive")}>{view.title}</span>
        {view.countLabel ? <span className="text-muted-foreground tabular-nums">{view.countLabel}</span> : null}
      </div>
      <ol className="grid grid-cols-3 gap-x-2 gap-y-3" aria-label="Progress stages">
        {view.phases.map((phase) => (
          <li key={phase.key} className="min-w-0" aria-current={phase.status === "running" ? "step" : undefined}>
            <div
              className={cn(
                "mb-2 h-0.5 bg-foreground/10",
                phase.status === "done" && "bg-foreground/70",
                phase.status === "running" && "animate-pulse bg-foreground motion-reduce:animate-none",
                phase.status === "failed" && "bg-destructive/70",
                phase.status === "partial" && "bg-warning/70",
              )}
              aria-hidden
            />
            <span
              className={cn(
                "flex items-center gap-1.5 text-[10px]",
                phase.status === "pending" && "text-muted-foreground",
              )}
            >
              <PhaseIcon status={phase.status} />
              <span className="truncate">{phase.label}</span>
            </span>
            {phase.detail && !compact ? (
              <span className="text-[10px] text-muted-foreground">{phase.detail}</span>
            ) : null}
          </li>
        ))}
      </ol>
      {error ? <p className="text-xs leading-relaxed break-words text-destructive">{error}</p> : null}
      {!view.terminal ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {job.status === "queued"
            ? "Starts automatically. You can keep browsing."
            : usual && ["render", "extract", "detect"].includes(prefix ?? "")
              ? `Usually ${usual}${prefix === "render" ? " per image" : prefix === "extract" ? " per piece" : " per photo"}. You can keep browsing.`
              : "You can keep browsing. Updates appear here automatically."}
        </p>
      ) : null}
    </div>
  );
}

function PhaseIcon({ status }: { status: ProgressPhase["status"] }) {
  const base = "size-3 shrink-0";
  if (status === "running")
    return <Spinner className={cn(base, "motion-reduce:animate-none")} aria-label="In progress" />;
  if (status === "done") return <Check className={cn(base, "text-success")} aria-label="Complete" />;
  if (status === "failed" || status === "partial")
    return (
      <AlertCircle
        className={cn(base, status === "failed" ? "text-destructive" : "text-warning")}
        aria-label={status === "failed" ? "Failed" : "Partly complete"}
      />
    );
  if (status === "skipped") return <Minus className={cn(base, "text-muted-foreground")} aria-label="Skipped" />;
  return <Clock3 className={cn(base, "text-muted-foreground/60")} aria-label="Waiting" />;
}
