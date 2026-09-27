import { MessageSquareOff } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";

export default function ThreadNotFound() {
  return (
    <div className="mx-auto w-full max-w-3xl py-10">
      <EmptyState
        icon={MessageSquareOff}
        title="This chat is gone"
        description="It may have been deleted from another device, or the link is wrong."
        action={
          <Button nativeButton={false} render={<Link href={routes.stylist} />}>
            Back to the stylist
          </Button>
        }
      />
    </div>
  );
}
