"""Step 6 Phase B stage 1: Florence grounding over bench/detection cases (venv, 4.44.2 TRC).

One greedy grounding call per (case, prompt); plus a single combined-prompt
efficiency probe on multi-outfit. Writes boxes JSON. CPU only. $0.
"""
import json
import time
from pathlib import Path

import psutil
import torch
from PIL import Image

HERE = Path(__file__).resolve().parent
CASES = json.loads((HERE / "cases.json").read_text())["fixtures"]

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
TASK = "<CAPTION_TO_PHRASE_GROUNDING>"
out = {"load_ms": round(load_ms, 1), "rss_loaded": r_loaded, "cases": {}}

with torch.no_grad():
    for cid, spec in CASES.items():
        img = Image.open(HERE / spec["file"]).convert("RGB")
        W0, H0 = img.size
        runs = []
        for prompt in spec["prompts"]:
            t1 = time.perf_counter()
            inputs = processor(text=TASK + prompt, images=img, return_tensors="pt")
            gids = model.generate(input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
                                  max_new_tokens=1024, num_beams=1, do_sample=False)
            infer_ms = (time.perf_counter() - t1) * 1000
            gtext = processor.batch_decode(gids, skip_special_tokens=False)[0]
            inner = processor.post_process_generation(gtext, task=TASK, image_size=(W0, H0)).get(TASK, {})
            runs.append({"prompt": prompt, "infer_ms": round(infer_ms, 1),
                         "boxes": inner.get("bboxes", []), "labels": inner.get("labels", []),
                         "rss_mb": rss()})
            print(f"CASE {cid} prompt={prompt} ms={infer_ms:.0f} boxes={len(runs[-1]['boxes'])}", flush=True)
        out["cases"][cid] = {"dims": [W0, H0], "runs": runs}

# Combined-prompt efficiency probe (single call, two concepts).
img = Image.open(HERE / CASES["multi-outfit"]["file"]).convert("RGB")
W0, H0 = img.size
t1 = time.perf_counter()
inputs = processor(text=TASK + "t-shirt and pants", images=img, return_tensors="pt")
gids = model.generate(input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
                      max_new_tokens=1024, num_beams=1, do_sample=False)
combo_ms = (time.perf_counter() - t1) * 1000
gtext = processor.batch_decode(gids, skip_special_tokens=False)[0]
inner = processor.post_process_generation(gtext, task=TASK, image_size=(W0, H0)).get(TASK, {})
out["combined_probe"] = {"prompt": "t-shirt and pants", "infer_ms": round(combo_ms, 1),
                         "boxes": inner.get("bboxes", []), "labels": inner.get("labels", [])}
print(f"COMBO ms={combo_ms:.0f} boxes={len(out['combined_probe']['boxes'])} labels={inner.get('labels', [])}", flush=True)

# Region-description material probe on two grounded boxes (one call each).
# NOTE: region= kwarg is unsupported by this processor build; the attempt below
# records the outcome honestly (success text or API error) without failing the run.
out["captions"] = []
for cid in ["worn-dress", "jacket"]:
    boxes = out["cases"][cid]["runs"][0]["boxes"]
    if not boxes:
        continue
    areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in boxes]
    box = boxes[int(__import__("numpy").argmax(areas))]
    img = Image.open(HERE / CASES[cid]["file"]).convert("RGB")
    t1 = time.perf_counter()
    try:
        inputs = processor(text="<REGION_TO_DESCRIPTION>", images=img, return_tensors="pt",
                           region=[{"x_min": box[0], "y_min": box[1], "x_max": box[2], "y_max": box[3]}])
        gids = model.generate(input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
                              max_new_tokens=64, num_beams=1, do_sample=False)
        text = processor.batch_decode(gids, skip_special_tokens=True)[0]
    except Exception as e:
        text = f"ERROR: {type(e).__name__}: {str(e)[:160]}"
    out["captions"].append({"case": cid, "infer_ms": round((time.perf_counter() - t1) * 1000, 1), "text": text})
    print(f"CAPTION {cid}: {text[:160]}", flush=True)

out["peak_rss"] = round(peak[0], 1)
(HERE / ".out" / "florence-boxes.json").parent.mkdir(parents=True, exist_ok=True)
(HERE / ".out" / "florence-boxes.json").write_text(json.dumps(out))
print("SAVED florence-boxes.json", flush=True)
