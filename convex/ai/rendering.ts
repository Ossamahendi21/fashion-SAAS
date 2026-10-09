"use node";

import { appError } from "../lib/errors";
import { type RenderQuality, type TokenUsage } from "../shared/credits";
import type { Slot } from "../shared/wardrobe";

/**
 * The render provider seam. `renderImage` (in `ai/openai.ts`) builds a RenderRequest from the
 * render context and dispatches to the local composer:
 *
 * - "composite": deterministic local composition with sharp, at $0 external cost.
 *
 * There is no paid-provider fallback. The dispatch logic is plain and injectable so tests exercise
 * it without a network.
 */

export const RENDER_PROVIDERS = ["composite"] as const;
export type RenderProviderId = (typeof RENDER_PROVIDERS)[number];

/** Which provider renders this image. Reads per call so tests can flip it without a stale cache. */
export function renderProvider(env: Record<string, string | undefined> = process.env): RenderProviderId {
  const provider = env.RENDER_PROVIDER;
  if (provider === undefined || provider === "composite") return "composite";
  throw appError("INVALID_INPUT", `RENDER_PROVIDER "${provider}" is not supported; use "composite".`);
}

export type RenderRequest = {
  /** Normalized avatar PNG with its reference name ("person"). */
  person: { bytes: Uint8Array; name: string };
  /** Ordered normalized garment cutouts (inner layer first) with their reference names. */
  garments: Array<{ bytes: Uint8Array; name: string; slot: Slot }>;
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

/** The local composer implementation, injected so tests can stub the seam. */
export type RenderRunners = {
  composite: (request: RenderRequest) => Promise<RenderRunnerResult>;
};

/**
 * The local composer runs exactly once; any failure propagates to the caller.
 */
export async function renderOutfitImage(
  request: RenderRequest,
  runners: RenderRunners,
  env: Record<string, string | undefined> = process.env,
): Promise<RenderResult> {
  const provider = renderProvider(env);
  const result = await runners.composite(request);
  return { ...result, provider };
}
