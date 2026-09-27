"use client";

import { useAuth } from "@clerk/nextjs";
import { PLANS, type PlanId } from "@convex/shared/credits";

export function useClerkPlan() {
  const { has, isLoaded } = useAuth();
  const planId: PlanId = has?.({ plan: "plus" }) ? "plus" : has?.({ plan: "pro" }) ? "pro" : "free";
  return {
    isLoaded,
    planId,
    plan: PLANS[planId],
    canShare: has?.({ feature: "sharing" }) ?? false,
    canRenderHq: has?.({ feature: "hq_renders" }) ?? false,
  };
}
