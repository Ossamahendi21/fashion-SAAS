"use client";

import { ArrowUpRight, Check, Sparkles, UserRound } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { CreditQuote } from "@/components/common/credit-quote";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorAlert } from "@/components/common/error-alert";
import { ItemImage } from "@/components/common/item-image";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCreditQuote } from "@/hooks/use-credits";
import { useClerkPlan } from "@/hooks/use-clerk-plan";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAvatars, useRenderActions } from "@/hooks/use-renders";
import { formatCredits, pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { LIMITS, renderCreditCost, type RenderQuality } from "@convex/shared/credits";

type RenderSheetProps = {
  outfitId: Id<"outfits">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (jobId: Id<"jobs">) => void;
};

const COUNTS = Array.from({ length: LIMITS.maxRendersPerRequest }, (_, index) => index + 1);

/** Avatar, how many, what quality, what it costs — then start the render job. */
export function RenderSheet({ outfitId, open, onOpenChange, onStarted }: RenderSheetProps) {
  const isMobile = useIsMobile();
  const avatars = useAvatars();
  const { canRenderHq: hqUnlocked } = useClerkPlan();
  const actions = useRenderActions();

  const [chosenAvatarId, setChosenAvatarId] = useState<Id<"avatars"> | null>(null);
  const [count, setCount] = useState(1);
  const [quality, setQuality] = useState<RenderQuality>("standard");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The default avatar is preselected without an effect: it is simply the fallback until one is picked.
  const defaultAvatarId = (avatars?.find((avatar) => avatar.isDefault) ?? avatars?.[0])?._id ?? null;
  const avatarId = chosenAvatarId ?? defaultAvatarId;

  const effectiveQuality: RenderQuality = hqUnlocked ? quality : "standard";
  const quote = useCreditQuote(open ? { kind: "render", quality: effectiveQuality, count } : null);
  const credits = renderCreditCost(effectiveQuality, count);

  async function handleStart() {
    if (!avatarId || pending) return;
    setPending(true);
    setError(null);
    const result = await actions.start(
      { outfitIds: [outfitId], avatarId, count, quality: effectiveQuality },
      (clientError) => setError(clientError.message),
    );
    setPending(false);
    if (!result) return;
    toast.success(`Creating ${pluralize(count, "try-on")}. Follow the progress in your outfit.`);
    onOpenChange(false);
    onStarted(result.jobId);
  }

  const noAvatars = avatars !== undefined && avatars.length === 0;
  const canStart = Boolean(avatarId) && !pending && (quote?.canAfford ?? false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className="flex flex-col gap-0 p-0 data-[side=bottom]:max-h-[90dvh] data-[side=bottom]:rounded-t-none data-[side=right]:sm:max-w-lg"
      >
        <SheetHeader className="border-b border-foreground/15 p-6">
          <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            Your personal fitting room
          </p>
          <SheetTitle className="text-3xl font-medium tracking-[-0.05em]">See it on you.</SheetTitle>
          <SheetDescription>Your saved outfit, fitted to your reference photo.</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto p-6">
          {noAvatars ? (
            <EmptyState
              icon={UserRound}
              className="min-h-0 rounded-none border-0 py-5"
              title="No photo of you yet"
              description="Add a full-length photo in settings and Fitcheck can dress it in your clothes."
              action={
                <Button nativeButton={false} render={<Link href={routes.settings} />}>
                  Add a photo
                </Button>
              }
            />
          ) : (
            <fieldset disabled={pending} className="space-y-3">
              <legend className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                01 / Your reference
              </legend>
              <div className="flex flex-wrap gap-4 pt-1">
                {avatars === undefined
                  ? Array.from({ length: 2 }, (_, index) => <Skeleton key={index} className="h-36 w-24 rounded-none" />)
                  : avatars.map((avatar) => {
                      const selected = avatar._id === avatarId;
                      return (
                        <button
                          key={avatar._id}
                          type="button"
                          onClick={() => setChosenAvatarId(avatar._id)}
                          aria-pressed={selected}
                          className={cn(
                            "relative p-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                            selected ? "ring-2 ring-primary" : "ring-1 ring-transparent hover:ring-border",
                          )}
                        >
                          <ItemImage
                            src={avatar.url}
                            alt={avatar.label}
                            variant="render"
                            className="h-36 w-24 rounded-none"
                          />
                          {selected ? (
                            <span className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-3" aria-hidden />
                            </span>
                          ) : null}
                          <span className="mt-2 block max-w-24 truncate text-left text-xs">{avatar.label}</span>
                        </button>
                      );
                    })}
              </div>
            </fieldset>
          )}

          <fieldset disabled={pending} className="space-y-3">
            <legend className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
              02 / Number of images
            </legend>
            <ToggleGroup
              value={[String(count)]}
              onValueChange={(value) => {
                const next = Number(value[0]);
                if (Number.isFinite(next) && next >= 1) setCount(next);
              }}
              variant="default"
              spacing={1}
              className="pt-1"
              aria-label="Number of images"
            >
              {COUNTS.map((option) => (
                <ToggleGroupItem
                  key={option}
                  value={String(option)}
                  className="h-11 min-w-12 rounded-none border border-foreground/15 tabular-nums aria-pressed:bg-foreground aria-pressed:text-background"
                >
                  {option}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </fieldset>

          <fieldset disabled={pending} className="space-y-3">
            <legend className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
              03 / The finish
            </legend>
            <ToggleGroup
              value={[effectiveQuality]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "standard") setQuality("standard");
                if (next === "hq" && hqUnlocked) setQuality("hq");
              }}
              variant="default"
              spacing={1}
              className="pt-1"
              aria-label="Render quality"
            >
              <ToggleGroupItem
                value="standard"
                className="h-11 rounded-none border border-foreground/15 px-5 aria-pressed:bg-foreground aria-pressed:text-background"
              >
                Standard
              </ToggleGroupItem>
              {hqUnlocked ? (
                <ToggleGroupItem
                  value="hq"
                  className="h-11 rounded-none border border-foreground/15 px-5 aria-pressed:bg-foreground aria-pressed:text-background"
                >
                  <Sparkles data-icon="inline-start" />
                  HQ
                </ToggleGroupItem>
              ) : (
                // `aria-disabled` rather than `disabled` so the "Plus plan" tooltip still reaches
                // hover and keyboard focus; the controlled `onValueChange` above ignores the click.
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ToggleGroupItem
                        value="hq"
                        aria-disabled
                        className="h-11 cursor-not-allowed rounded-none border border-foreground/15 px-5 opacity-50"
                      />
                    }
                  >
                    <Sparkles data-icon="inline-start" />
                    HQ
                  </TooltipTrigger>
                  <TooltipContent>Plus plan</TooltipContent>
                </Tooltip>
              )}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              Standard costs {formatCredits(renderCreditCost("standard", 1))} an image, HQ{" "}
              {formatCredits(renderCreditCost("hq", 1))}.
            </p>
          </fieldset>

          <CreditQuote quote={quote} label={pluralize(count, "image")} />

          {error ? <ErrorAlert title="Could not start rendering" message={error} /> : null}
        </div>

        <SheetFooter className="flex-col gap-3 border-t border-foreground/15 p-6">
          <Button className="h-12 w-full rounded-none" disabled={!canStart} onClick={() => void handleStart()}>
            {pending ? <Spinner data-icon="inline-start" /> : <ArrowUpRight data-icon="inline-start" />}
            Create {pluralize(count, "try-on")} · {formatCredits(credits)}
          </Button>
          {quote && !quote.canAfford && quote.reason !== "daily_cap" ? (
            <Button
              variant="outline"
              className="h-11 w-full rounded-none"
              nativeButton={false}
              render={<Link href={`${routes.billing}#plans`} />}
            >
              View plans
            </Button>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
