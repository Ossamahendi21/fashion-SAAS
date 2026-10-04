"""B6: Marqo FashionSigLIP garment-category benchmark over Phase B regions.

Pinned: Marqo/marqo-fashionSigLIP @ c56244c (== current main, verified).
Official open_clip path (no trust_remote_code): hf-hub model + tokenizer.
Prompts: frozen B3 clip_prompts.json ("a photo of {concept}"); no mandated
template on the model card, so B3 wording is kept for a fair CLIP comparison.
Scoring: L2-normalized cosine, per-concept embeddings averaged per category,
text tower embedded once. Variants: A box crop, B SAM-masked (black).
Writes: .out/fashionsiglip-model.json, .out/fashionsiglip-results.json.
CPU only. $0.
"""
import json
import time
from pathlib import Path

import numpy as np
import psutil
import torch
from huggingface_hub import snapshot_download
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / ".out"
MODEL_ID = "Marqo/marqo-fashionSigLIP"
REVISION = "c56244cc94f92419e8369fa71efdaf403b124ce8"

proc = psutil.Process()
peak = [0]


def rss():
    mb = proc.memory_info().rss / 1024 / 1024
    peak[0] = max(peak[0], mb)
    return round(mb, 1)


def main():
    import os as _os
    box_only = _os.environ.get("FS_BOXONLY") == "1"
    mask_only = _os.environ.get("FS_MASKONLY") == "1"
    tag = "-box" if box_only else ("-masked" if mask_only else "")
    out_name = f"fashionsiglip-results{tag}.json"

    snap = snapshot_download(repo_id=MODEL_ID, revision=REVISION,
                             allow_patterns=["open_clip_config.json",
                                             "open_clip_model.safetensors",
                                             "*.json"])
    dl_bytes = sum(f.stat().st_size for f in Path(snap).rglob("*") if f.is_file())

    import open_clip
    rss_before = rss()
    t0 = time.perf_counter()
    model, _, preprocess = open_clip.create_model_and_transforms(
        f"hf-hub:{MODEL_ID}")
    tokenizer = open_clip.get_tokenizer(f"hf-hub:{MODEL_ID}")
    model.eval()
    load_ms = (time.perf_counter() - t0) * 1000
    rss_after = rss()
    params = sum(p.numel() for p in model.parameters())
    (OUT / "fashionsiglip-model.json").write_text(json.dumps({
        "modelId": MODEL_ID, "revision": REVISION, "snapshotDir": snap,
        "snapshotBytes": dl_bytes, "loadMs": round(load_ms, 1),
        "rssBeforeMb": rss_before, "rssAfterMb": rss_after,
        "params": params, "dtype": str(next(model.parameters()).dtype),
    }, indent=2))

    boxes = json.loads((OUT / "florence-boxes.json").read_text())
    by_case_prompt = {}
    for case_id, c in boxes["cases"].items():
        for run in c["runs"]:
            by_case_prompt[(case_id, run["prompt"])] = run
    cases = json.loads((HERE / "cases.json").read_text())
    fixtures = cases["fixtures"]
    reference = cases["reference"]
    prompts = json.loads((HERE / "clip_prompts.json").read_text())
    cats = list(prompts["groups"].keys())
    regions = [
        ("single-top", "r1", "t-shirt", 0, "top", OUT / "sam-single-top-t-shirt.png"),
        ("dress", "r1", "dress", 0, "dress", OUT / "sam-dress-dress.png"),
        ("patterned", "r1", "t-shirt", 0, "top", None),
        ("jacket", "r1", "jacket", 0, "outerwear", OUT / "sam-jacket-jacket.png"),
        ("worn-dress", "r1", "dress", 0, reference["worn-dress"]["items"][0]["category"], OUT / "sam-worn-dress-dress.png"),
        ("occluded-hoodie", "r1", "hoodie", 0, reference["occluded-hoodie"]["items"][0]["category"], OUT / "sam-occluded-hoodie-hoodie.png"),
        ("shoe", "r1", "sneaker", 0, "shoes", OUT / "sam-shoe-sneaker.png"),
        ("pants", "r1", "pants", 0, "bottom", OUT / "sam-pants-pants.png"),
        ("bag", "r1", "bag", 0, "bag", OUT / "sam-bag-bag.png"),
        ("multi-outfit", "tee", "t-shirt", 0, "top", None),
        ("multi-outfit", "pants", "pants", 1, "bottom", OUT / "sam-multi-outfit-pants.png"),
    ]

    # Fixed text embeddings, computed ONCE.
    t1 = time.perf_counter()
    cat_vecs = {}
    with torch.no_grad():
        for cat in cats:
            texts = [prompts["template"].format(concept=c) for c in prompts["groups"][cat]]
            feats = model.encode_text(tokenizer(texts))
            feats = feats / feats.norm(p=2, dim=-1, keepdim=True)
            v = feats.mean(dim=0)
            cat_vecs[cat] = (v / v.norm(p=2)).numpy()
    text_ms = (time.perf_counter() - t1) * 1000

    def crop_box(path, box_xyxy, mask_path=None):
        img = Image.open(path).convert("RGB")
        x0, y0, x1, y1 = (max(0, int(v)) for v in box_xyxy)
        crop = img.crop((x0, y0, min(x1, img.width), min(y1, img.height)))
        if mask_path and Path(mask_path).exists():
            m = Image.open(mask_path).convert("L").resize(crop.size, Image.NEAREST)
            return Image.composite(crop, Image.new("RGB", crop.size, (0, 0, 0)), m), "B-masked"
        return crop, "A-box"

    results, lat = [], []
    with torch.no_grad():
        for case, rid, prompt, idx, expected, mask in regions:
            if mask_only and mask is None:
                continue
            box = by_case_prompt[(case, prompt)]["boxes"][idx]
            fix = (HERE / fixtures[case]["file"]).resolve()
            crop, kind = crop_box(fix, box, None if box_only else mask)
            t2 = time.perf_counter()
            ivec = model.encode_image(preprocess(crop).unsqueeze(0))
            ivec = ivec / ivec.norm(p=2, dim=-1, keepdim=True)
            ivec = ivec.numpy()[0]
            ms = (time.perf_counter() - t2) * 1000
            lat.append(ms)
            scores = {c: float(ivec @ cat_vecs[c]) for c in cats}
            ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
            (top1, s1), (top2, s2) = ranked[0], ranked[1]
            results.append({"caseId": case, "regionId": rid, "inputVariant": kind,
                            "expectedCategory": expected, "predictedCategory": top1,
                            "top1Score": round(s1, 4), "top2Category": top2,
                            "top2Score": round(s2, 4), "margin": round(s1 - s2, 4),
                            "correct": top1 == expected,
                            "scores": {c: round(v, 4) for c, v in scores.items()}})
    if mask_only:
        results = [r for r in results if r["inputVariant"] == "B-masked"]
    summary = {"regions": len(results),
               "top1Correct": sum(r["correct"] for r in results),
               "textSetupMs": round(text_ms, 1),
               "meanImageMs": round(float(np.mean(lat)), 1),
               "medianImageMs": round(float(np.median(lat)), 1),
               "maxImageMs": round(float(np.max(lat)), 1),
               "peakRssMb": round(peak[0], 1)}
    (OUT / out_name).write_text(json.dumps({"summary": summary, "results": results}, indent=2))
    print(json.dumps(summary, indent=1))
    for r in results:
        print(f"{r['caseId']:>14}/{r['regionId']:<5} {r['inputVariant']:<8} exp={r['expectedCategory']:<9} "
              f"pred={r['predictedCategory']:<9} s1={r['top1Score']:.3f} top2={r['top2Category']:<9} "
              f"s2={r['top2Score']:.3f} margin={r['margin']:+.3f} {'OK' if r['correct'] else 'MISS'}")


if __name__ == "__main__":
    import os
    try:
        main()
    except Exception as e:
        print(f"BENCH_FAILED: {type(e).__name__}: {e}", flush=True)
        os._exit(1)
    os._exit(0)
