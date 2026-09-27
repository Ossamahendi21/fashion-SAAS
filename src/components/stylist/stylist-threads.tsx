"use client";

import { useMutation } from "convex/react";
import { ArrowUpRight, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PageHeader } from "@/components/common/page-header";
import { EXAMPLE_BRIEFS } from "@/components/stylist/example-briefs";
import { ThreadList, ThreadListSkeleton } from "@/components/stylist/thread-list";
import { StylistWardrobeStrip } from "@/components/stylist/stylist-wardrobe-strip";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_THREAD_TITLE, useStylistThreads } from "@/hooks/use-stylist";
import { reportError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { api } from "@convex/_generated/api";

const STARTERS = [
  { label: "A wedding to dress for", detail: "Find the right balance of dressy and you.", brief: EXAMPLE_BRIEFS[0] },
  { label: "Something for dinner", detail: "A little considered. Still comfortable.", brief: EXAMPLE_BRIEFS[1] },
  { label: "The working week", detail: "Fresh combinations for the days ahead.", brief: EXAMPLE_BRIEFS[2] },
] as const;

export function StylistThreads() {
  const router = useRouter();
  const { threads } = useStylistThreads();
  const create = useMutation(api.threads.create);
  const remove = useMutation(api.threads.remove);
  const [brief, setBrief] = useState("");
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /** A brief passed here is handed to the new thread through the URL so the chat sends it on mount. */
  async function startChat(value: string) {
    const message = value.trim();
    if (!message || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      const threadId = await create({ title: DEFAULT_THREAD_TITLE });
      router.push(`${routes.thread(threadId)}?brief=${encodeURIComponent(message)}`);
    } catch (error) {
      reportError(error, "Could not start a new chat.");
      startingRef.current = false;
      setStarting(false);
    }
  }

  return (
    <div className="grid gap-x-16 gap-y-10 lg:grid-cols-[0.95fr_1.05fr] xl:gap-x-24">
      <div className="space-y-8 lg:col-start-1 lg:row-start-1">
        <PageHeader
          eyebrow="The styling room"
          title={
            <span className="block text-[clamp(2.5rem,5vw,4.75rem)] leading-[0.98] font-medium tracking-[-0.065em]">
              Your wardrobe.
              <br />A fresh eye.
            </span>
          }
          description="A personal AI stylist for the clothes you own. Bring an occasion, a mood, or a piece you want to wear."
        />
        <StylistWardrobeStrip />
      </div>

      <div className="space-y-10 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:pt-1">
        <form
          noValidate
          className="border-t border-foreground pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            void startChat(brief);
          }}
        >
          <div className="mb-6 flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
              A new conversation
            </span>
            <span className="text-[11px] text-muted-foreground">Outfit ideas are always free</span>
          </div>
          <Field className="gap-3">
            <FieldLabel htmlFor="stylist-brief" className="text-xl font-medium tracking-tight">
              What are you dressing for?
            </FieldLabel>
            <Textarea
              ref={inputRef}
              id="stylist-brief"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Dinner tonight. Relaxed, but a little dressed up…"
              rows={4}
              disabled={starting}
              className="max-h-72 min-h-40 resize-none rounded-none border-0 border-b bg-transparent px-0 py-3 text-lg leading-relaxed shadow-none placeholder:text-muted-foreground/70 focus-visible:border-foreground focus-visible:ring-0 md:text-xl dark:bg-transparent"
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-4 pt-5">
            <p className="max-w-48 text-[11px] leading-relaxed text-muted-foreground">
              Try-ons use credits.
              <br />
              You always approve the cost first.
            </p>
            <Button
              type="submit"
              disabled={starting || brief.trim().length === 0}
              className="h-12 min-w-40 cursor-pointer rounded-none px-5"
            >
              {starting ? <Spinner data-icon="inline-start" /> : null}
              {starting ? "Starting chat…" : "Ask stylist"}
              {!starting ? <ArrowUpRight data-icon="inline-end" /> : null}
            </Button>
          </div>
        </form>
        {threads === undefined || threads.length > 0 ? (
          <section aria-labelledby="recent-chats-title">
            <h2
              id="recent-chats-title"
              className="mb-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase"
            >
              Your conversations
            </h2>
            {threads === undefined ? (
              <ThreadListSkeleton />
            ) : (
              <ThreadList threads={threads} onDelete={(threadId) => remove({ threadId })} />
            )}
          </section>
        ) : null}
      </div>

      <section className="lg:col-start-1 lg:row-start-2" aria-labelledby="stylist-starters-title">
        <h2
          id="stylist-starters-title"
          className="mb-4 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase"
        >
          Somewhere to start
        </h2>
        <div className="divide-y border-y">
          {STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              disabled={starting}
              className="group flex w-full cursor-pointer items-center justify-between gap-4 py-4 text-left transition-colors hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
              onClick={() => {
                setBrief(starter.brief);
                inputRef.current?.focus();
              }}
            >
              <span>
                <span className="block text-sm font-medium">{starter.label}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{starter.detail}</span>
              </span>
              <ArrowRight
                className="size-4 shrink-0 transition-transform group-hover:translate-x-1 motion-reduce:transform-none"
                aria-hidden
              />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
