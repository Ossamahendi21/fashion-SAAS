"""B9: google SigLIP2-base zero-shot garment-category benchmark (VPS aarch64 CPU).

Pinned: google/siglip2-base-patch16-224 @ 75de2d5 (full SHA in load json),
Apache-2.0, official Google release. Runs on the VPS in
/home/ubuntu/step6-b9-siglip2 (isolated venv, CPU only).
Input: the exact 11 BBOX crops in /home/ubuntu/step6-b8-smolvlm/crops
(manifest.json carries frozen ground truth) — same regions as B3/B6/B8.
Prompts: frozen bench/detection/clip_prompts.json ("a photo of {concept}"),
per-concept embeddings averaged per category (B3 strategy, unchanged).
Scoring: L2-normalized cosine argmax (scale-invariant; identical ranking to
official logit scoring). Text tower embedded once.
Writes: out/siglip2-load.json, out/siglip2-results.json (retrieved to
bench/detection/.out/ as siglip2-*.json). $0.
"""
import json
import time
from pathlib import Path

import psutil
import torch

BASE = Path("/home/ubuntu/step6-b9-siglip2")
CROPS = Path("/home/ubuntu/step6-b8-smolvlm/crops")
OUT = BASE / "out"

MODEL_ID = "google/siglip2-base-patch16-224"
REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"

# Frozen B3 concept groups (copied verbatim; clip_prompts.json is the source).
GROUPS = {
    "top": ["shirt", "t-shirt", "blouse", "sweater", "hoodie"],
    "bottom": ["pants", "trousers", "jeans", "shorts", "skirt"],
    "outerwear": ["jacket", "coat", "blazer", "cardigan"],
    "dress": ["dress", "gown", "one-piece dress"],
    "shoes": ["shoes", "sneakers", "boots", "sandals", "heels"],
    "accessory": ["belt", "scarf", "jewelry", "sunglasses", "fashion accessory"],
    "bag": ["handbag", "backpack", "tote bag", "purse"],
    "headwear": ["hat", "cap", "beanie", "headwear"],
}
TEMPLATE = "a photo of {concept}"

proc = psutil.Process()
peak = [0]


def rss():
    mb = proc.memory_info().rss / 1024 / 1024
    peak[0] = max(peak[0], mb)
    return round(mb, 1)


def pooled(out, names):
    for n in names:
        if hasattr(out, n):
            return getattr(out, n)
    return out[1]


def main():
    from transformers import AutoModel, AutoProcessor

    rss_before = rss()
    t0 = time.perf_counter()
    processor = AutoProcessor.from_pretrained(MODEL_ID, revision=REVISION)
    model = AutoModel.from_pretrained(MODEL_ID, revision=REVISION, dtype=torch.float32)
    model.eval()
    load_ms = (time.perf_counter() - t0) * 1000
    rss_after = rss()
    (OUT / "siglip2-load.json").write_text(json.dumps({
        "modelId": MODEL_ID, "revision": REVISION,
        "modelClass": type(model).__name__,
        "loadMs": round(load_ms, 1), "rssBeforeMb": rss_before,
        "rssAfterMb": rss_after,
        "params": sum(p.numel() for p in model.parameters()),
        "dtype": str(next(model.parameters()).dtype),
        "device": str(next(model.parameters()).device),
    }, indent=2))

    from PIL import Image
    manifest = json.loads((CROPS / "manifest.json").read_text())
    cats = list(GROUPS.keys())

    t1 = time.perf_counter()
    cat_vecs = {}
    with torch.no_grad():
        for cat in cats:
            texts = [TEMPLATE.format(concept=c) for c in GROUPS[cat]]
            ti = processor(text=texts, return_tensors="pt", padding=True)
            feats = pooled(model.get_text_features(**ti), ["text_embeds"])
            feats = feats / feats.norm(p=2, dim=-1, keepdim=True)
            v = feats.mean(dim=0)
            cat_vecs[cat] = (v / v.norm(p=2)).numpy()
    text_ms = (time.perf_counter() - t1) * 1000

    rows, lat = [], []
    with torch.no_grad():
        for m in manifest:
            img = Image.open(CROPS / m["file"]).convert("RGB")
            t2 = time.perf_counter()
            ii = processor(images=img, return_tensors="pt")
            ivec = pooled(model.get_image_features(**ii), ["image_embeds"])
            ivec = ivec / ivec.norm(p=2, dim=-1, keepdim=True)
            ivec = ivec.numpy()[0]
            ms = (time.perf_counter() - t2) * 1000
            lat.append(ms)
            scores = {c: float(ivec @ cat_vecs[c]) for c in cats}
            ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
            (top1, s1), (top2, s2) = ranked[0], ranked[1]
            rows.append({"caseId": m["caseId"], "regionId": m["regionId"],
                         "expectedCategory": m["expectedCategory"],
                         "predictedCategory": top1, "top1Score": round(s1, 4),
                         "top2Category": top2, "top2Score": round(s2, 4),
                         "margin": round(s1 - s2, 4),
                         "correct": top1 == m["expectedCategory"],
                         "latencyMs": round(ms, 1),
                         "scores": {c: round(v, 4) for c, v in scores.items()}})
            print(f"{m['caseId']}/{m['regionId']} ms={ms:.0f} exp={m['expectedCategory']:<9} "
                  f"pred={top1:<9} s1={s1:+.3f} top2={top2:<9} s2={s2:+.3f} "
                  f"{'OK' if top1 == m['expectedCategory'] else 'MISS'}", flush=True)
    out = {"rows": len(rows), "correct": sum(r["correct"] for r in rows),
           "textSetupMs": round(text_ms, 1), "peakRssMb": round(peak[0], 1),
           "results": rows}
    (OUT / "siglip2-results.json").write_text(json.dumps(out, indent=2))
    print(f"SAVED rows={out['rows']} correct={out['correct']}", flush=True)


if __name__ == "__main__":
    import os
    try:
        main()
    except Exception as e:
        print(f"BENCH_FAILED: {type(e).__name__}: {e}", flush=True)
        os._exit(1)
    os._exit(0)
