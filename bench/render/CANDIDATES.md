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

---

# Phase C2 gate — Leffa (franciszzj/Leffa @ 05a2591): REJECT_LEFFA

Source-only audit (no weights/inference/installs). Do not download weights to
re-prove what the source already shows.

## Verified facts

- Code is MIT, but the normal VTON path hard-requires, per case:
  DensePose via vendored detectron2 + `model_final_162be9.pkl` (zoo weights under
  CC-BY-SA 3.0 per the vendored MODEL_ZOO.md — share-alike terms need counsel
  before SaaS use, not a plain commercial-safe grant); SCHP parsing via
  `parsing_atr/lip.onnx` of unstated converter provenance (plus original
  GoGoDuck `.pth` files in the same bundle); OpenPose via ControlNet-style
  annotator code carrying CMU's academic/noncommercial license file in-tree and
  a `body_pose_model.pth` of unstated provenance; SD-inpainting base under
  CreativeML Open RAIL-M (restrictions apply); Leffa checkpoints trained on
  academic VITON-HD/DressCode data per the author's own demo note.
- Preprocessing is NOT optional: `Parsing` (atr+lip CPU-ONNX), `OpenPose`
  (.pth), and `DensePosePredictor` (detectron2 pickle) are all constructed and
  called on the VTON path (`app.py` wiring; `get_agnostic_mask_hd/dc` consume
  parse + keypoints; densepose seg/iuv feeds the diffusion input).
- Footprint: dual SD1.5-class UNets + VAE at 768×1024, default 50 diffusion
  steps with CFG (2 UNet forwards/step + per-step reference encoder without
  `ref_acceleration`); model defaults to float16 even on CPU; no CPU offload,
  no quantization path in source. Expect multi-GB RSS and very long 2-vCPU
  runs — TO VERIFY figures were never reached because licensing already fails.
- Contract: single garment only (`upper_body`/`lower_body`/`dresses`; no
  outerwear/shoes/accessories); no multi-garment or sequential support in source.
- aarch64/CPU: torch/onnxruntime/diffusers/transformers are portable in
  principle, but detectron2 arrives as vendored CUDA/C++ source requiring a
  from-source build, `requirements.txt` is version-unpinned (incl. `triton`),
  and OpenPose weights have no stated commercial terms.

## Decision rationale

Three independent hard gates, any one sufficient: (1) OpenPose annotator code
is explicitly academic/noncommercial in-tree; (2) DensePose zoo weights are
CC-BY-SA (share-alike encumbrance unresolved for SaaS); (3) SCHP-ONNX and
OpenPose weight provenance is unstated. Added weight: dual-UNet diffusion at
50 steps has no plausible CPU story on 2 vCPU beside FlorenceSAM, and the
contract covers at most 3 of our 10 fit needs with no multi-garment path.
REJECT_LEFFA: do not download weights to prove failure.
