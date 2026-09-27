"use client";

import { ArrowUpRight, Trash } from "lucide-react";
import Link from "next/link";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { StylistThread } from "@/hooks/use-stylist";
import { formatRelative } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { Id } from "@convex/_generated/dataModel";

type ThreadListProps = {
  threads: StylistThread[];
  onDelete: (threadId: Id<"threads">) => Promise<unknown>;
};

export function ThreadList({ threads, onDelete }: ThreadListProps) {
  return (
    <ul className="divide-y border-t">
      {threads.map((thread) => (
        <li key={thread._id}>
          <div className="group flex items-center gap-3 py-4">
            <Link
              href={routes.thread(thread._id)}
              className="flex min-w-0 flex-1 items-center justify-between gap-4 outline-none hover:text-muted-foreground focus-visible:underline"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{thread.title}</span>
                <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                  {formatRelative(thread.lastMessageAt)}
                </span>
              </span>
              <ArrowUpRight className="size-4 shrink-0" aria-hidden />
            </Link>
            {/* On touch there is no hover, so Delete stays visible; a pointer device gets it on hover. */}
            <ConfirmDialog
              trigger={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${thread.title}`}
                  className="transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"
                >
                  <Trash />
                </Button>
              }
              title="Delete this chat?"
              description="The conversation will be deleted. Saved outfits stay in Outfits."
              confirmLabel="Delete"
              destructive
              onConfirm={() => onDelete(thread._id)}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ThreadListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="divide-y border-t" aria-busy="true" aria-label="Loading chats">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3 py-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}
