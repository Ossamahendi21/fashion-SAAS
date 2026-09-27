"use client";

import { useQuery } from "convex/react";
import { notFound } from "next/navigation";
import { StylistChat } from "@/components/stylist/stylist-chat";
import { useStylistPanel } from "@/components/stylist/stylist-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@convex/_generated/api";

/**
 * The chat is only mounted once the thread is loaded: `useEveAgent` reads `initialSession` and
 * `resume` when it builds its store, so the saved session cursor has to be in hand first.
 *
 * `threads.get` takes the raw id from the URL and returns `null` for a malformed, deleted or
 * foreign one, so a bad link renders `not-found.tsx` instead of a validator error.
 */
export function StylistChatRoute({ threadId, initialBrief }: { threadId: string; initialBrief?: string }) {
  const thread = useQuery(api.threads.get, { threadId });
  const panel = useStylistPanel();

  if (thread === undefined) return <ChatSkeleton />;
  if (thread === null) notFound();

  if (panel.open && panel.selectedThreadId === threadId) {
    return (
      <div className="mx-auto max-w-3xl space-y-5 py-8">
        <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">The styling room</p>
        <h1 className="text-3xl font-medium tracking-tight">{thread.title}</h1>
        <p className="text-sm text-muted-foreground">This conversation is open in your stylist panel.</p>
        <Button variant="outline" className="rounded-none" onClick={() => panel.setOpen(false)}>
          Show conversation here
        </Button>
      </div>
    );
  }

  return <StylistChat key={thread._id} thread={thread} initialBrief={initialBrief} />;
}

export function ChatSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6" aria-busy="true" aria-label="Loading this chat">
      <div className="space-y-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8 w-56" />
      </div>
      <div className="space-y-5">
        <Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" />
        <div className="flex gap-2.5">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-16 w-4/5 rounded-2xl" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-44 rounded-xl" />
              <Skeleton className="h-44 rounded-xl" />
            </div>
          </div>
        </div>
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  );
}
