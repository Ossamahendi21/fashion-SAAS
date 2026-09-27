"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { ArrowLeft, ArrowUpRight, History, PanelRightClose, Plus, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";
import { ErrorAlert } from "@/components/common/error-alert";
import { Composer } from "@/components/stylist/composer";
import { StylistChat } from "@/components/stylist/stylist-chat";
import { useStylistPanel } from "@/components/stylist/stylist-provider";
import { ThreadListSkeleton } from "@/components/stylist/thread-list";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_THREAD_TITLE, useStylistThreads } from "@/hooks/use-stylist";
import { useStylistPageContext } from "@/hooks/use-stylist-page-context";
import { reportError } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { StylistPageContext } from "@/lib/stylist-context";
import { api } from "@convex/_generated/api";

const DESKTOP_QUERY = "(min-width: 1280px)";
function subscribeViewport(listener: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
const desktopSnapshot = () => window.matchMedia(DESKTOP_QUERY).matches;
const serverSnapshot = () => false;

export function StylistPanel() {
  const { open, selectedThreadId, contextOverride, setOpen, openThread } = useStylistPanel();
  const isDesktop = useSyncExternalStore(subscribeViewport, desktopSnapshot, serverSnapshot);
  const pathname = usePathname();
  const { isAuthenticated } = useConvexAuth();
  const { threads } = useStylistThreads();
  const thread = useQuery(
    api.threads.get,
    isAuthenticated && selectedThreadId ? { threadId: selectedThreadId } : "skip",
  );
  const create = useMutation(api.threads.create);
  const { context: pageContext, isLoading: contextLoading } = useStylistPageContext({ enabled: open });
  const [includeContext, setIncludeContext] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [initial, setInitial] = useState<{
    threadId: string;
    brief: string;
    context: StylistPageContext | null;
  } | null>(null);
  const starting = useRef(false);
  const activeOverride = contextOverride?.path === pathname ? contextOverride : null;
  const effectiveContext = activeOverride ?? pageContext;
  const waitForContext = includeContext && contextLoading && !activeOverride;
  // Only one useEveAgent instance may own a given session across the panel and its standalone route.
  const pageOwnsThread = selectedThreadId !== null && pathname === routes.thread(selectedThreadId) && !open;

  async function startChat(brief: string) {
    if (starting.current || waitForContext) return;
    starting.current = true;
    try {
      const id = await create({ title: DEFAULT_THREAD_TITLE });
      setInitial({ threadId: id, brief, context: includeContext ? effectiveContext : null });
      setShowHistory(false);
      openThread(id);
    } catch (error) {
      reportError(error, "Could not start your conversation.");
      throw error;
    } finally {
      starting.current = false;
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={!isDesktop} disablePointerDismissal>
      <Dialog.Portal keepMounted>
        {!isDesktop ? <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 data-closed:hidden" /> : null}
        <Dialog.Popup
          id="stylist-panel"
          inert={!open}
          aria-hidden={!open}
          initialFocus={isDesktop ? false : true}
          className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-foreground/15 bg-background shadow-[-12px_0_40px_-24px_rgba(0,0,0,0.2)] transition-transform duration-200 outline-none data-ending-style:translate-x-full data-starting-style:translate-x-full motion-reduce:transition-none xl:top-[72px] xl:w-[440px] data-closed:pointer-events-none data-closed:invisible"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-4">
            <div>
              <p className="font-mono text-[9px] tracking-[0.18em] text-muted-foreground uppercase">The styling room</p>
              <Dialog.Title className="mt-1 text-xl font-medium tracking-tight">Your stylist.</Dialog.Title>
              <Dialog.Description className="sr-only">
                Ask about your wardrobe and the page you are viewing.
              </Dialog.Description>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Recent conversations"
                title="Recent conversations"
                onClick={() => setShowHistory((value) => !value)}
              >
                <History />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="New conversation"
                title="New conversation"
                onClick={() => {
                  setInitial(null);
                  setShowHistory(false);
                  openThread();
                }}
              >
                <Plus />
              </Button>
              <Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close stylist" />}>
                <PanelRightClose />
              </Dialog.Close>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-5 py-2.5">
            {includeContext ? (
              <>
                <span
                  className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                  title={effectiveContext?.description}
                >
                  {contextLoading && !effectiveContext
                    ? "Reading this page…"
                    : `Context: ${effectiveContext?.label ?? "This page"}`}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Exclude page context"
                  title="Exclude page context"
                  onClick={() => setIncludeContext(false)}
                >
                  <X />
                </Button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setIncludeContext(true)}
                className="cursor-pointer text-[11px] text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Page context off · Include this page
              </button>
            )}
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className={showHistory ? "hidden" : "flex min-h-0 flex-1 flex-col"} inert={showHistory}>
              {selectedThreadId ? (
                pageOwnsThread ? null : thread === undefined ? (
                  <div className="space-y-4 p-5" aria-busy="true" aria-label="Loading conversation">
                    <Skeleton className="h-12 w-4/5" />
                    <Skeleton className="h-28 w-full" />
                  </div>
                ) : thread === null ? (
                  <div className="p-5">
                    <ErrorAlert
                      title="Conversation unavailable"
                      message="This conversation was deleted or is not available to your account."
                    />
                    <Button className="mt-5 rounded-none" onClick={() => openThread()}>
                      Start a new conversation
                    </Button>
                  </div>
                ) : (
                  <StylistChat
                    key={thread._id}
                    thread={thread}
                    embedded
                    pageContext={
                      initial?.threadId === thread._id ? initial.context : includeContext ? effectiveContext : null
                    }
                    contextLoading={initial?.threadId === thread._id ? false : waitForContext}
                    initialBrief={initial?.threadId === thread._id ? initial.brief : undefined}
                    onInitialBriefConsumed={() => setInitial(null)}
                    onNewChat={() => {
                      setInitial(null);
                      setShowHistory(false);
                      openThread();
                    }}
                  />
                )
              ) : (
                <div className="flex min-h-0 flex-1 flex-col px-5">
                  <div className="min-h-0 flex-1 overflow-y-auto py-7">
                    <h2 className="max-w-72 text-3xl leading-tight font-medium tracking-[-0.05em]">
                      A fresh eye on
                      <br />
                      what you already own.
                    </h2>
                    <p className="mt-4 max-w-72 text-sm leading-relaxed text-muted-foreground">
                      Ask what to wear, refine a look, or style the piece you’re viewing.
                    </p>
                    <p className="mt-7 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
                      Your page context is shown above. Turn it off whenever you prefer. Try-ons always ask for your
                      approval.
                    </p>
                  </div>
                  <Composer
                    onSend={startChat}
                    onCancel={async () => {}}
                    isBusy={false}
                    isResuming={false}
                    blocked={waitForContext}
                    placeholder={waitForContext ? "Reading this page…" : "What would you like to wear?"}
                  />
                </div>
              )}
            </div>

            {showHistory ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-5 rounded-none px-0"
                  onClick={() => setShowHistory(false)}
                >
                  <ArrowLeft data-icon="inline-start" />
                  Back to conversation
                </Button>
                <h2 className="mb-4 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                  Your conversations
                </h2>
                {threads === undefined ? (
                  <ThreadListSkeleton />
                ) : threads.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Your conversations will appear here after you ask the stylist.
                  </p>
                ) : (
                  <ul className="divide-y border-t">
                    {threads.map((entry) => (
                      <li key={entry._id}>
                        <button
                          type="button"
                          onClick={() => {
                            setShowHistory(false);
                            openThread(entry._id);
                          }}
                          className="flex w-full cursor-pointer items-center justify-between gap-3 py-4 text-left hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{entry.title}</span>
                            <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                              {formatRelative(entry.lastMessageAt)}
                            </span>
                          </span>
                          <ArrowUpRight className="size-4 shrink-0" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
