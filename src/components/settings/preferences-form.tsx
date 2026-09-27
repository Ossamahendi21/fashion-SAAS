"use client";

import { useMutation } from "convex/react";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { WardrobePreference } from "@/components/common/wardrobe-preference";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCurrentUser, type CurrentUser } from "@/hooks/use-current-user";
import { reportError } from "@/lib/errors";
import { titleCase } from "@/lib/format";
import { api } from "@convex/_generated/api";
import { FITS } from "@convex/shared/wardrobe";

type Prefs = CurrentUser["prefs"];

const MAX_AVOID_COLOURS = 12;

/** Base UI toggle groups are multi-select by shape; this pins one valid value. */
function pickOne<T extends string>(allowed: readonly T[], next: readonly string[]): T | null {
  const candidate = next[0];
  return candidate !== undefined && (allowed as readonly string[]).includes(candidate) ? (candidate as T) : null;
}

function sameColours(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((colour, index) => colour === b[index]);
}

function isDirty(draft: Prefs, saved: Prefs): boolean {
  return (
    draft.presentation !== saved.presentation ||
    draft.fit !== saved.fit ||
    (draft.homeCity ?? "") !== (saved.homeCity ?? "") ||
    !sameColours(draft.avoidColours, saved.avoidColours)
  );
}

export function PreferencesForm() {
  const { user, isLoading } = useCurrentUser();
  if (isLoading || !user) return <PreferencesSkeleton />;
  return <PreferencesFields initial={user.prefs} />;
}

function PreferencesFields({ initial }: { initial: Prefs }) {
  const updatePrefs = useMutation(api.users.updatePrefs);
  const [saved, setSaved] = useState<Prefs>(initial);
  const [draft, setDraft] = useState<Prefs>(initial);
  const [colourInput, setColourInput] = useState("");
  const [saving, setSaving] = useState(false);
  const dirty = isDirty(draft, saved);

  // Preferences can change elsewhere (another tab, an admin adjustment). Adopt the server's values
  // during render — never from an effect — and only while the user has nothing unsaved here.
  if (!dirty && isDirty(initial, saved)) {
    setSaved(initial);
    setDraft(initial);
  }

  function addColour() {
    const colour = colourInput.trim().toLowerCase();
    if (!colour) return;
    if (draft.avoidColours.includes(colour)) {
      setColourInput("");
      return;
    }
    if (draft.avoidColours.length >= MAX_AVOID_COLOURS) {
      toast.error(`That is enough colours to avoid — ${MAX_AVOID_COLOURS} is the limit.`);
      return;
    }
    setDraft({ ...draft, avoidColours: [...draft.avoidColours, colour] });
    setColourInput("");
  }

  async function handleSave() {
    setSaving(true);
    const next: Prefs = { ...draft, homeCity: draft.homeCity?.trim() ? draft.homeCity.trim() : undefined };
    try {
      await updatePrefs({ prefs: next });
      setSaved(next);
      setDraft(next);
      toast.success("Preferences saved.");
    } catch (error) {
      reportError(error, "Could not save your preferences.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      id="preferences"
      className="grid scroll-mt-24 gap-6 border-t py-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10"
    >
      <header className="space-y-2">
        <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">02 / Personal style</p>
        <h2 className="text-xl font-semibold tracking-tight">Your preferences</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The stylist and every render read these before suggesting anything.
        </p>
      </header>

      <div className="min-w-0 space-y-6">
        <FieldGroup className="grid gap-7 sm:grid-cols-2">
          <WardrobePreference
            value={draft.presentation}
            onChange={(presentation) => setDraft({ ...draft, presentation })}
            disabled={saving}
          />

          <Field>
            <FieldTitle>Preferred fit</FieldTitle>
            <FieldDescription>Used when an item could be worn more than one way.</FieldDescription>
            <ToggleGroup
              variant="outline"
              spacing={2}
              disabled={saving}
              aria-label="Preferred fit"
              value={[draft.fit]}
              onValueChange={(next) => {
                const value = pickOne(FITS, next);
                if (value) setDraft({ ...draft, fit: value });
              }}
            >
              {FITS.map((option) => (
                <ToggleGroupItem
                  key={option}
                  value={option}
                  className="rounded-sm aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
                >
                  {titleCase(option)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Field>
            <FieldLabel htmlFor="avoid-colour">Colours to avoid</FieldLabel>
            <FieldDescription>Outfit suggestions will steer around these.</FieldDescription>
            <div className="flex gap-2">
              <Input
                id="avoid-colour"
                value={colourInput}
                placeholder="mustard"
                autoComplete="off"
                disabled={saving}
                onChange={(event) => setColourInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addColour();
                  }
                }}
              />
              <Button variant="outline" onClick={addColour} disabled={saving || !colourInput.trim()}>
                <Plus data-icon="inline-start" aria-hidden />
                Add
              </Button>
            </div>
            {draft.avoidColours.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {draft.avoidColours.map((colour) => (
                  <li key={colour} className="max-w-full">
                    <Badge
                      variant="secondary"
                      className="h-auto min-h-8 max-w-full gap-1 overflow-visible py-0 pr-0 pl-2.5 capitalize"
                    >
                      <span className="min-w-0 [overflow-wrap:anywhere] whitespace-normal">{colour}</span>
                      <button
                        type="button"
                        aria-label={`Stop avoiding ${colour}`}
                        disabled={saving}
                        onClick={() =>
                          setDraft({ ...draft, avoidColours: draft.avoidColours.filter((entry) => entry !== colour) })
                        }
                        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing ruled out — every colour in your wardrobe is fair game.
              </p>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="home-city">Home city</FieldLabel>
            <FieldDescription>Optional location for your styling preferences.</FieldDescription>
            <Input
              id="home-city"
              value={draft.homeCity ?? ""}
              placeholder="London"
              autoComplete="address-level2"
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, homeCity: event.target.value })}
            />
          </Field>
        </FieldGroup>
        <div className="flex justify-end gap-2 border-t pt-4">
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <Button disabled={!dirty || saving} onClick={() => void handleSave()}>
            {saving ? <Spinner data-icon="inline-start" /> : null}
            Save changes
          </Button>
        </div>
      </div>
    </section>
  );
}

function PreferencesSkeleton() {
  return (
    <section className="space-y-6 border-t py-8" aria-busy="true" aria-label="Loading preferences">
      <header className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-64" />
      </header>
      <div className="grid gap-5 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-full max-w-sm rounded-lg" />
          </div>
        ))}
      </div>
    </section>
  );
}
