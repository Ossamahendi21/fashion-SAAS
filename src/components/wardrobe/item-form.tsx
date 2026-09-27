"use client";

import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { ChevronDown, Save } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common/error-alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { Item } from "@/hooks/use-items";
import { reportError } from "@/lib/errors";
import { api } from "@convex/_generated/api";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  FITS,
  FORMALITY,
  FORMALITY_LABELS,
  SEASONS,
  type Category,
  type Fit,
  type Formality,
  type Season,
} from "@convex/shared/wardrobe";
import { ChipsInput } from "./chips-input";
import { MultiToggleGroup, SingleToggleGroup } from "./toggle-options";

type Draft = {
  name: string;
  category: Category;
  subcategory: string;
  primary: string;
  secondary: string[];
  pattern: string;
  material: string;
  season: Season[];
  formality: Formality;
  fit: Fit | undefined;
  brand: string;
  notes: string;
};

function draftOf(item: Item): Draft {
  return {
    name: item.name,
    category: item.category,
    subcategory: item.subcategory,
    primary: item.colours.primary,
    secondary: [...item.colours.secondary],
    pattern: item.pattern,
    material: item.material,
    season: [...item.season],
    formality: item.formality,
    fit: item.fit,
    brand: item.brand ?? "",
    notes: item.notes ?? "",
  };
}

function changedAttributes(draft: Draft, saved: Draft, item: Item): FunctionArgs<typeof api.items.update>["patch"] {
  const changes: FunctionArgs<typeof api.items.update>["patch"] = {};
  for (const key of ["name", "subcategory", "pattern", "material", "brand", "notes"] as const) {
    if (draft[key].trim() !== saved[key].trim()) changes[key] = draft[key].trim();
  }
  if (draft.category !== saved.category) changes.category = draft.category;
  if (draft.formality !== saved.formality) changes.formality = draft.formality;
  if (draft.fit !== saved.fit && draft.fit !== undefined) changes.fit = draft.fit;
  if (JSON.stringify(draft.season) !== JSON.stringify(saved.season)) changes.season = draft.season;
  const primaryChanged = draft.primary.trim() !== saved.primary.trim();
  const secondaryChanged = JSON.stringify(draft.secondary) !== JSON.stringify(saved.secondary);
  if (primaryChanged || secondaryChanged) {
    changes.colours = {
      ...item.colours,
      ...(primaryChanged ? { primary: draft.primary.trim() } : {}),
      ...(secondaryChanged ? { secondary: draft.secondary } : {}),
    };
  }
  return changes;
}

/** Everything about a garment the user can correct. Mount with `key={item._id}` so drafts survive live updates. */
export function ItemForm({ item }: { item: Item }) {
  const update = useMutation(api.items.update);
  const ids = {
    name: useId(),
    subcategory: useId(),
    primary: useId(),
    secondary: useId(),
    pattern: useId(),
    material: useId(),
    brand: useId(),
    notes: useId(),
  };

  const [editor, setEditor] = useState(() => {
    const source = draftOf(item);
    return { source, saved: source, draft: source };
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { draft, saved } = editor;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const live = draftOf(item);

  if (JSON.stringify(live) !== JSON.stringify(editor.source)) {
    setEditor({ ...editor, source: live, ...(!dirty && !pending ? { saved: live, draft: live } : {}) });
  }

  function patch(next: Partial<Draft>) {
    setEditor((current) => ({ ...current, draft: { ...current.draft, ...next } }));
  }

  async function handleSave() {
    if (!dirty || pending) return;
    if (draft.name.trim().length === 0) {
      setError("Give the item a name.");
      return;
    }
    setError(null);
    const changes = changedAttributes(draft, saved, item);
    if (Object.keys(changes).length === 0) {
      setEditor({ source: live, saved: live, draft: live });
      return;
    }
    setPending(true);
    try {
      await update({
        itemId: item._id,
        patch: changes,
      });
      setEditor((current) => {
        const { colours, ...attributes } = changes;
        const accepted = {
          ...current.source,
          ...attributes,
          ...(colours ? { primary: colours.primary, secondary: [...colours.secondary] } : {}),
        };
        return { ...current, saved: accepted, draft: accepted };
      });
      toast.success("Saved.");
    } catch (caught) {
      setError(reportError(caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-6 [&_[data-slot=input]]:h-10 [&_[data-slot=input]]:bg-card [&_[data-slot=input]]:shadow-none [&_[data-slot=select-trigger]]:h-10 [&_[data-slot=select-trigger]]:bg-card [&_[data-slot=select-trigger]]:shadow-none"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor={ids.name}>Name</FieldLabel>
          <Input
            id={ids.name}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            disabled={pending}
            required
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${ids.subcategory}-category`}>Category</FieldLabel>
            <Select
              value={draft.category}
              onValueChange={(next) => {
                if (next) patch({ category: next });
              }}
              disabled={pending}
            >
              <SelectTrigger id={`${ids.subcategory}-category`} className="w-full">
                <SelectValue>
                  {(value: Category | null) => (value ? CATEGORY_LABELS[value] : "Choose a category")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {CATEGORY_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor={ids.subcategory}>Subcategory</FieldLabel>
            <Input
              id={ids.subcategory}
              value={draft.subcategory}
              onChange={(event) => patch({ subcategory: event.target.value })}
              placeholder="e.g. oxford shirt"
              disabled={pending}
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={ids.primary}>Primary colour</FieldLabel>
            <Input
              id={ids.primary}
              value={draft.primary}
              onChange={(event) => patch({ primary: event.target.value })}
              placeholder="e.g. navy"
              disabled={pending}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={ids.secondary}>Other colours</FieldLabel>
            <ChipsInput
              id={ids.secondary}
              value={draft.secondary}
              onValueChange={(secondary) => patch({ secondary })}
              placeholder="Add a colour"
              disabled={pending}
              swatches
            />
          </Field>
        </div>

        <Collapsible className="border-y border-border">
          <CollapsibleTrigger
            render={<Button variant="ghost" className="h-14 w-full justify-between rounded-none px-0" />}
          >
            Fabric, fit & styling
            <ChevronDown className="size-4" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-5 pb-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={ids.pattern}>Pattern</FieldLabel>
                <Input
                  id={ids.pattern}
                  value={draft.pattern}
                  onChange={(event) => patch({ pattern: event.target.value })}
                  placeholder="e.g. solid, striped"
                  disabled={pending}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor={ids.material}>Material</FieldLabel>
                <Input
                  id={ids.material}
                  value={draft.material}
                  onChange={(event) => patch({ material: event.target.value })}
                  placeholder="e.g. cotton"
                  disabled={pending}
                />
              </Field>
            </div>

            <FieldSet disabled={pending}>
              <FieldLegend variant="label">Season</FieldLegend>
              <FieldDescription>Leave empty if it works all year.</FieldDescription>
              <MultiToggleGroup
                options={SEASONS}
                value={draft.season}
                onValueChange={(season) => patch({ season })}
                disabled={pending}
                aria-label="Season"
              />
            </FieldSet>

            <FieldSet disabled={pending}>
              <FieldLegend variant="label">Formality</FieldLegend>
              <SingleToggleGroup
                options={FORMALITY}
                value={draft.formality}
                onValueChange={(formality) => patch({ formality })}
                label={(option) => FORMALITY_LABELS[option]}
                disabled={pending}
                aria-label="Formality"
              />
            </FieldSet>

            <FieldSet disabled={pending}>
              <FieldLegend variant="label">Fit</FieldLegend>
              <SingleToggleGroup
                options={FITS}
                value={draft.fit}
                onValueChange={(fit) => patch({ fit })}
                disabled={pending}
                aria-label="Fit"
              />
            </FieldSet>

            <Field>
              <FieldLabel htmlFor={ids.brand}>Brand</FieldLabel>
              <Input
                id={ids.brand}
                value={draft.brand}
                onChange={(event) => patch({ brand: event.target.value })}
                disabled={pending}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={ids.notes}>Notes</FieldLabel>
              <Textarea
                id={ids.notes}
                value={draft.notes}
                onChange={(event) => patch({ notes: event.target.value })}
                rows={3}
                placeholder="Anything the stylist should know — runs small, needs dry cleaning…"
                disabled={pending}
              />
            </Field>
          </CollapsibleContent>
        </Collapsible>
      </FieldGroup>

      {error ? <ErrorAlert title="Could not save" message={error} /> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" className="h-11 rounded-full px-6" disabled={!dirty || pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          Save changes
        </Button>
        {dirty && !pending ? <span className="text-sm text-muted-foreground">Unsaved changes</span> : null}
      </div>
    </form>
  );
}
