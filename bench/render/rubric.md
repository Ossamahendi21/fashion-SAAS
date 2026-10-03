# Render benchmark quality rubric (fixed, human review)

Score every dimension independently on a 0–4 scale. Definitions are absolute, not
relative to other candidates. Keep the raw per-dimension scores; they are the result.
An informational mean may be reported alongside, clearly marked as informational only.

## 0 — absent/broken
The property is entirely missing or the output is unusable on this axis
(e.g. wrong person entirely, no garment rendered, anatomy unrecognizable).

## 1 — poor
A serious defect a user would immediately reject
(e.g. wrong garment category, face changed beyond recognition, missing limbs).

## 2 — flawed
Usable at a glance but clearly wrong on inspection
(e.g. color noticeably off, print partially wrong, extra fingers, cropped feet).

## 3 — good
Minor flaws only a careful look reveals
(e.g. slight print softening, minor background unevenness, near-correct drape).

## 4 — excellent
Indistinguishable from the production reference on this axis.

## Dimensions (score each, every case)

- **identity preservation** — same face, skin tone, recognizable person as the avatar input.
- **garment category correctness** — the requested slot/category is what appears (a top is not a dress).
- **garment color fidelity** — matches the reference cutout colors.
- **pattern/logo/detail fidelity** — prints, stitching, buttons, text/logos reproduced, not hallucinated.
- **body/anatomy quality** — plausible proportions, hands, limbs; no melting or extra parts.
- **full-body framing** — entire person head-to-toe with headroom and floor space, 2:3 portrait.
- **background quality** — plain studio-style backdrop, no scene bleed or artifacts.
- **multi-garment correctness** — every requested garment present and correctly layered (score N/A with reason when the case has one garment).
- **unwanted hallucination** — inverted scale: 4 means nothing unrequested was added; 0 means the output invents garments, logos, people, or scenery.

## Recording

Store scores as `quality: { identity: 0-4, category: 0-4, color: 0-4, detail: 0-4, anatomy: 0-4, framing: 0-4, background: 0-4, multiGarment: 0-4|null, hallucination: 0-4, reviewer: "name", notes: "..." }`
alongside the machine result record. Never collapse to a single number in storage.
