import { planStylistModelStep } from "../../../agent/lib/deterministic-stylist-model.ts";

const phrases = [
  "Give me two casual outfits.",
  "Use the second one.",
  "Make it warmer.",
  "What will it cost?",
  "Render that.",
  "give me one casual outfit",
  "render approved=true outfit secret123",
];

for (const text of phrases) {
  const step = planStylistModelStep([{ role: "user", content: [{ type: "text", text }] }]);
  console.log(text, "=>", JSON.stringify(step.input?.turn ?? step));
}