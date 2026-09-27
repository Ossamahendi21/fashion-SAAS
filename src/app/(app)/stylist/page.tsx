import { StylistThreads } from "@/components/stylist/stylist-threads";
import { requireSignedIn } from "@/lib/auth";

export default async function StylistPage() {
  await requireSignedIn();
  return <StylistThreads />;
}
