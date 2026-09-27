"use client";

import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { ArrowRight, Check, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorAlert } from "@/components/common/error-alert";
import { ItemImage } from "@/components/common/item-image";
import { describeRejection, DropZone, type FileRejection } from "@/components/upload/drop-zone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useUpload } from "@/hooks/use-upload";
import { reportError } from "@/lib/errors";
import { pluralize } from "@/lib/format";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { PLANS, type PlanId } from "@convex/shared/credits";
import { PhotoTips } from "./photo-tips";

type AvatarStepProps = {
  plan: PlanId;
  onContinue: () => void;
};

type Pending = { key: string; name: string };

function labelFromFile(file: File, index: number): string {
  const base = file.name.replace(/\.[^.]+$/, "").trim();
  return base.length > 0 && base.length <= 40 ? base : `Photo ${index + 1}`;
}

/** Step 1: at least one photo of the user, and which one renders use by default. */
export function AvatarStep({ plan, onContinue }: AvatarStepProps) {
  const { isAuthenticated } = useConvexAuth();
  const avatars = useQuery(api.avatars.list, isAuthenticated ? {} : "skip");
  const refreshSubscription = useAction(api.subscriptions.refresh);
  const createAvatar = useMutation(api.avatars.create);
  const setDefault = useMutation(api.avatars.setDefault);
  const removeAvatar = useMutation(api.avatars.remove);
  const { upload, progress } = useUpload("avatars");

  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState<Id<"avatars"> | null>(null);

  const maxAvatars = PLANS[plan].maxAvatars;
  const count = avatars?.length ?? 0;
  const remaining = Math.max(0, maxAvatars - count - pending.length);
  const busy = pending.length > 0;

  async function handleDrop(accepted: File[], rejections: FileRejection[]) {
    for (const rejection of rejections) toast.error(describeRejection(rejection));
    if (accepted.length === 0) return;
    if (remaining === 0) {
      toast.error(`Your plan allows ${pluralize(maxAvatars, "photo")}. Remove one to add another.`);
      return;
    }
    const files = accepted.slice(0, remaining);
    if (accepted.length > files.length) {
      toast.warning(
        `Only ${pluralize(files.length, "photo")} added — your plan allows ${pluralize(maxAvatars, "photo")}.`,
      );
    }

    const entries = files.map((file, index) => ({ key: `${Date.now()}-${index}-${file.name}`, file, index }));
    setPending(entries.map(({ key, file, index }) => ({ key, name: labelFromFile(file, count + index) })));
    setError(null);

    try {
      for (const { key, file, index } of entries) {
        const storageId = await upload(file, key);
        await refreshSubscription({});
        await createAvatar({ storageId, label: labelFromFile(file, count + index) });
      }
      toast.success(files.length === 1 ? "Photo added." : `${files.length} photos added.`);
    } catch (caught) {
      setError(reportError(caught).message);
    } finally {
      setPending([]);
    }
  }

  async function handleSetDefault(avatarId: Id<"avatars">) {
    setSettingDefault(avatarId);
    try {
      await setDefault({ avatarId });
    } catch (caught) {
      reportError(caught);
    } finally {
      setSettingDefault(null);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-12">
      <div className="space-y-4">
        <DropZone
          onDrop={handleDrop}
          multiple={maxAvatars > 1}
          maxFiles={Math.max(1, remaining)}
          disabled={busy || remaining === 0 || avatars === undefined}
          size="lg"
          title="A full-length photo of you"
          description="Keep your head and shoes in frame, with your arms relaxed by your sides."
          buttonLabel={busy ? "Uploading…" : "Choose a photo"}
          hint={
            remaining === 0
              ? `You have used all ${pluralize(maxAvatars, "photo")} on the ${PLANS[plan].name} plan.`
              : `${pluralize(count, "photo")} of ${maxAvatars} used · JPG, PNG or WebP`
          }
        />

        {pending.length > 0 ? (
          <ul className="space-y-2" aria-live="polite">
            {pending.map((entry) => {
              const value = Math.round((progress[entry.key] ?? 0) * 100);
              return (
                <li key={entry.key} className="space-y-1.5 rounded-lg border p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Spinner className="size-4" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{value}%</span>
                  </div>
                  <Progress value={value} aria-label={`Uploading ${entry.name}`} />
                </li>
              );
            })}
          </ul>
        ) : null}

        {error ? (
          <ErrorAlert title="Upload failed" message={error} onRetry={() => setError(null)} retryLabel="Dismiss" />
        ) : null}

        <p className="text-xs leading-relaxed text-muted-foreground">
          Your default photo is selected for new renders. You can replace it later in settings.
        </p>
      </div>
      <div className="min-w-0 space-y-5">
        {avatars === undefined ? (
          <div className="grid grid-cols-2 gap-5">
            {Array.from({ length: 2 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="aspect-[3/4] w-full rounded-xl" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ))}
          </div>
        ) : avatars.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Your photos</p>
            <ul className="grid grid-cols-2 gap-5">
              {avatars.map((avatar) => (
                <li key={avatar._id} className="space-y-2">
                  <div className="relative">
                    <ItemImage
                      src={avatar.url}
                      alt={avatar.label}
                      variant="photo"
                      aspect="aspect-[2/3]"
                      className="rounded-none"
                      imgClassName="object-contain"
                    />
                    {avatar.isDefault ? (
                      <Badge className="absolute top-2 left-2 gap-1">
                        <Check aria-hidden />
                        Default
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-sm">{avatar.label}</span>
                    <ConfirmDialog
                      trigger={
                        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${avatar.label}`}>
                          <Trash2 />
                        </Button>
                      }
                      title="Remove this photo?"
                      description="You can add another one straight away."
                      confirmLabel="Remove"
                      destructive
                      onConfirm={() => removeAvatar({ avatarId: avatar._id })}
                    />
                  </div>
                  {avatar.isDefault ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => handleSetDefault(avatar._id)}
                      disabled={settingDefault !== null}
                    >
                      {settingDefault === avatar._id ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <Star data-icon="inline-start" />
                      )}
                      Make default
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <PhotoTips />
        )}
      </div>

      <div className="flex items-center justify-between gap-4 border-t pt-5 lg:col-span-2">
        <p className="text-xs text-muted-foreground">
          {count > 0 ? "Photo added. Next, choose your styling preferences." : "Add a photo to continue."}
        </p>
        <Button size="lg" className="h-11 rounded-sm px-6" onClick={onContinue} disabled={count === 0 || busy}>
          Continue
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
