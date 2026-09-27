import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = { title: "Set up" };

export default async function OnboardingPage() {
  await requireSignedIn();
  return <OnboardingFlow />;
}
