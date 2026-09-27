import type { Metadata } from "next";
import { OutfitBuilder } from "@/components/outfits/outfit-builder";
import { requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = {
  title: "New outfit",
  description: "Put pieces from your wardrobe together into a look.",
};

export default async function NewOutfitPage() {
  await requireSignedIn();
  return <OutfitBuilder mode="create" />;
}
