import type { ReactNode } from "react";
import { StylistProvider } from "@/components/stylist/stylist-provider";
import { AppFrame } from "./app-frame";
import { OnboardingGate } from "./onboarding-gate";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <OnboardingGate>
      <StylistProvider>
        <AppFrame>{children}</AppFrame>
      </StylistProvider>
    </OnboardingGate>
  );
}
