"use client";

import { CircleStop, CornerDownLeft, Send } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { shouldSubmitComposer } from "./composer-keyboard";

type ComposerProps = {
  onSend: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
  isBusy: boolean;
  isResuming: boolean;
  placeholder?: string;
  blocked?: boolean;
};

export function Composer({ onSend, onCancel, isBusy, isResuming, placeholder, blocked = false }: ComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const [cancelFailed, setCancelFailed] = useState(false);
  const submitting = useRef(false);
  const hintId = useId();
  const disabled = isBusy || isResuming || sending || blocked;

  async function submit(previousMessage?: string) {
    const message = (previousMessage ?? value).trim();
    if (message.length === 0 || disabled || submitting.current) return;
    submitting.current = true;
    if (previousMessage === undefined) setValue("");
    setFailedMessage(null);
    setCancelFailed(false);
    setSending(true);
    try {
      await onSend(message);
      if (previousMessage !== undefined) setValue((draft) => (draft === previousMessage ? "" : draft));
    } catch {
      // Preserve a new draft written while the previous response was running.
      if (previousMessage === undefined) setValue((draft) => draft || message);
      setFailedMessage(message);
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      !shouldSubmitComposer(
        { ...event, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode },
        window.matchMedia("(pointer: coarse)").matches,
      )
    )
      return;
    event.preventDefault();
    void submit();
  }

  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    setCancelFailed(false);
    try {
      await onCancel();
    } catch {
      setCancelFailed(true);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="shrink-0 border-t border-foreground bg-background pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          rows={1}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={isResuming || blocked}
          placeholder={
            isResuming
              ? "Catching up on this conversation…"
              : isBusy
                ? "Write your next message…"
                : (placeholder ?? "Ask me what to wear…")
          }
          aria-label="Message the stylist"
          aria-describedby={hintId}
          enterKeyHint="enter"
          className="max-h-[min(10rem,25dvh)] min-h-12 resize-none overscroll-contain rounded-none border-0 bg-transparent px-0 py-3 text-base shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
        />
        {isBusy ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-12 rounded-none"
            onClick={() => void cancel()}
            disabled={cancelling}
            aria-label={cancelling ? "Stopping response" : "Stop response"}
          >
            {cancelling ? <Spinner /> : <CircleStop />}
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            className="size-12 rounded-none"
            onPointerDown={(event) => {
              if (event.pointerType === "mouse") event.preventDefault();
            }}
            disabled={disabled || value.trim().length === 0}
            aria-label="Send message"
          >
            {sending ? <Spinner /> : <Send />}
          </Button>
        )}
      </div>
      {failedMessage ? (
        <div className="mt-1 text-xs text-destructive">
          <p role="alert">Message delivery wasn’t confirmed. Your draft is safe.</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 rounded-none px-0 text-xs"
            disabled={disabled}
            onClick={() => void submit(failedMessage)}
          >
            Retry message
          </Button>
        </div>
      ) : null}
      {cancelFailed ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          Couldn’t stop the response. Please try again.
        </p>
      ) : null}
      <div id={hintId} className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        {isBusy ? (
          <p role="status">{cancelling ? "Stopping…" : "Stylist is working. You can draft your next message."}</p>
        ) : (
          <>
            <p className="flex items-center gap-1 [@media(pointer:coarse)]:hidden">
              <Kbd>
                <CornerDownLeft className="size-3" aria-hidden /> Enter
              </Kbd>{" "}
              to send, <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> for a new line
            </p>
            <p className="hidden [@media(pointer:coarse)]:block">Return for a new line · Tap the arrow to send</p>
          </>
        )}
      </div>
    </form>
  );
}
