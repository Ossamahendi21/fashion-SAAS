"""B3: OpenAI CLIP ViT-B/32 garment-category benchmark over Phase B regions.

- Official HF release only: openai/clip-vit-base-patch32 @ pinned revision.
- Fixed prompt set from clip_prompts.json (versioned before scoring).
- Input: SAM-masked crop where the mask represents the whole garment, else box crop.
- No OpenAI API, no paid services, CPU only.
Writes: .out/clip-model.json (load/RSS/size), .out/clip-results.json (per-region scores).
"""
import json
import os
import time
from pathlib import Path

import numpy as np
import psutil
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

HERE = Path(__file__).resolve().parent
OUT = HERE / ".out"
FIX = HERE / "fixtures"
MODEL_ID = "openai/clip-vit-base-patch32"
REVISION = "3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268"

proc = psutil.Process()


def rss_mb():
    return proc.memory_info().rss / 1024 / 1024


def load_clip():
    rss_before = rss_mb()
    t0 = time.perf_counter()
    model = CLIPModel.from_pretrained(MODEL_ID, revision=REVISION)
    processor = CLIPProcessor.from_pretrained(MODEL_ID, revision=REVISION)
    model.eval()
    load_ms = (time.perf_counter() - t0) * 1000
    rss_after = rss_mb()
    params = sum(p.numel() for p in model.parameters())
    dtype = str(next(model.parameters()).dtype)
    cache = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    blob_bytes = sum(
        f.stat().st_size for f in cache.rglob("*") if f.is_file()
    )
    return model, processor, {
        "modelId": MODEL_ID,
        "revision": REVISION,
        "loadMs": round(load_ms, 1),
        "rssBeforeMb": round(rss_before, 1),
        "rssAfterMb": round(rss_after, 1),
        "params": params,
        "dtype": dtype,
        "hfCacheBytes": blob_bytes,
    }


@torch.no_grad()
def embed_texts(model, processor, texts):
    t0 = time.perf_counter()
    inputs = processor(text=texts, return_tensors="pt", padding=True)
    out = model.get_text_features(**inputs)
    # transformers>=5 returns BaseModelOutputWithPooling: [1] is the pooled projection
    feats = out[1]
    feats = feats / feats.norm(p=2, dim=-1, keepdim=True)
    return feats, (time.perf_counter() - t0) * 1000


@torch.no_grad()
def embed_image(model, processor, image):
    t0 = time.perf_counter()
    inputs = processor(images=image, return_tensors="pt")
    out = model.get_image_features(**inputs)
    # transformers>=5 returns BaseModelOutputWithPooling: [1] is the pooled projection
    feats = out[1]
    feats = feats / feats.norm(p=2, dim=-1, keepdim=True)
    return feats, (time.perf_counter() - t0) * 1000


def crop_box(path, box_xyxy, mask_path=None):
    img = Image.open(path).convert("RGB")
    x0, y0, x1, y1 = (max(0, int(v)) for v in box_xyxy)
    crop = img.crop((x0, y0, min(x1, img.width), min(y1, img.height)))
    if mask_path and Path(mask_path).exists():
        m = Image.open(mask_path).convert("L").resize(crop.size, Image.NEAREST)
        black = Image.new("RGB", crop.size, (0, 0, 0))
        return Image.composite(crop, black, m), "sam-masked"
    return crop, "box"


def main():
    import os as _os
    box_only = _os.environ.get("CLIP_BOXONLY") == "1"
    out_name = "clip-results-box.json" if box_only else "clip-results.json"
    boxes = json.loads((OUT / "florence-boxes.json").read_text())
    by_case_prompt = {}
    for case_id, c in boxes["cases"].items():
        for run in c["runs"]:
            by_case_prompt[(case_id, run["prompt"])] = run
    cases = json.loads((HERE / "cases.json").read_text())
    fixtures = cases["fixtures"]
    reference = cases["reference"]
    # (caseId, regionId, prompt-for-box, box-index, expected, mask?, why)
    regions = [
        ("single-top", "r1", "t-shirt", 0, "top", OUT / "sam-single-top-t-shirt.png", "whole-garment SAM mask"),
        ("dress", "r1", "dress", 0, "dress", OUT / "sam-dress-dress.png", "whole-garment SAM mask"),
        # patterned: SAM mask is stripes-only -> use full-garment box crop instead
        ("patterned", "r1", "t-shirt", 0, "top", None, "full-garment box crop"),
        ("jacket", "r1", "jacket", 0, "outerwear", OUT / "sam-jacket-jacket.png", "whole-garment SAM mask"),
        ("worn-dress", "r1", "dress", 0, reference["worn-dress"]["items"][0]["category"], OUT / "sam-worn-dress-dress.png", "whole-garment SAM mask"),
        ("occluded-hoodie", "r1", "hoodie", 0, reference["occluded-hoodie"]["items"][0]["category"], OUT / "sam-occluded-hoodie-hoodie.png", "whole-garment SAM mask"),
        ("shoe", "r1", "sneaker", 0, "shoes", OUT / "sam-shoe-sneaker.png", "whole-garment SAM mask"),
        ("pants", "r1", "pants", 0, "bottom", OUT / "sam-pants-pants.png", "whole-garment SAM mask"),
        ("bag", "r1", "bag", 0, "bag", OUT / "sam-bag-bag.png", "whole-garment SAM mask"),
        # multi-item: tee box (never got its own SAM mask) + pants SAM region
        ("multi-outfit", "tee", "t-shirt", 0, "top", None, "tee box crop, no SAM mask exists"),
        ("multi-outfit", "pants", "pants", 1, "bottom", OUT / "sam-multi-outfit-pants.png", "whole-garment SAM mask"),
    ]
    prompts = json.loads((HERE / "clip_prompts.json").read_text())
    cats = list(prompts["groups"].keys())

    model, processor, load_info = load_clip()
    (OUT / "clip-model.json").write_text(json.dumps(load_info, indent=2))

    # Fixed text embeddings, computed ONCE (production reuse pattern)
    cat_vecs, text_rows = {}, []
    for cat in cats:
        texts = [prompts["template"].format(concept=c) for c in prompts["groups"][cat]]
        feats, ms = embed_texts(model, processor, texts)
        text_rows.append({"category": cat, "concepts": len(texts), "batchMs": round(ms, 1)})
        v = feats.mean(dim=0)
        cat_vecs[cat] = (v / v.norm(p=2)).numpy()
    text_total_ms = round(sum(r["batchMs"] for r in text_rows), 1)

    results, lat = [], []
    for case, rid, prompt, idx, expected, mask, why in regions:
        box = by_case_prompt[(case, prompt)]["boxes"][idx]
        fix = (HERE / fixtures[case]["file"]).resolve()
        use_mask = None if box_only else mask
        crop, kind = crop_box(fix, box, use_mask)
        if box_only:
            kind, why = "box", "box-crop ablation (mask ignored)"
        ivec, img_ms = embed_image(model, processor, crop)
        ivec = ivec.numpy()[0]
        scores = {c: float(ivec @ cat_vecs[c]) for c in cats}
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        (top1, s1), (top2, s2) = ranked[0], ranked[1]
        lat.append(img_ms)
        results.append({
            "caseId": case, "regionId": rid, "input": f"{kind} ({why})",
            "expectedCategory": expected, "predictedCategory": top1,
            "top1Score": round(s1, 4), "top2Category": top2,
            "top2Score": round(s2, 4), "margin": round(s1 - s2, 4),
            "correct": top1 == expected, "scores": {c: round(v, 4) for c, v in scores.items()},
        })
    summary = {
        "regions": len(results),
        "top1Correct": sum(r["correct"] for r in results),
        "textSetupMs": text_total_ms,
        "meanImageMs": round(float(np.mean(lat)), 1),
        "maxImageMs": round(float(np.max(lat)), 1),
        "rssAfterMb": round(rss_mb(), 1),
        "textBatches": text_rows,
    }
    (OUT / out_name).write_text(json.dumps({"summary": summary, "results": results}, indent=2))
    print(json.dumps(summary, indent=2))
    for r in results:
        print(f"{r['caseId']:>14}/{r['regionId']:<5} exp={r['expectedCategory']:<9} pred={r['predictedCategory']:<9} "
              f"s1={r['top1Score']:.3f} top2={r['top2Category']:<9} s2={r['top2Score']:.3f} "
              f"margin={r['margin']:+.3f} {'OK' if r['correct'] else 'MISS'} [{r['input']}]")


if __name__ == "__main__":
    import os
    import sys
    try:
        main()
    except Exception as e:
        print(f"BENCH_FAILED: {type(e).__name__}: {e}", flush=True)
        os._exit(1)
    os._exit(0)
