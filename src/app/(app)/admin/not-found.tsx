import { ShieldOff } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";

export default function AdminNotFound() {
  return (
    <EmptyState
      icon={ShieldOff}
      title="Admins only"
      description="This dashboard is limited to accounts with the admin role."
      action={
        <Button variant="outline" nativeButton={false} render={<Link href={routes.wardrobe} />}>
          Back to your wardrobe
        </Button>
      }
    />
  );
}
