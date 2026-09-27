"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { isTerminalJobStatus } from "@convex/shared/jobs";

export type JobView = FunctionReturnType<typeof api.jobs.listActive>[number];

export function useActiveJobs(): { jobs: JobView[] | undefined; count: number } {
  const { isAuthenticated } = useConvexAuth();
  const jobs = useQuery(api.jobs.listActive, isAuthenticated ? {} : "skip");
  return { jobs, count: jobs?.length ?? 0 };
}

export function useJob(jobId: JobView["_id"] | null | undefined): JobView | null | undefined {
  return useQuery(api.jobs.get, jobId ? { jobId } : "skip");
}

/** Running average duration per step prefix (`detect`, `extract`, `render`) in ms, for ETAs. */
export type StepEstimates = FunctionReturnType<typeof api.jobs.stepEstimates>;

/**
 * Server-side step averages. Every caller subscribes with the same (empty) args, so the Convex
 * client keeps one subscription no matter how many steppers and tiles ask for it.
 */
export function useStepEstimates(): StepEstimates | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.jobs.stepEstimates, isAuthenticated ? {} : "skip");
}

/**
 * Fires a toast when a job the user is watching finishes.
 * Tracks the set of active job ids and reports transitions out of it.
 */
export function useJobCompletionToasts(): void {
  const { isAuthenticated } = useConvexAuth();
  const recent = useQuery(api.jobs.listRecent, isAuthenticated ? { limit: 10 } : "skip");
  const seen = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!recent) return;
    for (const job of recent) {
      const previous = seen.current.get(job._id);
      seen.current.set(job._id, job.status);
      if (previous === undefined || previous === job.status || !isTerminalJobStatus(job.status)) continue;
      const noun = job.type === "ingest" ? "Wardrobe update" : "Render";
      if (job.status === "done") {
        const reviewReady = job.steps.some((step) => step.key === "review" && step.status === "done");
        toast.success(reviewReady ? "Scan ready. Choose the pieces you want to import." : `${noun} finished.`);
      } else if (job.status === "partial") toast.warning(`${noun} finished with some items skipped.`);
      else if (job.status === "failed") toast.error(job.error ?? `${noun} failed.`);
    }
  }, [recent]);
}
