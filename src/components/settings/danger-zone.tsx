"use client";

import { useClerk } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { api } from "@convex/_generated/api";

const CONFIRM_PHRASE = "DELETE";

export function DangerZone() {
  const deleteAllData = useMutation(api.users.deleteAllData);
  const { signOut } = useClerk();
  const [typed, setTyped] = useState("");

  async function handleDelete() {
    await deleteAllData({ confirm: CONFIRM_PHRASE });
    await signOut({ redirectUrl: routes.home });
  }

  return (
    <section id="data" className="grid scroll-mt-24 gap-6 border-t py-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
      <header className="space-y-2">
        <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">04 / Your data</p>
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <TriangleAlert className="size-4" aria-hidden />
          Wardrobe data
        </h2>
        <p className="text-sm text-muted-foreground">Manage the content stored in your account.</p>
      </header>
      <div className="space-y-4">
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
          Deleting removes your wardrobe, outfits, renders, photos and conversations permanently. Your account,
          subscription, credit balance and credit history are kept.
        </p>
        <ConfirmDialog
          trigger={<Button variant="destructive">Delete wardrobe data</Button>}
          title="Delete your wardrobe data?"
          description="Every item, outfit, render, avatar and conversation is erased, then you are signed out. Your subscription and credits stay available."
          confirmLabel="Delete wardrobe data"
          destructive
          confirmDisabled={typed.trim() !== CONFIRM_PHRASE}
          onOpenChange={(open) => !open && setTyped("")}
          onConfirm={handleDelete}
        >
          <Field>
            <FieldLabel htmlFor="confirm-delete">Type {CONFIRM_PHRASE} to confirm</FieldLabel>
            <Input
              id="confirm-delete"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={CONFIRM_PHRASE}
            />
            <FieldDescription>
              This wipes your account data. Your sign-in stays, so you can start again.
            </FieldDescription>
          </Field>
        </ConfirmDialog>
      </div>
    </section>
  );
}
