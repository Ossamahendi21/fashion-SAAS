import type { StylistPorts } from "../../../../../agent/lib/stylist-orchestrator";
import type { WardrobeItem } from "../../../../../agent/lib/stylist-rank";

/**
 * Step 7 Phase C7B.1 — in-process fakes for the isolated Eve canary.
 *
 * The canary agent runs on the deterministic model and must never reach Convex, a provider, or the
 * network. These ports stand in for the production Convex ports in `agent/lib/stylist-turn.ts` and
 * additionally count every side effect per session, so the approval test can prove that
 * `startRenders` is called zero times before approval and exactly once after it. Counts are keyed by
 * the real Eve session id, so concurrent sessions never share an audit.
 */

export type CanaryAudit = {
  readonly listReadyItems: number;
  readonly fetchWeather: number;
  readonly composeOutfits: number;
  readonly quoteRenders: number;
  readonly startRenders: number;
  readonly saveOutfit: number;
  readonly gapAnalysis: number;
  /** Process-wide count of `globalThis.fetch` calls, proving zero provider network from the adapter. */
  readonly networkCalls: number;
};

const ZERO_AUDIT: CanaryAudit = {
  listReadyItems: 0,
  fetchWeather: 0,
  composeOutfits: 0,
  quoteRenders: 0,
  startRenders: 0,
  saveOutfit: 0,
  gapAnalysis: 0,
  networkCalls: 0,
};

let networkCalls = 0;

/** Called by instrumentation to record every outbound `fetch` in the server process. */
export function countNetworkCall(): void {
  networkCalls += 1;
}

export function networkCallCount(): number {
  return networkCalls;
}

/** A deterministic, controlled backend failure the failure-path scenario can trigger. */
export const CANARY_FAILURE_MARKER = "CANARY_PORT_FAILURE";

const audits = new Map<string, CanaryAudit>();

export function canaryAudit(sessionId: string): CanaryAudit {
  return { ...(audits.get(sessionId) ?? ZERO_AUDIT), networkCalls };
}

export function resetCanaryAudit(sessionId: string): void {
  audits.delete(sessionId);
}

const WARDROBE: readonly WardrobeItem[] = [
  { id: "t1", name: "White Tee", status: "ready", category: "top", colours: { primary: "white", secondary: [], hex: [] }, season: [], formality: "casual", wearCount: 0 },
  { id: "t2", name: "Navy Polo", status: "ready", category: "top", colours: { primary: "navy", secondary: [], hex: [] }, season: [], formality: "casual", wearCount: 0 },
  { id: "b1", name: "Indigo Jeans", status: "ready", category: "bottom", colours: { primary: "indigo", secondary: [], hex: [] }, season: [], formality: "casual", wearCount: 0 },
  { id: "s1", name: "White Sneakers", status: "ready", category: "shoes", colours: { primary: "white", secondary: [], hex: [] }, season: [], formality: "casual", wearCount: 0 },
];

export function buildCanaryPorts(sessionId: string): StylistPorts {
  const bump = (key: keyof CanaryAudit): void => {
    const current = audits.get(sessionId) ?? ZERO_AUDIT;
    audits.set(sessionId, { ...current, [key]: current[key] + 1 });
  };

  return {
    async listReadyItems() {
      bump("listReadyItems");
      return WARDROBE;
    },
    async fetchWeather() {
      bump("fetchWeather");
      return {};
    },
    async composeOutfits(request) {
      bump("composeOutfits");
      if (typeof request.brief === "string" && request.brief.includes(CANARY_FAILURE_MARKER)) {
        throw new Error("canary compose failure (controlled, deterministic)");
      }
      return request.outfits.map((outfit, index) => ({
        outfitId: `outfit-${index + 1}`,
        name: outfit.name,
        problems: [],
      }));
    },
    async quoteRenders(request) {
      bump("quoteRenders");
      return {
        credits: request.outfitIds.length,
        available: 10,
        shortfall: 0,
        canAfford: true,
        blockers: [],
      };
    },
    async startRenders(request) {
      bump("startRenders");
      return { jobId: `job-${request.outfitIds.length}` };
    },
    async saveOutfit() {
      bump("saveOutfit");
    },
    async gapAnalysis() {
      bump("gapAnalysis");
      return { totalItems: WARDROBE.length, gaps: ["outerwear"] };
    },
  };
}