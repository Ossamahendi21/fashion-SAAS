"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ErrorAlert } from "@/components/common/error-alert";
import { PageSkeleton } from "@/components/common/page-skeleton";
import { OnboardingSkeleton } from "@/components/onboarding/onboarding-skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { reportError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { api } from "@convex/_generated/api";

/** How long a signed-in session may sit without a `users` row before we offer a retry instead of a skeleton. */
const STORE_USER_TIMEOUT_MS = 5000;

/**
 * Sends users without an avatar to onboarding and keeps onboarded users out of it.
 * Renders a page-shaped skeleton while the user record loads so there's never a flash of the wrong screen.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  return <AccountOnboardingGate key={userId ?? "signed-out"}>{children}</AccountOnboardingGate>;
}

function AccountOnboardingGate({ children }: { children: ReactNode }) {
  const { user, isLoading, isAuthenticated } = useCurrentUser();
  const ensure = useMutation(api.users.ensure);
  const pathname = usePathname();
  const router = useRouter();
  const onOnboarding = pathname.startsWith(routes.onboarding);
  const needsOnboarding = Boolean(user && !user.onboardedAt);
  const missingUser = isAuthenticated && !isLoading && user === null;
  const [stuck, setStuck] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (isLoading || !user) return;
    if (needsOnboarding && !onOnboarding) router.replace(routes.onboarding);
    if (!needsOnboarding && onOnboarding) router.replace(routes.wardrobe);
  }, [isLoading, user, needsOnboarding, onOnboarding, router]);

  useEffect(() => {
    if (!missingUser) return;
    const timeout = setTimeout(() => setStuck(true), STORE_USER_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [missingUser]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await ensure({});
    } catch (error) {
      reportError(error);
    } finally {
      setRetrying(false);
    }
  }, [ensure]);

  if (missingUser && stuck) {
    return (
      <main className="mx-auto w-full max-w-lg px-4 py-12">
        <ErrorAlert
          title="We could not load your account"
          message="Your session is signed in but your Fitcheck account has not finished setting up."
          onRetry={() => void retry()}
          retryLabel={retrying ? "Retrying…" : "Try again"}
        />
      </main>
    );
  }

  if (isLoading || !user || (needsOnboarding && !onOnboarding) || (!needsOnboarding && onOnboarding)) {
    return (
      <main className="mx-auto w-full max-w-[1520px] px-4 py-12 sm:px-8 lg:px-12">
        <p role="status" className="mb-6 text-sm text-muted-foreground">
          {missingUser ? "Setting up your Fitcheck account…" : "Loading your account…"}
        </p>
        {onOnboarding ? <OnboardingSkeleton /> : <PageSkeleton />}
      </main>
    );
  }
  return <>{children}</>;
}
