import type { Metadata } from "next";
import { WardrobeGrid } from "@/components/wardrobe/wardrobe-grid";
import { requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = { title: "Wardrobe" };

export default async function WardrobePage() {
  await requireSignedIn();
  return <WardrobeGrid />;
}
