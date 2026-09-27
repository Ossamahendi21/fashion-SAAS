"use client";

import { ArrowUpRight, Check, Plus, Save } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useStylistPanel } from "@/components/stylist/stylist-provider";
import { createStylistDraftContext } from "@/lib/stylist-context";
import { ItemImage } from "@/components/common/item-image";
import { BOARD_SLOT_CLASS } from "@/components/outfits/outfit-composition";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorAlert } from "@/components/common/error-alert";
import { ItemPickerSheet } from "@/components/outfits/item-picker-sheet";
import { SlotCard } from "@/components/outfits/slot-card";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useOutfitActions, type Outfit } from "@/hooks/use-outfits";
import { useWardrobe, type Item as WardrobeItem } from "@/hooks/use-items";
import { formatDate, pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { Id } from "@convex/_generated/dataModel";
import { SLOTS, SLOT_CATEGORIES, SLOT_LABELS, type Slot } from "@convex/shared/wardrobe";

export type DraftSlots = {
  outerwear?: Id<"items">;
  top?: Id<"items">;
  bottom?: Id<"items">;
  dress?: Id<"items">;
  shoes?: Id<"items">;
  accessories: Id<"items">[];
};

export type OutfitDraft = { name: string; occasion: string; slots: DraftSlots };

type SingleSlot = Exclude<Slot, "accessories">;

export const EMPTY_DRAFT: OutfitDraft = { name: "", occasion: "", slots: { accessories: [] } };

export function draftFromOutfit(outfit: Outfit): OutfitDraft {
  return {
    name: outfit.name,
    occasion: outfit.occasion ?? "",
    slots: {
      outerwear: outfit.slots.outerwear,
      top: outfit.slots.top,
      bottom: outfit.slots.bottom,
      dress: outfit.slots.dress,
      shoes: outfit.slots.shoes,
      accessories: [...outfit.slots.accessories],
    },
  };
}

type OutfitFormProps = {
  initial: OutfitDraft;
  compact?: boolean;
  /** Lets the screen around the form warn before throwing unsaved work away. */
  onDirtyChange?: (dirty: boolean) => void;
} & ({ mode: "create" } | { mode: "edit"; outfitId: Id<"outfits">; onTryOn?: () => void });

/** The slot board plus name/occasion. Owns the draft; saving is create-then-redirect or patch-in-place. */
export function OutfitForm(props: OutfitFormProps) {
  const { initial, onDirtyChange, compact = false } = props;
  const router = useRouter();
  const pathname = usePathname();
  const { setContextOverride } = useStylistPanel();
  const { items: wardrobe } = useWardrobe();
  const actions = useOutfitActions();

  const [slots, setSlots] = useState<DraftSlots>(() => cloneSlots(initial.slots));
  const [occasion, setOccasion] = useState(initial.occasion);
  const [name, setName] = useState(initial.name);
  const [nameTouched, setNameTouched] = useState(initial.name.length > 0);
  const [useDress, setUseDress] = useState(Boolean(initial.slots.dress));
  const [pickerSlot, setPickerSlot] = useState<Slot | null>(null);
  const [baseline, setBaseline] = useState<OutfitDraft>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fixed at mount so the fallback name does not change under the user while they are picking pieces.
  const [today] = useState(() => formatDate(Date.now()));
  const itemsById = useMemo(() => new Map((wardrobe ?? []).map((item) => [item._id, item])), [wardrobe]);
  const chosen = useMemo(() => pickItems(slots, itemsById), [slots, itemsById]);
  const itemCount = countItems(slots);
  const suggestedName = useMemo(() => suggestName(chosen, today), [chosen, today]);
  const effectiveName = nameTouched ? name : suggestedName;

  const dirty =
    effectiveName !== baseline.name ||
    occasion.trim() !== baseline.occasion.trim() ||
    !slotsEqual(slots, baseline.slots);
  const canSave = itemCount > 0 && dirty && !pending;
  const hasUnsavedChanges = dirty && (props.mode === "edit" || itemCount > 0);
  const visibleSlots = SLOTS.filter((slot) => (useDress ? slot !== "top" && slot !== "bottom" : slot !== "dress"));

  const savedOutfitId = props.mode === "edit" ? props.outfitId : undefined;
  const stylistContext = useMemo(
    () =>
      createStylistDraftContext({
        path: pathname,
        name: effectiveName,
        occasion,
        slots,
        items: wardrobe ?? [],
        dirty: hasUnsavedChanges,
        savedOutfitId,
      }),
    [pathname, effectiveName, occasion, slots, wardrobe, hasUnsavedChanges, savedOutfitId],
  );
  useEffect(() => {
    setContextOverride(stylistContext);
    return () => setContextOverride(null);
  }, [stylistContext, setContextOverride]);

  useUnsavedChangesWarning(hasUnsavedChanges);
  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);

  function setSlot(slot: SingleSlot, itemId: Id<"items"> | undefined) {
    setSlots((current) => {
      const next: DraftSlots = cloneSlots(current);
      next[slot] = itemId;
      return next;
    });
  }

  function toggleAccessory(itemId: Id<"items">) {
    setSlots((current) => ({
      ...current,
      accessories: current.accessories.includes(itemId)
        ? current.accessories.filter((id) => id !== itemId)
        : [...current.accessories, itemId],
    }));
  }

  function handleToggle(itemId: Id<"items">) {
    if (!pickerSlot) return;
    if (pickerSlot === "accessories") {
      toggleAccessory(itemId);
      return;
    }
    setSlot(pickerSlot, slots[pickerSlot] === itemId ? undefined : itemId);
    setPickerSlot(null);
  }

  function handleClearPicker() {
    if (!pickerSlot) return;
    if (pickerSlot === "accessories") setSlots((current) => ({ ...current, accessories: [] }));
    else setSlot(pickerSlot, undefined);
  }

  function switchLayer(next: "separates" | "dress") {
    setUseDress(next === "dress");
    setSlots((current) =>
      next === "dress" ? { ...current, top: undefined, bottom: undefined } : { ...current, dress: undefined },
    );
  }

  async function handleSave() {
    if (!canSave) return;
    setPending(true);
    setError(null);
    const savedName = effectiveName.trim() || suggestedName;
    const savedOccasion = occasion.trim();
    const savedSlots = toSlotsArg(slots);
    if (props.mode === "create") {
      const newId = await actions.create(
        { name: savedName, slots: savedSlots, occasion: savedOccasion || undefined },
        (clientError) => setError(clientError.message),
      );
      setPending(false);
      if (!newId) return;
      toast.success("Outfit saved.");
      router.replace(routes.outfit(newId));
      return;
    }
    // `null` rather than `undefined`: an omitted key means "leave it alone", null means "clear it".
    const result = await actions.update(
      { outfitId: props.outfitId, patch: { name: savedName, slots: savedSlots, occasion: savedOccasion || null } },
      (clientError) => setError(clientError.message),
    );
    setPending(false);
    if (result === undefined) return;
    setBaseline({ name: savedName, occasion: savedOccasion, slots: cloneSlots(slots) });
    setName(savedName);
    setNameTouched(true);
    toast.success("Outfit updated.");
  }

  function startWithPiece(item: WardrobeItem) {
    const slot = SLOTS.find((candidate) => SLOT_CATEGORIES[candidate].includes(item.category));
    if (!slot) return;
    if (slot === "dress") switchLayer("dress");
    else if (slot === "top" || slot === "bottom") switchLayer("separates");
    if (slot === "accessories") toggleAccessory(item._id);
    else setSlot(slot, item._id);
  }

  return (
    <section className="@container" aria-busy={pending}>
      <fieldset
        disabled={pending}
        className={compact ? "space-y-4" : "grid gap-8 @3xl:grid-cols-[minmax(0,1fr)_240px] @3xl:gap-8"}
      >
        <div className="min-w-0">
          <div
            className={
              compact
                ? "flex items-center justify-between border-t border-foreground/20 py-3 font-mono text-[10px] tracking-[0.16em] uppercase"
                : "flex items-center justify-between border-t border-foreground/20 py-4 font-mono text-[10px] tracking-[0.16em] uppercase"
            }
          >
            <h2>{compact ? "The pieces" : "01 / The outfit board"}</h2>
            <span className="text-muted-foreground">{pluralize(itemCount, "piece")}</span>
          </div>
          {itemCount > 0 || compact ? (
            <div
              className={
                compact
                  ? "grid grid-cols-3 gap-2 @min-[30rem]:grid-cols-4"
                  : "grid aspect-[16/9] max-h-[480px] min-h-80 grid-cols-6 grid-rows-8 gap-2 bg-muted/25 px-3 py-6 sm:px-8 sm:py-8"
              }
            >
              {visibleSlots.flatMap((slot) => {
                const items = slotItems(slot, slots, itemsById);
                const groups = compact && slot === "accessories" ? [...items.map((item) => [item]), []] : [items];
                return groups.map((group, index) => (
                  <SlotCard
                    key={`${slot}-${group[0]?._id ?? index}`}
                    slot={slot}
                    compact={compact}
                    multiple={!compact && slot === "accessories"}
                    className={compact ? "h-25 bg-muted/25 p-2 @min-[30rem]:h-28" : BOARD_SLOT_CLASS[slot]}
                    items={group}
                    onOpen={() => setPickerSlot(slot)}
                    onRemove={(itemId) => {
                      if (slot === "accessories") toggleAccessory(itemId);
                      else setSlot(slot, undefined);
                    }}
                  />
                ));
              })}
            </div>
          ) : (
            <div className="space-y-6 bg-muted/25 p-5 sm:p-8">
              <div className="max-w-md space-y-2">
                <h3 className="text-3xl font-medium tracking-[-0.05em] sm:text-4xl">A look starts with one piece.</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Choose something from your wardrobe. Build the rest around it.
                </p>
              </div>
              {wardrobe === undefined ? (
                <div className="grid grid-cols-3 gap-3">
                  {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="aspect-[3/4] rounded-none" />
                  ))}
                </div>
              ) : wardrobe.length > 0 ? (
                <div className="grid grid-cols-3 gap-3">
                  {wardrobe.slice(0, 6).map((item) => (
                    <button
                      key={item._id}
                      type="button"
                      onClick={() => startWithPiece(item)}
                      className="group text-left focus-visible:outline-2 focus-visible:outline-offset-4"
                      aria-label={`Start with ${item.name}`}
                    >
                      <ItemImage
                        src={item.url}
                        alt={item.name}
                        aspect="aspect-[4/3]"
                        className="rounded-none bg-transparent p-1 dark:bg-transparent"
                      />
                      <span className="mt-2 block truncate text-[11px] text-muted-foreground group-hover:text-foreground">
                        {item.name}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <Button nativeButton={false} render={<Link href={routes.add} />} className="h-11 rounded-none">
                  Add your first clothes <ArrowUpRight className="size-4" />
                </Button>
              )}
              <div className="flex flex-wrap gap-x-5 gap-y-3 border-t border-foreground/10 pt-4">
                {visibleSlots.map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => setPickerSlot(slot)}
                    className="flex items-center gap-1 text-[10px] tracking-wide text-muted-foreground uppercase hover:text-foreground"
                  >
                    <Plus className="size-3" />
                    {SLOT_LABELS[slot]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {itemCount > 0 && !compact ? (
            <p className="pt-3 text-xs text-muted-foreground">
              Select a piece to change it. Use + to add another layer.
            </p>
          ) : null}
        </div>

        <div className={compact ? "flex flex-col" : "flex flex-col border-t border-foreground/20 @3xl:pb-8"}>
          {!compact ? (
            <h2 className="py-4 font-mono text-[10px] tracking-[0.16em] uppercase">02 / Make it yours</h2>
          ) : null}
          <div className={compact ? "grid grid-cols-2 gap-x-4 gap-y-3" : "space-y-6 pt-2"}>
            <Field>
              <FieldLabel
                htmlFor="outfit-name"
                className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase"
              >
                Outfit name
              </FieldLabel>
              <Input
                id="outfit-name"
                className={
                  compact
                    ? "h-9 rounded-none border-0 border-b border-foreground/20 bg-transparent px-0 text-sm shadow-none dark:bg-transparent"
                    : "h-11 rounded-none border-0 border-b border-foreground/20 bg-transparent px-0 text-lg shadow-none dark:bg-transparent"
                }
                value={effectiveName}
                placeholder={suggestedName}
                onChange={(event) => {
                  setNameTouched(true);
                  setName(event.target.value);
                }}
              />
            </Field>
            <Field>
              <FieldLabel
                htmlFor="outfit-occasion"
                className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase"
              >
                The occasion
              </FieldLabel>
              <Input
                id="outfit-occasion"
                className={
                  compact
                    ? "h-9 rounded-none border-0 border-b border-foreground/20 bg-transparent px-0 text-sm shadow-none dark:bg-transparent"
                    : "h-10 rounded-none border-0 border-b border-foreground/20 bg-transparent px-0 shadow-none dark:bg-transparent"
                }
                value={occasion}
                placeholder="Everyday, dinner, a night out…"
                onChange={(event) => setOccasion(event.target.value)}
              />
            </Field>
            <div className={compact ? "col-span-2 flex flex-wrap items-center justify-between gap-2" : "space-y-2"}>
              <p className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">The silhouette</p>
              <ToggleGroup
                value={[useDress ? "dress" : "separates"]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === "dress" || next === "separates") switchLayer(next);
                }}
                spacing={1}
                aria-label="Top and bottom, or a dress"
                className={compact ? "rounded-none" : "w-full rounded-none"}
              >
                <ToggleGroupItem
                  value="separates"
                  className={
                    compact
                      ? "h-9 flex-1 rounded-none border border-foreground/15 text-xs aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
                      : "h-10 flex-1 rounded-none border border-foreground/15 text-xs aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
                  }
                >
                  Top + bottom
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="dress"
                  className={
                    compact
                      ? "h-9 flex-1 rounded-none border border-foreground/15 text-xs aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
                      : "h-10 flex-1 rounded-none border border-foreground/15 text-xs aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
                  }
                >
                  Dress
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
          <div className={compact ? "mt-3 space-y-2" : "mt-8 space-y-3"}>
            {error ? (
              <ErrorAlert title="Could not save this outfit" message={error} onRetry={() => void handleSave()} />
            ) : null}
            <p id="outfit-save-status" className="text-xs leading-relaxed text-muted-foreground" role="status">
              {itemCount === 0
                ? "Choose a piece to begin."
                : pending
                  ? "Saving your outfit…"
                  : dirty
                    ? props.mode === "edit"
                      ? "Save your changes before trying on this outfit."
                      : "Save this look, then see it on you."
                    : "Saved. Ready for the fitting room."}
            </p>
            {!compact || dirty || props.mode === "create" ? (
              <Button
                variant={props.mode === "create" ? "default" : "outline"}
                className="h-11 w-full rounded-none"
                onClick={() => void handleSave()}
                disabled={!canSave}
              >
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : dirty ? (
                  <Save data-icon="inline-start" />
                ) : (
                  <Check data-icon="inline-start" />
                )}
                {props.mode === "create" ? "Save outfit" : dirty ? "Save changes" : "Outfit saved"}
              </Button>
            ) : null}
            {props.mode === "edit" && props.onTryOn ? (
              <Button
                className={
                  compact
                    ? "h-11 w-full justify-between rounded-none px-4"
                    : "h-12 w-full justify-between rounded-none px-4"
                }
                disabled={dirty || pending || itemCount === 0}
                aria-describedby="outfit-save-status"
                onClick={props.onTryOn}
              >
                Try on outfit <ArrowUpRight className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </fieldset>

      <ItemPickerSheet
        slot={pickerSlot}
        items={wardrobe}
        multiple={pickerSlot === "accessories"}
        selected={pickerSlot ? selectedIds(pickerSlot, slots) : []}
        onOpenChange={(open) => {
          if (!open) setPickerSlot(null);
        }}
        onToggle={handleToggle}
        onClear={handleClearPicker}
      />
    </section>
  );
}

function slotItems(slot: Slot, slots: DraftSlots, itemsById: Map<Id<"items">, WardrobeItem>): WardrobeItem[] {
  if (slot === "accessories") {
    return slots.accessories.map((id) => itemsById.get(id)).filter((item): item is WardrobeItem => Boolean(item));
  }
  const id = slots[slot];
  const item = id ? itemsById.get(id) : undefined;
  return item ? [item] : [];
}

function selectedIds(slot: Slot, slots: DraftSlots): Id<"items">[] {
  if (slot === "accessories") return slots.accessories;
  const id = slots[slot];
  return id ? [id] : [];
}

function pickItems(slots: DraftSlots, itemsById: Map<Id<"items">, WardrobeItem>): WardrobeItem[] {
  const ids = [slots.outerwear, slots.dress, slots.top, slots.bottom, slots.shoes, ...slots.accessories];
  return ids.map((id) => (id ? itemsById.get(id) : undefined)).filter((item): item is WardrobeItem => Boolean(item));
}

function countItems(slots: DraftSlots): number {
  const single = [slots.outerwear, slots.top, slots.bottom, slots.dress, slots.shoes].filter(Boolean).length;
  return single + slots.accessories.length;
}

function cloneSlots(slots: DraftSlots): DraftSlots {
  return { ...slots, accessories: [...slots.accessories] };
}

function toSlotsArg(slots: DraftSlots): DraftSlots {
  return {
    outerwear: slots.outerwear,
    top: slots.top,
    bottom: slots.bottom,
    dress: slots.dress,
    shoes: slots.shoes,
    accessories: [...slots.accessories],
  };
}

function slotsEqual(a: DraftSlots, b: DraftSlots): boolean {
  return (
    a.outerwear === b.outerwear &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.dress === b.dress &&
    a.shoes === b.shoes &&
    a.accessories.length === b.accessories.length &&
    a.accessories.every((id, index) => id === b.accessories[index])
  );
}

/** "Black tee + indigo jeans", falling back to "Outfit · 16 Sep 2026" until something is picked. */
function suggestName(items: WardrobeItem[], today: string): string {
  const headline = items.filter((item) => item.category !== "accessory" && item.category !== "bag").slice(0, 2);
  if (headline.length === 0) return `Outfit · ${today}`;
  const name = headline.map((item) => item.name).join(" + ");
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/** Catches a tab close or reload mid-edit. In-app navigation is not interceptable in the App Router yet. */
function useUnsavedChangesWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    function handler(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);
}
