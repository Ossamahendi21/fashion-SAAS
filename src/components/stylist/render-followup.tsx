"use client";

import { renderJobStatus } from "@/components/stylist/render-job-status";
import { useJob } from "@/hooks/use-active-jobs";
import type { Id } from "@convex/_generated/dataModel";

export function RenderFollowup({ jobIds }: { jobIds: Id<"jobs">[] }) {
  return (
    <div className="space-y-2 text-sm" role="status" aria-live="polite" aria-atomic="true">
      {jobIds.map((jobId) => (
        <JobOutcome key={jobId} jobId={jobId} />
      ))}
    </div>
  );
}

function JobOutcome({ jobId }: { jobId: Id<"jobs"> }) {
  const job = useJob(jobId);
  if (job === undefined) return <p>Checking your try-on…</p>;
  if (job === null) return <p>This try-on is no longer available.</p>;
  const status = renderJobStatus(job);
  return (
    <p>
      <strong>{status.title}.</strong> {status.detail}
    </p>
  );
}
