"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";

type SharedProps = {
  disabled?: boolean;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "outline";
  className?: string;
  "aria-label"?: string;
};

type SingleProps<T extends string> = SharedProps & {
  options: readonly T[];
  value: T | undefined;
  /** Never called with `undefined`: clicking the active option keeps it selected. */
  onValueChange: (value: T) => void;
  label?: (option: T) => string;
  /** Allow clearing back to `undefined`, e.g. an optional attribute. */
  clearable?: boolean;
  onClear?: () => void;
};

/** One-of-many toggle row. Wraps on phones instead of scrolling sideways. */
export function SingleToggleGroup<T extends string>({
  options,
  value,
  onValueChange,
  label = titleCase,
  clearable = false,
  onClear,
  disabled,
  size = "sm",
  variant = "outline",
  className,
  ...aria
}: SingleProps<T>) {
  return (
    <ToggleGroup
      value={value ? [value] : []}
      onValueChange={(next) => {
        const picked = next.at(-1);
        if (picked) onValueChange(picked as T);
        else if (clearable) onClear?.();
      }}
      disabled={disabled}
      size={size}
      variant={variant}
      aria-label={aria["aria-label"]}
      className={cn("flex-wrap", className)}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option} value={option}>
          {label(option)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

type MultiProps<T extends string> = SharedProps & {
  options: readonly T[];
  value: readonly T[];
  onValueChange: (value: T[]) => void;
  label?: (option: T) => string;
};

/** Any-of-many toggle row, e.g. seasons. */
export function MultiToggleGroup<T extends string>({
  options,
  value,
  onValueChange,
  label = titleCase,
  disabled,
  size = "sm",
  variant = "outline",
  className,
  ...aria
}: MultiProps<T>) {
  return (
    <ToggleGroup
      multiple
      value={value}
      onValueChange={(next) => onValueChange(next as T[])}
      disabled={disabled}
      size={size}
      variant={variant}
      aria-label={aria["aria-label"]}
      className={cn("flex-wrap", className)}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option} value={option}>
          {label(option)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
