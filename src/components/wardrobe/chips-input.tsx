"use client";

import { X } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

type ChipsInputProps = {
  value: readonly string[];
  onValueChange: (next: string[]) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  maxChips?: number;
  /** Colour names get a swatch dot; the browser resolves whatever CSS understands. */
  swatches?: boolean;
  "aria-describedby"?: string;
  className?: string;
};

function normalise(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Free-text tags in a single box: Enter or comma commits, Backspace on an empty box removes the last.
 * Used for "colours to avoid" in onboarding and secondary colours on an item.
 */
export function ChipsInput({
  value,
  onValueChange,
  placeholder = "Type and press Enter",
  id,
  disabled = false,
  maxChips = 12,
  swatches = false,
  className,
  ...aria
}: ChipsInputProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const atLimit = value.length >= maxChips;

  function commit(raw: string) {
    const next = normalise(raw);
    setDraft("");
    if (!next || atLimit || value.includes(next)) return;
    onValueChange([...value, next]);
  }

  function remove(chip: string) {
    onValueChange(value.filter((entry) => entry !== chip));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      event.preventDefault();
      remove(value[value.length - 1]);
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((chip) => (
        <span
          key={chip}
          className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full bg-secondary pl-2 text-xs font-medium text-secondary-foreground"
        >
          {swatches ? (
            <span
              className="size-2.5 shrink-0 rounded-full ring-1 ring-foreground/15"
              style={{ backgroundColor: chip }}
              aria-hidden
            />
          ) : null}
          <span className="min-w-0 [overflow-wrap:anywhere]">{chip}</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              remove(chip);
            }}
            disabled={disabled}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`Remove ${chip}`}
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={inputId}
        value={draft}
        disabled={disabled || atLimit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
        placeholder={atLimit ? `Up to ${maxChips}` : value.length ? "" : placeholder}
        aria-describedby={aria["aria-describedby"]}
        className="h-6 min-w-24 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
      />
    </div>
  );
}
