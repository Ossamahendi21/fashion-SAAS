"use client";

import { Eye, EyeOff, Trash2, X } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { pluralize } from "@/lib/format";
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@convex/shared/wardrobe";

type SelectionBarProps = {
  count: number;
  /** True when every selected item is already hidden, so the button offers to unhide. */
  allHidden: boolean;
  pending: boolean;
  onClear: () => void;
  onSetStatus: (status: "hidden" | "ready") => void;
  onSetCategory: (category: Category) => void;
  onDelete: () => Promise<unknown>;
};

/** Sticky bulk actions. Appears only while something is selected. */
export function SelectionBar({
  count,
  allHidden,
  pending,
  onClear,
  onSetStatus,
  onSetCategory,
  onDelete,
}: SelectionBarProps) {
  const [category, setCategory] = useState<Category | null>(null);

  return (
    <div
      className="sticky z-30 mx-auto w-full max-w-3xl"
      style={{ bottom: "max(1rem, env(safe-area-inset-bottom, 0px))" }}
      role="region"
      aria-label="Selected items"
    >
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-popover/95 p-2 shadow-lg backdrop-blur">
        <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear selection">
          <X />
        </Button>
        <span className="px-1 text-sm font-medium tabular-nums">{pluralize(count, "item")} selected</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSetStatus(allHidden ? "ready" : "hidden")}
            disabled={pending}
          >
            {pending ? (
              <Spinner data-icon="inline-start" />
            ) : allHidden ? (
              <Eye data-icon="inline-start" />
            ) : (
              <EyeOff data-icon="inline-start" />
            )}
            {allHidden ? "Unhide" : "Hide"}
          </Button>

          <Select
            value={category}
            onValueChange={(next) => {
              if (!next) return;
              setCategory(null);
              onSetCategory(next);
            }}
            disabled={pending}
          >
            <SelectTrigger size="sm" className="w-44" aria-label="Change category">
              <SelectValue placeholder="Change category" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((option) => (
                <SelectItem key={option} value={option}>
                  {CATEGORY_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ConfirmDialog
            trigger={
              <Button variant="destructive" size="sm" disabled={pending}>
                <Trash2 data-icon="inline-start" />
                Delete
              </Button>
            }
            title={`Delete ${pluralize(count, "item")}?`}
            description="The cutouts are deleted and the items are removed from any outfits that use them. This cannot be undone."
            confirmLabel="Delete"
            destructive
            onConfirm={onDelete}
          />
        </div>
      </div>
    </div>
  );
}
