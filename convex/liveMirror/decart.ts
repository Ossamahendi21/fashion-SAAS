import { appError } from "../lib/errors";

/**
 * Pure server-side helpers for Live Mirror authorization. No Convex runtime imports here
 * so the decision logic stays unit-testable in plain Node; `convex/liveMirror.ts` wires
 * these into the authenticated query/action pair.
 */

/** The only Lucy realtime model the server will ever mint tokens for. */
export const LIVE_MIRROR_MODEL = "lucy-vton-latest";
export const DECART_API_BASE = "https://api.decart.ai";
export const DECART_CLIENT_TOKENS_PATH = "/v1/client/tokens";
/** Matches the extension's current token lifetime; the browser never sees the permanent key. */
export const LIVE_MIRROR_TOKEN_EXPIRES_IN_SECONDS = 60;
/**
 * Bounds for the per-session safety cap. This is a guardrail, not a commercial minute
 * allowance (plan allowances are a later migration step).
 */
export const LIVE_MIRROR_SESSION_MIN_SECONDS = 1;
export const LIVE_MIRROR_SESSION_MAX_LIMIT_SECONDS = 3600;
/** Upper bound for the operator daily guard; large enough for production but still an integer. */
export const LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_LIMIT = Number.MAX_SAFE_INTEGER;
/** Matches the extension background worker's Decart timeout. */
export const DECART_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Strictly parse the server session cap. Missing or invalid values fail closed with a
 * plain config error (the `requireEnv` convention), never with a granted token.
 */
export function parseSessionCap(raw: string | undefined): number {
  const invalid =
    "Missing or invalid environment variable LIVE_MIRROR_SESSION_MAX_SECONDS. " +
    `Set it to a positive integer number of seconds (1-${LIVE_MIRROR_SESSION_MAX_LIMIT_SECONDS}).`;
  if (raw === undefined) throw new Error(invalid);
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(invalid);
  const seconds = Number(trimmed);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < LIVE_MIRROR_SESSION_MIN_SECONDS ||
    seconds > LIVE_MIRROR_SESSION_MAX_LIMIT_SECONDS
  ) {
    throw new Error(invalid);
  }
  return seconds;
}

/**
 * Strictly parse the operator daily worst-case spend guard. Missing or invalid values fail
 * closed with a plain config error (the `requireEnv` convention) before any token is minted.
 */
export function parseDailyAuthorizedSecondsCap(raw: string | undefined): number {
  const invalid =
    "Missing or invalid environment variable LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_CAP. " +
    `Set it to a positive integer number of seconds (1-${LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_LIMIT}).`;
  if (raw === undefined) throw new Error(invalid);
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(invalid);
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_LIMIT) {
    throw new Error(invalid);
  }
  return seconds;
}

/** Exact Decart client-token body. The model and lifetime are server constants. */
export function clientTokenRequestBody(sessionSeconds: number): string {
  return JSON.stringify({
    expiresIn: LIVE_MIRROR_TOKEN_EXPIRES_IN_SECONDS,
    allowedModels: [LIVE_MIRROR_MODEL],
    constraints: { realtime: { maxSessionDuration: sessionSeconds } },
  });
}

/** Extract the short-lived client token, rejecting malformed provider responses. */
export function parseClientTokenResponse(body: unknown): string {
  const token =
    typeof body === "object" && body !== null && "apiKey" in body
      ? (body as { apiKey: unknown }).apiKey
      : undefined;
  if (typeof token === "string" && token.length > 0) return token;
  throw appError("UPSTREAM_FAILED", "Live Mirror is temporarily unavailable. Please try again.");
}
