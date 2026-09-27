export const JOB_TYPES = ["ingest", "render"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "done", "partial", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["done", "partial", "failed", "cancelled"];

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/**
 * Stable step keys. Dynamic steps use a prefix + index (`extract:3`, `render:1`);
 * `stepLabel` turns any key into copy for the UI.
 */
export const INGEST_STEPS = {
  upload: "upload",
  detect: "detect",
  review: "review",
  reserve: "reserve",
  extract: "extract",
  finalize: "finalize",
} as const;

export const RENDER_STEPS = {
  reserve: "reserve",
  render: "render",
  finalize: "finalize",
} as const;

const STATIC_LABELS: Record<string, string> = {
  upload: "Uploaded",
  detect: "Detecting items",
  review: "Ready to review",
  reserve: "Reserving credits",
  finalize: "Finishing up",
};

export function stepLabel(key: string, meta?: Record<string, unknown>): string {
  if (STATIC_LABELS[key]) {
    if (key === "detect" && typeof meta?.found === "number") {
      return meta.found === 1 ? "Found 1 item" : `Found ${meta.found} items`;
    }
    return STATIC_LABELS[key];
  }
  const [prefix, index] = key.split(":");
  const n = index ? Number(index) + 1 : undefined;
  if (prefix === "extract") return n ? `Extracting item ${n}` : "Extracting items";
  if (prefix === "render") return n ? `Rendering image ${n}` : "Rendering";
  return key;
}

export function stepIndex(key: string): number | null {
  const [, index] = key.split(":");
  return index === undefined ? null : Number(index);
}

/** `extract:3` → `extract`; static keys map to themselves. Used for step-duration statistics. */
export function stepPrefix(key: string): string {
  const [prefix] = key.split(":");
  return prefix || key;
}
