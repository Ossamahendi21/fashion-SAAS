"""Reference Florence+SAM2 extraction gateway (DEPLOY-ONLY, not part of the app bundle).

Runs on the no-GPU Ubuntu VPS and serves the Convex florencesam provider:
  POST /v1/extract  {image: base64 png, prompt: grounding phrase} -> image/png cutout
  GET  /v1/healthz  -> {"ok": true}

Pinned runtime (do not silently upgrade; matches the validated Step 4 recipe):
  - Florence-2-base (MIT): transformers==4.44.2 via trust_remote_code, greedy
    (num_beams=1, do_sample=False), max_new_tokens=1024, trust_remote_code deps
    timm + torchvision, flash_attn import-scan stub (never executed on CPU).
  - SAM2.1 Hiera Tiny (Apache-2.0): transformers==5.14.1 native Sam2Model,
    multimask on, CPU only, masks resampled via processor.post_process_masks.
Model revisions are pinned by path: FLORENCE_MODEL_PATH / SAM2_MODEL_PATH point at
exact snapshot directories (systemd sets them); with HF_HUB_OFFLINE=1 no branch refs
resolve at runtime. HF_MODULES_CACHE must be writable for trust_remote_code.
Deterministic rules (mirrored by selectLargestBox/selectLargestMask in
convex/ai/extraction.ts): Florence largest-area box, SAM largest-area mask,
first wins ties, mask threshold 0.5.
Bounded concurrency: one heavy inference at a time; an overlapping request gets
503 + Retry-After. Health checks never take the lock.

Two venvs (one process cannot hold both transformers versions):
  - this file serves HTTP + SAM2 under the venv-sam python,
  - `--ground` mode runs Florence grounding under the venv-flor python and is
    invoked as a subprocess with the request JSON on stdin.

Only stdlib beyond torch/transformers/Pillow/numpy. Auth: X-API-Key compared
against FLORENCESAM_API_KEY with compare_digest; the key never appears in
responses or logs. External provider spend for callers is $0 by contract.
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import os
import secrets
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MASK_THRESHOLD = 0.5
MAX_BODY_BYTES = 20 * 1024 * 1024
RETRY_AFTER_S = 30
FLORENCE_VENV_PYTHON = os.environ.get(
    "FLORENCE_VENV_PYTHON", "/opt/fashion-florencesam/venv-flor/bin/python"
)
# Pinned local snapshot directories (set by the systemd unit). A local path plus
# HF_HUB_OFFLINE=1 means no branch refs are resolved at runtime: revisions cannot drift.
FLORENCE_MODEL_PATH = os.environ.get("FLORENCE_MODEL_PATH", "microsoft/Florence-2-base")
SAM2_MODEL_PATH = os.environ.get("SAM2_MODEL_PATH", "facebook/sam2.1-hiera-tiny")

# Bounded concurrency: at most one heavy extraction inference at a time. A second
# concurrent request fails fast with 503 instead of thrashing CPU/RAM or OOMing.
# Health checks never take the lock and stay responsive.
INFERENCE_LOCK = threading.Lock()


def _json(status: int, payload: object, content_type: str = "application/json") -> tuple[int, bytes, str]:
    return status, json.dumps(payload).encode("utf-8"), content_type


def _authorized(headers) -> bool:
    expected = os.environ.get("FLORENCESAM_API_KEY", "")
    if not expected:
        return False
    return secrets.compare_digest(headers.get("X-API-Key", ""), expected)


def _ground(image_png: bytes, prompt: str) -> dict:
    """Run Florence grounding in the pinned venv-flor interpreter via --ground mode."""
    child = os.path.abspath(__file__)
    proc = subprocess.run(
        [FLORENCE_VENV_PYTHON, child, "--ground"],
        input=json.dumps({
            "image": base64.b64encode(image_png).decode("ascii"),
            "prompt": prompt,
        }).encode("utf-8"),
        capture_output=True,
        timeout=int(os.environ.get("FLORENCE_TIMEOUT_S", "600")),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"florence grounding failed: {proc.stderr.decode()[-240:]}")
    return json.loads(proc.stdout.decode("utf-8"))


def _ground_mode() -> int:
    """Florence child mode: read {image, prompt} on stdin, write grounding JSON on stdout."""
    import torch
    from PIL import Image
    from transformers import AutoModelForCausalLM, AutoProcessor

    request = json.loads(sys.stdin.read())
    image = Image.open(io.BytesIO(base64.b64decode(request["image"]))).convert("RGB")
    prompt_text = request["prompt"]
    if not isinstance(prompt_text, str) or not prompt_text.strip():
        raise ValueError("grounding needs a non-empty prompt")
    processor = AutoProcessor.from_pretrained(FLORENCE_MODEL_PATH, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(FLORENCE_MODEL_PATH, trust_remote_code=True)
    model.eval()
    task = "<CAPTION_TO_PHRASE_GROUNDING>"
    with torch.no_grad():
        inputs = processor(text=task + prompt_text, images=image, return_tensors="pt")
        generated = model.generate(
            input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
            max_new_tokens=1024, num_beams=1, do_sample=False,
        )
        text = processor.batch_decode(generated, skip_special_tokens=False)[0]
        inner = processor.post_process_generation(text, task=task, image_size=image.size).get(task, {})
    print(json.dumps({"boxes": inner.get("bboxes", []), "labels": inner.get("labels", [])}))
    return 0


def _segment(image_png: bytes, box: list) -> bytes:
    """Run SAM2 box segmentation (venv-sam interpreter) and return an RGBA PNG."""
    import numpy as np
    import torch
    from PIL import Image
    from transformers import Sam2Model, Sam2Processor

    image = Image.open(io.BytesIO(image_png)).convert("RGB")
    width, height = image.size
    processor = Sam2Processor.from_pretrained(SAM2_MODEL_PATH)
    model = Sam2Model.from_pretrained(SAM2_MODEL_PATH)
    model.eval()
    with torch.no_grad():
        inputs = processor(images=image, input_boxes=[[box]],
                           original_sizes=[[height, width]], return_tensors="pt")
        output = model(**inputs, multimask_output=True)
        # Back to original image dimensions through the processor (not a hand-rolled
        # resize), then the existing deterministic largest-area rule below.
        masks = processor.post_process_masks(
            output.pred_masks.detach().cpu(),
            inputs["original_sizes"],
            binarize=False,
        )[0][0].numpy()
    best, best_area = -1, 0
    best_mask = None
    for index in range(masks.shape[0]):
        raw = masks[index]
        prob = 1 / (1 + np.exp(-raw)) if (raw.min() < 0 or raw.max() > 1) else raw
        mask = (prob >= MASK_THRESHOLD)
        area = int(mask.sum())
        if area > best_area:
            best, best_area, best_mask = index, area, mask
    if best_mask is None or best_area == 0:
        raise ValueError("sam produced no mask")
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[..., :3] = np.asarray(image)
    rgba[..., 3] = np.where(best_mask, 255, 0).astype(np.uint8)
    out = io.BytesIO()
    Image.fromarray(rgba).save(out, format="PNG")
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "FlorenceSAMGateway/1"

    def log_message(self, *args):  # keep logs free of prompts and keys
        sys.stderr.write(f"{self.command} {self.path} -> {args[1]}\n")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/v1/healthz":
            status, body, ctype = _json(200, {"ok": True})
        else:
            status, body, ctype = _json(404, {"error": "not found"})
        self._send(status, body, ctype)

    def do_POST(self) -> None:
        if self.path != "/v1/extract":
            status, body, ctype = _json(404, {"error": "not found"})
            self._send(status, body, ctype)
            return
        if not _authorized(self.headers):
            status, body, ctype = _json(401, {"error": "unauthorized"})
            self._send(status, body, ctype)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            status, body, ctype = _json(413, {"error": "body too large"})
            self._send(status, body, ctype)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            image_png = base64.b64decode(payload["image"])
            prompt = payload["prompt"]
            if not isinstance(prompt, str) or not prompt.strip():
                raise ValueError("prompt must be a non-empty string")
            from PIL import Image
            Image.open(io.BytesIO(image_png)).verify()
        except (ValueError, KeyError, binascii.Error, OSError):
            status, body, ctype = _json(400, {"error": "invalid image or prompt"})
            self._send(status, body, ctype)
            return
        if not INFERENCE_LOCK.acquire(blocking=False):
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", str(RETRY_AFTER_S))
            overloaded = json.dumps({"error": "busy, retry later"}).encode("utf-8")
            self.send_header("Content-Length", str(len(overloaded)))
            self.end_headers()
            self.wfile.write(overloaded)
            return
        try:
            grounding = _ground(image_png, prompt)
        except Exception as error:
            status, body, ctype = _json(502, {"error": f"grounding failed: {error}"[:240]})
            self._send(status, body, ctype)
            return
        try:
            boxes = grounding.get("boxes", [])
            areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in boxes]
            best = max(range(len(areas)), key=lambda i: areas[i]) if areas and max(areas) > 0 else -1
            if best < 0:
                status, body, ctype = _json(422, {"error": "no garment for prompt"})
                self._send(status, body, ctype)
                return
            try:
                png = _segment(image_png, boxes[best])
            except Exception as error:
                status, body, ctype = _json(502, {"error": f"segmentation failed: {error}"[:240]})
                self._send(status, body, ctype)
                return
            self._send(200, png, "image/png")
        finally:
            INFERENCE_LOCK.release()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--ground":
        sys.exit(_ground_mode())
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
