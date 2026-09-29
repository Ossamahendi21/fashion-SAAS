// Local room preferences live in chrome.storage.local on this browser only.
//
// Step 2E3 removed the permanent browser Decart credential completely: there is no apiKey,
// no fastMode, and no provider-key workflow anywhere in the extension. The ONLY permanent
// Decart credential is the server-side DECART_API_KEY env variable, which the browser never
// sees. Live Mirror authorization is a server-side Convex action (convex/liveMirror.ts).

export type Settings = {
  /**
   * Optional local auto-freeze: end live processing early and keep a frozen preview. This can
   * only SHORTEN a session — the server grant always wins via effectiveSessionSeconds — has no
   * billing effect, and 0 means "no early freeze, use the server limit".
   */
  autoFreezeSeconds: number
}

/** Safe default at the server production target, so it can never lengthen a session. */
export const DEFAULT_SETTINGS: Settings = { autoFreezeSeconds: 60 }

/**
 * The exact legacy keys removed in Step 2E3. Canonical list: every purge path references
 * this, so the set can never drift between call sites.
 */
export const LEGACY_SETTING_KEYS = ["apiKey", "fastMode", "sessionMinutes"]

export async function loadSettings(): Promise<Settings> {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))
  // Defense in depth: an old install that never opens Options still gets cleaned the next
  // time settings load. The background worker purges actively on its own lifecycle too.
  await purgeLegacySettings()
  const autoFreezeSeconds =
    typeof saved.autoFreezeSeconds === "number" &&
    Number.isFinite(saved.autoFreezeSeconds) &&
    saved.autoFreezeSeconds >= 0
      ? Math.floor(saved.autoFreezeSeconds)
      : DEFAULT_SETTINGS.autoFreezeSeconds
  return { autoFreezeSeconds }
}

export async function saveSettings(patch: Partial<Settings>) {
  await chrome.storage.local.set(patch)
}

/**
 * Actively purges the removed credential-era keys. Safe and idempotent: removes exactly the
 * canonical legacy keys, never touches `autoFreezeSeconds`, Clerk state, or anything else,
 * and silently succeeds when storage is unavailable or already clean.
 */
export async function purgeLegacySettings(): Promise<void> {
  try {
    await chrome.storage.local.remove?.(LEGACY_SETTING_KEYS)
  } catch {
    // Already clean or storage unavailable; the keys are never read regardless.
  }
}
