# Stylist benchmark (Phase B0 fixtures)

Provider-independent frozen suite for Fitcheck's stylist contract. No model has seen these
prompts; no scores exist yet. Phase B1 will run candidates against `cases/` and check recorded
traces with `validate-trace.mjs`.

- `tool-contract.json` — the 10 active tools, mirrored from `agent/tools/*.ts` (everything else
  under `agent/tools/` is `disableTool()` and is intentionally absent).
- `wardrobe.json` — 15 frozen items with stable IDs; the only IDs any outfit may reference.
- `contexts.json` — frozen prefs, balance, weather, empty/filtered wardrobes, quote responses.
- `cases/case-01.json` … `case-18.json` — turns, mocked tool results, and `expect` blocks.
- `validate-trace.mjs` — checks a recorded trace: required/forbidden tools, order, argument
  schemas, ID grounding, quote-before-start with identical args, granted approval before start,
  authorized side effects only, problems-then-fixed retry.
- `rubric.json` — 0-2 response rubric, frozen hard gates, Phase B1 metrics schema.
- `context-sizes.json` — short/medium/long prompt windows for later KV/RAM/latency runs.
- `.out/` — future model outputs live here and are gitignored; never commit them.

Mock-result references resolve as: `wardrobe:all|empty|filter:<category>`,
`context:prefs|weather|quoteStandard|quoteBlocked`. A trace step is
`{type:"tool",tool,args}`, `{type:"result",tool,output}` (may carry
`composedOutfitIds` or `results:[{outfitId…}]`), or
`{type:"approval",tool:"start_renders",decision:"granted"|"denied"}`.
