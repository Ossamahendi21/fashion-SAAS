"""B8: SmolVLM2-500M-Video-Instruct garment-category benchmark (VPS aarch64 CPU).

Pinned: HuggingFaceTB/SmolVLM2-500M-Video-Instruct @ 7b375e1b, Apache-2.0.
Runs on the VPS in /home/ubuntu/step6-b8-smolvlm (isolated venv, CPU only).
Input: the exact 11 BBOX crops from Phase B (manifest.json carries ground truth).
Prompt is FROZEN (PROMPT below). Greedy decode, max_new_tokens=12.
Normalization is formatting-only; anything else => INVALID_OUTPUT.
Writes: out/smolvlm-load.json, out/smolvlm-results.json (retrieved to
bench/detection/.out/ as smolvlm-*.json). $0.
"""
import json
import time
from pathlib import Path

import psutil
import torch

BASE = Path("/home/ubuntu/step6-b8-smolvlm")
CROPS = BASE / "crops"
OUT = BASE / "out"

MODEL_ID = "HuggingFaceTB/SmolVLM2-500M-Video-Instruct"
REVISION = "7b375e1b73b11138ff12fe22c8f2822d8fe03467"

# FROZEN prompt (fixed before scoring; identical for every crop).
PROMPT = (
    "Classify the main fashion item in this image.\n"
    "Return exactly one label from this list:\n"
    "top, bottom, outerwear, dress, shoes, accessory, bag, headwear.\n"
    "Reply with only the label. Do not explain."
)

CANON = ["top", "bottom", "outerwear", "dress", "shoes", "accessory", "bag", "headwear"]

proc = psutil.Process()
peak = [0]


def rss():
    mb = proc.memory_info().rss / 1024 / 1024
    peak[0] = max(peak[0], mb)
    return round(mb, 1)


def normalize(raw):
    t = raw.strip().lower().strip("\"'.,:;*` \n\t")
    return t if t in CANON else "INVALID_OUTPUT"


def main():
    from transformers import AutoModelForImageTextToText, AutoProcessor

    rss_before = rss()
    t0 = time.perf_counter()
    processor = AutoProcessor.from_pretrained(MODEL_ID, revision=REVISION)
    model = AutoModelForImageTextToText.from_pretrained(
        MODEL_ID, revision=REVISION, dtype=torch.float32)
    model.eval()
    load_ms = (time.perf_counter() - t0) * 1000
    rss_after = rss()
    (OUT / "smolvlm-load.json").write_text(json.dumps({
        "modelId": MODEL_ID, "revision": REVISION,
        "loadMs": round(load_ms, 1), "rssBeforeMb": rss_before,
        "rssAfterMb": rss_after,
        "params": sum(p.numel() for p in model.parameters()),
        "dtype": str(next(model.parameters()).dtype),
        "attn": getattr(model.config, "_attn_implementation", "default"),
        "device": str(next(model.parameters()).device),
    }, indent=2))

    from PIL import Image
    manifest = json.loads((CROPS / "manifest.json").read_text())
    rows = []
    with torch.no_grad():
        for m in manifest:
            img = Image.open(CROPS / m["file"]).convert("RGB")
            messages = [{"role": "user", "content": [
                {"type": "image", "image": img}, {"type": "text", "text": PROMPT}]}]
            text = processor.apply_chat_template(messages, add_generation_prompt=True)
            inputs = processor(text=text, images=[img], return_tensors="pt")
            t1 = time.perf_counter()
            gids = model.generate(**inputs, do_sample=False, max_new_tokens=12)
            ms = (time.perf_counter() - t1) * 1000
            raw = processor.batch_decode(
                gids[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
            pred = normalize(raw)
            rows.append({"caseId": m["caseId"], "regionId": m["regionId"],
                         "expectedCategory": m["expectedCategory"],
                         "rawOutput": raw, "predictedCategory": pred,
                         "correct": pred == m["expectedCategory"],
                         "generationLatencyMs": round(ms, 1), "error": None,
                         "rssMb": rss()})
            print(f"{m['caseId']}/{m['regionId']} ms={ms:.0f} raw={raw!r:60} -> {pred} "
                  f"{'OK' if pred == m['expectedCategory'] else 'MISS'}", flush=True)
    out = {"rows": len(rows), "correct": sum(r["correct"] for r in rows),
           "invalid": sum(1 for r in rows if r["predictedCategory"] == "INVALID_OUTPUT"),
           "peakRssMb": round(peak[0], 1), "results": rows}
    (OUT / "smolvlm-results.json").write_text(json.dumps(out, indent=2))
    print(f"SAVED rows={out['rows']} correct={out['correct']} invalid={out['invalid']}", flush=True)


if __name__ == "__main__":
    import os
    try:
        main()
    except Exception as e:
        print(f"BENCH_FAILED: {type(e).__name__}: {e}", flush=True)
        os._exit(1)
    os._exit(0)
