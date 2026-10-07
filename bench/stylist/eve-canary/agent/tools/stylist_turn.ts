import { defineTool } from "eve/tools";
import { toStylistTurnOutput, stylistTurnInputSchema, type StylistTurnOutput } from "../../../../../agent/lib/stylist-turn";
import { runStylistTurn, turnNeedsApproval } from "../../../../../agent/lib/stylist-orchestrator";
import { mergeStylistTurn, type StylistTurnInput } from "../../../../../agent/lib/stylist-plan";
import { readStylistState, writeStylistState } from "../../../../../agent/lib/stylist-session-state";
import type { StylistThreadState } from "../../../../../agent/lib/stylist-state";
import { buildCanaryPorts, canaryAudit, type CanaryAudit } from "../lib/canary-ports";

/**
 * Step 7 Phase C7B.1 — the single canary tool, run by the real Eve runtime.
 *
 * Byte-for-byte the same contract as the production `stylist_turn` (same input schema, same approval
 * policy, the same orchestrator and formatter), with two differences that keep the canary offline:
 * ports are the in-process fakes from `agent/lib/canary-ports.ts` instead of Convex, and the trusted
 * output additionally carries the per-session side-effect audit so the approval test can observe
 * whether a render ever started.
 */

export type CanaryStylistTurnOutput = StylistTurnOutput & { audit: CanaryAudit };

const toolLabel = {
  start: (): string => "Working out your look",
  complete: (_input: unknown, output: CanaryStylistTurnOutput): string => output.summary,
};

export default defineTool({
  description:
    "Run one stylist turn: recommend or refine outfits, price or render one, save it, or report " +
    "wardrobe gaps. Pass the normalised turn; the tool keeps the conversation's state itself. A " +
    "render turn is quoted and approved before anything is spent.",
  inputSchema: stylistTurnInputSchema,
  label: toolLabel,
  approval: {
    async request(ctx) {
      const input = ctx.toolInput;
      if (!input) return { type: "denied", reason: "The stylist turn was missing its arguments." };

      const state = readStylistState();
      const turn = input.turn as StylistTurnInput;
      if (!turnNeedsApproval(state, turn)) return "not-applicable";

      const outfitId = referentOutfitId(state, turn);
      if (!outfitId) return "not-applicable";

      try {
        const { blockers } = await buildCanaryPorts(ctx.session.id).quoteRenders({
          outfitIds: [outfitId],
          perOutfit: input.perOutfit ?? 1,
          quality: input.quality ?? "standard",
        });
        const [blocker] = blockers;
        if (blocker) return { type: "denied", reason: blocker };
      } catch (error) {
        return { type: "denied", reason: error instanceof Error ? error.message : "Quote failed." };
      }

      return "user-approval";
    },
    response() {
      return { status: "allowed" };
    },
  },
  async execute(input, ctx): Promise<CanaryStylistTurnOutput> {
    const result = await runStylistTurn({
      state: readStylistState(),
      turn: input.turn as StylistTurnInput,
      now: Date.now(),
      ports: buildCanaryPorts(ctx.session.id),
      quality: input.quality,
      perOutfit: input.perOutfit,
      approved: true,
    });
    writeStylistState(result.state);
    return { ...toStylistTurnOutput(result), audit: canaryAudit(ctx.session.id) };
  },
});

function referentOutfitId(state: StylistThreadState, turn: StylistTurnInput): string | null {
  const plan = mergeStylistTurn(
    { turnIndex: state.turnIndex, plan: state.plan, candidates: state.candidates },
    turn,
  );
  return plan.referent?.outfitId ?? null;
}