import type { Feature } from "@convex/shared/credits";

/**
 * Human labels for the entitlement slugs in `convex/shared/credits.ts`.
 * Lives here until there is a second consumer outside the marketing surface.
 */
export const FEATURE_LABELS: Record<Feature, string> = {
  sharing: "Share renders with a link",
  hq_renders: "HQ renders",
  priority_queue: "Priority queue",
};
