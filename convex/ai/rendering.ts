"use node";

import { appError } from "../lib/errors";
import { type RenderQuality, type TokenUsage } from "../shared/credits";
import { RENDER_UNAVAILABLE_REASON } from "../shared/render_policy";

/**
 * The render provider seam. `renderImage` (in `ai/openai.ts`) builds a RenderRequest from the
 * render context and dispatches on the server-only `RENDER_PROVIDER` env:
 *
 * - "disabled" (default): fail closed without calling a provider.
 * - "openai": gpt-image-2 edit, only when explicitly configured.
 *
 * No automatic failover between providers: the configured provider is the provider, and a provider
 * failure settles the render like any render failure (the workflow retries transient errors and
 * refunds failures; it never calls another provider). All dispatch logic here is plain and
 * injectable (runners, env) so tests exercise it without a network.
 */

export const RENDER_PROVIDERS = ["disabled", "openai"] as const;
export type RenderProviderId = (typeof RENDER_PROVIDERS)[number];

/** Which provider renders this image. Reads per call so tests can flip it without a stale cache. */
export function renderProvider(env: Record<string, string | undefined> = process.env): RenderProviderId {
  const provider = env.RENDER_PROVIDER;
  if (provider === undefined) return "disabled";
  if (provider === "openai") return provider;
  if (provider === "disabled") return provider;
  throw appError("INVALID_INPUT", `RENDER_PROVIDER "${provider}" is not supported; use "disabled" or "openai".`);
}

export type RenderRequest = {
  /** Normalized avatar PNG with its reference name ("person"). */
  person: { bytes: Uint8Array; name: string };
  /** Ordered normalized garment cutouts (inner layer first) with their reference names. */
  garments: Array<{ bytes: Uint8Array; name: string }>;
  /** The full try-on instruction for the outfit. */
  prompt: string;
  /** Billing quality; each runner maps it to its own output settings. */
  quality: RenderQuality;
};

/** What one provider run returns. Usage is absent for providers with no token accounting. */
export type RenderRunnerResult = {
  bytes: Uint8Array<ArrayBuffer>;
  usage?: TokenUsage;
  costUsd: number;
  latencyMs: number;
};

export type RenderResult = RenderRunnerResult & {
  provider: RenderProviderId;
};

/** The provider implementations, owned by `ai/openai.ts` so tests can stub the seam. */
export type RenderRunners = {
  openai: (request: RenderRequest) => Promise<RenderRunnerResult>;
};

/**
 * The dispatch. The configured provider runs exactly once; any failure propagates to the
 * caller (the workflow retries transient errors and refunds failures) without failover.
 */
export async function renderOutfitImage(
  request: RenderRequest,
  runners: RenderRunners,
  env: Record<string, string | undefined> = process.env,
): Promise<RenderResult> {
  const provider = renderProvider(env);
  if (provider === "disabled") throw appError("FEATURE_LOCKED", RENDER_UNAVAILABLE_REASON);
  const result = await runners.openai(request);
  return { ...result, provider };
}
