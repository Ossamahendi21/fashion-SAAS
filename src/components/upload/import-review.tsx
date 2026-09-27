"use client";

import { useAction, useMutation } from "convex/react";
import { Check, ScanLine, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common/error-alert";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CreditQuote } from "@/components/common/credit-quote";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { useCreditQuote } from "@/hooks/use-credits";
import { reportError, toClientError } from "@/lib/errors";
import { formatCredits, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { api } from "@convex/_generated/api";
import { CATEGORY_LABELS } from "@convex/shared/wardrobe";
import type { UploadDoc } from "./upload-status";

export function ImportReview({ upload, inDialog = false }: { upload: UploadDoc; inDialog?: boolean }) {
  const candidates = upload.candidates ?? [];
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [pending, setPending] = useState<"import" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useMutation(api.uploads.confirmSelection);
  const remove = useMutation(api.uploads.remove);
  const refresh = useAction(api.subscriptions.refresh);
  const quote = useCreditQuote(selected.size ? { kind: "extract", items: selected.size } : null);

  function toggle(index: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function importSelected() {
    if (pending || selected.size === 0) return;
    setPending("import");
    setError(null);
    try {
      await refresh({});
      await confirm({ uploadId: upload._id, indices: [...selected].sort((a, b) => a - b) });
      toast.success(`Selection confirmed for ${pluralize(selected.size, "piece")}.`);
    } catch (caught) {
      setError(reportError(caught, "Could not confirm these pieces.").message);
    } finally {
      setPending(null);
    }
  }

  async function discardPhoto() {
    if (pending) return;
    setPending("discard");
    setError(null);
    try {
      await remove({ uploadId: upload._id });
      toast.success("Photo discarded.");
    } catch (caught) {
      setError(toClientError(caught).message);
      throw caught;
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      className={cn("@container", inDialog ? "flex min-h-0 flex-1 flex-col" : "space-y-4")}
      aria-label={`Choose items from ${upload.fileName}`}
    >
      <div
        className={cn(
          "space-y-5 overscroll-contain",
          inDialog
            ? "min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
            : "max-h-[60dvh] overflow-y-auto @lg:max-h-none @lg:overflow-visible",
        )}
      >
        <div className="space-y-1">
          <h3 className="text-xl font-medium tracking-tight">Which pieces are yours?</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            We found {pluralize(candidates.length, "piece")}. Choose pieces from the list.
          </p>
        </div>
        <fieldset
          disabled={pending !== null}
          className="grid min-w-0 gap-5 @lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"
        >
          <div className="flex min-w-0 items-start justify-center bg-muted/40 p-3">
            {upload.url ? (
              <div className="relative w-fit max-w-full">
                {/* eslint-disable-next-line @next/next/no-img-element -- original stored photo; boxes share its natural aspect ratio */}
                <img
                  src={upload.url}
                  alt={`Original photo: ${upload.fileName}`}
                  className="block max-h-[min(30dvh,14rem)] max-w-full @lg:max-h-96"
                />
                {candidates.map((item, index) => {
                  const [x0, y0, x1, y1] = item.bbox;
                  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
                  return (
                    <div
                      key={index}
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-none absolute border-2 text-left transition-colors",
                        selected.has(index) ? "border-white bg-black/15" : "border-white/60",
                      )}
                      style={{
                        left: `${x0 * 100}%`,
                        top: `${y0 * 100}%`,
                        width: `${(x1 - x0) * 100}%`,
                        height: `${(y1 - y0) * 100}%`,
                      }}
                    >
                      <span
                        className={cn(
                          "absolute -top-0.5 -left-0.5 flex size-6 items-center justify-center text-[10px] font-medium",
                          selected.has(index) ? "bg-white text-black" : "bg-black text-white",
                        )}
                      >
                        {index + 1}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <ScanLine className="m-8 size-10 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                {selected.size} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                disabled={pending !== null}
                onClick={() =>
                  setSelected(
                    selected.size === candidates.length ? new Set() : new Set(candidates.map((_, index) => index)),
                  )
                }
              >
                {selected.size === candidates.length ? "Clear selection" : "Select all"}
              </Button>
            </div>
            <div className="divide-y border-y">
              {candidates.map((item, index) => (
                <label
                  key={index}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 px-2 py-3 transition-colors",
                    selected.has(index) ? "bg-muted/65" : "hover:bg-muted/30",
                  )}
                >
                  <Checkbox
                    checked={selected.has(index)}
                    onCheckedChange={() => toggle(index)}
                    disabled={pending !== null}
                    aria-label={item.name}
                  />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.name}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {CATEGORY_LABELS[item.category]} · {item.colours.primary}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </fieldset>
        {selected.size > 0 && selected.size < candidates.length ? (
          <p className="text-xs text-muted-foreground">
            {pluralize(candidates.length - selected.size, "unselected piece")} will not be added to your wardrobe.
          </p>
        ) : null}
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm" className="h-9 px-2 text-muted-foreground" disabled={pending !== null}>
              <Trash2 data-icon="inline-start" />
              Discard photo
            </Button>
          }
          title="Discard this photo?"
          description="The original photo and its scan will be permanently deleted. Existing wardrobe items are kept. This cannot be undone."
          confirmLabel="Discard photo"
          destructive
          confirmDisabled={pending === "import"}
          onConfirm={discardPhoto}
        />
      </div>
      <div className={cn("shrink-0 space-y-3 border-t bg-background pt-4", inDialog ? "px-4 pb-4 sm:px-6" : "pb-2")}>
        {error ? <ErrorAlert message={error} /> : null}
        <div className="flex flex-col gap-3 @2xl:flex-row @2xl:items-center @2xl:justify-between">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            {quote?.reason === "daily_cap" && selected.size ? (
              <p role="status">
                This selection needs {formatCredits(quote.credits)}. You have {formatCredits(quote.available)} left in
                today’s allowance. Choose fewer pieces or try again tomorrow.
              </p>
            ) : selected.size ? (
              <CreditQuote
                quote={quote}
                label={pluralize(selected.size, "selected cutout")}
                className="flex-wrap gap-y-2 [&>div:first-child]:flex-wrap"
              />
            ) : (
              "Nothing imported yet. Scanning this photo is free."
            )}
          </div>
          <Button
            className="h-11 shrink-0 rounded-full px-5"
            disabled={pending !== null || selected.size === 0 || !quote?.canAfford}
            onClick={() => void importSelected()}
          >
            {pending === "import" ? <Spinner /> : <Check />}
            {pending === "import"
              ? "Confirming…"
              : selected.size
                ? `Import ${pluralize(selected.size, "piece")}${quote ? ` · ${formatCredits(quote.credits)}` : ""}`
                : "Select pieces to import"}
          </Button>
        </div>
      </div>
    </section>
  );
}
