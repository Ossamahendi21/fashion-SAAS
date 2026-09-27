import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "../_generated/api";

/**
 * One manager for every pipeline. Parallelism is global across the component;
 * per-user fairness comes from LIMITS.maxRunningJobsPerUser enforced in model/jobs.
 */
export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    maxParallelism: 8,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 2000, base: 2 },
    retryActionsByDefault: true,
  },
});
