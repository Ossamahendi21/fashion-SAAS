import { ConvexError, type Value } from "convex/values";

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_INPUT",
  "INSUFFICIENT_CREDITS",
  "DAILY_CAP_REACHED",
  "TOO_MANY_JOBS",
  "RATE_LIMITED",
  "FEATURE_LOCKED",
  "SUBSCRIPTION_REFRESH_REQUIRED",
  "SPEND_KILL_SWITCH",
  "ONBOARDING_REQUIRED",
  "UPSTREAM_FAILED",
  "CONFLICT",
  "WARDROBE_FULL",
  "ITEM_BUSY",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type AppErrorDetails = Record<string, Value>;

export type AppErrorData = {
  code: ErrorCode;
  message: string;
  details?: AppErrorDetails;
};

/** All thrown application errors go through here so clients can switch on `error.data.code`. */
export function appError(code: ErrorCode, message: string, details?: AppErrorDetails): ConvexError<AppErrorData> {
  return new ConvexError<AppErrorData>({ code, message, ...(details ? { details } : {}) });
}

export function isAppError(error: unknown): error is ConvexError<AppErrorData> {
  return (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    "code" in error.data &&
    "message" in error.data
  );
}
