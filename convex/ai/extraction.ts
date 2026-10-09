"use node";

import { PNG, type PNGWithMetadata } from "pngjs";
import sharp, { type Metadata } from "sharp";
import type { TokenUsage } from "../shared/credits";

/**
 * The extraction cutout seam. `extractItem` (in `ai/openai.ts`) asks this module for a garment
 * cutout and it dispatchs on the server-only `EXTRACTION_PROVIDER` env:
 *
 * - "original" (default): preserves the normalized uploaded image without an external call. This
 *   zero-provider fallback supports one isolated garment per photo and reports exactly $0 spend.
 * - "florencesam": self-hosted Florence-2-base grounding plus SAM2.1 Tiny segmentation
 *   (`POST {baseUrl}/v1/extract` with `{ image: base64Png, prompt }`, `X-API-Key`), validated in
 *   Step 4 at F1 >= 98 on all 7 fixture cases with one deterministic rule per stage (Florence
 *   largest-area box, SAM largest-area mask). External provider spend is $0 by contract.
 * - "openai" (legacy): gpt-image-2 generative edit, costed from SDK token usage. Kept as an
 *   explicit reference/benchmark path only; it is never an automatic runtime fallback.
 * - "withoutbg": a self-hosted withoutBG Open Weights gateway (`POST {baseUrl}/v1/remove-background`,
 *   `X-API-Key`), costed from an operator-set per-image infra estimate.
 *
 * Pinned gateway runtime (documented, do not silently upgrade): Florence-2 on transformers 4.44.2
 * via trust_remote_code, SAM2 on transformers 5.14.1, CPU-only, with a flash_attn import-scan stub
 * (never executed; guarded off on CPU). The reference gateway implementation lives in
 * `bench/extraction/server/florencesam_gateway.py` (deploy-only, not part of the app bundle).
 *
 * No automatic failover between providers: the configured provider is the provider, and a provider
 * failure settles the item like any extraction failure. All request/parse/cost logic here is plain
 * and injectable (transport, runners, env) so the tests exercise it without a network or a dashboard.
 * Whatever the gateway returns, `ensureSquareCutout` normalizes the result to a 1024×1024 PNG first.
 */

export const EXTRACTION_CUTOUT_SIZE = 1024;
/** Long enough to wait out a slow self-hosted inference, short enough to fail inside the action budget. */
export const EXTRACTION_TIMEOUT_MS = 5 * 60 * 1000;
/** Self-hosted cost placeholder recorded as COGS per extraction until an operator calibrates it. */
export const WITHOUTBG_COST_USD_PER_IMAGE_DEFAULT = 0.001;

export const EXTRACTION_PROVIDERS = ["original", "openai", "withoutbg", "florencesam"] as const;
export type ExtractionProviderId = (typeof EXTRACTION_PROVIDERS)[number];

export type ExtractionErrorKind =
  | "auth-config"
  | "rate-limited"
  | "invalid-input"
  | "unsupported-image"
  | "transient"
  | "permanent-rejection"
  | "malformed-output";

/** Normalized provider failure. The raw provider body and the api key never appear in the message. */
export class ExtractionError extends Error {
  readonly kind: ExtractionErrorKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(kind: ExtractionErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ExtractionError";
    this.kind = kind;
    this.status = status;
    this.retryable = kind === "transient" || kind === "rate-limited";
  }
}

/** Which provider cuts this photo. Reads per call so tests can flip it without a stale cache. */
export function extractionProvider(env: Record<string, string | undefined> = process.env): ExtractionProviderId {
  const provider = env.EXTRACTION_PROVIDER;
  if (provider === undefined) return "original";
  if (provider === "original" || provider === "openai" || provider === "withoutbg" || provider === "florencesam")
    return provider;
  throw new ExtractionError(
    "auth-config",
    `EXTRACTION_PROVIDER "${provider}" is not supported; use "original", "florencesam", "openai" or "withoutbg".`,
  );
}

export type WithoutBgConfig = {
  baseUrl: string;
  apiKey: string;
  costUsdPerImage: number;
  timeoutMs: number;
};

/** Builds the withoutBG config and fails closed when a required server env var is missing. */
export function withoutBgConfig(env: Record<string, string | undefined> = process.env): WithoutBgConfig {
  const baseUrl = env.WITHOUTBG_BASE_URL;
  if (!baseUrl) throw new ExtractionError("auth-config", "Missing environment variable WITHOUTBG_BASE_URL.");
  const apiKey = env.WITHOUTBG_API_KEY;
  if (!apiKey) throw new ExtractionError("auth-config", "Missing environment variable WITHOUTBG_API_KEY.");
  const raw = env.WITHOUTBG_COST_USD_PER_IMAGE;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  const costUsdPerImage = Number.isFinite(parsed) && parsed >= 0 ? parsed : WITHOUTBG_COST_USD_PER_IMAGE_DEFAULT;
  return { baseUrl, apiKey, costUsdPerImage, timeoutMs: EXTRACTION_TIMEOUT_MS };
}

export function withoutBgEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/remove-background`;
}

export function withoutBgHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey, "Content-Type": "image/png", Accept: "image/png" };
}

export function withoutBgRequest(config: WithoutBgConfig, imageBytes: Uint8Array): { url: string; init: RequestInit } {
  return {
    url: withoutBgEndpoint(config.baseUrl),
    init: {
      method: "POST",
      headers: withoutBgHeaders(config.apiKey),
      body: imageBytes as BodyInit,
    },
  };
}

export function classifyWithoutBgStatus(status: number): ExtractionError {
  switch (status) {
    case 401:
    case 402:
    case 403:
    case 404:
      return new ExtractionError(
        "auth-config",
        `The withoutBG gateway rejected the request (HTTP ${status}). Verify WITHOUTBG_API_KEY and WITHOUTBG_BASE_URL.`,
        status,
      );
    case 408:
    case 429:
      return new ExtractionError("rate-limited", `The withoutBG gateway is rate-limiting (HTTP ${status}).`, status);
    case 400:
    case 415:
    case 422:
      return new ExtractionError(
        "invalid-input",
        `The withoutBG gateway rejected this image (HTTP ${status}).`,
        status,
      );
    case 413:
      return new ExtractionError(
        "unsupported-image",
        `The image is too large for the withoutBG gateway (HTTP 413).`,
        status,
      );
    default:
      return status >= 500
        ? new ExtractionError("transient", `The withoutBG gateway failed (HTTP ${status}).`, status)
        : new ExtractionError(
            "permanent-rejection",
            `The withoutBG gateway rejected the request (HTTP ${status}).`,
            status,
          );
  }
}

export function classifyTransportError(reason: unknown, gatewayLabel = "withoutBG"): ExtractionError {
  if (reason instanceof ExtractionError) return reason;
  if (reason instanceof Error && reason.name === "AbortError") {
    return new ExtractionError("transient", `The ${gatewayLabel} gateway did not respond in time.`);
  }
  const message = reason instanceof Error ? reason.message : String(reason);
  return new ExtractionError("transient", `Cannot reach the ${gatewayLabel} gateway: ${message}`);
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** POSTs one request to a self-hosted gateway and returns {status, bytes}, or a normalized ExtractionError. */
async function gatewayFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  transport: FetchFn,
  classifyStatus: (status: number) => ExtractionError,
  gatewayLabel: string,
): Promise<{ status: number; bytes: Uint8Array }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await transport(url, { ...init, signal: controller.signal });
    } catch (reason) {
      throw classifyTransportError(reason, gatewayLabel);
    }
    const status = response.status;
    if (status !== 200) throw classifyStatus(status);
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length === 0) {
      throw new ExtractionError("malformed-output", `The ${gatewayLabel} gateway returned an empty response.`);
    }
    const bytes = new Uint8Array(raw.byteLength);
    bytes.set(raw);
    return { status, bytes };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads cutout bytes: dims and whether the PNG genuinely carries an alpha channel. */
export function parseWithoutBgBytes(bytes: Uint8Array): {
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  hasAlpha: boolean;
} {
  let png: PNGWithMetadata;
  try {
    png = PNG.sync.read(Buffer.from(bytes));
  } catch {
    throw new ExtractionError("malformed-output", "The withoutBG gateway returned an image that is not a valid PNG.");
  }
  // pngjs decodes every PNG to RGBA in memory, so the palette always reports four channels; the
  // true transparency comes from the PNG's color type (4 = gray+alpha, 6 = truecolor+alpha).
  const hasAlpha = png.colorType === 4 || png.colorType === 6;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return { bytes: copy, width: png.width, height: png.height, hasAlpha };
}

export type ExtractGarmentResult = {
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  background: "transparent" | "opaque";
  provider: ExtractionProviderId;
  usage?: TokenUsage;
  costUsd: number;
  latencyMs: number;
};

/**
 * The withoutBG adapter. `transport` is injectable so tests (and the bench mock lane) never touch
 * the network; production passes `fetch`.
 */
export async function withoutBgExtract(
  input: { bytes: Uint8Array; prompt: string },
  config: WithoutBgConfig,
  transport: FetchFn = fetch,
): Promise<ExtractGarmentResult> {
  const started = Date.now();
  const { url, init } = withoutBgRequest(config, input.bytes);
  const { bytes } = await gatewayFetch(url, init, config.timeoutMs, transport, classifyWithoutBgStatus, "withoutBG");
  const parsed = parseWithoutBgBytes(bytes);
  return {
    bytes: parsed.bytes,
    width: parsed.width,
    height: parsed.height,
    background: parsed.hasAlpha ? "transparent" : "opaque",
    provider: "withoutbg",
    costUsd: config.costUsdPerImage,
    latencyMs: Date.now() - started,
  };
}

/**
 * Deterministic Florence box selection: the largest-area grounded box wins; ties and empties
 * are settled without randomness (first wins, empty yields null). The gateway implements this
 * same rule; this helper pins the contract in code so tests cover it without a network.
 */
export function selectLargestBox(boxes: [number, number, number, number][]): {
  index: number;
  box: [number, number, number, number];
} | null {
  let best: { index: number; box: [number, number, number, number] } | null = null;
  let bestArea = 0;
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const area = Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
    if (area > bestArea) {
      best = { index, box };
      bestArea = area;
    }
  }
  return best;
}

/**
 * Deterministic SAM mask selection: the largest-area candidate mask wins, first wins ties.
 * Returns -1 when there are no candidates. The gateway implements this same rule.
 */
export function selectLargestMask(areas: number[]): number {
  let best = -1;
  let bestArea = 0;
  for (let index = 0; index < areas.length; index++) {
    if (areas[index] > bestArea) {
      best = index;
      bestArea = areas[index];
    }
  }
  return bestArea > 0 ? best : -1;
}

/** External provider spend for the self-hosted Florence+SAM2 gateway: $0 by contract. Never billed from tokens. */
export const FLORENCESAM_COST_USD_PER_IMAGE = 0;

export type FlorenceSamConfig = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
};

/** Builds the Florence+SAM2 config and fails closed when a required server env var is missing. */
export function florenceSamConfig(env: Record<string, string | undefined> = process.env): FlorenceSamConfig {
  const baseUrl = env.FLORENCESAM_BASE_URL;
  if (!baseUrl) throw new ExtractionError("auth-config", "Missing environment variable FLORENCESAM_BASE_URL.");
  const apiKey = env.FLORENCESAM_API_KEY;
  if (!apiKey) throw new ExtractionError("auth-config", "Missing environment variable FLORENCESAM_API_KEY.");
  return { baseUrl, apiKey, timeoutMs: EXTRACTION_TIMEOUT_MS };
}

export function florenceSamEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/extract`;
}

export function florenceSamHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "image/png" };
}

export type FlorenceSamRequestBody = {
  /** Source photo as base64 PNG. */
  image: string;
  /** Grounding phrase naming the garment (e.g. "a photo of a blue dress"). */
  prompt: string;
};

export function florenceSamRequest(
  config: FlorenceSamConfig,
  imageBytes: Uint8Array,
  prompt: string,
): { url: string; init: RequestInit } {
  if (!prompt.trim()) {
    throw new ExtractionError("invalid-input", "Florence+SAM2 extraction needs a non-empty garment prompt.");
  }
  const body: FlorenceSamRequestBody = {
    image: Buffer.from(imageBytes).toString("base64"),
    prompt,
  };
  return {
    url: florenceSamEndpoint(config.baseUrl),
    init: {
      method: "POST",
      headers: florenceSamHeaders(config.apiKey),
      body: JSON.stringify(body),
    },
  };
}

export function classifyFlorenceSamStatus(status: number): ExtractionError {
  switch (status) {
    case 401:
    case 402:
    case 403:
    case 404:
      return new ExtractionError(
        "auth-config",
        `The Florence+SAM2 gateway rejected the request (HTTP ${status}). Verify FLORENCESAM_API_KEY and FLORENCESAM_BASE_URL.`,
        status,
      );
    case 408:
    case 429:
      return new ExtractionError(
        "rate-limited",
        `The Florence+SAM2 gateway is rate-limiting (HTTP ${status}).`,
        status,
      );
    case 400:
    case 415:
      return new ExtractionError(
        "invalid-input",
        `The Florence+SAM2 gateway rejected this image (HTTP ${status}).`,
        status,
      );
    case 422:
      return new ExtractionError(
        "invalid-input",
        "The Florence+SAM2 gateway found no garment for the prompt (empty grounding).",
        status,
      );
    case 413:
      return new ExtractionError(
        "unsupported-image",
        `The image is too large for the Florence+SAM2 gateway (HTTP 413).`,
        status,
      );
    default:
      return status >= 500
        ? new ExtractionError("transient", `The Florence+SAM2 gateway failed (HTTP ${status}).`, status)
        : new ExtractionError(
            "permanent-rejection",
            `The Florence+SAM2 gateway rejected the request (HTTP ${status}).`,
            status,
          );
  }
}

/**
 * The Florence+SAM2 adapter. `transport` is injectable so tests (and the bench mock lane) never touch
 * the network; production passes `fetch`. External spend is always $0: there are no tokens to bill.
 */
export async function florenceSamExtract(
  input: { bytes: Uint8Array; prompt: string },
  config: FlorenceSamConfig,
  transport: FetchFn = fetch,
): Promise<ExtractGarmentResult> {
  const started = Date.now();
  const { url, init } = florenceSamRequest(config, input.bytes, input.prompt);
  const { bytes } = await gatewayFetch(
    url,
    init,
    config.timeoutMs,
    transport,
    classifyFlorenceSamStatus,
    "Florence+SAM2",
  );
  const parsed = parseWithoutBgBytes(bytes);
  return {
    bytes: parsed.bytes,
    width: parsed.width,
    height: parsed.height,
    background: parsed.hasAlpha ? "transparent" : "opaque",
    provider: "florencesam",
    costUsd: FLORENCESAM_COST_USD_PER_IMAGE,
    latencyMs: Date.now() - started,
  };
}

/**
 * Normalizes raw cutout bytes to a 1024×1024 PNG on a transparent canvas. An already-square result
 * passes through byte-identical (the gpt-image-2 path), so nothing is re-encoded unexpectedly.
 */
export async function ensureSquareCutout(
  input: Uint8Array,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; width: number; height: number }> {
  let metadata: Metadata;
  try {
    metadata = await sharp(Buffer.from(input), {
      limitInputPixels: EXTRACTION_CUTOUT_SIZE * EXTRACTION_CUTOUT_SIZE * 16,
    }).metadata();
  } catch {
    throw new ExtractionError("malformed-output", "The cutout bytes are not a decodable image.");
  }
  const { width, height } = metadata;
  if (!width || !height) {
    throw new ExtractionError("malformed-output", "The cutout has no measurable size.");
  }
  const size = EXTRACTION_CUTOUT_SIZE;
  if (width === size && height === size) {
    const bytes = new Uint8Array(input.byteLength);
    bytes.set(input);
    return { bytes, width: size, height: size };
  }
  const resized = await sharp(Buffer.from(input), { limitInputPixels: size * size * 16 })
    .resize(size, size, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  const canvas = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: resized, gravity: "center" }])
    .png()
    .toBuffer();
  const bytes = new Uint8Array(canvas.byteLength);
  bytes.set(canvas);
  return { bytes, width: size, height: size };
}

export type ExtractionCutRequest = {
  imageBytes: Uint8Array;
  imageName: string;
  /** Generative-edit prompt for the legacy OpenAI branch. */
  prompt: string;
  /**
   * Garment noun for the Florence+SAM2 branch (e.g. "dress", "t-shirt"), derived from the
   * item's catalogue fields. The other branches ignore it.
   */
  noun: string;
};

/** What the OpenAI branch of the seam must return so cost/usage stay honest and transparent. */
export type OpenaiCutResult = {
  bytes: Uint8Array<ArrayBuffer>;
  usage: TokenUsage;
  background: "transparent" | "opaque";
  costUsd: number;
  latencyMs: number;
};

/** What the withoutBG branch returns (no token usage exists on a self-hosted gateway). */
export type WithoutBgCutResult = {
  bytes: Uint8Array<ArrayBuffer>;
  background: "transparent" | "opaque";
  costUsd: number;
  latencyMs: number;
};

/** What the Florence+SAM2 branch returns (no token usage exists on a self-hosted gateway; spend is $0). */
export type FlorenceSamCutResult = {
  bytes: Uint8Array<ArrayBuffer>;
  background: "transparent" | "opaque";
  costUsd: number;
  latencyMs: number;
};

/** The three provider implementations, injected by `ai/openai.ts` so tests can stub every side. */
export type ExtractionRunners = {
  openai: (request: ExtractionCutRequest) => Promise<OpenaiCutResult>;
  withoutbg: (request: ExtractionCutRequest) => Promise<WithoutBgCutResult>;
  florencesam: (request: ExtractionCutRequest) => Promise<FlorenceSamCutResult>;
};

/**
 * The dispatch. Locks the 1024×1024 contract for every provider, and never fails over: the
 * configured provider must succeed or the extraction fails.
 */
export async function extractGarmentCutout(
  request: ExtractionCutRequest,
  runners: ExtractionRunners,
  env: Record<string, string | undefined> = process.env,
): Promise<ExtractGarmentResult> {
  const provider = extractionProvider(env);
  const cut =
    provider === "original"
      ? { bytes: request.imageBytes, background: "opaque" as const, costUsd: 0, latencyMs: 0 }
      : provider === "openai"
        ? await runners.openai(request)
        : provider === "withoutbg"
          ? await runners.withoutbg(request)
          : await runners.florencesam(request);
  const square = await ensureSquareCutout(cut.bytes);
  return {
    bytes: square.bytes,
    width: square.width,
    height: square.height,
    background: cut.background,
    provider,
    ...(provider === "openai" && "usage" in cut ? { usage: (cut as OpenaiCutResult).usage } : {}),
    costUsd: cut.costUsd,
    latencyMs: cut.latencyMs,
  };
}
