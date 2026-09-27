import type { Metadata } from "next";
import { Lookbook } from "@/components/renders/lookbook";
import { requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Lookbook",
  description: "Every image Fitcheck has rendered of you.",
};

export default async function LookbookPage() {
  await requireSignedIn();
  return <Lookbook />;
}
