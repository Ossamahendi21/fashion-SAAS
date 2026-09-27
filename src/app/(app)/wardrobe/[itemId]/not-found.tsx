import { PackageOpen, Shirt } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";

export default function ItemNotFound() {
  return (
    <EmptyState
      icon={PackageOpen}
      title="Item not found"
      description="It may have been deleted, or the link is wrong."
      action={
        <Button nativeButton={false} render={<Link href={routes.wardrobe} />}>
          <Shirt data-icon="inline-start" />
          Back to wardrobe
        </Button>
      }
    />
  );
}
