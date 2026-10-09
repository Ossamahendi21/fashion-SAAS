export const RENDER_UNAVAILABLE_REASON = "Virtual try-on is not available in this beta yet.";
export const RENDER_FAILED_MESSAGE = "This try-on could not be completed.";

/**
 * Rendering is opt-in and fail-closed. Naming the provider is not enough: the selected paid
 * provider must also have a server credential before any job, reservation, or render row exists.
 */
export function isRenderRuntimeEnabled(env: Record<string, string | undefined>): boolean {
  if (env.RENDER_PROVIDER !== "openai") return false;
  return Boolean(env.OPENAI_API_KEY || env.AI_GATEWAY_API_KEY);
}
