import type { Metadata } from "next";
import { ItemDetail } from "@/components/wardrobe/item-detail";
import { requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = { title: "Item" };

export default async function ItemPage({ params }: PageProps<"/wardrobe/[itemId]">) {
  await requireSignedIn();
  const { itemId } = await params;
  // `items.get` normalises the id itself and answers `null` for anything malformed or foreign.
  return <ItemDetail itemId={itemId} />;
}
