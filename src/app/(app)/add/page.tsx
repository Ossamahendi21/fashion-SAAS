import type { Metadata } from "next";
import { Suspense } from "react";
import { AddClothes } from "@/components/upload/add-clothes";
import { AddClothesSkeleton } from "@/components/upload/add-clothes-skeleton";
import { requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = { title: "Add clothes" };

export default async function AddPage() {
  await requireSignedIn();
  // AddClothes keeps the batch id in the query string, so it needs a Suspense boundary.
  return (
    <Suspense fallback={<AddClothesSkeleton />}>
      <AddClothes />
    </Suspense>
  );
}
