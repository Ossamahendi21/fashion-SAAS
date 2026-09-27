"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";

type ThemeOption = { value: string; label: string; description: string; icon: LucideIcon };

const OPTIONS: readonly ThemeOption[] = [
  { value: "light", label: "Light", description: "Always the light palette.", icon: Sun },
  { value: "dark", label: "Dark", description: "Always the dark palette.", icon: Moon },
  { value: "system", label: "System", description: "Follow your device setting.", icon: Monitor },
];

/** Hydration probe: false on the server and during hydration, true afterwards. No effect, no cascading render. */
const subscribeToNothing = () => () => {};
const isMounted = () => true;
const isNotMounted = () => false;

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  // `theme` is only known in the browser, so the radios wait for hydration rather than flashing the wrong one.
  const mounted = useSyncExternalStore(subscribeToNothing, isMounted, isNotMounted);

  return (
    <section
      id="appearance"
      className="grid scroll-mt-24 gap-6 border-t py-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10"
    >
      <header className="space-y-2">
        <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">03 / The studio</p>
        <h2 className="text-xl font-semibold tracking-tight">Appearance</h2>
        <p className="text-sm text-muted-foreground">Applies to this browser only.</p>
      </header>
      <div className="min-w-0">
        {!mounted ? (
          <div className="grid gap-2 sm:grid-cols-3" aria-busy="true" aria-label="Loading theme">
            {OPTIONS.map((option) => (
              <Skeleton key={option.value} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : (
          <RadioGroup
            aria-label="Theme"
            className="sm:grid-cols-3"
            value={theme ?? "system"}
            onValueChange={(value) => setTheme(String(value))}
          >
            {OPTIONS.map((option) => (
              <FieldLabel key={option.value} htmlFor={`theme-${option.value}`}>
                <Field orientation="horizontal" className="rounded-none border-foreground/15 bg-background/50 py-5">
                  <FieldContent>
                    <FieldTitle>
                      <option.icon className="size-4 text-muted-foreground" aria-hidden />
                      {option.label}
                    </FieldTitle>
                    <FieldDescription>{option.description}</FieldDescription>
                  </FieldContent>
                  <RadioGroupItem id={`theme-${option.value}`} value={option.value} />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
        )}
      </div>
    </section>
  );
}
