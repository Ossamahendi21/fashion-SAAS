/**
 * The embedding seam, mirroring the shape of `ai/extraction.ts` and `ai/rendering.ts`: the caller
 * asks this module for a vector and it dispatches on the server-only `EMBEDDING_PROVIDER` env,
 * which has NO default — missing/empty/unsupported fails closed before any runner executes.
 *
 * - "local" (explicit): the self-hosted BGE gateway (`POST {baseUrl}/v1/embed` with
 *   `{ text }`, `X-API-Key`), validated in Step 7 Phase B1 on the pinned revision of
 *   `BAAI/bge-small-en-v1.5`: 384 dims, CLS pooling, L2-normalised once, ~22 texts/s single
 *   stream, 474 MiB peak RSS. External provider spend is $0 by contract.
 * - "openai" (legacy reference): `text-embedding-3-small`, 1536 dims. Kept ONLY as the rollback
 *   lever and as the historical vector space for rows written before Step 7 Phase C. It is never
 *   called automatically: there is no local -> openai fallback anywhere in this file, and a local
 *   failure is a local failure.
 *
 * No runtime or env value may decide index dimensions: `EMBEDDING_MODELS` below is static, because
 * `by_embeddingBge` is defined in `schema.ts` at 384 and the legacy `by_embedding` at 1536. A
 * gateway that answered with the wrong width must fail loudly rather than be written to an index.
 *
 * This module deliberately has no `"use node"`: it imports nothing Node-only (plain `fetch`, JSON
 * and an AbortController), so both actions (`ai/openai.ts`, `embeddingBackfill.ts`) and
 * query/mutation context can import it. The OpenAI branch is injected as a runner by
 * `ai/openai.ts`, which is the file that owns the SDK import.
 */

import { EMBEDDING_GENERATION } from "../shared/embeddingText";

export const EMBEDDING_PROVIDERS = ["openai", "local"] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDERS)[number];

/** Static per-provider model metadata. Dimensions are compile-time facts, never configuration. */
export const EMBEDDING_MODELS = {
  openai: { model: "text-embedding-3-small", dimensions: 1536 },
  local: { model: "BAAI/bge-small-en-v1.5", dimensions: 384 },
} as const;

/** The exact model revision the deployed gateway is pinned to (Step 7 Phase B1). Never a branch ref. */
export const LOCAL_EMBEDDING_MODEL = EMBEDDING_MODELS.local.model;
export const LOCAL_EMBEDDING_REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";

/** Self-hosted cost placeholder: the local gateway has no tokens to bill, so spend is exactly $0. */
export const LOCAL_COST_USD_PER_EMBEDDING = 0;

/** Long enough for a cold ORT session on a busy VPS, short enough to fail inside the action budget. */
export const EMBEDDING_TIMEOUT_MS = 60 * 1000;

export type EmbeddingErrorKind =
  | "auth-config"
  | "rate-limited"
  | "invalid-input"
  | "transient"
  | "permanent-rejection"
  | "malformed-output";

/** Normalized provider failure. The raw provider body and the api key never appear in the message. */
export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind;
  readonly provider: EmbeddingProviderId;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    provider: EmbeddingProviderId,
    kind: EmbeddingErrorKind,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
    this.provider = provider;
    this.kind = kind;
    this.status = status;
    this.retryable = kind === "transient" || kind === "rate-limited";
  }
}

/**
 * Which provider embeds text. Reads per call so tests can flip it without a stale cache.
 *
 * FAIL-CLOSED: there is no implicit provider. Missing, empty or unsupported means a configuration
 * error BEFORE any runner executes — an unset variable must never quietly pick the paid OpenAI path
 * and must never quietly depend on the local gateway being deployed either. Operators select
 * explicitly: "local" for self-hosted BGE writes, "openai" for the legacy reference/rollback path.
 */
export function embeddingProvider(env: Record<string, string | undefined> = process.env): EmbeddingProviderId {
  const provider = env.EMBEDDING_PROVIDER;
  if (provider === "openai" || provider === "local") return provider;
  throw new EmbeddingError(
    "local",
    "auth-config",
    `EMBEDDING_PROVIDER "${provider ?? "(missing)"}" is not supported; set it explicitly to "local" (self-hosted BGE) or "openai" (legacy reference only).`,
  );
}

export type LocalEmbeddingConfig = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
};

/** Builds the local gateway config and fails closed when a required server env var is missing. */
export function localEmbeddingConfig(
  env: Record<string, string | undefined> = process.env,
): LocalEmbeddingConfig {
  const baseUrl = env.EMBEDDING_BASE_URL;
  if (!baseUrl) throw new EmbeddingError("local", "auth-config", "Missing environment variable EMBEDDING_BASE_URL.");
  const apiKey = env.EMBEDDING_API_KEY;
  if (!apiKey) throw new EmbeddingError("local", "auth-config", "Missing environment variable EMBEDDING_API_KEY.");
  return { baseUrl, apiKey, timeoutMs: EMBEDDING_TIMEOUT_MS };
}

export function localEmbeddingEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/embed`;
}

export function localEmbeddingHealthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/health`;
}

export function localEmbeddingHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" };
}

/** POST body for one text. The gateway embeds exactly what it is given, unprefixed. */
export function localEmbeddingRequest(config: LocalEmbeddingConfig, text: string): { url: string; init: RequestInit } {
  return {
    url: localEmbeddingEndpoint(config.baseUrl),
    init: {
      method: "POST",
      headers: localEmbeddingHeaders(config.apiKey),
      body: JSON.stringify({ text }),
    },
  };
}

export function classifyLocalEmbeddingStatus(status: number): EmbeddingError {
  switch (status) {
    case 401:
    case 403:
      return new EmbeddingError(
        "local",
        "auth-config",
        `The local BGE gateway rejected the request (HTTP ${status}). Verify EMBEDDING_API_KEY and EMBEDDING_BASE_URL.`,
        status,
      );
    case 404:
      return new EmbeddingError(
        "local",
        "auth-config",
        "The local BGE gateway has no /v1/embed endpoint. Verify EMBEDDING_BASE_URL points at the deployed gateway.",
        status,
      );
    case 408:
    case 429:
      return new EmbeddingError("local", "rate-limited", `The local BGE gateway is rate-limiting (HTTP ${status}).`, status);
    case 400:
    case 413:
    case 422:
      return new EmbeddingError("local", "invalid-input", `The local BGE gateway rejected this text (HTTP ${status}).`, status);
    case 503:
      return new EmbeddingError(
        "local",
        "rate-limited",
        "The local BGE gateway is busy with another embedding (it serves one inference at a time).",
        status,
      );
    default:
      return status >= 500
        ? new EmbeddingError("local", "transient", `The local BGE gateway failed (HTTP ${status}).`, status)
        : new EmbeddingError("local", "permanent-rejection", `The local BGE gateway rejected the request (HTTP ${status}).`, status);
  }
}

export function classifyEmbeddingTransportError(reason: unknown): EmbeddingError {
  if (reason instanceof EmbeddingError) return reason;
  if (reason instanceof Error && reason.name === "AbortError") {
    return new EmbeddingError("local", "transient", "The local BGE gateway did not respond in time.");
  }
  const message = reason instanceof Error ? reason.message : String(reason);
  return new EmbeddingError("local", "transient", `Cannot reach the local BGE gateway: ${message}`);
}

/**
 * The vector contract, enforced on every provider response. Length comes from the static
 * `EMBEDDING_MODELS` table, never from the response or the env, so a misconfigured gateway fails
 * here instead of writing a wrong-width vector into `by_embeddingBge`.
 *
 * The unit-norm check is an assertion, not a fix: the gateway normalizes exactly once (Phase B1
 * contract). Re-normalizing here would hide a double-normalization or pooling regression inside the
 * gateway, which is exactly the drift the pinned benchmark is meant to catch.
 */
export function validateEmbeddingVector(
  provider: EmbeddingProviderId,
  vector: unknown,
  tolerance = 1e-3,
): number[] {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new EmbeddingError(provider, "malformed-output", `The ${provider} provider returned no vector.`);
  }
  const expected = EMBEDDING_MODELS[provider].dimensions;
  if (vector.length !== expected) {
    throw new EmbeddingError(
      provider,
      "malformed-output",
      `The ${provider} provider returned ${vector.length} dimensions; ${EMBEDDING_MODELS[provider].model} must return exactly ${expected}.`,
    );
  }
  let sumSquares = 0;
  const values: number[] = new Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbeddingError(provider, "malformed-output", `The ${provider} provider returned a non-finite value.`);
    }
    values[index] = value;
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares);
  if (!(Math.abs(norm - 1) <= tolerance)) {
    throw new EmbeddingError(
      provider,
      "malformed-output",
      `The ${provider} provider returned a vector with L2 norm ${norm.toFixed(6)}; expected 1 (normalize exactly once, server-side).`,
    );
  }
  return values;
}

export type EmbedRequest = {
  /** Text to embed. Empty or whitespace-only input is rejected before any provider is called. */
  text: string;
};

export type EmbedResult = {
  vector: number[];
  costUsd: number;
  latencyMs: number;
};

/**
 * The local adapter. `transport` is injectable so tests (and the bench lane) never touch the
 * network; production passes `fetch`. External spend is always $0: the gateway has no tokens.
 */
export async function localEmbed(
  request: EmbedRequest,
  config: LocalEmbeddingConfig,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<EmbedResult> {
  if (request.text.trim().length === 0) {
    throw new EmbeddingError("local", "invalid-input", "Cannot embed empty text.");
  }
  const started = Date.now();
  const { url, init } = localEmbeddingRequest(config, request.text);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await transport(url, { ...init, signal: controller.signal });
  } catch (reason) {
    throw classifyEmbeddingTransportError(reason);
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 200) throw classifyLocalEmbeddingStatus(response.status);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EmbeddingError("local", "malformed-output", "The local BGE gateway returned a non-JSON response.");
  }
  const vector = (payload as { vector?: unknown } | null)?.vector;
  return {
    vector: validateEmbeddingVector("local", vector),
    costUsd: LOCAL_COST_USD_PER_EMBEDDING,
    latencyMs: Date.now() - started,
  };
}

/**
 * The two provider implementations, injected by `ai/openai.ts` so tests can stub every side and no
 * module here has to import the OpenAI SDK.
 */
export type EmbeddingRunners = {
  openai: (request: EmbedRequest) => Promise<EmbedResult>;
  local: (request: EmbedRequest) => Promise<EmbedResult>;
};

/**
 * The dispatch. There is no failover: the configured provider must succeed or the embedding fails.
 * A `local` failure surfaces as a `local` failure and is never retried against OpenAI — a silent
 * fallback would both spend money and put 1536-d and 384-d vectors behind one env var.
 */
export async function embedText(
  request: EmbedRequest,
  runners: EmbeddingRunners,
  env: Record<string, string | undefined> = process.env,
): Promise<EmbedResult> {
  const provider = embeddingProvider(env);
  const result = provider === "openai" ? await runners.openai(request) : await runners.local(request);
  // Re-validate the injected branch too: a runner is a test double in production-adjacent paths and
  // a wrong-width vector must never reach an index.
  return { ...result, vector: validateEmbeddingVector(provider, result.vector) };
}

export { EMBEDDING_GENERATION };