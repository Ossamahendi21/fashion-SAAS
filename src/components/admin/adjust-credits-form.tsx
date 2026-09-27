"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common/error-alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toClientError } from "@/lib/errors";
import { formatCredits } from "@/lib/format";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { FunctionArgs } from "convex/server";

type Bucket = FunctionArgs<typeof api.admin.adjustCredits>["bucket"];

const BUCKETS = ["plan", "pack"] as const satisfies readonly Bucket[];
const BUCKET_LABELS: Record<Bucket, string> = { plan: "Plan credits", pack: "Non-expiring credits" };

export function AdjustCreditsForm() {
  const adjustCredits = useMutation(api.admin.adjustCredits);
  const [userId, setUserId] = useState("");
  const [delta, setDelta] = useState("");
  const [bucket, setBucket] = useState<Bucket>("pack");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedDelta = Number.parseInt(delta, 10);
  const deltaValid = Number.isInteger(parsedDelta) && parsedDelta !== 0;
  const canSubmit = userId.trim().length > 0 && deltaValid && note.trim().length > 0 && !pending;

  async function handleSubmit() {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      await adjustCredits({
        userId: userId.trim() as Id<"users">,
        delta: parsedDelta,
        bucket,
        note: note.trim(),
      });
      toast.success(`Adjusted by ${formatCredits(parsedDelta, { signed: true })}.`);
      setUserId("");
      setDelta("");
      setNote("");
    } catch (caught) {
      setError(toClientError(caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Adjust credits</CardTitle>
        <CardDescription>
          Support-only manual correction. Writes one `admin` ledger line; negative values take credits away.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <ErrorAlert title="The adjustment did not go through" message={error} onRetry={() => void handleSubmit()} />
        ) : null}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="adjust-user">User id</FieldLabel>
            <FieldDescription>The Convex `users` document id, not the Clerk id.</FieldDescription>
            <Input
              id="adjust-user"
              value={userId}
              placeholder="j57..."
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setUserId(event.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="adjust-delta">Change</FieldLabel>
              <FieldDescription>Whole credits, e.g. 25 or -10.</FieldDescription>
              <Input
                id="adjust-delta"
                value={delta}
                inputMode="numeric"
                placeholder="25"
                className="tabular-nums"
                aria-invalid={delta.length > 0 && !deltaValid}
                onChange={(event) => setDelta(event.target.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="adjust-bucket">Bucket</FieldLabel>
              <FieldDescription>Non-expiring credits stay available; plan credits reset next cycle.</FieldDescription>
              <Select
                value={bucket}
                onValueChange={(value) => {
                  const next = BUCKETS.find((option) => option === value);
                  if (next) setBucket(next);
                }}
              >
                <SelectTrigger id="adjust-bucket" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUCKETS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {BUCKET_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="adjust-note">Note</FieldLabel>
            <FieldDescription>Shown to the user on their ledger. Required.</FieldDescription>
            <Input
              id="adjust-note"
              value={note}
              placeholder="Goodwill credit for the failed batch on 14 Sep"
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </FieldGroup>
      </CardContent>

      <CardFooter className="justify-end">
        <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Apply adjustment
        </Button>
      </CardFooter>
    </Card>
  );
}
