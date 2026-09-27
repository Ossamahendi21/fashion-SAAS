"use client";

import { useState } from "react";
import { PageHeader } from "@/components/common/page-header";
import { useCurrentUser, type CurrentUser } from "@/hooks/use-current-user";
import { cn } from "@/lib/utils";
import { useClerkPlan } from "@/hooks/use-clerk-plan";
import { AvatarStep } from "./avatar-step";
import { OnboardingSkeleton } from "./onboarding-skeleton";
import { PreferencesStep } from "./preferences-step";

const STEPS = [
  {
    title: "Your fitting photo.",
    description: "Start with a full-length photo. This is who your outfits will be rendered on.",
  },
  {
    title: "Set your style.",
    description: "Choose your wardrobe and fit. We’ll tailor your examples and styling to you.",
  },
] as const;

/** Two steps, no skipping: a photo to render on, then the preferences the stylist needs. */
export function OnboardingFlow() {
  const { user, isLoading } = useCurrentUser();
  const { planId } = useClerkPlan();
  const [step, setStep] = useState<0 | 1>(0);
  const [prefsDraft, setPrefsDraft] = useState<CurrentUser["prefs"] | null>(null);

  if (isLoading || !user) return <OnboardingSkeleton />;

  const current = STEPS[step];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <div className="space-y-4">
        <PageHeader
          eyebrow={`Step ${step + 1} of ${STEPS.length}`}
          title={current.title}
          description={current.description}
        />
        <ol className="grid grid-cols-2 border-b pt-3" aria-label="Setup progress">
          {STEPS.map((entry, index) => (
            <li
              key={entry.title}
              aria-current={index === step ? "step" : undefined}
              className={cn(
                "flex items-center gap-3 border-b-2 py-3 text-sm",
                index === step ? "border-foreground font-medium" : "border-transparent text-muted-foreground",
              )}
            >
              <span className="font-mono text-[11px]">0{index + 1}</span>
              <span>{index === 0 ? "Your photo" : "Your preferences"}</span>
            </li>
          ))}
        </ol>
      </div>

      {step === 0 ? (
        <AvatarStep plan={planId} onContinue={() => setStep(1)} />
      ) : (
        <PreferencesStep
          prefs={prefsDraft ?? user.prefs}
          onBack={(draft) => {
            setPrefsDraft(draft);
            setStep(0);
          }}
        />
      )}
    </div>
  );
}
