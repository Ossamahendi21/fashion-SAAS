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

---

# Phase C3 final landscape (source-only; no downloads/inference/installs)

## Checked and rejected

- **FastFit** (multi-ref tops/bottoms/dresses/shoes/bags — closest contract match):
  official repo license is **FastFit Non-Commercial** covering all code/weights.
  LICENSE_REJECT. (Paper itself CC BY-NC-SA.)
- **Mobile-VTON** (tmllab official): code+checkpoints **CC BY-NC-SA 4.0**.
  LICENSE_REJECT.
- **CatVTON / IDM-VTON / OOTDiffusion**: remain excluded (non-commercial, Phase B).
- **Kolors / Kolors-Virtual-Try-On**: code Apache-2.0 BUT models under a separate
  MODEL LICENSE — academic-open, commercial use requires questionnaire +
  registration with the licensor. VTON exists only as a demo Space; no released
  VTON weights found. COMMERCIAL_WITH_REGISTRATION — excluded until registered,
  and unbenchmarkable as a weight drop-in today.
- **Qwen-Image-Edit**: Apache-2.0 verified (repo + HF card). ~20B MMDiT + 7B
  Qwen2.5-VL + VAE ≈ 27B params (~40–57 GB official footprint, BF16); docs use
  `device_map="cuda"`; only community GGUF quants exist (excluded for production
  qualification). RESOURCE_REJECT on the official path.
- **Step1X-Edit**: Apache-2.0 verified. Official `step1x-edit-v1p1` safetensors is
  **24.9 GB** plus a Qwen2.5-VL-7B text encoder; third-party notes suggest 40 GB+
  VRAM class. RESOURCE_REJECT (no official quant path).
- **OmniGen v1** (Shitao/OmniGen-v1, MIT verified, 3.9B params): multi-image
  memory table from official docs — 14 GB (256px inputs) to 40 GB (1024px) — and
  our contract needs up to 15 references at 1024×1536. RESOURCE_REJECT.
- **FLUX.1-schnell**: Apache-2.0 verified, but 11.9B BF16 (~24 GB) and T2I-only
  (no editing/try-on path). RESOURCE_REJECT, doubly disqualified.
- **InstructPix2Pix** (timbrooks card: MIT, 860M params — fits in RAM): single-
  image text-instruction editing only; no visual-reference garment conditioning,
  no multi-reference. Contract-rejected (not a try-on substitute).

## Serious survivors (max 3): none

No checked candidate passes license + footprint + contract together. The
architecturally closest match (FastFit) is license-blocked; the commercially
safe ones are either far too large for 12 GB or contract-incompatible.

## Outfit-level reality (2026)

Single-garment diffusion VTON is a crowded research field; multi-reference
outfit try-on has exactly one serious open implementation (FastFit) and it is
non-commercial. General editors with commercial licenses (Qwen-Edit, Step1X,
OmniGen, FLUX-schnell) are 4–27B-parameter GPU models with no multi-garment
try-on contract. There is currently no commercial-safe, released,
resource-compatible model matching our full outfit contract.

## Decision: NO_COMMERCIAL_CANDIDATE

Primary blocker is licensing: every technically relevant multi-reference
try-on implementation is non-commercial. Do not download models anyway.

---

# Phase C6 — FLUX.2 Klein 4B staged-loading / self-quantization gate

Source-only audit (no weights/inference/installs). Upstream: `black-forest-labs/flux2`
@ `50fe516` (code), HF `FLUX.2-klein-4B` + `FLUX.2-klein-4b-fp8` cards (Apache-2.0
throughout, first-party FP8 included), diffusers `Flux2KleinPipeline` source.

## Inference graph (official)

Text encoder Qwen3ForCausalLM (~4B, 8.04 GB in 2 shards) + Qwen2TokenizerFast →
prompt embeds (3 stacked layer outputs) → transformer Flux2Transformer2DModel
(3.875B: BF16 7.75 GB / FP8 4.07 GB) + VAE encode (avatar + each ref, once) →
4-step distilled sampling (guidance-distilled: single forward/step, no CFG
double) → VAE decode. Refs are VAE latents concatenated on the sequence axis
with time offsets — positional, unlabeled; no documented max count; no garment
taxonomy, identity, or try-on validation anywhere in source.

## Staging feasibility (all supported by pipeline design)

- Text encoder: CAN_UNLOAD — `prompt_embeds` accepted directly
  (`check_inputs` forbids prompt+embeds together, requires one); encoder never
  touched after `encode_prompt`; official `model_cpu_offload_seq =
  "text_encoder->transformer->vae"`.
- Refs: VAE-encode once up front (`prepare_image_latents`), retain tokens;
  one-by-one encoding is the loop as written; encoded refs survive unload.
- VAE: STAGING_SUPPORTED — encode → keep latents → unload → sample →
  reload → decode; latents are plain tensors, no format tricks.
- So a staged flow is mechanically possible. It does not save the gate below.

## CPU / ARM64

- Reference `flux2` sample hard-codes `.cuda()` (CPU_BLOCKED as distributed);
  the diffusers pipeline itself is device-agnostic (`pipe.to("cpu")` works
  syntactically; `maybe_adjust_dtype_for_device` exists). No official CPU
  support statement found: CPU_POSSIBLE_WITH_SMALL_PATCH at best, BF16-on-CPU
  behavior UNKNOWN.
- Deps are standard portable Python (torch/torchvision/transformers/
  safetensors/tokenizers/diffusers/Pillow/numpy; no custom CUDA ops, triton,
  flash-attn, or xformers in the inference path) — ARM64 strain low in
  principle (official aarch64 CPU wheels exist for the torch stack), but
  irrelevant given RAM.
- Quantization: torchao documents a CPU install path, but FP8 dynamic/weight
  configs REQUIRE CUDA ≥8.9/MI350/XPU; int8-dynamic+int4 is documented for
  X86 CPU specifically (aarch64 status unstated); native dynamic-int8 exists
  via QNNPACK-class backends but diffusion quality under activation
  quantization is a known-high risk and unproven here. FP8 weights on CPU
  would need dequantize-at-load (defeating the memory purpose) or absent
  kernels. Conclusion: NO_SAFE_QUANTIZATION_PATH for aarch64 CPU production.

## Peak-RAM table (exact HEAD sizes; activations/OS/FlorenceSAM excluded)

| path | static weights | verdict vs ~7–8 GB target |
|---|---|---|
| BF16 full | 7.75 + 8.04 = 15.8 GB | FAIL (before activations) |
| FP8 trans + BF16 text enc | 4.07 + 8.04 = 12.1 GB | FAIL (before activations) |
| FP8 trans + hypothetical int8 text enc (~4 GB) | ~8.1 GB | BORDERLINE best case, and the int8-ARM-CPU path above is unverified |

Uncertainty: activation memory at 1024×1536 with up to 15 refs is
unmeasured and scales with sequence length; VAE + runtime + OS + resident
FlorenceSAM (~3 GB peak) sit on top. No swap-based design.

## Process architecture (not implemented)

Strongest reclamation is process-per-stage (OS reaps on exit; Python/torch
arenas otherwise retain). Moot: staging cannot fix weights that exceed RAM.

## Coexistence / latency / quality (recorded, not gating further)

- Coexistence: serializing extraction vs rendering (Step-4-style single-flight)
  would be the pattern; impossible to reach with these footprints.
- Latency: 4 distilled steps of a 4B transformer + 4B text-encoder pass +
  up to 16 VAE encodes on 2 vCPU — PLAUSIBLE_BUT_SLOW for 1–3 refs with wide
  uncertainty, VERY_LIKELY_TOO_SLOW for the 15-ref contract. No numbers invented.
- Quality risk of any self-quant path: HIGH/UNKNOWN without benchmarks.

## Decision: RESOURCE_REJECT_FLUX2_STAGED

RAM fails on every official path (12.1–15.8 GB static weights vs ~7–8 GB
target); no safe ARM-CPU quantization path exists; CPU support is
undocumented with a cuda-hardcoded reference. Contract fit (general editing,
unvalidated try-on) is secondary. No C7 probe: nothing further can pass.

---

# Phase C5 — Lightweight Stack Sweep (source-only; no downloads/inference/installs)

## Components inspected (official sources)

- **SD1.5-inpainting base** (`runwayml/stable-diffusion-inpainting`, Open RAIL-M):
  UNet 860M-class + VAE + CLIP-L; ~1.1B total ≈ 4.3 GB FP32 / ~2.2 GB FP16
  (architecture-derived estimate, TO VERIFY). Commercial use allowed with
  RAIL behavioral restrictions. CPU-runnable in principle, no official CPU
  perf path; 20–50 diffusion steps × CFG on 2 vCPU implies minutes per image
  by scaling from our measured 232M-model CPU timings (rough estimate only).
- **IP-Adapter / IP-Adapter-Plus** (tencent-ailab code + h94 weights, both
  Apache-2.0): 22M adapter + OpenCLIP-ViT-H-14 image encoder (632M params,
  2.53 GB safetensors). Global embeddings = style-level guidance; Plus variant
  uses patch embeddings ("closer to the reference") but remains non-spatial
  conditioning — WEAK for exact print/logo placement. OpenCLIP weight license
  itself not re-verified here → would need confirmation before production.
- **ControlNet 1.x** (lllyasviel code Apache-2.0; control checkpoints tagged
  Open RAIL on HF): pose/depth/canny spatial control; needs a pose detector.
  OpenPose path is NC-blocked (Phase C2); MediaPipe BlazePose (Apache-2.0,
  on-device, CPU/aarch64-plausible, ~tens of MB) is the commercial-safe pose
  substitute, outputs 33 landmarks only (no IUV/parse).
- **FlorenceSAM reuse**: approved ONLY for garment masks/boxes/region
  segmentation. It provides no pose keypoints, no DensePose/IUV, no semantic
  human-part parsing — strict limit, no exceptions.

## Serious stacks (max 3 considered, none survive)

- **Stack A (SD-inpaint + IP-Adapter-Plus + FlorenceSAM masks + MediaPipe pose):**
  licenses RAIL-M/Apache-2.0 except OpenCLIP encoder weight terms unverified
  → cannot proceed. Fidelity WEAK regardless (non-spatial reference).
- **Stack B (Stack A + ControlNet-openpose via MediaPipe skeleton):** adds
  OpenRAIL control weights + ~400M+ resident + second diffusion-conditioning
  path; still no spatial garment transfer. Rejected: heavier, same fidelity gap.
- **Stack C (sequential per-garment inpainting passes):** multiplies Stack A
  latency ×N with identity drift, garment overwrite, and artifact accumulation
  risks; officially demonstrated nowhere. Rejected: UNPROVEN + compounds risks.

## Contract matrix (best stack, Stack A)

Avatar/person: SUPPORTED_FROM_SOURCE. Tops/bottoms/dresses/outerwear/shoes/
accessories: no garment taxonomy exists — POSSIBLY_WITH_PROMPTING at best,
effectively UNSUPPORTED for slot-correct multi-garment output. Identity:
UNKNOWN (face adapters exist; full-body try-on identity unvalidated).
Colors: LIKELY_BUT_UNPROVEN. Patterns/logos: WEAK (no spatial transfer).
Framing/background/1024×1536: normalizable mechanics, quality UNKNOWN.

## Sequential-edit risks (why C is not a fallback)

Identity drift per pass, previous-garment overwrite inside repaint masks,
cumulative artifacts, logo degradation, pose/anatomy drift, N× latency
(minutes × garments on this CPU). No source demonstrates sequential outfit
try-on with these components. UNPROVEN, do not assume.

## Decision: NO_LIGHTWEIGHT_PRODUCTION_STACK

Every composable path fails at least one hard gate: visual garment fidelity
(no spatial garment transfer in any commercial-safe adapter checked),
license completeness (OpenCLIP/control/OpenPose weight terms), or CPU
practicality (diffusion steps × CFG on 2 vCPU). No Phase C6 target exists.

## Minimum constraint change (product decision, unchanged from C3)

GPU capacity first (unlocks commercial-safe editors, contract gaps remain),
a commercial multi-ref VTON license (FastFit-class via LavieAI), or an
explicitly rescoped non-generative compositing product (not a provider
substitute). Deterministic 2D overlay remains a product-scope alternative
only — never classified as meeting the photographic contract.

## Minimum constraint change to unblock (pick one, product decision)

1. Obtain a commercial license for FastFit-class multi-reference VTON
   (repo directs to LavieAI) — plus GPU capacity, since even SD1.5-class
   diffusion wants a GPU for sane latency.
2. Add a GPU machine — makes commercial-safe large editors runnable, but the
   multi-reference contract gap remains for all of them.
3. Reduce the contract to deterministic compositing (product-scope alternative,
explicitly not a photographic provider substitute).

---

# Phase C4 gate — FLUX.2 Klein 4B (black-forest-labs): RESOURCE_REJECT_FLUX2

Source-only audit (no weights/inference/installs). Upstream inspected:
`black-forest-labs/flux2` @ `50fe516`, HF `FLUX.2-klein-4B` + `FLUX.2-klein-4b-fp8`
cards. License is clean (Apache-2.0 code AND weights, including the FP8
variant) — this rejection is resource + contract, not license.

## Verified facts

- 4B rectified-flow transformer with official text-to-image + single/multi-ref
  editing in one model (official table confirms all three for the 4B; 9B/dev are
  non-commercial — 4B only).
- Exact weights (HEAD sizes): transformer BF16 7.75 GB, FP8 4.07 GB; text
  encoder (Qwen3-class ~4B) 8.04 GB across 2 shards. VAE small.
- Multi-reference = image list VAE-encoded and concatenated on the sequence
  axis (`encode_image_refs`, `_blend_*_mods`); references are positional, NOT
  semantically labeled per garment; no documented max count; no garment
  taxonomy, identity-preservation, or try-on validation anywhere in source.
- Official sample code hard-codes `.cuda()` (`sampling.py:72`); all documented
  invocations use `device_map="cuda"` (MPS mentioned, CPU never documented).
  Reference implementation: CPU_BLOCKED as distributed.
- Distilled 4-step default for production (50-step base); requires-python
  >=3.10,<3.13 (fits Ubuntu 24.04); deps are standard CPU-portable Python
  (torch/torchvision/transformers/safetensors/einops, no custom CUDA ops,
  no triton/flash-attn/xformers) — so ARM64 strain is low in principle, but
  moot given below.
- Contract: 1 avatar + 1024×1536 + photographic output = supported mechanics;
  everything garment-specific (tops/bottoms/dresses/outerwear/shoes/
  accessories, identity, logos) = UNKNOWN/POSSIBLY_WITH_PROMPTING, unproven.

## Why it fails

- BF16 path: 15.8 GB weights alone > 12 GB box. FP8 path: 4.07 + 8.04 =
  12.1 GB weights alone, before VAE, activations (15 references inflate the
  sequence), OS, and resident FlorenceSAM. The 8 GB text encoder single-handedly
  breaks both paths, and no OFFICIAL quantized text encoder exists
  (third-party quants excluded by rule). RESOURCE_REJECT.
- CPU path is officially undocumented and the reference code is cuda-hardcoded;
  coexistence options (B/C) are moot inside this RAM budget — pattern D,
  impossible, so no deployment pattern is designed.
- Stability section omitted intentionally: rejected candidates get no design.
REJECT_LEFFA: do not download weights to prove failure.
