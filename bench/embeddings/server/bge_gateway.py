"""Reference local BGE embedding gateway (DEPLOY-ONLY, not part of the app bundle).

Runs on the no-GPU Ubuntu VPS (Linux aarch64) and serves the Convex `local` embedding provider:

    POST /v1/embed   {"text": "..."}            -> {"vector": [384 floats]}
    GET  /health     -> {"ok": true, ...}

Pinned runtime (do not silently upgrade; this is the recipe validated in Step 7 Phase B1):
  - BAAI/bge-small-en-v1.5, revision 5c38ec7c405ec4b44b94cc5a9bb96e735b38267a (MIT),
    the OFFICIAL `onnx/model.onnx` FP32 artifact, on onnxruntime CPUExecutionProvider.
    No torch, no CUDA, no self-quantization.
  - Official pipeline, replicated from this model's sentence-transformers modules.json:
        Transformer (BERT) -> Pooling(CLS) -> Normalize(L2)
    The ONNX graph stops at `last_hidden_state`, so CLS pooling happens here and L2 normalization
    happens in exactly ONE function (`_l2_normalize`), applied once, after pooling.
  - intra_op_num_threads=2, inter_op_num_threads=1 (B1 best single-stream latency: p50 37 ms).
  - Tokenization is the model's own `tokenizer.json` via the `tokenizers` library, with
    truncation enabled at the model's 512 position embeddings.

The revision is pinned by PATH (BGE_MODEL_PATH, set by the systemd unit) plus HF_HUB_OFFLINE=1, so
no branch ref is ever resolved at runtime and the weights cannot drift. Model weights are NEVER in
git: install.sh fetches the snapshot onto the host.

Bounded concurrency: ONE inference at a time. A second concurrent request fails fast with
503 + Retry-After instead of thrashing CPU/RAM. Health checks never take the lock.

Auth: X-API-Key compared against EMBEDDING_API_KEY with secrets.compare_digest; the key never
appears in responses or logs. External provider spend for callers is $0 by contract: there are no
tokens here to bill.
"""
from __future__ import annotations

import json
import math
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "BAAI/bge-small-en-v1.5"
REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"
EXPECTED_DIM = 384
MODEL_MAX_SEQ = 512
INTRA_OP_THREADS = 2
INTER_OP_THREADS = 1
MAX_BODY_BYTES = 64 * 1024
MAX_TEXT_CHARS = 4000
NORM_TOLERANCE = 1e-3

# Pinned local snapshot directory (set by the systemd unit / install.sh). With HF_HUB_OFFLINE=1 no
# branch refs resolve at runtime: the revision cannot drift under us.
BGE_MODEL_PATH = os.environ.get(
    "BGE_MODEL_PATH",
    f"/opt/fashion-bge-gateway/models/{REVISION}",
)

# Single-flight: at most one embedding inference at a time.
INFERENCE_LOCK = threading.Lock()

_SESSION = None
_TOKENIZER = None
_LOCK_INIT = threading.Lock()
LOAD_SECONDS = None


def _init():
    """Load the ONNX session and tokenizer once, lazily, under a lock. Returns (session, tokenizer)."""
    global _SESSION, _TOKENIZER, LOAD_SECONDS
    if _SESSION is not None:
        return _SESSION, _TOKENIZER
    with _LOCK_INIT:
        if _SESSION is None:
            started = time.perf_counter()
            import onnxruntime as ort
            from tokenizers import Tokenizer

            model_path = os.path.join(BGE_MODEL_PATH, "onnx", "model.onnx")
            tokenizer_path = os.path.join(BGE_MODEL_PATH, "tokenizer.json")
            if not os.path.exists(model_path):
                raise RuntimeError(f"missing pinned ONNX artifact: {model_path}")
            options = ort.SessionOptions()
            options.intra_op_num_threads = INTRA_OP_THREADS
            options.inter_op_num_threads = INTER_OP_THREADS
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            _SESSION = ort.InferenceSession(
                model_path, options, providers=["CPUExecutionProvider"]
            )
            tokenizer = Tokenizer.from_file(tokenizer_path)
            tokenizer.enable_truncation(max_length=MODEL_MAX_SEQ)
            _TOKENIZER = tokenizer
            LOAD_SECONDS = round(time.perf_counter() - started, 3)
    return _SESSION, _TOKENIZER


def _feeds(tokenizer, text: str):
    """int64 [1, seq] feeds with padding, exactly as the B1 benchmark built them."""
    import numpy as np

    encoding = tokenizer.encode(text)
    ids = encoding.ids
    width = len(ids)
    input_ids = np.zeros((1, width), dtype=np.int64)
    attention_mask = np.zeros((1, width), dtype=np.int64)
    token_type_ids = np.zeros((1, width), dtype=np.int64)
    input_ids[0, :width] = ids
    attention_mask[0, :width] = 1
    token_type_ids[0, :width] = encoding.type_ids
    return {"input_ids": input_ids, "attention_mask": attention_mask, "token_type_ids": token_type_ids}


def _l2_normalize(vector):
    """THE single normalization point in this process. Applied once, after CLS pooling."""
    import numpy as np

    matrix = np.asarray(vector, dtype=np.float32).reshape(1, -1)
    norm = float(np.linalg.norm(matrix, axis=1)[0])
    if not math.isfinite(norm) or norm == 0.0:
        raise ValueError("cls vector has no usable norm")
    unit = (matrix / norm).astype(np.float32)
    deviation = abs(float(np.linalg.norm(unit, axis=1)[0]) - 1.0)
    if deviation > NORM_TOLERANCE:
        raise ValueError(f"post-normalization norm deviates by {deviation:.2e}")
    return [float(x) for x in unit[0]]


def embed(text: str) -> list[float]:
    """CLS-pool + L2-normalize one text. Raises ValueError on unusable input."""
    session, tokenizer = _init()
    hidden = session.run(["last_hidden_state"], _feeds(tokenizer, text))[0]
    pooled = hidden[:, 0, :]
    return _l2_normalize(pooled)


def _json(status: int, payload: object) -> tuple[int, bytes, str]:
    return status, json.dumps(payload).encode("utf-8"), "application/json"


def _authorized(headers) -> bool:
    expected = os.environ.get("EMBEDDING_API_KEY", "")
    if not expected:
        return False
    return secrets.compare_digest(headers.get("X-API-Key", ""), expected)


class Handler(BaseHTTPRequestHandler):
    server_version = "BgeGateway/1"

    def log_message(self, *args):  # keep logs free of keys and garment text
        sys.stderr.write(f"{self.command} {self.path} -> {args[1]}\n")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        # /health is unauthenticated on purpose: it exposes no model detail and no secret, and the
        # deploy check must be able to run before EMBEDDING_API_KEY is known to be correct. It
        # reports readiness, not a token.
        if self.path != "/health":
            status, body, ctype = _json(404, {"error": "not found"})
            self._send(status, body, ctype)
            return
        try:
            session, _ = _init()
            status, body, ctype = _json(
                200,
                {
                    "ok": True,
                    "model": MODEL_ID,
                    "revision": REVISION,
                    "dimensions": EXPECTED_DIM,
                    "pooling": "cls",
                    "normalization": "l2-once",
                    "runtime": "onnxruntime CPUExecutionProvider (official fp32 onnx/model.onnx)",
                    "intra_op_threads": INTRA_OP_THREADS,
                    "load_seconds": LOAD_SECONDS,
                    "providers": session.get_providers() if session else [],
                },
            )
        except Exception as error:  # not ready yet (weights missing, etc.)
            status, body, ctype = _json(503, {"ok": False, "error": str(error)[:240]})
        self._send(status, body, ctype)

    def do_POST(self) -> None:
        if self.path != "/v1/embed":
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
            text = payload["text"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError("text must be a non-empty string")
            if len(text) > MAX_TEXT_CHARS:
                raise ValueError("text too long")
        except (ValueError, KeyError, TypeError):
            status, body, ctype = _json(400, {"error": "invalid request: expected {\"text\": \"...\"}"})
            self._send(status, body, ctype)
            return
        if not INFERENCE_LOCK.acquire(blocking=False):
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "30")
            busy = json.dumps({"error": "busy, retry later"}).encode("utf-8")
            self.send_header("Content-Length", str(len(busy)))
            self.end_headers()
            self.wfile.write(busy)
            return
        try:
            try:
                vector = embed(text)
            except Exception as error:
                status, body, ctype = _json(500, {"error": f"embedding failed: {error}"[:240]})
                self._send(status, body, ctype)
                return
            self._send(200, json.dumps({"vector": vector}).encode("utf-8"), "application/json")
        finally:
            INFERENCE_LOCK.release()


if __name__ == "__main__":
    # Fail fast at boot rather than on the first request: a gateway that cannot load the pinned
    # weights should never look healthy.
    _init()
    port = int(os.environ.get("PORT", "8090"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()