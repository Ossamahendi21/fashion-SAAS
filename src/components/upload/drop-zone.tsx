"use client";

import { ImagePlus, UploadCloud } from "lucide-react";
import type { ReactNode } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ACCEPTED_IMAGE_TYPES, MAX_UPLOAD_BYTES } from "@convex/shared/wardrobe";

export type { FileRejection };

type DropZoneProps = {
  onDrop: (accepted: File[], rejections: FileRejection[]) => void;
  multiple?: boolean;
  maxFiles?: number;
  disabled?: boolean;
  /** `lg` is the upload workspace; `sm` sits above a list. */
  size?: "sm" | "lg";
  title: string;
  description: string;
  buttonLabel?: string;
  hint?: ReactNode;
  className?: string;
};

/**
 * The one drop zone: same accepted types, size cap and affordances everywhere a photo goes in.
 * Keyboard users reach the file picker through the button, so the root is not a second tab stop.
 */
export function DropZone({
  onDrop,
  multiple = false,
  maxFiles,
  disabled = false,
  size = "sm",
  title,
  description,
  buttonLabel = "Choose photos",
  hint,
  className,
}: DropZoneProps) {
  const { getRootProps, getInputProps, isDragActive, isDragReject, open } = useDropzone({
    onDrop,
    accept: ACCEPTED_IMAGE_TYPES,
    maxSize: MAX_UPLOAD_BYTES,
    multiple,
    maxFiles,
    disabled,
    noKeyboard: true,
  });

  return (
    <div
      {...getRootProps({
        className: cn(
          "group relative flex flex-col items-center justify-center gap-3 border border-dashed border-foreground/25 bg-background/60 text-center transition-colors",
          size === "lg" ? "min-h-56 px-5 py-6" : "px-4 py-5",
          disabled ? "pointer-events-none opacity-60" : "cursor-pointer hover:border-foreground/25 hover:bg-muted/50",
          isDragActive && "border-primary/60 bg-primary/5",
          isDragReject && "border-destructive/60 bg-destructive/5",
          className,
        ),
      })}
    >
      <input {...getInputProps()} />
      <div
        className={cn(
          "flex items-center justify-center text-foreground transition-colors",
          size === "lg" ? "size-7" : "size-6",
          isDragActive && "text-primary ring-primary/40",
        )}
        aria-hidden
      >
        {isDragActive ? <UploadCloud className="size-5" /> : <ImagePlus className="size-5" />}
      </div>
      <div className="space-y-2">
        <p className={cn("font-medium text-balance", size === "lg" ? "text-base tracking-tight" : "text-sm")}>
          {isDragActive ? "Drop to upload" : title}
        </p>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-pretty text-muted-foreground">{description}</p>
      </div>
      <Button
        type="button"
        variant={size === "lg" ? "default" : "outline"}
        size={size === "lg" ? "lg" : "sm"}
        className={cn("rounded-sm", size === "lg" && "h-10 min-w-40 px-6")}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
      >
        {buttonLabel}
      </Button>
      <p className="text-xs text-muted-foreground">
        {hint ?? `JPG, PNG or WebP · up to ${formatBytes(MAX_UPLOAD_BYTES)} each`}
      </p>
    </div>
  );
}

/** Turns react-dropzone rejections into one readable line per file. */
export function describeRejection(rejection: FileRejection): string {
  const reason = rejection.errors[0];
  if (!reason) return `${rejection.file.name} was not accepted.`;
  if (reason.code === "file-too-large")
    return `${rejection.file.name} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}.`;
  if (reason.code === "file-invalid-type") return `${rejection.file.name} is not a JPG, PNG or WebP image.`;
  if (reason.code === "too-many-files") return `${rejection.file.name} went over the file limit.`;
  return `${rejection.file.name}: ${reason.message}`;
}
