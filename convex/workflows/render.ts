import { vResultValidator, vWorkflowId } from "@convex-dev/workflow";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { refund } from "../model/credits";
import { completeJob, getJob, setStep } from "../model/jobs";
import { listByJob, markRenderFailed } from "../model/renders";
import { isTerminalJobStatus, RENDER_STEPS, type JobStatus } from "../shared/jobs";
import { workflow } from "./manager";

/**
 * Render every pending `renders` row of a job in parallel. Credits were already reserved by
 * renders.start / renders.regenerate / agent.startRenders, which start this with:
 *   start(ctx, internal.workflows.render.renderOutfits, { jobId, renderIds },
 *         { onComplete: internal.workflows.render.onRenderComplete, context: { jobId } })
 * Step keys: RENDER_STEPS.reserve (already done, mark done), `render:<n>`, RENDER_STEPS.finalize.
 */

export type RenderOutcome = { rendered: number; failed: number; skipped: number };

const vRenderOutcome = v.object({ rendered: v.number(), failed: v.number(), skipped: v.number() });

type SettledStatus = Extract<JobStatus, "done" | "partial" | "failed" | "cancelled">;

export const renderOutfits = workflow
  .define({ args: { jobId: v.id("jobs"), renderIds: v.array(v.id("renders")) }, returns: vRenderOutcome })
  .handler(async (step, args): Promise<RenderOutcome> => {
    const targets = await step.runMutation(internal.ai.pipeline.beginRenders, {
      jobId: args.jobId,
      renderIds: args.renderIds,
    });

    const results = await Promise.all(
      targets.map(async ({ renderId, stepKey }) => {
        try {
          const result = await step.runAction(
            internal.ai.openai.renderImage,
            { renderId, jobId: args.jobId, stepKey },
            { retry: true },
          );
          return result === null;
        } catch {
          // Exhausted transient errors settle together in onRenderComplete, including their refund.
          return false;
        }
      }),
    );

    const rendered = results.filter(Boolean).length;
    return {
      rendered,
      failed: results.length - rendered,
      skipped: args.renderIds.length - targets.length,
    };
  });

/** Refunds failed renders and marks the job done / partial / failed. */
export const onRenderComplete = internalMutation({
  args: { workflowId: vWorkflowId, result: vResultValidator, context: v.object({ jobId: v.id("jobs") }) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const job = await getJob(ctx, args.context.jobId);
    if (isTerminalJobStatus(job.status)) return null;

    const renders = await listByJob(ctx, job._id);
    const done = renders.filter((render) => render.status === "done");
    const unfinished = renders.filter((render) => render.status !== "done");
    const workflowError = args.result.kind === "failed" ? args.result.error : undefined;

    for (const render of unfinished) {
      const renderStep = job.steps.find((step) => step.meta?.renderId === render._id);
      const error = render.error ?? workflowError ?? renderStep?.error ?? "This image didn't finish.";
      if (render.status === "pending") {
        await markRenderFailed(ctx, render._id, error);
      }
      if (renderStep && renderStep.status !== "failed") {
        await setStep(ctx, job._id, renderStep.key, { status: "failed", error });
      }
    }

    // Renders are charged up front, so every image that never landed is money back.
    const unused = unfinished.reduce((sum, render) => sum + render.creditsCharged, 0);
    const refunded = unused > 0 ? await refund(ctx, job, unused, "Render failed") : 0;

    const firstError = unfinished
      .map((render) => render.error ?? job.steps.find((step) => step.meta?.renderId === render._id)?.error)
      .find(Boolean);

    let status: SettledStatus;
    let error: string | undefined;
    if (args.result.kind === "canceled") {
      status = "cancelled";
      error = "Cancelled before every image was rendered.";
    } else if (renders.length > 0 && done.length === 0) {
      status = "failed";
      error = workflowError ?? firstError ?? "No images could be rendered.";
    } else if (unfinished.length > 0) {
      status = "partial";
      error = workflowError ?? firstError;
    } else if (args.result.kind === "failed") {
      status = "failed";
      error = workflowError;
    } else {
      status = "done";
    }

    if (job.steps.some((step) => step.key === RENDER_STEPS.finalize)) {
      await setStep(ctx, job._id, RENDER_STEPS.finalize, {
        status: "done",
        meta: { rendered: done.length, failed: unfinished.length, refunded },
      });
    }
    await completeJob(ctx, job._id, { status, error });
    return null;
  },
});
