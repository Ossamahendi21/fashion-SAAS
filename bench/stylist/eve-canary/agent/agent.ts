import { defineAgent } from "eve";
import { createDeterministicStylistModel } from "../../../../agent/lib/deterministic-stylist-model";

export default defineAgent({
  defaultTools: false,
  model: createDeterministicStylistModel(),
  modelContextWindowTokens: 1_000_000,
});