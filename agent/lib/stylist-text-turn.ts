import type { RenderQuality } from "../../convex/shared/credits";
import { parseStylistText, type StylistParseResult } from "./stylist-language";
import {
  runStylistTurn,
  type StylistPorts,
  type StylistTurnResult,
} from "./stylist-orchestrator";
import {
  formatStylistResponse,
  responseOutcomeFromTurn,
  type StylistResponseOutcome,
} from "./stylist-response";
import type { StylistThreadState } from "./stylist-state";

/**
 * Step 7 Phase C5 — the raw-text adapter over the deterministic pipeline.
 *
 * It is the only place raw language meets C1–C4, and it grants the text no authority:
 *
 * - `parseStylistText` (C5) normalises the utterance into a C1 turn, or fails safely.
 * - A failed parse returns the fallback response WITHOUT calling a single port, so unknown text
 *   cannot compose, quote, spend or save.
 * - A successful parse runs the trusted `runStylistTurn` (C4); a thrown port failure becomes the
 *   safe `readFailed` response.
 * - The reply is produced only by `formatStylistResponse` (C5) from the trusted outcome.
 *
 * Every dependency is injected, so tests drive the whole thing with fakes and no clock.
 */

export type StylistTextTurnOptions = {
  text: string;
  state: StylistThreadState;
  now: number;
  ports: StylistPorts;
  quality?: RenderQuality;
  perOutfit?: number;
  approved?: boolean;
  /** Step 7 Phase C9.1 — explicit render capability; omitted resolves the fail-closed policy. */
  renderEnabled?: boolean;
};

export type StylistTextTurnResult = {
  parse: StylistParseResult;
  outcome: StylistResponseOutcome;
  response: string;
  /** Present only when the deterministic pipeline actually ran. */
  turn?: StylistTurnResult;
};

export async function runStylistTextTurn(options: StylistTextTurnOptions): Promise<StylistTextTurnResult> {
  const parse = parseStylistText(options.text);

  if (!parse.ok) {
    const outcome: StylistResponseOutcome = { kind: "chat" };
    return { parse, outcome, response: formatStylistResponse(outcome) };
  }

  let turn: StylistTurnResult;
  try {
    turn = await runStylistTurn({
      state: options.state,
      turn: parse.turn,
      now: options.now,
      ports: options.ports,
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
      ...(options.perOutfit !== undefined ? { perOutfit: options.perOutfit } : {}),
      ...(options.approved !== undefined ? { approved: options.approved } : {}),
      ...(options.renderEnabled !== undefined ? { renderEnabled: options.renderEnabled } : {}),
    });
  } catch {
    const outcome: StylistResponseOutcome = { kind: "readFailed" };
    return { parse, outcome, response: formatStylistResponse(outcome) };
  }

  const outcome = responseOutcomeFromTurn(turn);
  return { parse, outcome, response: formatStylistResponse(outcome), turn };
}