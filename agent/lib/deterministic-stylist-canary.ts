import { isStepCount, ToolLoopAgent, tool } from "ai";
import {
  createDeterministicStylistModel,
  STYLIST_TURN_TOOL_NAME,
} from "./deterministic-stylist-model";
import { runStylistTurn, turnNeedsApproval, type StylistPorts } from "./stylist-orchestrator";
import type { StylistTurnInput } from "./stylist-plan";
import { stylistTurnInputSchema, toStylistTurnOutput, type StylistTurnOutput } from "./stylist-turn";
import type { StylistThreadState } from "./stylist-state";

/**
 * Step 7 Phase C7B — the deterministic canary harness.
 *
 * This wires the real `ai` `ToolLoopAgent` (the same tool-loop class Eve's harness builds, with the
 * same `stopWhen` bounded step count) to the deterministic transport adapter. It is the proof that
 * the adapter satisfies the tool-loop contract end to end without any AI inference:
 *
 * - the ONLY tool visible to the model is `stylist_turn` — the legacy production surface is never
 *   registered here;
 * - the tool delegates to the already-verified deterministic pipeline (`runStylistTurn` →
 *   `toStylistTurnOutput`), which owns all durable state and every credit decision;
 * - approval is Eve-native: `needsApproval` mirrors the tool policy, and the harness itself never
 *   reads an approval token, a garment id, or a persisted outfit id from model or user text.
 *
 * The agent reports exactly two model steps for a normal turn (Phase A tool call, Phase B text) and
 * one step for a turn that pauses for approval, which is what Eve's session machinery expects.
 */

export const CANARY_NOW = 1_000;

export type DeterministicStylistCanaryOptions = {
  ports: StylistPorts;
  state: StylistThreadState;
  now?: number;
};

export function createDeterministicStylistCanary(
  options: DeterministicStylistCanaryOptions,
) {
  let state = options.state;
  const now = options.now ?? CANARY_NOW;
  const outputs: StylistTurnOutput[] = [];

  const stylistTurn = tool({
    description:
      "Run one deterministic stylist turn for the latest user message. The only tool available.",
    inputSchema: stylistTurnInputSchema,
    needsApproval: (input) => turnNeedsApproval(state, input.turn as StylistTurnInput),
    execute: async (input) => {
      const result = await runStylistTurn({
        state,
        turn: input.turn as StylistTurnInput,
        now,
        ports: options.ports,
        approved: true,
        ...(input.quality !== undefined ? { quality: input.quality } : {}),
        ...(input.perOutfit !== undefined ? { perOutfit: input.perOutfit } : {}),
      });
      state = result.state;
      const output = toStylistTurnOutput(result);
      outputs.push(output);
      return output;
    },
  });

  const agent = new ToolLoopAgent({
    model: createDeterministicStylistModel(),
    tools: { [STYLIST_TURN_TOOL_NAME]: stylistTurn },
    stopWhen: isStepCount(2),
  });

  return {
    agent,
    toolName: STYLIST_TURN_TOOL_NAME,
    getState: () => state,
    outputs,
  };
}

export type DeterministicStylistCanary = ReturnType<typeof createDeterministicStylistCanary>;