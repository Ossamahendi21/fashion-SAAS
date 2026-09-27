import { ConvexError } from "convex/values";
import { toast } from "sonner";
import type { AppErrorData, ErrorCode } from "@convex/lib/errors";

export type ClientError = { code: ErrorCode | "UNKNOWN"; message: string; details?: Record<string, unknown> };

/** Normalise anything thrown by a Convex call (or fetch) into `{ code, message }` the UI can act on. */
export function toClientError(error: unknown): ClientError {
  if (error instanceof ConvexError) {
    const data = error.data as Partial<AppErrorData> | string;
    if (typeof data === "string") return { code: "UNKNOWN", message: data };
    return { code: data.code ?? "UNKNOWN", message: data.message ?? "Something went wrong.", details: data.details };
  }
  if (error instanceof Error) return { code: "UNKNOWN", message: error.message || "Something went wrong." };
  return { code: "UNKNOWN", message: "Something went wrong." };
}

/** Show a toast for an error and return it so callers can branch on `code`. */
export function reportError(error: unknown, fallback?: string): ClientError {
  const clientError = toClientError(error);
  toast.error(fallback && clientError.code === "UNKNOWN" ? fallback : clientError.message);
  return clientError;
}

/** Notified with the normalised error after it has already been toasted, for inline `<ErrorAlert>`s. */
export type ErrorSink = (error: ClientError) => void;

/**
 * Runs a mutation/action, toasts whatever it throws and resolves to `undefined` so callers can bail quietly.
 * Convex functions that succeed return `null` at worst, so `undefined` unambiguously means "failed".
 */
export async function guardMutation<T>(run: () => Promise<T>, onError?: ErrorSink): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    const clientError = reportError(error);
    onError?.(clientError);
    return undefined;
  }
}
