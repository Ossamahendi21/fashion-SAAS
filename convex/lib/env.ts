export const SERVER_ENV_KEYS = [
  "CLERK_JWT_ISSUER_DOMAIN",
  "CLERK_SECRET_KEY",
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "AGENT_SERVICE_KEY",
  "SITE_URL",
  "MAX_DAILY_SPEND_USD",
  /** Server-only Decart credential for Live Mirror token minting. Never expose via NEXT_PUBLIC_. */
  "DECART_API_KEY",
  /** Per-session Live Mirror safety cap in seconds (strictly validated; missing/invalid fails closed). */
  "LIVE_MIRROR_SESSION_MAX_SECONDS",
  /** Maximum total Live Mirror seconds that may be authorized across all users per UTC day. */
  "LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_CAP",
  /** "1" enables the internal smoke-test functions in `convex/dev/smoke.ts`; unset everywhere but a scratch deployment. */
  "ALLOW_DEV_SMOKE",
  /**
   * Which provider cuts garment cutouts: "florencesam" (default, free self-hosted),
   * "openai" (legacy reference only, never an automatic fallback) or "withoutbg".
   * Server-only: read in `convex/ai/extraction.ts` and never exposed to the client.
   */
  "EXTRACTION_PROVIDER",
  /** Server-only self-hosted withoutBG gateway base URL (never NEXT_PUBLIC_). */
  "WITHOUTBG_BASE_URL",
  /** Server-only private gateway key for the withoutBG gateway (never NEXT_PUBLIC_, never in logs). */
  "WITHOUTBG_API_KEY",
  /** Operator-estimated self-host cost per extraction, recorded as COGS like OpenAI usage would be. */
  "WITHOUTBG_COST_USD_PER_IMAGE",
  /** Server-only self-hosted Florence+SAM2 gateway base URL (never NEXT_PUBLIC_). */
  "FLORENCESAM_BASE_URL",
  /** Server-only private gateway key for the Florence+SAM2 gateway (never NEXT_PUBLIC_, never in logs). */
  "FLORENCESAM_API_KEY",
] as const;

export type ServerEnvKey = (typeof SERVER_ENV_KEYS)[number];

/** Read a required server env var, failing loudly with the variable name so misconfiguration is obvious. */
export function requireEnv(key: ServerEnvKey): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing environment variable ${key}. Set it in the Convex dashboard (Settings → Environment Variables).`,
    );
  }
  return value;
}

export function optionalEnv(key: ServerEnvKey): string | undefined {
  return process.env[key] || undefined;
}

export function envNumber(key: ServerEnvKey, fallback: number): number {
  const raw = optionalEnv(key);
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
