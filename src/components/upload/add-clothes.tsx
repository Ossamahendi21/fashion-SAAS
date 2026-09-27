"use client";

import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common/error-alert";
import { ItemImage } from "@/components/common/item-image";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { ImportQueue } from "./import-queue";
import { isUploadSuccess, useUpload, type UploadSuccess } from "@/hooks/use-upload";
import { toClientError, type ClientError } from "@/lib/errors";
import { formatCredits, pluralize } from "@/lib/format";
import { imageUploadMimeType } from "@/lib/image-upload";
import { routes } from "@/lib/routes";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { CREDIT_COSTS, LIMITS } from "@convex/shared/credits";
import { DEMO_WARDROBE } from "@convex/shared/demo_wardrobe";
import { describeRejection, DropZone, type FileRejection } from "./drop-zone";
import { PendingTile, type PendingFile } from "./pending-tile";
import { RecentUploads } from "./recent-uploads";
import { UploadTile } from "./upload-tile";

const EXAMPLE_KEYS = {
  masculine: ["v2-men-mens-cotton-jacket", "v2-men-blue-jeans", "v2-men-white-red-trainers"],
  feminine: ["v2-women-womens-blouse", "v2-women-blue-jeans", "v2-women-brown-leather-bag"],
} as const;

export function AddClothes() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const presentation = user?.prefs.presentation;
  const exampleKeys: readonly string[] = presentation && presentation !== "neutral" ? EXAMPLE_KEYS[presentation] : [];
  const exampleItems = DEMO_WARDROBE.filter((item) => exampleKeys.includes(item.key));
  const searchParams = useSearchParams();
  const batchId = searchParams.get("batch");

  const { isAuthenticated } = useConvexAuth();
  const rows = useQuery(api.uploads.listBatch, isAuthenticated && batchId ? { batchId } : "skip");
  const refreshSubscription = useAction(api.subscriptions.refresh);
  const createBatch = useMutation(api.uploads.createBatch);
  const resumeUpload = useMutation(api.uploads.resume);
  const { upload, uploadMany, progress } = useUpload("items");

  const [pending, setPending] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [batchError, setBatchError] = useState<ClientError | null>(null);
  const [resuming, setResuming] = useState<Id<"uploads"> | null>(null);
  const previewUrls = useRef<Map<string, string>>(new Map());
  const sourceFiles = useRef<Map<string, File>>(new Map());
  const working = useRef(false);
  const acceptedBatches = useRef(new Map<string, string>());
  /** The files that reached storage, kept so "Retry" can re-queue them without uploading again. */
  const uploaded = useRef<UploadSuccess[]>([]);

  useEffect(
    () => () => {
      for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
      previewUrls.current.clear();
      sourceFiles.current.clear();
    },
    [],
  );

  function goToBatch(id: string) {
    router.replace(`${routes.add}?batch=${encodeURIComponent(id)}`);
  }

  function openBatchFromHistory(id: string) {
    goToBatch(id);
  }

  const releaseFileResources = useCallback((keys: ReadonlySet<string>) => {
    for (const key of keys) {
      const url = previewUrls.current.get(key);
      if (url) URL.revokeObjectURL(url);
      previewUrls.current.delete(key);
      sourceFiles.current.delete(key);
      acceptedBatches.current.delete(key);
    }
    uploaded.current = uploaded.current.filter((entry) => !keys.has(entry.key));
  }, []);

  useEffect(() => {
    if (!batchId || rows === undefined) return;
    const visible = new Set(
      [...acceptedBatches.current].filter(([, acceptedBatchId]) => acceptedBatchId === batchId).map(([key]) => key),
    );
    if (visible.size > 0) releaseFileResources(visible);
  }, [batchId, releaseFileResources, rows]);

  function dismissPending(key: string) {
    if (working.current) return;
    releaseFileResources(new Set([key]));
    setPending((current) => current.filter((entry) => entry.key !== key));
    setBatchError(null);
  }

  /** Turns stored files into a batch. Separate from the drop so "Retry" can run it again unchanged. */
  async function queueBatch(files: readonly UploadSuccess[]) {
    if (files.length === 0) return;
    const queued = new Set(files.map(({ key }) => key));
    try {
      const batch = await createBatch({
        files: files.map(({ file, storageId }) => ({
          storageId,
          fileName: file.name,
          mimeType: imageUploadMimeType(file),
          sizeBytes: file.size,
        })),
      });
      setBatchError(null);
      for (const key of queued) acceptedBatches.current.set(key, batch.batchId);
      setPending((current) =>
        current.map((entry) =>
          queued.has(entry.key) ? { ...entry, error: undefined, acceptedBatchId: batch.batchId } : entry,
        ),
      );
      goToBatch(batch.batchId);
    } catch (caught) {
      const error = toClientError(caught);
      setBatchError(error);
      setPending((current) =>
        current.map((entry) => (queued.has(entry.key) ? { ...entry, error: entry.error ?? error.message } : entry)),
      );
      toast.error(error.message);
    }
  }

  async function retryPending(key: string) {
    if (working.current || acceptedBatches.current.has(key)) return;
    const file = sourceFiles.current.get(key);
    if (!file) return;
    working.current = true;
    setBusy(true);
    setBatchError(null);
    setPending((current) => current.map((entry) => (entry.key === key ? { ...entry, error: undefined } : entry)));
    try {
      let stored = uploaded.current.find((entry) => entry.key === key);
      if (!stored) {
        stored = { key, file, storageId: await upload(file, key) };
        uploaded.current.push(stored);
      }
      await queueBatch([stored]);
    } catch (caught) {
      const error = toClientError(caught);
      setPending((current) => current.map((entry) => (entry.key === key ? { ...entry, error: error.message } : entry)));
      toast.error(`${file.name}: ${error.message}`);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function handleDrop(accepted: File[], rejections: FileRejection[]) {
    for (const rejection of rejections) toast.error(describeRejection(rejection));
    if (accepted.length === 0 || working.current) return;

    const files = accepted.slice(0, LIMITS.maxPhotosPerUpload);
    if (accepted.length > files.length) {
      toast.warning(`Only the first ${pluralize(LIMITS.maxPhotosPerUpload, "photo")} were taken from this drop.`);
    }

    const stamp = crypto.randomUUID();
    const entries = files.map((file, index) => ({
      key: `${stamp}-${index}-${file.name}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    for (const entry of entries) {
      previewUrls.current.set(entry.key, entry.previewUrl);
      sourceFiles.current.set(entry.key, entry.file);
    }
    setPending((current) => [
      ...current,
      ...entries.map(({ key, file, previewUrl }) => ({ key, name: file.name, sizeBytes: file.size, previewUrl })),
    ]);
    setBatchError(null);
    working.current = true;
    setBusy(true);

    try {
      // `uploadMany` never rejects: each entry carries its own error.
      const results = await uploadMany(
        entries.map(({ key, file }) => ({ key, file })),
        4,
      );
      for (const result of results) {
        if (result.error) toast.error(`${result.file.name}: ${result.error}`);
      }
      setPending((current) =>
        current.map((file) => {
          const result = results.find((entry) => entry.key === file.key);
          return result?.error ? { ...file, error: result.error } : file;
        }),
      );
      const successful = results.filter(isUploadSuccess);
      uploaded.current.push(...successful);
      if (successful.length > 0) await queueBatch(successful);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function handleResume(uploadId: Id<"uploads">) {
    setResuming(uploadId);
    try {
      await refreshSubscription({});
      await resumeUpload({ uploadId });
      toast.success("Extraction restarted.");
    } catch (caught) {
      const error = toClientError(caught);
      toast.error(error.message, {
        action:
          error.code === "INSUFFICIENT_CREDITS"
            ? { label: "View plans", onClick: () => router.push(`${routes.billing}#plans`) }
            : undefined,
      });
    } finally {
      setResuming(null);
    }
  }

  // Keep each accepted photo in place through navigation and the first subscription result.
  const visiblePending = pending.filter(
    (file) => !file.acceptedBatchId || file.acceptedBatchId !== batchId || rows === undefined,
  );
  if (visiblePending.length !== pending.length) setPending(visiblePending);
  const showPending = visiblePending.length > 0;
  const awaitingCurrentBatch = rows === undefined && pending.some((file) => file.acceptedBatchId === batchId);
  const showBatch = Boolean(batchId) && !awaitingCurrentBatch;

  return (
    <div className="@container space-y-6">
      <PageHeader
        eyebrow="Wardrobe studio"
        title="Add clothes."
        description="Upload photos. Choose the pieces to keep."
      />

      <div className="grid gap-5 border-t pt-5 @3xl:grid-cols-[minmax(250px,0.7fr)_minmax(0,1.3fr)] @3xl:gap-8 @3xl:pt-6">
        <aside className="space-y-4 @3xl:space-y-6 @3xl:border-r @3xl:pr-8">
          <section className="space-y-3" aria-labelledby="upload-photos-heading">
            <h2
              id="upload-photos-heading"
              className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase"
            >
              01 / Your photos
            </h2>
            <DropZone
              onDrop={handleDrop}
              multiple
              maxFiles={LIMITS.maxPhotosPerUpload}
              disabled={busy}
              size="lg"
              className="min-h-0 gap-2 px-4 py-4 sm:min-h-56 @3xl:gap-3 @3xl:px-5 @3xl:py-6"
              title="Drop your photos here"
              description={`One piece or a whole outfit. Up to ${LIMITS.maxPhotosPerUpload} photos.`}
              buttonLabel={busy ? "Uploading…" : "Select photos"}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Free scan. Choose what to keep. {formatCredits(CREDIT_COSTS.extractItem)} per imported piece.
            </p>
          </section>
          <details className="border-t pt-4">
            <summary className="cursor-pointer font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase focus-visible:outline-2 focus-visible:outline-offset-4">
              Tips for a cleaner cutout
            </summary>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed">
              <li>
                <span className="font-medium">Keep the whole piece in frame.</span>
                <br />
                <span className="text-muted-foreground">Include sleeves, hems and shoes.</span>
              </li>
              <li>
                <span className="font-medium">Use light and a simple background.</span>
                <br />
                <span className="text-muted-foreground">Lay pieces flat or photograph them on a hanger.</span>
              </li>
              <li>
                <span className="font-medium">Give each piece some space.</span>
                <br />
                <span className="text-muted-foreground">Avoid overlapping garments in group photos.</span>
              </li>
            </ul>
          </details>
        </aside>

        <div className="min-w-0 space-y-6">
          {!showBatch && !showPending ? (
            <>
              <ImportQueue />
              <RecentUploads activeBatchId={batchId} onOpenBatch={openBatchFromHistory} />
            </>
          ) : null}
          {showPending ? (
            <section className="space-y-4" aria-labelledby="upload-progress-heading">
              <div className="flex items-center justify-between gap-3 border-b pb-3">
                <h2 id="upload-progress-heading" className="text-xl font-semibold tracking-tight">
                  {busy
                    ? "Uploading your photos"
                    : visiblePending.some((file) => file.acceptedBatchId)
                      ? "Preparing your scan"
                      : "Photos to retry"}
                </h2>
                <span className="text-xs text-muted-foreground">{pluralize(visiblePending.length, "photo")}</span>
              </div>
              {batchError?.code === "WARDROBE_FULL" ? (
                <ErrorAlert
                  title="Your wardrobe is full"
                  message={
                    <>
                      {batchError.message}{" "}
                      <Link href={routes.wardrobe} className="font-medium underline underline-offset-4">
                        Delete a few items
                      </Link>{" "}
                      and try again.
                    </>
                  }
                />
              ) : null}
              <div className="space-y-5">
                {visiblePending.map((file) => (
                  <PendingTile
                    key={file.key}
                    file={file}
                    progress={progress[file.key] ?? 0}
                    onRetry={file.error ? () => void retryPending(file.key) : undefined}
                    onDismiss={file.error ? () => dismissPending(file.key) : undefined}
                    disabled={busy}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {showBatch ? (
            <section className="space-y-4" aria-labelledby="scan-results-heading">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                <h2 id="scan-results-heading" className="text-xl font-semibold tracking-tight">
                  Your scan
                </h2>
                <Button variant="ghost" nativeButton={false} render={<Link href={routes.wardrobe} />}>
                  View wardrobe
                </Button>
              </div>
              {rows === undefined ? (
                <BatchSkeleton />
              ) : rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">That batch is no longer available.</p>
              ) : (
                <div className="space-y-6">
                  {rows.map((row) => (
                    <UploadTile
                      key={row.upload._id}
                      row={row}
                      onResume={handleResume}
                      resuming={resuming === row.upload._id}
                    />
                  ))}
                </div>
              )}
            </section>
          ) : !showPending ? (
            <section className="space-y-3 border-t pt-4" aria-labelledby="scan-preview-heading">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                    02 / The cutouts
                  </p>
                  <h2 id="scan-preview-heading" className="text-lg font-medium tracking-tight">
                    Scan. Select. Style.
                  </h2>
                </div>
                <span className="shrink-0 border px-2 py-1 text-[10px] tracking-wider text-muted-foreground uppercase">
                  Example pieces
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 bg-muted/40 p-3">
                {exampleItems.map((item) => (
                  <figure key={item.key} className="min-w-0 space-y-3">
                    <ItemImage
                      src={item.imagePath}
                      alt={item.attributes.name}
                      aspect="aspect-auto"
                      className="h-28 rounded-none bg-transparent p-1 dark:bg-transparent"
                      priority
                    />
                    <figcaption className="text-center text-[11px] leading-snug text-muted-foreground">
                      {item.attributes.name}
                    </figcaption>
                  </figure>
                ))}
              </div>
              {exampleItems.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Choose men’s or women’s clothing in{" "}
                  <Link href={routes.settings} className="underline underline-offset-4">
                    your preferences
                  </Link>{" "}
                  to personalise your examples.
                </p>
              ) : null}
              <ol className="grid gap-4 pb-2 sm:grid-cols-3">
                {[
                  ["Scan", "We identify the clothing in each photo."],
                  ["Select", "Choose only the pieces you want."],
                  ["Import", "Confirmed pieces join your wardrobe."],
                ].map(([title, description], index) => (
                  <li key={title} className="space-y-1">
                    <p className="text-sm font-medium">
                      <span className="mr-2 text-xs text-muted-foreground">0{index + 1}</span>
                      {title}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {showBatch || showPending ? (
            <RecentUploads activeBatchId={batchId} onOpenBatch={openBatchFromHistory} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BatchSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading batch">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="space-y-4 border-b pb-5">
          <div className="flex items-center gap-3">
            <Skeleton className="size-12 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
