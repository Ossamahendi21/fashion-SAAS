import type { Metadata } from "next";
import { OutfitsList } from "@/components/outfits/outfits-list";
import { requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Outfits",
  description: "Looks you have put together, and the ones the stylist suggested.",
};

export default async function OutfitsPage() {
  await requireSignedIn();
  return <OutfitsList />;
}
