"use client";

import { ArrowUpRight, CalendarCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PageHeader } from "@/components/common/page-header";
import { draftFromOutfit, EMPTY_DRAFT, OutfitForm } from "@/components/outfits/outfit-form";
import { RenderPanel } from "@/components/renders/render-panel";
import { RenderSheet } from "@/components/renders/render-sheet";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutfit, useOutfitActions, type Outfit } from "@/hooks/use-outfits";
import { formatRelative, pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { Id } from "@convex/_generated/dataModel";

type OutfitBuilderProps = { mode: "create" } | { mode: "edit"; outfitId: string };

/** The /outfits/new and /outfits/[outfitId] screen. One board, two modes. */
export function OutfitBuilder(props: OutfitBuilderProps) {
  if (props.mode === "create") return <CreateBuilder />;
  return <EditBuilder outfitId={props.outfitId} />;
}

function CreateBuilder() {
  const router = useRouter();
  const [dirty, setDirty] = useState(false);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="The outfit studio"
        title="New outfit"
        description="Choose your pieces, save the look, then try it on."
        actions={
          dirty ? (
            <ConfirmDialog
              trigger={
                <Button variant="ghost" className="rounded-none">
                  Cancel
                </Button>
              }
              title="Leave without saving?"
              description="This outfit has not been saved yet, so the pieces you picked are lost."
              confirmLabel="Discard outfit"
              cancelLabel="Keep editing"
              destructive
              onConfirm={() => router.push(routes.outfits)}
            />
          ) : (
            <Button
              variant="ghost"
              className="rounded-none"
              nativeButton={false}
              render={<Link href={routes.outfits} />}
            >
              Cancel
            </Button>
          )
        }
      />
      <OutfitForm mode="create" initial={EMPTY_DRAFT} onDirtyChange={setDirty} />
    </div>
  );
}

function EditBuilder({ outfitId }: { outfitId: string }) {
  const outfit = useOutfit(outfitId);

  if (outfit === undefined) {
    return (
      <div className="space-y-8">
        <PageHeader title="Outfit" description="Loading…" />
        <div className="@container" aria-busy="true" aria-label="Loading outfit try-ons">
          <div className="grid gap-7 @2xl:grid-cols-[minmax(0,1.05fr)_minmax(280px,0.95fr)]">
            <Skeleton className="mx-auto aspect-[2/3] w-full max-w-[min(340px,36svh)] rounded-none" />
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-3">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} className="h-28 rounded-none" />
                ))}
              </div>
              <Skeleton className="h-12 w-full rounded-none" />
              <Skeleton className="h-12 w-full rounded-none" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Deleted, never existed, or someone else's: the route's not-found page says so.
  if (outfit === null) notFound();

  return <SavedOutfitBuilder key={outfit._id} outfit={outfit} />;
}

function SavedOutfitBuilder({ outfit }: { outfit: Outfit }) {
  const [dirty, setDirty] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [startedJobId, setStartedJobId] = useState<Id<"jobs"> | null>(null);
  const hasPieces = Object.values(outfit.items).some((item) => (Array.isArray(item) ? item.length > 0 : Boolean(item)));
  const canTryOn = !dirty && hasPieces;

  function openFittingRoom() {
    if (canTryOn) setSheetOpen(true);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={outfit.source === "agent" ? "The outfit studio / Styled by Fitcheck" : "The outfit studio"}
        title={outfit.name}
        description={describe(outfit)}
        actions={
          <>
            <Button
              className="h-11 rounded-none px-3 sm:hidden"
              disabled={!canTryOn}
              aria-label="Try on outfit"
              aria-describedby="outfit-save-status"
              onClick={openFittingRoom}
            >
              Try on <ArrowUpRight data-icon="inline-end" />
            </Button>
            <OutfitActionsRow outfit={outfit} />
          </>
        }
      />
      <div className="@container">
        <div className="grid items-start gap-7 @2xl:grid-cols-[minmax(0,1.05fr)_minmax(280px,0.95fr)] @4xl:gap-10">
          <RenderPanel outfit={outfit} draftDirty={dirty} startedJobId={startedJobId} />
          <OutfitForm
            mode="edit"
            compact
            outfitId={outfit._id}
            initial={draftFromOutfit(outfit)}
            onDirtyChange={setDirty}
            onTryOn={openFittingRoom}
          />
        </div>
      </div>
      <RenderSheet
        outfitId={outfit._id}
        open={sheetOpen && canTryOn}
        onOpenChange={setSheetOpen}
        onStarted={setStartedJobId}
      />
    </div>
  );
}

function OutfitActionsRow({ outfit }: { outfit: Outfit }) {
  const actions = useOutfitActions();
  const router = useRouter();
  const [wearPending, setWearPending] = useState(false);

  async function handleWorn() {
    setWearPending(true);
    const result = await actions.markWorn(outfit._id);
    setWearPending(false);
    if (result !== undefined) toast.success("Logged as worn today.");
  }

  return (
    <>
      <Button
        variant="outline"
        className="h-11 rounded-none sm:h-10"
        onClick={() => void handleWorn()}
        disabled={wearPending}
      >
        {wearPending ? <Spinner data-icon="inline-start" /> : <CalendarCheck data-icon="inline-start" />}
        Worn today
      </Button>
      <ConfirmDialog
        trigger={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 rounded-none text-muted-foreground sm:size-8"
            aria-label="Delete this outfit"
          >
            <Trash2 data-icon="inline-start" />
          </Button>
        }
        title="Delete this outfit?"
        description="The outfit and every render made from it are removed. Your clothes stay in the wardrobe."
        confirmLabel="Delete outfit"
        destructive
        onConfirm={async () => {
          const result = await actions.remove(outfit._id);
          if (result === undefined) return;
          toast.success("Outfit deleted.");
          router.push(routes.outfits);
        }}
      />
    </>
  );
}

function describe(outfit: Outfit): string {
  const worn =
    outfit.wornOn.length > 0
      ? `${pluralize(outfit.wornOn.length, "wear")} · last worn ${formatRelative(Math.max(...outfit.wornOn))}`
      : "Never worn";
  return [outfit.occasion, worn].filter(Boolean).join(" · ");
}
