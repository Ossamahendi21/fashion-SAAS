"use client";

import { useAction, useMutation } from "convex/react";
import { CalendarCheck, Eye, EyeOff, Trash2, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CreditQuote } from "@/components/common/credit-quote";
import { JobStepper } from "@/components/common/job-stepper";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useJob } from "@/hooks/use-active-jobs";
import { useCreditQuote } from "@/hooks/use-credits";
import { useSetItemStatus, type Item } from "@/hooks/use-items";
import { reportError, toClientError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

/** Everything you can do to an item that is not editing its attributes. */
export function ItemActions({ item }: { item: Item }) {
  const router = useRouter();
  const markWorn = useMutation(api.items.markWorn);
  const setStatus = useSetItemStatus();
  const refreshSubscription = useAction(api.subscriptions.refresh);
  const reextract = useMutation(api.items.reextract);
  const removeItems = useMutation(api.items.remove);

  const [pending, setPending] = useState<"worn" | "status" | null>(null);
  const [reextractOpen, setReextractOpen] = useState(false);
  const [jobId, setJobId] = useState<Id<"jobs"> | null>(null);
  const job = useJob(jobId);
  // One item, one cutout — and only while the dialog is open, so a closed dialog costs no subscription.
  const quote = useCreditQuote(reextractOpen && item.uploadId ? { kind: "extract", items: 1 } : null);
  const hidden = item.status === "hidden";

  async function run(kind: "worn" | "status", action: () => Promise<unknown>, success: string) {
    setPending(kind);
    try {
      await action();
      toast.success(success);
    } catch (error) {
      reportError(error);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 [&_button]:rounded-full">
        <Button
          variant="outline"
          onClick={() => void run("worn", () => markWorn({ itemId: item._id }), "Marked as worn today.")}
          disabled={pending !== null}
        >
          {pending === "worn" ? <Spinner data-icon="inline-start" /> : <CalendarCheck data-icon="inline-start" />}
          Worn today
        </Button>

        {item.uploadId ? (
          <ConfirmDialog
            trigger={
              <Button variant="outline">
                <Wand2 data-icon="inline-start" />
                Re-extract
              </Button>
            }
            open={reextractOpen}
            onOpenChange={setReextractOpen}
            confirmDisabled={!quote?.canAfford}
            title="Cut this item out again?"
            description="Runs the extraction on the original photo again and replaces the cutout. The old one is discarded."
            confirmLabel="Re-extract"
            onConfirm={async () => {
              // Handled here rather than rethrown: the dialog's own handler would toast the raw server message too.
              try {
                await refreshSubscription({});
                const result = await reextract({ itemId: item._id });
                setJobId(result.jobId);
                toast.success("Re-extraction started.");
              } catch (error) {
                const clientError = toClientError(error);
                toast.error(
                  clientError.code === "ITEM_BUSY" ? "This item is already being re-extracted." : clientError.message,
                );
              }
            }}
          >
            <CreditQuote quote={quote} label="one cutout" />
          </ConfirmDialog>
        ) : null}

        <Button
          variant="outline"
          onClick={() =>
            void run(
              "status",
              () => setStatus({ itemIds: [item._id], status: hidden ? "ready" : "hidden" }),
              hidden ? "Back in your wardrobe." : "Hidden from the grid.",
            )
          }
          disabled={pending !== null}
        >
          {pending === "status" ? (
            <Spinner data-icon="inline-start" />
          ) : hidden ? (
            <Eye data-icon="inline-start" />
          ) : (
            <EyeOff data-icon="inline-start" />
          )}
          {hidden ? "Unhide" : "Hide"}
        </Button>

        <ConfirmDialog
          trigger={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete item"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
            </Button>
          }
          title={`Delete ${item.name}?`}
          description="The cutout is deleted and the item is removed from any outfits that use it. This cannot be undone."
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            await removeItems({ itemIds: [item._id] });
            toast.success("Item deleted.");
            router.push(routes.wardrobe);
          }}
        />
      </div>

      {job ? (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">Re-extraction</p>
          <JobStepper job={job} />
        </div>
      ) : null}
    </div>
  );
}
