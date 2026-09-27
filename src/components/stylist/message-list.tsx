"use client";

import type { EveMessage, EveMessagePart } from "eve/react";
import { ApprovalCard } from "@/components/stylist/approval-card";
import { MarkdownLite } from "@/components/stylist/markdown-lite";
import { ProposalCards } from "@/components/stylist/proposal-cards";
import { QuestionCard } from "@/components/stylist/question-card";
import { RenderFollowup } from "@/components/stylist/render-followup";
import { RenderJobCard } from "@/components/stylist/render-job-card";
import { projectRenderFollowups, readRenderJobId, type TranscriptPart } from "@/components/stylist/render-transcript";
import { ToolActivity } from "@/components/stylist/tool-activity";
import { groupActivityParts, isActiveActivityMessage } from "@/components/stylist/tool-activity-state";
import { Button } from "@/components/ui/button";
import type { PendingRequest } from "@/hooks/use-stylist";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";

type DynamicToolPart = Extract<EveMessagePart, { type: "dynamic-tool" }>;

type MessageListProps = {
  messages: readonly EveMessage[];
  threadId: Id<"threads">;
  onRespond: (response: { requestId: string; optionId?: string; text?: string }) => Promise<void>;
  onRetryMessage: (message: string) => Promise<void>;
  isBusy: boolean;
  isStreaming?: boolean;
};

export function MessageList({
  messages,
  threadId,
  onRespond,
  onRetryMessage,
  isBusy,
  isStreaming = isBusy,
}: MessageListProps) {
  return (
    <div className="@container min-w-0 space-y-7 [overflow-wrap:anywhere]">
      {projectRenderFollowups(messages).map(({ message, parts }, index) =>
        message.role === "user" ? (
          <UserMessage key={message.id} message={message} onRetry={onRetryMessage} disabled={isBusy} />
        ) : (
          <AssistantMessage
            key={message.id}
            message={message}
            projectedParts={parts}
            threadId={threadId}
            onRespond={onRespond}
            onRetry={onRetryMessage}
            isBusy={isBusy}
            active={isActiveActivityMessage(messages, index, isStreaming)}
          />
        ),
      )}
    </div>
  );
}

function UserMessage({
  message,
  onRetry,
  disabled,
}: {
  message: EveMessage;
  onRetry: (message: string) => Promise<void>;
  disabled: boolean;
}) {
  const text = message.parts
    .filter((part): part is Extract<EveMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text.length === 0) return null;

  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[90%] border-l-2 border-foreground bg-muted/45 px-4 py-3 text-sm leading-relaxed sm:max-w-[80%]",
          message.metadata?.status === "failed" && "bg-destructive/15 text-destructive",
        )}
      >
        <MarkdownLite text={text} className="space-y-1.5" />
        {message.metadata?.status === "failed" ? (
          <div className="mt-3 border-t border-destructive/20 pt-3">
            <p className="text-xs" role="alert">
              Message delivery wasn’t confirmed.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 min-h-11 rounded-none"
              disabled={disabled}
              onClick={() => void onRetry(text).catch(() => {})}
            >
              Retry message
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  projectedParts,
  threadId,
  onRespond,
  onRetry,
  isBusy,
  active,
}: {
  message: EveMessage;
  projectedParts: TranscriptPart[];
  threadId: Id<"threads">;
  onRespond: MessageListProps["onRespond"];
  onRetry: MessageListProps["onRetryMessage"];
  isBusy: boolean;
  active: boolean;
}) {
  const parts = groupActivityParts(projectedParts);
  if (parts.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="font-mono text-[9px] tracking-[0.2em] text-muted-foreground uppercase">Fitcheck / Stylist</p>
      <div className="min-w-0 space-y-4 text-sm leading-relaxed">
        {parts.map((segment) =>
          segment.kind === "activity" ? (
            <ToolActivity
              key={`${message.id}-${segment.key}`}
              tools={segment.tools}
              active={active}
              disabled={isBusy}
              onRetry={onRetry}
            />
          ) : segment.value.renderJobIds ? (
            <RenderFollowup key={`${message.id}-${segment.key}`} jobIds={segment.value.renderJobIds} />
          ) : (
            <PartView
              key={`${message.id}-${segment.key}`}
              part={segment.value.part}
              threadId={threadId}
              onRespond={onRespond}
              onRetry={onRetry}
              isBusy={isBusy}
              active={active}
            />
          ),
        )}
      </div>
    </div>
  );
}

function PartView({
  part,
  threadId,
  onRespond,
  onRetry,
  isBusy,
  active,
}: {
  part: EveMessagePart;
  threadId: Id<"threads">;
  onRespond: MessageListProps["onRespond"];
  onRetry: MessageListProps["onRetryMessage"];
  isBusy: boolean;
  active: boolean;
}) {
  if (part.type === "text") {
    return part.text.trim().length > 0 ? <MarkdownLite text={part.text} /> : null;
  }

  if (part.type === "authorization") {
    return (
      <p className="rounded-lg border bg-muted/40 p-3 text-sm">
        {part.state === "completed"
          ? `${part.displayName} authorization ${part.outcome}.`
          : (part.description ?? `${part.displayName} needs to be connected.`)}
        {part.state === "required" && part.authorization?.url ? (
          <a
            className="ml-1 underline underline-offset-2"
            href={part.authorization.url}
            rel="noreferrer"
            target="_blank"
          >
            Sign in
          </a>
        ) : null}
      </p>
    );
  }

  if (part.type !== "dynamic-tool") return null;
  return (
    <ToolPart part={part} threadId={threadId} onRespond={onRespond} onRetry={onRetry} isBusy={isBusy} active={active} />
  );
}

function ToolPart({
  part,
  threadId,
  onRespond,
  onRetry,
  isBusy,
  active,
}: {
  part: DynamicToolPart;
  threadId: Id<"threads">;
  onRespond: MessageListProps["onRespond"];
  onRetry: MessageListProps["onRetryMessage"];
  isBusy: boolean;
  active: boolean;
}) {
  if (part.state === "approval-requested") {
    const request = part.toolMetadata?.eve?.inputRequest;
    if (!request) return null;
    const pending: PendingRequest = {
      requestId: request.requestId,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
      request,
    };
    return request.kind === "question" ? (
      <QuestionCard pending={pending} onRespond={onRespond} disabled={isBusy} />
    ) : (
      <ApprovalCard pending={pending} onRespond={onRespond} disabled={isBusy} />
    );
  }

  if (part.state !== "output-available" || part.partial)
    return <ToolActivity tools={[part]} active={active} disabled={isBusy} onRetry={onRetry} />;

  // output-available
  if (part.toolName === "compose_outfits") {
    const { outfitIds, problems } = readComposeOutput(part.output);
    return <ProposalCards threadId={threadId} outfitIds={outfitIds} problems={problems} />;
  }

  if (part.toolName === "start_renders") {
    const jobId = readRenderJobId(part.output);
    return jobId ? <RenderJobCard jobId={jobId} /> : null;
  }

  return <ToolActivity tools={[part]} active={active} disabled={isBusy} onRetry={onRetry} />;
}

type ComposeResult = { outfitId: string | null; name: string; problems: string[] };

function readComposeOutput(output: unknown): {
  outfitIds: Id<"outfits">[];
  problems: { name: string; problems: string[] }[];
} {
  const results = (output as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return { outfitIds: [], problems: [] };

  const outfitIds: Id<"outfits">[] = [];
  const problems: { name: string; problems: string[] }[] = [];
  for (const entry of results as ComposeResult[]) {
    if (typeof entry?.outfitId === "string") outfitIds.push(entry.outfitId as Id<"outfits">);
    else if (Array.isArray(entry?.problems) && entry.problems.length > 0) {
      problems.push({ name: entry.name ?? "That outfit", problems: entry.problems });
    }
  }
  return { outfitIds, problems };
}
