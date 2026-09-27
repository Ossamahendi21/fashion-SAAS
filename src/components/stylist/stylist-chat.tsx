"use client";

import { useMutation } from "convex/react";
import { ArrowDown, ArrowLeft, History, Plus, ShieldQuestionMark } from "lucide-react";
import { useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorAlert } from "@/components/common/error-alert";
import { PageHeader } from "@/components/common/page-header";
import { Composer } from "@/components/stylist/composer";
import { EXAMPLE_BRIEFS } from "@/components/stylist/example-briefs";
import { MessageList } from "@/components/stylist/message-list";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { DEFAULT_THREAD_TITLE, useStylistSession, type StylistThread } from "@/hooks/use-stylist";
import { useInitialStylistBrief } from "@/hooks/use-initial-stylist-brief";
import { reportError } from "@/lib/errors";
import { toStylistClientContext, type StylistPageContext } from "@/lib/stylist-context";
import { cn } from "@/lib/utils";
import { routes } from "@/lib/routes";
import { api } from "@convex/_generated/api";

type StylistChatProps = {
  thread: StylistThread;
  /** A brief carried over from the "New chat" buttons; sent once, then dropped from the URL. */
  initialBrief?: string;
  embedded?: boolean;
  pageContext?: StylistPageContext | null;
  contextLoading?: boolean;
  onInitialBriefConsumed?: () => void;
  onNewChat?: () => void;
};

/** Mount this keyed by thread id: the eve session is bound when the hook builds its store. */
export function StylistChat({
  thread,
  initialBrief,
  embedded = false,
  pageContext,
  contextLoading = false,
  onInitialBriefConsumed,
  onNewChat,
}: StylistChatProps) {
  const session = useStylistSession(thread);
  const rename = useMutation(api.threads.rename);
  const create = useMutation(api.threads.create);
  const [starting, setStarting] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);
  const startingRef = useRef(false);
  const reduceMotion = useReducedMotion();
  const router = useRouter();

  const named = useRef(thread.title !== DEFAULT_THREAD_TITLE);
  const transcript = useRef<HTMLDivElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const messages = session.data.messages;
  const messageCount = messages.length;
  const tailLength =
    messages.at(-1)?.parts.reduce((length, part) => length + (part.type === "text" ? part.text.length : 1), 0) ?? 0;

  useEffect(() => {
    const viewport = scrollArea.current;
    const content = transcript.current;
    if (!viewport || !content) return;
    const follow = () => {
      if (following.current) viewport.scrollTop = viewport.scrollHeight;
    };
    // Follow streamed text, loaded images and viewport changes without moving a reader away from older messages.
    const observer = new ResizeObserver(follow);
    observer.observe(viewport);
    observer.observe(content);
    follow();
    return () => observer.disconnect();
  }, []);

  function jumpToLatest() {
    following.current = true;
    setIsFollowing(true);
    const viewport = scrollArea.current;
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }

  const {
    send: sendTurn,
    respond: respondToRequest,
    cancel: cancelTurn,
    isBusy,
    isResuming,
    isUnavailable,
    status,
  } = session;

  const send = useCallback(
    async (message: string) => {
      if (isUnavailable) return;
      if (!named.current) {
        named.current = true;
        void rename({ threadId: thread._id, title: titleFromBrief(message) }).catch(() => {
          named.current = false;
        });
      }
      try {
        // The composer and the example chips are disabled while a turn is running, so this is
        // always a fresh turn; there is no steer path to keep alive.
        following.current = true;
        setIsFollowing(true);
        await sendTurn(message, { clientContext: toStylistClientContext(pageContext) });
      } catch (error) {
        reportError(error, "That message could not be sent.");
        throw error;
      }
    },
    [rename, sendTurn, thread._id, pageContext, isUnavailable],
  );

  const respond = useCallback(
    async (response: { requestId: string; optionId?: string; text?: string }) => {
      if (isUnavailable) return;
      await respondToRequest([response], { clientContext: toStylistClientContext(pageContext) });
    },
    [respondToRequest, pageContext, isUnavailable],
  );

  const cancel = useCallback(async () => {
    try {
      await cancelTurn();
    } catch (error) {
      reportError(error, "Could not stop that.");
    }
  }, [cancelTurn]);

  const consumeInitialBrief = useCallback(() => {
    if (!embedded) router.replace(routes.thread(thread._id));
    onInitialBriefConsumed?.();
  }, [embedded, onInitialBriefConsumed, router, thread._id]);
  useInitialStylistBrief({
    brief: initialBrief,
    isBusy: isBusy || isUnavailable,
    isResuming,
    messageCount,
    contextLoading,
    onSend: send,
    onConsume: consumeInitialBrief,
  });

  async function startNewChat() {
    if (startingRef.current) return;
    if (onNewChat) {
      onNewChat();
      return;
    }
    startingRef.current = true;
    setStarting(true);
    try {
      const threadId = await create({ title: DEFAULT_THREAD_TITLE });
      router.push(routes.thread(threadId));
    } catch (error) {
      reportError(error, "Could not start a new chat.");
      startingRef.current = false;
      setStarting(false);
    }
  }

  const isEmpty = messageCount === 0 && !isResuming && !initialBrief && !isUnavailable;
  const showThinking =
    !isUnavailable &&
    !isResuming &&
    (status === "submitted" || (isBusy && tailLength === 0) || (initialBrief !== undefined && messageCount === 0));

  return (
    <div
      className={cn(
        "flex min-h-0 w-full flex-1 flex-col",
        embedded ? "" : "mx-auto h-[calc(100dvh-var(--app-header-height)-var(--app-content-padding))] max-w-3xl gap-4",
      )}
    >
      {!embedded ? (
        <div className="shrink-0">
          <PageHeader
            className="gap-3 [&_h1]:line-clamp-2 [&_h1]:text-2xl sm:[&_h1]:text-3xl"
            eyebrow="The styling room / Conversation"
            title={thread.title}
            actions={
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 rounded-none"
                nativeButton={false}
                render={<Link href={routes.stylist} />}
              >
                <ArrowLeft data-icon="inline-start" />
                All chats
              </Button>
            }
          />
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollArea}
          onScroll={(event) => {
            const node = event.currentTarget;
            const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
            following.current = nearBottom;
            setIsFollowing(nearBottom);
          }}
          className={cn(
            "h-full [scrollbar-gutter:stable] overflow-y-auto overscroll-contain",
            embedded ? "px-4 sm:px-5" : "pr-2",
          )}
          role="region"
          aria-label="Conversation"
          tabIndex={0}
        >
          <div ref={transcript} className="space-y-6 py-4">
            {isResuming && messageCount === 0 ? <ResumingShimmer /> : null}

            {isResuming && messageCount > 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Spinner className="size-3.5" />
                Catching up on this conversation…
              </p>
            ) : null}

            {isEmpty ? (
              <EmptyThread onPick={(brief) => void send(brief).catch(() => {})} />
            ) : (
              <MessageList
                messages={messages}
                threadId={thread._id}
                onRespond={respond}
                onRetryMessage={send}
                isBusy={isBusy || isResuming || contextLoading || isUnavailable}
                isStreaming={isBusy || isResuming}
              />
            )}

            {showThinking ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Spinner className="size-3.5" />
                Thinking…
              </p>
            ) : null}

            {isUnavailable ? (
              <Alert className="rounded-none p-5">
                <History aria-hidden />
                <AlertTitle>Chat history unavailable</AlertTitle>
                <AlertDescription className="space-y-4">
                  <p>
                    The stylist could not find this conversation’s history. Start a new chat to continue. Your saved
                    outfits and renders are unchanged.
                  </p>
                  <Button className="rounded-none" disabled={starting} onClick={() => void startNewChat()}>
                    {starting ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                    {starting ? "Starting chat…" : "Start new chat"}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : status === "error" && session.error ? (
              <ErrorAlert title="The stylist stopped" message={session.error.message} />
            ) : null}

            {!isUnavailable && session.pendingRequests.length > 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <ShieldQuestionMark className="size-3.5 shrink-0" aria-hidden />
                Waiting on your answer above.
              </p>
            ) : null}
          </div>
        </div>
        {!isFollowing && messageCount > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            className="absolute bottom-3 left-1/2 min-h-11 -translate-x-1/2 border shadow-sm"
            onClick={jumpToLatest}
          >
            <ArrowDown aria-hidden /> Latest message
          </Button>
        ) : null}
      </div>

      {!isUnavailable ? (
        <div className={embedded ? "shrink-0 px-4 sm:px-5" : "shrink-0"}>
          <Composer
            onSend={send}
            onCancel={cancel}
            isBusy={isBusy}
            isResuming={isResuming}
            blocked={contextLoading}
            placeholder={contextLoading ? "Reading this page…" : undefined}
          />
        </div>
      ) : null}
    </div>
  );
}

function EmptyThread({ onPick }: { onPick: (brief: string) => void }) {
  return (
    <div className="space-y-6 border-y py-8">
      <div className="space-y-1">
        <h2 className="text-2xl font-medium tracking-tight">Let’s find your next look.</h2>
        <p className="text-sm text-pretty text-muted-foreground">
          Give me the occasion, the weather or the mood. I only use clothes that are already in your wardrobe, and
          I&apos;ll always tell you what a render costs before anything is spent.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {EXAMPLE_BRIEFS.map((brief) => (
          <Button
            key={brief}
            variant="outline"
            size="sm"
            className="h-auto max-w-full rounded-none py-2 text-left whitespace-normal"
            onClick={() => onPick(brief)}
          >
            {brief}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ResumingShimmer() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Catching up on this conversation">
      <Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" />
      <Skeleton className="h-16 w-4/5 rounded-2xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}

/** First line of the brief, trimmed to something that fits a sidebar row. */
function titleFromBrief(message: string): string {
  const line = message.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
}
