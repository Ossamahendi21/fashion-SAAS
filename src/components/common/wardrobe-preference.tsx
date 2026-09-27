"use client";

import { useId } from "react";
import { FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { Presentation } from "@convex/shared/wardrobe";

export type WardrobePresentation = Exclude<Presentation, "neutral">;

const OPTIONS: { value: WardrobePresentation; label: string }[] = [
  { value: "masculine", label: "Men’s wardrobe" },
  { value: "feminine", label: "Women’s wardrobe" },
];

export function WardrobePreference({
  value,
  onChange,
  disabled = false,
  required = false,
}: {
  value: Presentation | null;
  onChange: (value: WardrobePresentation) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const id = useId();
  return (
    <FieldSet disabled={disabled}>
      <FieldLegend id={`${id}-label`} variant="label">
        Your wardrobe
      </FieldLegend>
      <FieldDescription id={`${id}-description`}>
        Choose men’s or women’s clothing for your examples and styling. You can change this in settings.
      </FieldDescription>
      <RadioGroup
        value={value === "neutral" ? null : value}
        onValueChange={(next) => {
          if (next === "masculine" || next === "feminine") onChange(next);
        }}
        disabled={disabled}
        required={required}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="grid grid-cols-2 gap-2"
      >
        {OPTIONS.map((option) => (
          <FieldLabel
            key={option.value}
            htmlFor={`${id}-${option.value}`}
            className="min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-sm border px-3 py-3 text-sm has-data-checked:border-foreground has-data-checked:bg-muted"
          >
            <RadioGroupItem id={`${id}-${option.value}`} value={option.value} />
            <span>{option.label}</span>
          </FieldLabel>
        ))}
      </RadioGroup>
      {value === null || value === "neutral" ? (
        <p className="text-xs text-muted-foreground">Choose a wardrobe to personalize your examples.</p>
      ) : null}
    </FieldSet>
  );
}
