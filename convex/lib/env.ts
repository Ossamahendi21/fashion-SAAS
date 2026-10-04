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
  /** Which provider renders try-on images: "openai" (default, gpt-image-2). Server-only. */
  "RENDER_PROVIDER",
  /**
   * Which provider embeds item text: "local" (self-hosted BAAI/bge-small-en-v1.5, $0) or "openai"
   * (legacy text-embedding-3-small reference/rollback only, never an automatic fallback). NO
   * default: missing/empty/unsupported fails closed before any runner executes, so a deployment can
   * neither silently spend on OpenAI nor silently depend on an undeployed gateway. Server-only: read
   * in `convex/ai/embedding.ts`, never exposed to the client.
   */
  "EMBEDDING_PROVIDER",
  /**
   * Which stored vector generation shopping similarity reads: "legacy" (stored OpenAI vectors,
   * `by_embedding` — the TEMPORARY migration default, so existing users keep existing behavior) or
   * "bge" (local BGE vectors, `by_embeddingBge` — set explicitly after backfill validation). This
   * only selects stored vectors/indexes and can never cause an OpenAI API call. Server-only.
   */
  "EMBEDDING_READ_GENERATION",
  /** Server-only self-hosted BGE gateway base URL (never NEXT_PUBLIC_). */
  "EMBEDDING_BASE_URL",
  /** Server-only private gateway key the BGE gateway expects in X-API-Key (never NEXT_PUBLIC_, never logged). */
  "EMBEDDING_API_KEY",
  /**
   * Dedicated service key guarding the `embeddingBackfill` action. Deliberately NOT the stylist
   * `AGENT_SERVICE_KEY`: the backfill writes vectors to every user's wardrobe and must not be
   * reachable with agent credentials.
   */
  "EMBEDDING_BACKFILL_KEY",
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
