import type { Metadata } from "next";
import { OutfitBuilder } from "@/components/outfits/outfit-builder";
import { requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Outfit",
  description: "Edit the look and render it on yourself.",
};

export default async function OutfitPage({ params }: PageProps<"/outfits/[outfitId]">) {
  await requireSignedIn();
  const { outfitId } = await params;
  // Passed through raw: the query normalises it and returns null, and the builder calls notFound().
  return <OutfitBuilder mode="edit" outfitId={outfitId} />;
}
