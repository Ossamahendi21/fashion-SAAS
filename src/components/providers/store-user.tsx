"use client";

import { useAuth } from "@clerk/nextjs";
import { useSubscription } from "@clerk/nextjs/experimental";
import { useAction, useConvexAuth, useMutation } from "convex/react";
import { useEffect } from "react";
import { api } from "@convex/_generated/api";
import { useClerkPlan } from "@/hooks/use-clerk-plan";
import { reportError } from "@/lib/errors";

/** Provisions each account after Convex has authenticated its Clerk session. */
export function StoreUser() {
  const { userId } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  return isAuthenticated && userId ? <AuthenticatedUser key={userId} /> : null;
}

function AuthenticatedUser() {
  const ensure = useMutation(api.users.ensure);
  const refreshSubscription = useAction(api.subscriptions.refresh);
  const { planId } = useClerkPlan();
  const { data: subscription } = useSubscription();
  const subscriptionVersion = JSON.stringify([
    subscription?.updatedAt?.getTime(),
    subscription?.subscriptionItems.map((item) => [
      item.id,
      item.plan.slug,
      item.status,
      item.periodStart.getTime(),
      item.periodEnd?.getTime(),
      item.canceledAt?.getTime(),
    ]),
  ]);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      // Checkout can finish in a background tab; its SDK update must still reconcile credits.
      if (pending || disposed) return;
      pending = true;
      let accountReady = false;
      try {
        await ensure({});
        accountReady = true;
        if (disposed) return;
        await refreshSubscription({});
      } catch (error) {
        if (!disposed)
          reportError(
            error,
            accountReady
              ? "Could not refresh your plan. Try again from Billing."
              : "Could not finish setting up your account. Try again.",
          );
      } finally {
        pending = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [ensure, refreshSubscription, planId, subscriptionVersion]);
  return null;
}
