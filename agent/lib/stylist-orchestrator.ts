import type { RenderQuality } from "../../convex/shared/credits";
import { transitionStylistState, type MachineEvent, type TransitionErrorCode } from "./stylist-machine";
import {
  mergeStylistTurn,
  type ClarificationRequirement,
  type StylistDateRef,
  type StylistPlan,
  type StylistTurnInput,
} from "./stylist-plan";
import {
  candidateToProposal,
  rankOutfits,
  type OutfitSlot,
  type RankGap,
  type WardrobeItem,
  type WeatherFacts,
} from "./stylist-rank";
import type { StylistQuote, StylistThreadState } from "./stylist-state";
import { QUOTE_TTL_MS } from "./stylist-state";

/**
 * Step 7 Phase C4 — the Eve seam.
 *
 * Pure orchestration between the three deterministic layers: it merges a turn into a C1 plan,
 * ranks the wardrobe with C3, persists the winning picks through an injected port so C2's state
 * machine only ever carries REAL `outfits` ids, and routes quote/approval/render/save through the
 * state machine's transition table.
 *
 * Three invariants shape the file:
 *
 * 1. Identity is earned at the boundary. `CandidateOutfit.key` is a temporary signature; the ids
 *    that reach C2, a quote, a render or a save always come back from the `composeOutfits` port
 *    (the real persisted `outfits` rows). Nothing downstream ever sees a candidate key.
 * 2. Every side effect is a port. The orchestrator performs no I/O itself: it calls injected
 *    `StylistPorts`, so a test drives the whole seam with fakes and no network, Convex or clock.
 * 3. The machine owns transitions, the plan is written through. C2's `transitionStylistState`
 *    decides what is legal; this module applies events and then stores the freshly merged C1 plan
 *    on the returned state, because no machine event carries a plan.
 */

export type ComposedOutfitResult = {
  outfitId: string | null;
  name: string;
  problems: readonly string[];
};

export type ComposeRequest = {
  brief: string;
  outfits: readonly { name: string; slots: OutfitSlot; reasoning: string }[];
};

export type QuoteRequest = {
  outfitIds: readonly string[];
  perOutfit: number;
  quality: RenderQuality;
};

export type QuoteResponse = {
  credits: number;
  available: number;
  shortfall: number;
  canAfford: boolean;
  blockers: readonly string[];
};

export type GapReport = {
  totalItems: number;
  gaps: readonly string[];
};

/**
 * Every side effect the orchestrator needs, behind one injectable seam. The production
 * implementation lives in `stylist-turn.ts`; tests pass plain fakes.
 */
export type StylistPorts = {
  listReadyItems(): Promise<readonly WardrobeItem[]>;
  fetchWeather(place: string, date: StylistDateRef): Promise<WeatherFacts>;
  composeOutfits(request: ComposeRequest): Promise<readonly ComposedOutfitResult[]>;
  quoteRenders(request: QuoteRequest): Promise<QuoteResponse>;
  startRenders(request: QuoteRequest): Promise<{ jobId: string }>;
  saveOutfit(outfitId: string): Promise<void>;
  gapAnalysis(): Promise<GapReport>;
};

type StylistTurnBase = {
  state: StylistThreadState;
  plan: StylistPlan;
};

export type StylistTurnResult = StylistTurnBase &
  (
    | { kind: "clarification"; clarification: ClarificationRequirement }
    | { kind: "recommendation"; candidates: readonly { outfitId: string; name: string }[] }
    | { kind: "gap"; gap: RankGap }
    | { kind: "composeFailed"; problems: readonly string[] }
    | {
        kind: "quote";
        quote: StylistQuote;
        credits: number;
        available: number;
        shortfall: number;
        canAfford: boolean;
      }
    | { kind: "approvalRequired"; quote: StylistQuote }
    | { kind: "renderBlocked"; blockers: readonly string[] }
    | { kind: "renderStarted"; jobId: string }
    | { kind: "saved"; outfitId: string }
    | { kind: "gaps"; report: GapReport }
    | { kind: "chat" }
  );

export type StylistTurnOptions = {
  state: StylistThreadState;
  turn: StylistTurnInput;
  now: number;
  ports: StylistPorts;
  quality?: RenderQuality;
  perOutfit?: number;
  approved?: boolean;
};

/** Raised when an event is applied out of order; indicates a bug, not a user error. */
export class StylistOrchestrationError extends Error {
  readonly code: TransitionErrorCode;

  constructor(code: TransitionErrorCode) {
    super(`stylist orchestration failed: ${code}`);
    this.name = "StylistOrchestrationError";
    this.code = code;
  }
}

/**
 * Pure decision for the tool's approval policy: only a render turn that resolved a referent and
 * raised no clarification will spend credits and therefore needs the human.
 */
export function turnNeedsApproval(state: StylistThreadState, turn: StylistTurnInput): boolean {
  const plan = mergeStylistTurn(planStateOf(state), turn);
  return plan.intent === "render" && plan.clarification === null && plan.referent !== null;
}

export async function runStylistTurn(options: StylistTurnOptions): Promise<StylistTurnResult> {
  const { state, turn, ports, now } = options;
  const quality = options.quality ?? "standard";
  const perOutfit = options.perOutfit ?? 1;
  const approved = options.approved ?? false;
  const plan = mergeStylistTurn(planStateOf(state), turn);

  if (plan.clarification) {
    const next = apply(state, { type: "CLARIFICATION_REQUIRED", now });
    return { kind: "clarification", clarification: plan.clarification, state: withPlan(next, plan), plan };
  }

  switch (plan.intent) {
    case "recommend":
    case "refine":
      return recommend(state, plan, ports, now);
    case "price":
      return quoteTurn(state, plan, ports, now, quality, perOutfit, "price", false);
    case "render":
      return quoteTurn(state, plan, ports, now, quality, perOutfit, "render", approved);
    case "save":
      return save(state, plan, ports, now);
    case "gaps": {
      const report = await ports.gapAnalysis();
      return { kind: "gaps", report, state, plan };
    }
    case "chat":
    default:
      return { kind: "chat", state, plan };
  }
}

async function recommend(
  state: StylistThreadState,
  plan: StylistPlan,
  ports: StylistPorts,
  now: number,
): Promise<StylistTurnResult> {
  const wardrobe = await ports.listReadyItems();
  const weather: WeatherFacts =
    plan.weatherNeeded && plan.place !== null && plan.date !== null
      ? await ports.fetchWeather(plan.place, plan.date)
      : {};
  const ranked = rankOutfits({ wardrobe, plan, weather });
  if (!ranked.ok) return { kind: "gap", gap: ranked.gap, state, plan };

  const composed = await ports.composeOutfits({
    brief: plan.brief ?? plan.occasion ?? "A look from your wardrobe",
    outfits: ranked.candidates.map((candidate) => ({
      name: candidateToProposal(candidate, wardrobe).name,
      slots: candidate.slots,
      reasoning: reasoningFrom(candidate.facts),
    })),
  });

  const candidates: { outfitId: string; name: string }[] = [];
  const problems: string[] = [];
  for (const result of composed) {
    if (result.outfitId) candidates.push({ outfitId: result.outfitId, name: result.name });
    else problems.push(...result.problems);
  }
  if (candidates.length === 0) return { kind: "composeFailed", problems, state, plan };

  const recommended = apply(state, {
    type: "RECOMMENDATION_READY",
    candidates,
    turnIndex: plan.turnIndex,
    now,
  });
  const proposed = apply(recommended, { type: "PROPOSALS_READY", candidates, now });
  return { kind: "recommendation", candidates, state: withPlan(proposed, plan), plan };
}

async function quoteTurn(
  state: StylistThreadState,
  plan: StylistPlan,
  ports: StylistPorts,
  now: number,
  quality: RenderQuality,
  perOutfit: number,
  mode: "price" | "render",
  approved: boolean,
): Promise<StylistTurnResult> {
  const planReferent = plan.referent;
  if (!planReferent) {
    const next = apply(state, { type: "CLARIFICATION_REQUIRED", now });
    return {
      kind: "clarification",
      clarification: { required: true, field: "referent", reason: "unknownReferent" },
      state: withPlan(next, plan),
      plan,
    };
  }

  const outfitIds = [planReferent.outfitId];
  const response = await ports.quoteRenders({ outfitIds, perOutfit, quality });
  if (response.blockers.length > 0) {
    return { kind: "renderBlocked", blockers: response.blockers, state, plan };
  }

  const stylistQuote = buildQuote(outfitIds, quality, response.credits, now);
  const quoted = apply(state, { type: "QUOTE_READY", quote: stylistQuote, now });

  if (mode === "price") {
    return {
      kind: "quote",
      quote: stylistQuote,
      credits: response.credits,
      available: response.available,
      shortfall: response.shortfall,
      canAfford: response.canAfford,
      state: withPlan(quoted, plan),
      plan,
    };
  }

  const awaiting = apply(quoted, { type: "APPROVAL_REQUESTED", now });
  if (!approved) return { kind: "approvalRequired", quote: stylistQuote, state: withPlan(awaiting, plan), plan };

  const approvedState = apply(awaiting, { type: "APPROVED", now });
  const { jobId } = await ports.startRenders({ outfitIds, perOutfit, quality });
  const started = apply(approvedState, { type: "RENDER_STARTED", renderJobId: jobId, now });
  return { kind: "renderStarted", jobId, state: withPlan(started, plan), plan };
}

async function save(
  state: StylistThreadState,
  plan: StylistPlan,
  ports: StylistPorts,
  now: number,
): Promise<StylistTurnResult> {
  const planReferent = plan.referent;
  if (!planReferent) {
    const next = apply(state, { type: "CLARIFICATION_REQUIRED", now });
    return {
      kind: "clarification",
      clarification: { required: true, field: "referent", reason: "unknownReferent" },
      state: withPlan(next, plan),
      plan,
    };
  }

  await ports.saveOutfit(planReferent.outfitId);
  const saved = apply(state, { type: "OUTFIT_SAVED", outfitId: planReferent.outfitId, now });
  return { kind: "saved", outfitId: planReferent.outfitId, state: withPlan(saved, plan), plan };
}

function planStateOf(state: StylistThreadState): {
  turnIndex: number;
  plan: StylistPlan | null;
  candidates: readonly { outfitId: string; name: string }[];
} {
  return { turnIndex: state.turnIndex, plan: state.plan, candidates: state.candidates };
}

function withPlan(state: StylistThreadState, plan: StylistPlan): StylistThreadState {
  return { ...state, plan };
}

function buildQuote(outfitIds: readonly string[], quality: RenderQuality, credits: number, now: number): StylistQuote {
  const each = outfitIds.length > 0 ? credits / outfitIds.length : 0;
  return {
    outfitIds: [...outfitIds],
    perOutfit: outfitIds.map((outfitId) => ({ outfitId, credits: each })),
    quality,
    credits,
    quotedAt: now,
    expiresAt: now + QUOTE_TTL_MS,
  };
}

function reasoningFrom(facts: readonly string[]): string {
  if (facts.length === 0) return "A balanced look built from your wardrobe.";
  return `Built from ${facts.join(", ")}.`;
}

function apply(state: StylistThreadState, event: MachineEvent): StylistThreadState {
  const result = transitionStylistState(state, event);
  if (!result.ok) throw new StylistOrchestrationError(result.error.code);
  return result.state;
}