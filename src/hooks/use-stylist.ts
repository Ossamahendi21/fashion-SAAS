"use client";

import { useAuth } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Client } from "eve/client";
import { useEveAgent, type EveMessageData, type EveMessageInputRequest, type UseEveAgentHelpers } from "eve/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { reportError } from "@/lib/errors";
import { isMissingStylistSession } from "@/lib/stylist-session-error";

export type StylistThread = FunctionReturnType<typeof api.threads.list>[number];
export type ThreadProposal = FunctionReturnType<typeof api.threads.proposals>[number];

/** Threads start with this title; the first message replaces it. */
export const DEFAULT_THREAD_TITLE = "New chat";

/** How long to wait before persisting a stream-cursor move, so one turn is not one write per event. */
const CURSOR_WRITE_DELAY_MS = 2_000;

export type PendingRequest = {
  requestId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  request: EveMessageInputRequest;
};

export function useStylistThreads(): { threads: StylistThread[] | undefined; isLoading: boolean } {
  const { isAuthenticated } = useConvexAuth();
  const threads = useQuery(api.threads.list, isAuthenticated ? {} : "skip");
  return { threads, isLoading: threads === undefined };
}

export type StylistSession = UseEveAgentHelpers<EveMessageData> & {
  /** Approval and `ask_question` prompts still waiting on the user, oldest first. */
  pendingRequests: PendingRequest[];
  isBusy: boolean;
  isResuming: boolean;
  isUnavailable: boolean;
};

/**
 * One durable eve session per Convex thread.
 *
 * `initialSession`, `resume` and `headers` are read once when the hook builds its store, so the
 * thread must already be loaded and the component keyed by thread id before this is called.
 */
export function useStylistSession(thread: StylistThread): StylistSession {
  const { getToken } = useAuth();
  const linkSession = useMutation(api.threads.linkSession);

  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const headers = useMemo(
    () => async (): Promise<Record<string, string>> => {
      const token = await getTokenRef.current();
      if (!token) throw new Error("Sign in again to continue this conversation.");
      return { authorization: `Bearer ${token}`, "x-fitcheck-thread-id": thread._id };
    },
    [thread._id],
  );

  const [initialSession] = useState(() =>
    thread.eveSessionId ? { sessionId: thread.eveSessionId, streamIndex: thread.streamIndex ?? 0 } : undefined,
  );
  // eslint-disable-next-line react-hooks/refs -- Client.sessions.attach performs no I/O; headers reads the token ref only when a request starts.
  const [restoredSession] = useState(() => {
    if (!initialSession) return undefined;
    const session = new Client({ host: "", headers }).sessions.attach(initialSession.sessionId, {
      streamIndex: initialSession.streamIndex,
    });
    const stream = session.stream.bind(session);
    // A persisted session already exists or is unavailable; Eve's 404 creation-race retries do not apply.
    session.stream = (options) =>
      stream({
        ...options,
        streamReconnectPolicy: options?.streamReconnectPolicy ?? {
          retryableErrorStatuses: [409, 425, 500, 502, 503, 504],
        },
      });
    return session;
  });

  const persisted = useRef<{ sessionId: string; streamIndex: number } | null>(initialSession ?? null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unavailable = useRef(false);

  const writeCursor = useCallback(
    (session: { sessionId: string; streamIndex: number }) => {
      if (unavailable.current) return;
      persisted.current = session;
      void linkSession({
        threadId: thread._id,
        eveSessionId: session.sessionId,
        streamIndex: session.streamIndex,
      }).catch((error: unknown) => reportError(error, "Could not save this conversation."));
    },
    [linkSession, thread._id],
  );

  const onSessionChange = useCallback(
    (session: { sessionId: string; streamIndex: number } | undefined) => {
      if (!session || unavailable.current) return;
      if (timer.current) clearTimeout(timer.current);

      // A brand-new session id has to land immediately: a reload before the first turn finishes
      // needs it to resume. Cursor moves within a known session can wait.
      if (persisted.current?.sessionId !== session.sessionId) {
        writeCursor(session);
        return;
      }
      if (persisted.current.streamIndex === session.streamIndex) return;
      timer.current = setTimeout(() => writeCursor(session), CURSOR_WRITE_DELAY_MS);
    },
    [writeCursor],
  );

  const agent = useEveAgent({
    headers,
    initialSession,
    session: restoredSession,
    resume: initialSession !== undefined,
    onSessionChange,
    onFinish: (snapshot) => {
      if (timer.current) clearTimeout(timer.current);
      if (snapshot.session) writeCursor(snapshot.session);
    },
    onError: (error) => {
      if (initialSession && isMissingStylistSession(error)) {
        // Eve emits cursor/finish callbacks after a failed replay; retain the historical cursor.
        unavailable.current = true;
        if (timer.current) clearTimeout(timer.current);
        return;
      }
      reportError(error, "The stylist could not finish that.");
    },
  });

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const pendingRequests = useMemo(() => collectPendingRequests(agent.data.messages), [agent.data.messages]);

  return {
    ...agent,
    pendingRequests,
    isBusy: agent.status === "submitted" || agent.status === "streaming",
    isResuming: agent.status === "resuming",
    isUnavailable: initialSession !== undefined && agent.status === "error" && isMissingStylistSession(agent.error),
  };
}

/**
 * Approvals and `ask_question` both ride on a `dynamic-tool` part in `approval-requested` state.
 * Scan every message: an unrelated turn can add newer ones while a prompt stays open.
 */
export function collectPendingRequests(messages: EveMessageData["messages"]): PendingRequest[] {
  const pending: PendingRequest[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || part.state !== "approval-requested") continue;
      const request = part.toolMetadata?.eve?.inputRequest;
      if (!request) continue;
      pending.push({
        requestId: request.requestId,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        request,
      });
    }
  }
  return pending;
}

export function useThreadProposals(threadId: Id<"threads">): ThreadProposal[] | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.threads.proposals, isAuthenticated ? { threadId } : "skip");
}
