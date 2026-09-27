"use client";

import { ImageOff } from "lucide-react";
import { useCallback, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type ItemImageProps = {
  /** Signed storage URL, or null/undefined while extracting or missing. */
  src: string | null | undefined;
  alt: string;
  /** Renders preserve the full generated portrait; photos fill their frame. */
  variant?: "cutout" | "photo" | "render";
  aspect?: string;
  className?: string;
  imgClassName?: string;
  priority?: boolean;
};

/**
 * The one way to show a garment cutout, avatar or render. Handles the loading shimmer,
 * missing images and object-fit so every tile in the app looks the same.
 */
export function ItemImage({ src, alt, variant = "cutout", aspect, className, imgClassName, priority }: ItemImageProps) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const loaded = Boolean(src && loadedSrc === src);
  const failed = Boolean(src && failedSrc === src);
  const showImage = Boolean(src) && !failed;
  const imageRef = useCallback(
    (node: HTMLImageElement | null) => {
      // Cached images can finish before React attaches onLoad on a return visit.
      if (node?.complete && node.naturalWidth > 0) setLoadedSrc(src ?? null);
    },
    [src],
  );

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl",
        variant === "cutout" ? "bg-muted/60 p-3 dark:bg-muted/40" : "bg-muted",
        aspect ?? (variant === "render" ? "aspect-[2/3]" : "aspect-[3/4]"),
        className,
      )}
    >
      {!loaded || !showImage ? <Skeleton className="absolute inset-0 rounded-xl" /> : null}
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- storage URLs are signed and short-lived; next/image would re-fetch on every render
        <img
          ref={imageRef}
          key={src}
          src={src ?? undefined}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => setLoadedSrc(src ?? null)}
          onError={() => setFailedSrc(src ?? null)}
          className={cn(
            "relative size-full",
            variant === "photo" ? "object-cover" : "object-contain",
            variant === "cutout" && "drop-shadow-sm",
            imgClassName,
          )}
        />
      ) : null}
      {!src && !failed ? null : failed ? (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <ImageOff className="size-5" aria-hidden />
          <span className="sr-only">Image unavailable</span>
        </div>
      ) : null}
    </div>
  );
}
