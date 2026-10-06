import type {
  StylistQuote,
  StylistReferent,
  StylistStage,
  StylistThreadState,
} from "./stylist-state";
import { EMPTY_STYLIST_STATE, QUOTE_TTL_MS, quoteExpired, quoteIdentityMatches } from "./stylist-state";

export type TransitionResult =
  | { ok: true; state: StylistThreadState }
  | { ok: false; error: TransitionError };

export type TransitionError = {
  code: TransitionErrorCode;
  message: string;
};

export const TRANSITION_ERROR_CODES = [
  "outOfSequence",
  "noProposal",
  "unknownOutfit",
  "noQuote",
  "quoteStale",
  "quoteMismatch",
  "notApproved",
  "insufficientCredits",
  "noAvatar",
  "hqLocked",
  "tooManyJobs",
  "maxOutfits",
] as const;

export type TransitionErrorCode = (typeof TRANSITION_ERROR_CODES)[number];

export type EventTimestamp = { now: number };

export type MachineEvent =
  | { type: "RECOMMENDATION_READY"; candidates: readonly { outfitId: string; name: string }[]; turnIndex: number; now: number }
  | { type: "PROPOSALS_READY"; candidates: readonly { outfitId: string; name: string }[]; now: number }
  | { type: "QUOTE_READY"; quote: StylistQuote; now: number }
  | { type: "QUOTE_FAILED"; reason?: string; now: number }
  | { type: "QUOTE_EXPIRED"; now: number }
  | { type: "APPROVAL_REQUESTED"; now: number }
  | { type: "APPROVED"; now: number }
  | { type: "REJECTED"; now: number }
  | { type: "RENDER_STARTED"; renderJobId: string; now: number }
  | { type: "RENDER_COMPLETED"; renderJobId: string; now: number }
  | { type: "RENDER_FAILED"; reason?: string; now: number }
  | { type: "OUTFIT_SAVED"; outfitId: string; now: number }
  | { type: "RESET_RECOMMENDATION"; now: number }
  | { type: "CLARIFICATION_REQUIRED"; now: number }
  | { type: "PLAN_CHANGED"; candidates: readonly { outfitId: string; name: string }[]; selectedReferent: StylistReferent | null; now: number }
  | { type: "PRICE_ONLY"; now: number }
  | { type: "RENDER_INTENT"; selectedReferent: StylistReferent | null; now: number };

const IDENTITY_KEYS: readonly (keyof StylistThreadState)[] = [
  "version",
  "stage",
  "turnIndex",
  "plan",
  "candidates",
  "selectedReferent",
  "quote",
  "approved",
  "approvalRejectedAt",
  "renderJobId",
  "savedOutfitId",
  "pendingQuestion",
  "updatedAt",
];

function copyState(state: StylistThreadState): StylistThreadState {
  return structuredClone(state);
}

function candidatesEqual(a: readonly { outfitId: string; name: string }[], b: readonly { outfitId: string; name: string }[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].outfitId !== b[i].outfitId) return false;
  return true;
}

function referentMatches(referent: StylistReferent | null, candidates: readonly { outfitId: string; name: string }[]): boolean {
  if (!referent) return true;
  return candidates.some((c) => c.outfitId === referent.outfitId);
}

export function transitionStylistState(state: StylistThreadState, event: MachineEvent): TransitionResult {
  const s = copyState(state);
  switch (event.type) {
    case "RECOMMENDATION_READY": {
      const candidates = copyCandidates(event.candidates);
      const next: StylistThreadState = {
        ...EMPTY_STYLIST_STATE,
        version: 1,
        stage: "RECOMMENDED",
        turnIndex: event.turnIndex,
        plan: s.plan,
        candidates,
        selectedReferent: null,
        quote: null,
        approved: false,
        approvalRejectedAt: null,
        renderJobId: null,
        savedOutfitId: null,
        pendingQuestion: null,
        updatedAt: event.now,
      };
      return { ok: true, state: next };
    }
    case "PROPOSALS_READY": {
      if (s.stage !== "RECOMMENDED" && s.stage !== "PROPOSED" && s.stage !== "QUOTED" && s.stage !== "AWAITING_APPROVAL") {
        return invalid("outOfSequence");
      }
      const candidates = copyCandidates(event.candidates);
      if (candidates.length === 0) return invalid("noProposal");
      const next: StylistThreadState = {
        ...s,
        stage: "PROPOSED",
        candidates,
        selectedReferent: null,
        quote: null,
        approved: false,
        approvalRejectedAt: null,
        renderJobId: null,
        savedOutfitId: null,
        updatedAt: event.now,
      };
      return { ok: true, state: next };
    }
    case "QUOTE_READY": {
      if (s.stage !== "PROPOSED" && s.stage !== "QUOTED" && s.stage !== "AWAITING_APPROVAL") return invalid("outOfSequence");
      const candidates = s.candidates;
      for (const id of event.quote.outfitIds) if (!candidates.some((c) => c.outfitId === id)) return invalid("unknownOutfit");
      if (event.quote.outfitIds.length > candidates.length) return invalid("maxOutfits");
      const next: StylistThreadState = {
        ...s,
        stage: "QUOTED",
        quote: copyQuote(event.quote),
        approved: false,
        approvalRejectedAt: null,
        renderJobId: null,
        updatedAt: event.now,
      };
      return { ok: true, state: next };
    }
    case "QUOTE_FAILED": {
      if (s.stage !== "PROPOSED") return invalid("outOfSequence");
      return { ok: true, state: { ...s, stage: "PROPOSED", quote: null, approved: false, updatedAt: event.now } };
    }
    case "QUOTE_EXPIRED": {
      if (!s.quote) return invalid("noQuote");
      if (!quoteExpired(s.quote, event.now)) return { ok: true, state: { ...s, updatedAt: event.now } };
      return { ok: true, state: { ...s, stage: s.stage === "AWAITING_APPROVAL" ? "PROPOSED" : s.stage, quote: null, approved: false, approvalRejectedAt: null, updatedAt: event.now } };
    }
    case "APPROVAL_REQUESTED": {
      if (s.stage !== "QUOTED") return invalid("outOfSequence");
      if (!s.quote) return invalid("noQuote");
      return { ok: true, state: { ...s, stage: "AWAITING_APPROVAL", updatedAt: event.now } };
    }
    case "APPROVED": {
      if (s.stage !== "AWAITING_APPROVAL") return invalid("outOfSequence");
      if (!s.quote) return invalid("noQuote");
      if (quoteExpired(s.quote, event.now)) return invalid("quoteStale");
      return { ok: true, state: { ...s, approved: true, approvalRejectedAt: null, updatedAt: event.now } };
    }
    case "REJECTED": {
      if (s.stage !== "AWAITING_APPROVAL" && s.stage !== "QUOTED") return invalid("outOfSequence");
      return { ok: true, state: { ...s, approved: false, approvalRejectedAt: event.now, stage: "PROPOSED", quote: null, updatedAt: event.now } };
    }
    case "RENDER_STARTED": {
      if (!s.approved) return invalid("notApproved");
      if (!s.quote) return invalid("noQuote");
      if (quoteExpired(s.quote, event.now)) return invalid("quoteStale");
      if (s.stage !== "AWAITING_APPROVAL" && s.stage !== "QUOTED" && s.stage !== "PROPOSED") {
        if (s.stage !== "RENDERING") return invalid("outOfSequence");
      }
      return { ok: true, state: { ...s, stage: "RENDERING", renderJobId: event.renderJobId, updatedAt: event.now } };
    }
    case "RENDER_COMPLETED": {
      if (s.stage !== "RENDERING") return invalid("outOfSequence");
      if (s.renderJobId && s.renderJobId !== event.renderJobId) return invalid("outOfSequence");
      return { ok: true, state: { ...s, stage: "RENDERED", renderJobId: event.renderJobId, updatedAt: event.now } };
    }
    case "RENDER_FAILED": {
      if (s.stage !== "RENDERING") return invalid("outOfSequence");
      return { ok: true, state: { ...s, stage: "BLOCKED", renderJobId: null, approved: false, quote: null, updatedAt: event.now } };
    }
    case "OUTFIT_SAVED": {
      if (s.stage !== "RENDERED" && s.stage !== "PROPOSED" && s.stage !== "QUOTED") return invalid("outOfSequence");
      if (!s.candidates.some((c) => c.outfitId === event.outfitId)) return invalid("unknownOutfit");
      return { ok: true, state: { ...s, stage: "SAVED", savedOutfitId: event.outfitId, updatedAt: event.now } };
    }
    case "RESET_RECOMMENDATION": {
      return { ok: true, state: { ...EMPTY_STYLIST_STATE, version: 1, updatedAt: event.now } };
    }
    case "CLARIFICATION_REQUIRED": {
      return { ok: true, state: { ...s, pendingQuestion: s.pendingQuestion ?? "clarify", updatedAt: event.now } };
    }
    case "PLAN_CHANGED": {
      const candidates = copyCandidates(event.candidates);
      if (!candidatesEqual(candidates, s.candidates)) {
        return {
          ok: true,
          state: {
            ...s,
            candidates,
            selectedReferent: referentMatches(event.selectedReferent, candidates) ? event.selectedReferent : null,
            quote: null,
            approved: false,
            approvalRejectedAt: null,
            renderJobId: null,
            stage: candidates.length > 0 ? "PROPOSED" : s.stage,
            updatedAt: event.now,
          },
        };
      }
      const sel = referentMatches(event.selectedReferent, candidates) ? event.selectedReferent : s.selectedReferent;
      return { ok: true, state: { ...s, selectedReferent: sel, updatedAt: event.now } };
    }
    case "PRICE_ONLY": {
      return { ok: true, state: { ...s, updatedAt: event.now } };
    }
    case "RENDER_INTENT": {
      const sel = referentMatches(event.selectedReferent, s.candidates) ? event.selectedReferent : s.selectedReferent;
      return { ok: true, state: { ...s, selectedReferent: sel, updatedAt: event.now } };
    }
    default:
      return invalid("outOfSequence");
  }
}

function copyCandidates(c: readonly { outfitId: string; name: string }[]): readonly { outfitId: string; name: string }[] {
  return c.map((x) => ({ outfitId: x.outfitId, name: x.name }));
}

function copyQuote(q: StylistQuote): StylistQuote {
  return {
    outfitIds: [...q.outfitIds],
    perOutfit: q.perOutfit.map((p) => ({ outfitId: p.outfitId, credits: p.credits })),
    quality: q.quality,
    credits: q.credits,
    quotedAt: q.quotedAt,
    expiresAt: q.expiresAt,
  };
}

function invalid(code: TransitionErrorCode): TransitionResult {
  return { ok: false, error: { code, message: code } };
}
