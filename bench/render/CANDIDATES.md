# Candidate notes — FASHN VTON v1.5 (primary technical candidate)

Status: UNTESTED. Everything below is a contract gap Phase C must prove, not a claim.
Each item is marked TO VERIFY IN PHASE C where evidence is still missing.

## What the brief already establishes

- Main repo is Apache-2.0; roughly 2 GB weights; documented CPU mode with float32 conversion.
- Native contract is person + ONE garment (categories: tops, bottoms, one-pieces).

## Gaps to prove in Phase C

1. **Single-garment native interface vs 1–15 references.**
   Our contract sends up to 15 ordered references; FASHN takes person + one garment.
   TO VERIFY IN PHASE C: whether sequential application covers TOP_BOTTOM and LAYERED,
   and how intermediate artifacts affect fidelity. Do not claim sequential try-on works.

2. **Category coverage.** Native tops/bottoms/one-pieces only.
   TO VERIFY IN PHASE C: outerwear behavior, and that shoes/accessories are out of
   contract (measure, do not silently drop — TOP_BOTTOM/LAYERED rubric has explicit
   multi-garment scoring for this).

3. **CPU float32 cost.** Float32 conversion is documented but unmeasured here.
   TO VERIFY IN PHASE C: real RSS (expect materially above the ~441 MB SAM2-class
   envelope), per-case latency on 2 vCPU Neoverse-N1, and headroom beside FlorenceSAM.

4. **Output geometry.** Production requires final 1024×1536 opaque PNG.
   TO VERIFY IN PHASE C: native output size, resampling path, and framing behavior
   (rubric: full-body framing scored independently).

5. **Dependency licensing — PRODUCTION GATE, independent of all benchmarks.**
   The main repo license is not the whole picture: third-party dependencies,
   especially fashn-human-parser and anything NVIDIA-derived, must each be verified
   commercially acceptable BEFORE any production design. A benchmark pass without a
   license pass changes nothing. TO VERIFY IN PHASE C (read-only license audit first,
   before any download).

6. **Prompt/conditioning semantics.** Our contract is English-prompt + reference
   images; a try-on model conditions differently (garment image + category + pose
   inputs). TO VERIFY IN PHASE C: exactly which inputs drive quality and what the
   production adapter would need to synthesize per request.
