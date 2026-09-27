import type { JobView } from "@/hooks/use-active-jobs";
import { isTerminalJobStatus, stepIndex, stepPrefix } from "@convex/shared/jobs";

type Job = Pick<JobView, "steps" | "status" | "error">;
type Step = Job["steps"][number];

export type ProgressPhase = {
  key: string;
  label: string;
  status: Step["status"] | "partial";
  detail?: string;
};

const PHASE_ORDER = ["upload", "detect", "review", "reserve", "extract", "render", "finalize"];
const PHASE_LABELS: Record<string, string> = {
  upload: "Upload",
  detect: "Scan",
  review: "Review",
  reserve: "Prepare",
  extract: "Cut out",
  render: "Create",
  finalize: "Finish",
};

export function jobProgress(job: Job, compact = true) {
  const terminal = isTerminalJobStatus(job.status);
  const groups = new Map<string, Step[]>();
  for (const step of job.steps) {
    const key = compact && stepIndex(step.key) !== null ? stepPrefix(step.key) : step.key;
    groups.set(key, [...(groups.get(key) ?? []), step]);
  }
  const phases: ProgressPhase[] = [...groups].map(([key, steps]) => {
    const done = steps.filter((step) => step.status === "done").length;
    const failed = steps.filter((step) => step.status === "failed").length;
    const skipped = steps.filter((step) => step.status === "skipped").length;
    const unfinished = steps.length - done - failed - skipped;
    let status: ProgressPhase["status"];
    if (unfinished > 0 && !terminal) {
      status = steps.some((step) => step.status === "running") ? "running" : "pending";
    } else if (failed > 0 || (job.status === "failed" && steps.some((step) => step.status === "running"))) {
      status = done > 0 ? "partial" : "failed";
    } else if (skipped === steps.length || unfinished === steps.length) status = "skipped";
    else if (skipped > 0 || unfinished > 0) status = "partial";
    else status = "done";
    return {
      key,
      label: PHASE_LABELS[key] ?? steps[0].label,
      status,
      detail: steps.length > 1 ? `${done} of ${steps.length} ready` : undefined,
    };
  });
  phases.sort((a, b) => phaseOrder(a.key) - phaseOrder(b.key));

  const units = job.steps.filter((step) => ["render", "extract"].includes(stepPrefix(step.key)));
  const ready = units.filter((step) => step.status === "done").length;
  const failed = units.filter((step) => step.status === "failed").length;
  const skipped = units.filter((step) => step.status === "skipped").length;
  const pending = units.length - ready - failed - skipped;
  const countLabel = units.length
    ? [`${ready} of ${units.length} ready`, failed ? `${failed} failed` : "", skipped ? `${skipped} skipped` : ""]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const active = job.steps.find((step) => step.status === "running");
  const retrying = !terminal && job.steps.some((step) => step.status === "running" && Boolean(step.error));
  let title: string;
  if (job.status === "queued") title = "Queued";
  else if (job.status === "failed") title = "Couldn’t complete";
  else if (job.status === "partial") title = "Finished with some issues";
  else if (job.status === "cancelled") title = "Cancelled";
  else if (job.status === "done") {
    const review = job.steps.find((step) => step.key === "review");
    const emptyScan =
      review?.status === "skipped" && job.steps.some((step) => step.key === "detect" && step.meta?.found === 0);
    title = review?.status === "done" ? "Ready to choose pieces" : emptyScan ? "No clothing found" : "Complete";
  } else if (units.length > 0 && pending === 0) title = "Finishing up";
  else if (retrying) title = "Retrying automatically";
  else if (!active && pending > 0 && pending < units.length) {
    title = units.some((step) => stepPrefix(step.key) === "render")
      ? "Waiting for remaining images"
      : "Waiting for remaining pieces";
  } else {
    const key = active ? stepPrefix(active.key) : undefined;
    title =
      key === "render"
        ? units.length === 1
          ? "Creating your try-on"
          : "Creating your try-ons"
        : key === "extract"
          ? "Cutting out your pieces"
          : key === "detect"
            ? "Scanning your photo"
            : key === "reserve"
              ? "Preparing your request"
              : key === "finalize"
                ? "Finishing up"
                : "Waiting to start";
  }

  return { title, phases, countLabel, ready, failed, skipped, pending, total: units.length, terminal, retrying };
}

function phaseOrder(key: string) {
  const index = PHASE_ORDER.indexOf(stepPrefix(key));
  return index < 0 ? PHASE_ORDER.length : index;
}

/** Historical guidance, never a countdown or a promise about parallel work. */
export function typicalDuration(averageMs: number | undefined): string | null {
  if (averageMs === undefined || !Number.isFinite(averageMs) || averageMs <= 0) return null;
  if (averageMs < 90_000) return `about ${Math.max(15, Math.round(averageMs / 15_000) * 15)} sec`;
  return `about ${Math.round(averageMs / 60_000)} min`;
}

/** A completed upload is 100%; fractional bytes must not round up to completion. */
export function uploadPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.floor(Math.min(1, Math.max(0, fraction)) * 100);
}

export function pendingRenderProgress(
  job: Job | null | undefined,
  renderId: string,
): {
  title: string;
  running: boolean;
  startedAt?: number;
  settled?: boolean;
} {
  if (job && isTerminalJobStatus(job.status)) return { title: jobProgress(job).title, running: false, settled: true };
  const step = job?.steps.find((candidate) => candidate.meta?.renderId === renderId);
  if (step?.status === "running") {
    return {
      title: step.error ? "Retrying your try-on" : "Creating your try-on",
      running: true,
      startedAt: step.startedAt,
    };
  }
  if (job?.status === "queued" || step?.status === "pending") return { title: "Your try-on is queued", running: false };
  return { title: "Preparing your try-on", running: false };
}
