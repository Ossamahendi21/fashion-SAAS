"use client";

import { useAction, useConvexAuth } from "convex/react";
import { Images } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ItemImage } from "@/components/common/item-image";
import { ErrorAlert } from "@/components/common/error-alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { reportError } from "@/lib/errors";
import { pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { api } from "@convex/_generated/api";
import type { DemoWardrobeItem } from "@convex/shared/demo_wardrobe";

type Wardrobe = DemoWardrobeItem["wardrobe"];

export function SeedDemoWardrobe({ onSeeded }: { onSeeded: () => void }) {
  const seed = useAction(api.demoWardrobe.seed);
  const { isAuthenticated } = useConvexAuth();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [wardrobe, setWardrobe] = useState<Wardrobe | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSeed() {
    if (!wardrobe) return;
    setPending(true);
    setError(null);
    try {
      const { added, removed } = await seed({ wardrobe });
      onSeeded();
      setOpen(false);
      toast.success(
        added > 0 || removed > 0
          ? `${pluralize(added, "demo item")} added. No credits used.`
          : "This demo wardrobe is already added.",
      );
    } catch (error) {
      setError(reportError(error, "Could not add the demo wardrobe. Try again.").message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) {
          setWardrobe(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger render={<Button variant="ghost" className="h-10 rounded-full px-4" disabled={!isAuthenticated} />}>
        <Images data-icon="inline-start" />
        Seed demo wardrobe
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Choose a demo wardrobe</DialogTitle>
          <DialogDescription>Eight adult pieces to try Fitcheck. Free to add. Your own uploads stay.</DialogDescription>
        </DialogHeader>
        <RadioGroup
          aria-label="Demo wardrobe"
          className="grid grid-cols-2 gap-3"
          value={wardrobe}
          disabled={pending}
          onValueChange={(value) => {
            if (value === "men" || value === "women") setWardrobe(value);
          }}
        >
          {(["men", "women"] as const).map((choice) => (
            <Field
              key={choice}
              className={cn(
                "relative rounded-xl border p-3 transition-colors",
                wardrobe === choice ? "border-foreground bg-muted/50" : "border-border",
              )}
            >
              <FieldLabel htmlFor={`${id}-${choice}`} className="flex cursor-pointer flex-col gap-4">
                <span className="grid w-full grid-cols-2 gap-1" aria-hidden="true">
                  <ItemImage
                    src={
                      choice === "men"
                        ? "/demo-wardrobe/mens-cotton-jacket.png"
                        : "/demo-wardrobe/womens-leather-jacket.png"
                    }
                    alt=""
                    aspect="aspect-[3/4]"
                    className="rounded-none bg-transparent p-0 dark:bg-transparent"
                  />
                  <ItemImage
                    src={choice === "men" ? "/demo-wardrobe/blue-jeans.png" : "/demo-wardrobe/black-evening-gown.webp"}
                    alt=""
                    aspect="aspect-[3/4]"
                    className="rounded-none bg-transparent p-0 dark:bg-transparent"
                  />
                </span>
                <span className="flex w-full items-center gap-2.5 text-sm">
                  <RadioGroupItem id={`${id}-${choice}`} value={choice} />
                  {choice === "men" ? "Men’s wardrobe" : "Women’s wardrobe"}
                </span>
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Choosing a different collection replaces previously seeded demo pieces. Only the selected collection is added.
        </p>
        {error ? <ErrorAlert message={error} /> : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={pending || !wardrobe} onClick={() => void handleSeed()}>
            {pending ? <Spinner data-icon="inline-start" /> : <Images data-icon="inline-start" />}
            {pending
              ? "Adding demo wardrobe…"
              : wardrobe
                ? `Seed ${wardrobe === "men" ? "men's" : "women's"} wardrobe`
                : "Choose a wardrobe"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
