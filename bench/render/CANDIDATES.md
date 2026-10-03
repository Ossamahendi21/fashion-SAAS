# Candidate notes — FASHN VTON v1.5 (primary technical candidate)

Status: Phase C1 SOURCE GATE COMPLETE (no weights, no inference). Source-derived facts
below; everything still requiring a run is marked TO VERIFY IN PHASE C.

## Phase C1 verified source facts (2026-10-03)

- Upstream SHAs inspected: fashn-vton-1.5 `7c0f10a`, fashn-human-parser `f2771f2`,
  NVlabs/SegFormer `65fa8cf`.
- Main repo license is Apache-2.0, BUT the pipeline hard-requires
  `fashn-human-parser>=0.1.1`, whose LICENSE states the model inherits the NVIDIA
  SegFormer Source Code License (research/evaluation-only, Sec. 3.3). The Apache-2.0
  branding does not cover the parser dependency.
- Parser is NOT optional: top-level import (`pipeline.py:11`), always initialized
  (`_setup_hp_model`), and runs on BOTH person and garment images on every call
  (`pipeline.py:266-267`), including `segmentation_free=True` and flat-lay garments.
- Native resolution 864×576 (2:3 portrait); default 30 diffusion timesteps with CFG
  (two model forwards per step); CPU forces float32; weights ~2 GB total per README.
- DWPose runs via ONNX Runtime (CPU-portable in principle); pyproject defaults to
  `onnxruntime-gpu` (needs CPU substitution on our box).
- Replacement interface (for any commercial-safe parser): RGB uint8 in →
  (H,W) int map over the exact 18-class FASHN taxonomy (background/face/hair/top/
  dress/skirt/pants/belt/bag/hat/scarf/glasses/arms/hands/legs/feet/torso/jewelry)
  at 384×576 preprocessing; body-part labels (arms/hands/legs/feet/torso) are
  consumed by `create_clothing_agnostic_image`, so phrase-grounded object masks
  alone are insufficient.
- No drop-in commercial-safe replacement with this exact taxonomy exists in-repo;
  ATR/LIP-family parsers lack hands/feet/torso as separate labels.

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
