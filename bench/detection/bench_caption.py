"""B4: Florence-2-base crop-caption category benchmark over Phase B/B3 regions.

Same 11 regions, same ground truth. Crop (box or SAM-masked on neutral gray)
is fed as the whole image to the pinned Florence-2-base (venv-flor44,
transformers 4.44.2 TRC). Tasks: <DETAILED_CAPTION> + <MORE_DETAILED_CAPTION>.
Scoring: fixed florence_map.json (written before any caption), UNKNOWN on no match.
Writes: .out/florence-captions.json. CPU only. $0.
"""
import json
import re
import time
from pathlib import Path

import psutil
import torch
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / ".out"
proc = psutil.Process()
peak = [0]


def rss():
    mb = proc.memory_info().rss / 1024 / 1024
    peak[0] = max(peak[0], mb)
    return round(mb, 1)


from transformers import AutoModelForCausalLM, AutoProcessor

t0 = time.perf_counter()
processor = AutoProcessor.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True)
model.eval()
load_ms = (time.perf_counter() - t0) * 1000
r_loaded = rss()

TASKS = ["<DETAILED_CAPTION>", "<MORE_DETAILED_CAPTION>"]

MAP = json.loads((HERE / "florence_map.json").read_text())
PATTERNS = [
    (fam, [re.compile(r"\b" + re.escape(t) + r"\b") for t in sorted(terms, key=len, reverse=True)])
    for fam, terms in [(f, MAP["families"][f]) for f in MAP["priority"]]
]


def map_caption(text):
    low = text.lower()
    for fam, pats in PATTERNS:
        for p in pats:
            m = p.search(low)
            if m:
                return fam, m.group(0)
    return "UNKNOWN", None


def crop_box(path, box_xyxy, mask_path=None):
    img = Image.open(path).convert("RGB")
    x0, y0, x1, y1 = (max(0, int(v)) for v in box_xyxy)
    crop = img.crop((x0, y0, min(x1, img.width), min(y1, img.height)))
    if mask_path and Path(mask_path).exists():
        m = Image.open(mask_path).convert("L").resize(crop.size, Image.NEAREST)
        neutral = Image.new("RGB", crop.size, (128, 128, 128))
        return Image.composite(crop, neutral, m)
    return crop


@torch.no_grad()
def caption(img, task):
    t1 = time.perf_counter()
    try:
        inputs = processor(text=task, images=img, return_tensors="pt")
        gids = model.generate(input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
                              max_new_tokens=256, num_beams=1, do_sample=False)
        text = processor.batch_decode(gids, skip_special_tokens=True)[0].strip()
        err = None
    except Exception as e:
        text, err = "", f"{type(e).__name__}: {str(e)[:160]}"
    return text, err, round((time.perf_counter() - t1) * 1000, 1)


def main():
    boxes = json.loads((OUT / "florence-boxes.json").read_text())
    by_case_prompt = {}
    for case_id, c in boxes["cases"].items():
        for run in c["runs"]:
            by_case_prompt[(case_id, run["prompt"])] = run
    cases = json.loads((HERE / "cases.json").read_text())
    fixtures = cases["fixtures"]
    reference = cases["reference"]
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
    rows = []
    for case, rid, prompt, idx, expected, mask in regions:
        box = by_case_prompt[(case, prompt)]["boxes"][idx]
        fix = (HERE / fixtures[case]["file"]).resolve()
        variants = {"A-box": crop_box(fix, box), "B-masked": crop_box(fix, box, mask)}
        for variant, crop in variants.items():
            for task in TASKS:
                text, err, ms = caption(crop, task)
                pred, kw = map_caption(text) if text else ("UNKNOWN", None)
                rows.append({"caseId": case, "regionId": rid, "expectedCategory": expected,
                             "inputVariant": variant, "captionTask": task, "rawCaption": text,
                             "matchedKeyword": kw, "predictedCategory": pred,
                             "correct": pred == expected, "latencyMs": ms, "error": err,
                             "rssMb": rss()})
                print(f"{case}/{rid} {variant} {task} ms={ms:.0f} -> [{pred} via {kw}] {text[:110]}",
                      flush=True)
    correct = sum(r["correct"] for r in rows)
    out = {"loadMs": round(load_ms, 1), "rssLoadedMb": r_loaded, "peakRssMb": round(peak[0], 1),
           "rows": len(rows), "correct": correct, "results": rows}
    (OUT / "florence-captions.json").write_text(json.dumps(out, indent=2))
    print(f"SAVED florence-captions.json rows={len(rows)} correct={correct}", flush=True)


if __name__ == "__main__":
    import os
    try:
        main()
    except Exception as e:
        print(f"BENCH_FAILED: {type(e).__name__}: {e}", flush=True)
        os._exit(1)
    os._exit(0)
