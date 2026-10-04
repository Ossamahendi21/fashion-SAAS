"""Step 6 Phase B stage 2: SAM2 masks for grounded boxes (main env, native SAM2).

Largest-area box per prompt -> best-IoU mask. Saves binmasks + timings. CPU only.
"""
import json
import time
from pathlib import Path

import numpy as np
import psutil
import torch
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / ".out"
OUT.mkdir(parents=True, exist_ok=True)
CASES = json.loads((HERE / "cases.json").read_text())["fixtures"]
BOXES = json.loads((OUT / "florence-boxes.json").read_text())["cases"]

proc = psutil.Process()
peak = [0]


def rss():
    mb = proc.memory_info().rss / 1024 / 1024
    peak[0] = max(peak[0], mb)
    return round(mb, 1)


from transformers import Sam2Model, Sam2Processor

t0 = time.perf_counter()
sproc = Sam2Processor.from_pretrained("facebook/sam2.1-hiera-tiny")
smodel = Sam2Model.from_pretrained("facebook/sam2.1-hiera-tiny")
smodel.eval()
print(f"SAM_LOAD_MS={(time.perf_counter()-t0)*1000:.0f} rss={rss()}MB", flush=True)

res = {}
with torch.no_grad():
    for cid, spec in CASES.items():
        img = Image.open(HERE / spec["file"]).convert("RGB")
        W0, H0 = img.size
        masks_out = []
        for run in BOXES[cid]["runs"]:
            boxes = run["boxes"]
            if not boxes:
                masks_out.append({"prompt": run["prompt"], "box": None, "mask": None})
                continue
            areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in boxes]
            box = boxes[int(np.argmax(areas))]
            t1 = time.perf_counter()
            sin = sproc(images=img, input_boxes=[[box]], original_sizes=[[H0, W0]], return_tensors="pt")
            sout = smodel(**sin, multimask_output=True)
            infer_ms = (time.perf_counter() - t1) * 1000
            m = sout.pred_masks[0, 0].detach().cpu().numpy()
            s = sout.iou_scores[0, 0].detach().cpu().numpy()
            best = int(np.argmax(s))
            raw = m[best]
            prob = 1 / (1 + np.exp(-raw)) if (raw.min() < 0 or raw.max() > 1) else raw
            bm = np.asarray(Image.fromarray((prob >= 0.5).astype(np.uint8) * 255).resize(
                (W0, H0), Image.NEAREST)) > 0
            px = int(bm.sum())
            ys, xs = np.where(bm)
            path = OUT / f"sam-{cid}-{run['prompt'].replace(' ', '')}.png"
            Image.fromarray(bm.astype(np.uint8) * 255).save(path)
            masks_out.append({"prompt": run["prompt"], "box": [round(float(v), 1) for v in box],
                              "ious": [round(float(v), 4) for v in s], "best": best,
                              "px": px, "infer_ms": round(infer_ms, 1), "mask": str(path),
                              "bbox": f"{int(xs.max()-xs.min()+1)}x{int(ys.max()-ys.min()+1)}" if px else "empty"})
            print(f"MASK {cid}/{run['prompt']}: px={px} ms={infer_ms:.0f}", flush=True)
            del sin, sout, m
        res[cid] = {"dims": [W0, H0], "masks": masks_out, "rss_mb": rss()}

res["peak_rss"] = round(peak[0], 1)
(OUT / "sam-masks.json").write_text(json.dumps(res))
print("SAVED sam-masks.json", flush=True)
