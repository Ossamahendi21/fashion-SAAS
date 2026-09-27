import type { EveMessage, EveMessagePart } from "eve/react";
import type { Id } from "@convex/_generated/dataModel";

export type TranscriptPart = {
  part: EveMessagePart;
  renderJobIds?: Id<"jobs">[];
};

export function readRenderJobId(output: unknown): Id<"jobs"> | null {
  const jobId = (output as { jobId?: unknown } | null)?.jobId;
  return typeof jobId === "string" && jobId.trim().length > 0 ? (jobId as Id<"jobs">) : null;
}

/** A render launch's closing prose cannot know when its background job finishes. */
export function projectRenderFollowups(messages: readonly EveMessage[]) {
  let renderJobIds: Id<"jobs">[] = [];
  let followupShown = false;

  return messages.map((message) => {
    if (message.role === "user") {
      renderJobIds = [];
      followupShown = false;
    }

    const parts: TranscriptPart[] = [];
    for (const part of message.parts) {
      if (message.role !== "user" && part.type === "dynamic-tool") {
        const jobId =
          part.toolName === "start_renders" && part.state === "output-available" ? readRenderJobId(part.output) : null;
        if (jobId) {
          if (!renderJobIds.includes(jobId)) renderJobIds = [...renderJobIds, jobId];
        } else {
          // A different tool starts a new subject; preserve its explanation and any error/approval copy.
          renderJobIds = [];
        }
        followupShown = false;
      }

      if (message.role !== "user" && part.type === "text" && part.text.trim() && renderJobIds.length > 0) {
        if (!followupShown) parts.push({ part, renderJobIds: [...renderJobIds] });
        followupShown = true;
      } else {
        parts.push({ part });
      }
    }
    return { message, parts };
  });
}
