# Render benchmark harness (Phase B — no models, no calls, no production changes)

## Layout

- `manifest.json` — the 7 fixed cases (ids, person/garment fixture paths, what each tests).
- `validate.mjs` — machine validators (manifest schema, result record schema, output inspection via sharp).
- `rubric.md` — fixed human-review rubric (0–4 per dimension).
- `CANDIDATES.md` — FASHN VTON v1.5 contract gaps to prove in Phase C.
- `EXCLUDED.md` — candidates excluded from production benchmarking and why.
- `fixtures/` — operator-supplied images at benchmark time; never committed.

## Fixtures

Populate `bench/render/fixtures/` locally before Phase C. Acceptable sources, in order:
repo-owned synthetic images, user-provided photos with explicit permission, or
re-renders of Step 4 cutouts. Never commit private photos: the directory carries
only a `.gitkeep`, and `manifest.json` paths are the fixed contract.

## Result record (one JSON per candidate/case)

```json
{
  "candidate": "fashn-vton-1.5",
  "caseId": "TOP_BASIC",
  "success": true,
  "outputPath": "bench/render/.out/fashn-vton-1.5-TOP_BASIC.png",
  "width": 1024,
  "height": 1536,
  "format": "png",
  "opaque": true,
  "latencyMs": 45000,
  "peakRssMb": 6144,
  "externalCostUsd": 0,
  "error": null
}
```

`externalCostUsd` is mandatory and explicit: `0` for self-hosted, never omitted.
Outputs land under `bench/render/.out/` (gitignored, mirroring `bench/extraction/.out/`).

## Validation

```bash
node bench/render/validate.mjs bench/render/.out/<candidate-case>.json
```

Checks: file exists and decodes; PNG; recorded vs measured dimensions and format;
2:3 aspect within 1% (exact 1024×1536 reported separately as `exactDimensions`);
alpha/channel info; file size; record schema including explicit `externalCostUsd`.

## Hard acceptance gates (Phase C rejection criteria, fixed before running)

COMPATIBILITY (all must hold):
- successful decodable PNG per case, transformable to exactly 1024×1536
- zero external paid provider calls in the path (meter it, don't assume it)
- commercial-use licensing acceptable BEFORE any production design (see CANDIDATES.md gate)

RESOURCE (all must hold):
- peak RSS fits ~12 GB VPS RAM with safe headroom alongside the live FlorenceSAM service
- must not destabilize the existing gateway (record RSS + latency per case)
- any runaway (OOM, swap death, service restart) fails the candidate

STABILITY (all must hold):
- clean failure modes (empty mask / error, never a corrupt PNG or hung process)
- production design must support max-1 heavy inference / bounded concurrency like Step 4

QUALITY:
- identity and garment fidelity must not catastrophically regress vs the current reference
- multi-garment cases (TOP_BOTTOM, LAYERED) must report per-garment results, never hide a dropped garment
- DETAIL_FIDELITY and HARD_PERSON failures are blocking for a wardrobe product, advisory otherwise

No latency pass number is set: record latency first, judge after evidence.
