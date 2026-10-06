import type { StylistTurnResult } from "./stylist-orchestrator";

/**
 * Step 7 Phase C5 — the deterministic response formatter.
 *
 * It turns a trusted C4 outcome into short British-English prose and nothing else. It is pure, and
 * critically it never invents a fact:
 *
 * - Numbers come only from a trusted quote outcome. There is no arithmetic here, so a cost can never
 *   appear without a real quote.
 * - Garment and outfit identity never appears as an id; only the trusted proposal names are read.
 * - Weather is never mentioned, so an unavailable forecast cannot be fabricated.
 * - "Started" is said only for a `renderStarted` outcome, and "approval" only for `approvalRequired`.
 */

/** The trusted facts the formatter may speak about. Every field is produced upstream, never here. */
export type StylistResponseOutcome =
  | { kind: "chat" }
  | { kind: "clarification"; field: string }
  | { kind: "recommendation"; candidates: readonly { outfitId: string; name: string }[] }
  | { kind: "gap"; code: string }
  | { kind: "gaps"; totalItems: number; gaps: readonly string[] }
  | { kind: "composeFailed" }
  | { kind: "quote"; credits: number; available: number; shortfall: number; canAfford: boolean }
  | { kind: "approvalRequired"; credits: number }
  | { kind: "renderBlocked"; blockers: readonly string[] }
  | { kind: "renderStarted" }
  | { kind: "saved" }
  | { kind: "readFailed" };

function credits(count: number): string {
  return `${count} ${count === 1 ? "credit" : "credits"}`;
}

/** Fixed language per C3 gap code. The formatter owns the copy, so no upstream string can leak in. */
function gapCopy(code: string): string {
  switch (code) {
    case "noReadyItems":
      return "Nothing in your wardrobe is ready to wear yet. Finish or add a few items and I'll try again.";
    case "missingTop":
      return "You don't currently have a ready top or a dress to build a look around.";
    case "missingBottom":
      return "You don't currently have a ready bottom or a dress to complete a look.";
    case "missingDress":
      return "You don't currently have a ready top-and-bottom pair or a dress to build around.";
    case "missingShoes":
      return "You don't currently have ready shoes for this request.";
    case "missingOuterwear":
      return "You don't currently have suitable outerwear for this request.";
    case "colourConstraintUnsatisfied":
      return "I couldn't find a complete look in those colours from your wardrobe.";
    case "formalityConstraintUnsatisfied":
      return "Nothing in your wardrobe matches that level of formality just yet.";
    default:
      return "I can't build a complete look from your wardrobe for that request.";
  }
}

function clarificationCopy(field: string): string {
  switch (field) {
    case "occasion":
      return "What's the occasion? Tell me a little more and I'll put a look together.";
    case "referent":
      return "Which look do you mean? Try \u201cthe first one\u201d or \u201cthe second one\u201d.";
    case "place":
      return "Where will you be? Tell me and I'll check the weather.";
    case "formality":
      return "How formal should it be — casual, smart casual, or formal?";
    default:
      return "Tell me a little more and I'll put a look together.";
  }
}

function recommendationCopy(candidates: readonly { name: string }[]): string {
  const names = candidates.map((candidate) => candidate.name).filter((name) => name.trim().length > 0);
  if (names.length === 0) return "I couldn't put a look together from your wardrobe for that request.";
  if (names.length === 1) return `Here's your look: ${names[0]}.`;
  return `Here are ${names.length} looks: ${names.join(", ")}.`;
}

/**
 * Format a trusted outcome as one short British-English sentence group. Pure and total: the same
 * outcome always yields the identical string.
 */
export function formatStylistResponse(outcome: StylistResponseOutcome): string {
  switch (outcome.kind) {
    case "chat":
      return "Tell me what you'd like — a new look, a tweak, a price, or to save or render one.";

    case "clarification":
      return clarificationCopy(outcome.field);

    case "recommendation":
      return recommendationCopy(outcome.candidates);

    case "gap":
      return gapCopy(outcome.code);

    case "gaps":
      return outcome.gaps.length === 0
        ? "Your wardrobe looks well covered — I didn't find a gap."
        : `A few gaps to fill: ${outcome.gaps.join("; ")}.`;

    case "composeFailed":
      return "I couldn't put that look together just now. Please try again.";

    case "quote": {
      const base = `That's ${credits(outcome.credits)} (you have ${outcome.available}).`;
      if (!outcome.canAfford || outcome.shortfall > 0) return `${base} You're ${credits(outcome.shortfall)} short.`;
      return base;
    }

    case "approvalRequired":
      return `That would cost ${credits(outcome.credits)}. Approve it and I'll start the render.`;

    case "renderBlocked":
      return outcome.blockers.length > 0
        ? `I can't start that render just yet: ${outcome.blockers.join("; ")}.`
        : "I can't start that render just yet.";

    case "renderStarted":
      return "Your render is under way — I'll show it here when it's ready.";

    case "saved":
      return "Saved to your outfits.";

    case "readFailed":
      return "I couldn't reach your wardrobe just now. Please try again.";

    default:
      return formatStylistResponse({ kind: "chat" });
  }
}

/** Project a trusted C4 outcome onto the formatter's input. No new facts are created. */
export function responseOutcomeFromTurn(result: StylistTurnResult): StylistResponseOutcome {
  switch (result.kind) {
    case "clarification":
      return { kind: "clarification", field: result.clarification.field };
    case "recommendation":
      return { kind: "recommendation", candidates: result.candidates };
    case "gap":
      return { kind: "gap", code: result.gap.code };
    case "gaps":
      return { kind: "gaps", totalItems: result.report.totalItems, gaps: result.report.gaps };
    case "composeFailed":
      return { kind: "composeFailed" };
    case "quote":
      return {
        kind: "quote",
        credits: result.credits,
        available: result.available,
        shortfall: result.shortfall,
        canAfford: result.canAfford,
      };
    case "approvalRequired":
      return { kind: "approvalRequired", credits: result.quote.credits };
    case "renderBlocked":
      return { kind: "renderBlocked", blockers: result.blockers };
    case "renderStarted":
      return { kind: "renderStarted" };
    case "saved":
      return { kind: "saved" };
    case "chat":
    default:
      return { kind: "chat" };
  }
}