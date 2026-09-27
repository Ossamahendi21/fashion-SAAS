import type { JobView } from "@/hooks/use-active-jobs";
import { pluralize } from "@/lib/format";

type RenderJobState = Pick<JobView, "status" | "resultIds" | "error">;

export function renderJobStatus(job: RenderJobState) {
  const ready = job.resultIds.length;
  const readyText = `${pluralize(ready, "image")} ready.`;
  switch (job.status) {
    case "queued":
      return { title: "Queued", detail: "Your try-on will start shortly.", running: true };
    case "running":
      return {
        title: "Creating your try-on",
        detail:
          ready > 0
            ? `${readyText} The remaining images are still being created.`
            : "Images will appear here as they finish.",
        running: true,
      };
    case "done":
      return { title: "Done", detail: ready > 0 ? readyText : "Your try-on is ready.", running: false };
    case "partial":
      return { title: "Partly complete", detail: `${readyText} Some images could not be created.`, running: false };
    case "failed":
      return {
        title: "Try-on failed",
        detail: ready > 0 ? `${readyText} The job could not finish.` : "The job could not finish. Please try again.",
        running: false,
      };
    case "cancelled":
      return {
        title: "Cancelled",
        detail: ready > 0 ? `${readyText} The remaining images were cancelled.` : "This try-on was cancelled.",
        running: false,
      };
  }
}
