"use client";

import { MessageCircleQuestionMark, Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { PendingRequest } from "@/hooks/use-stylist";
import { reportError } from "@/lib/errors";

type QuestionCardProps = {
  pending: PendingRequest;
  onRespond: (response: { requestId: string; optionId?: string; text?: string }) => Promise<void>;
  disabled?: boolean;
};

/** `ask_question` — options become buttons, and free text gets an input when the model allowed it. */
export function QuestionCard({ pending, onRespond, disabled }: QuestionCardProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [text, setText] = useState("");
  const options = pending.request.options ?? [];

  async function answer(key: string, response: { optionId?: string; text?: string }) {
    setBusy(key);
    try {
      await onRespond({ requestId: pending.requestId, ...response });
      setText("");
    } catch (error) {
      reportError(error, "Could not send that answer.");
    } finally {
      setBusy(null);
    }
  }

  function submitFreeform(event: FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    void answer("freeform", { text: trimmed });
  }

  return (
    <section className="space-y-4 border-l border-foreground/30 py-2 pl-5" aria-label="Question from the stylist">
      <div className="flex items-start gap-2">
        <MessageCircleQuestionMark className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-pretty">{pending.request.prompt}</p>
      </div>

      {options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant="outline"
              className="h-9 rounded-none"
              disabled={disabled || busy !== null}
              onClick={() => void answer(option.id, { optionId: option.id })}
              title={option.description}
            >
              {busy === option.id ? <Spinner data-icon="inline-start" /> : null}
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}

      {pending.request.allowFreeform === true || options.length === 0 ? (
        <form noValidate onSubmit={submitFreeform} className="flex items-center gap-2">
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Or type an answer…"
            disabled={disabled || busy !== null}
            aria-label="Your answer"
          />
          <Button type="submit" size="icon-sm" disabled={disabled || busy !== null || text.trim().length === 0}>
            {busy === "freeform" ? <Spinner /> : <Send />}
            <span className="sr-only">Send answer</span>
          </Button>
        </form>
      ) : null}
    </section>
  );
}
