"""Focused gateway tests: auth, request validation, the single-flight guard, and health.

No model needed: `embed` is monkeypatched with a deterministic fake and the server runs on an
ephemeral localhost port. Run: python test_gateway.py

These cover the HTTP contract only. The vector contract (384 dims, finiteness, L2 norm ~1,
determinism, latency) is proved by the live check in bench/embeddings/README-gateway.md and by the
Phase B1 benchmark, not here.
"""
import json
import math
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bge_gateway as gw

os.environ["EMBEDDING_API_KEY"] = "test-key"


def unit_vector(dimension):
    return [1.0 / math.sqrt(dimension)] * dimension


class FakeSession:
    """Stands in for the onnxruntime session so /health can report providers without the model."""

    def get_providers(self):
        return ["CPUExecutionProvider"]


def post(port, body, key="test-key", raw_body=None, path="/v1/embed"):
    data = raw_body if raw_body is not None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if key is not None:
        headers["X-API-Key"] = key
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.headers.get("Retry-After"), res.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("Retry-After"), error.read()


class GatewayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_embed, cls._orig_init = gw.embed, gw._init
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), gw.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        gw.embed, gw._init = cls._orig_embed, cls._orig_init

    def setUp(self):
        gw._init = lambda: (FakeSession(), object())
        gw.embed = lambda text: unit_vector(gw.EXPECTED_DIM)

    def test_health_needs_no_key_and_reports_pinned_runtime(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=10) as res:
            self.assertEqual(res.status, 200)
            payload = json.loads(res.read())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["revision"], gw.REVISION)
        self.assertEqual(payload["dimensions"], gw.EXPECTED_DIM)

    def test_wrong_key_is_401(self):
        status, _, _ = post(self.port, {"text": "a dress"}, key="wrong")
        self.assertEqual(status, 401)

    def test_missing_key_is_401(self):
        status, _, _ = post(self.port, {"text": "a dress"}, key=None)
        self.assertEqual(status, 401)

    def test_bad_body_is_400(self):
        status, _, _ = post(self.port, None, raw_body=b"not json")
        self.assertEqual(status, 400)

    def test_empty_text_is_400(self):
        status, _, _ = post(self.port, {"text": "   "})
        self.assertEqual(status, 400)

    def test_unknown_path_is_404(self):
        status, _, _ = post(self.port, {"text": "a dress"}, path="/v1/nope")
        self.assertEqual(status, 404)

    def test_successful_embed_returns_exact_dimension(self):
        status, _, body = post(self.port, {"text": "a dress"})
        self.assertEqual(status, 200)
        vector = json.loads(body)["vector"]
        self.assertEqual(len(vector), gw.EXPECTED_DIM)

    def test_inference_failure_is_500_not_a_vector(self):
        gw.embed = lambda text: (_ for _ in ()).throw(RuntimeError("onnx exploded"))
        status, _, body = post(self.port, {"text": "a dress"})
        self.assertEqual(status, 500)
        self.assertNotIn(b"vector", body)

    def test_second_concurrent_request_gets_503_with_retry_after(self):
        entered, release = threading.Event(), threading.Event()

        def slow_embed(text):
            entered.set()
            release.wait(timeout=30)
            return unit_vector(gw.EXPECTED_DIM)

        gw.embed = slow_embed
        results = []

        def first():
            results.append(post(self.port, {"text": "a dress"}))

        worker = threading.Thread(target=first, daemon=True)
        worker.start()
        self.assertTrue(entered.wait(timeout=30), "first request never reached inference")

        # Health stays responsive while inference is busy.
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=10) as res:
            self.assertEqual(res.status, 200)

        status, retry_after, body = post(self.port, {"text": "a dress"})
        self.assertEqual(status, 503)
        self.assertTrue(retry_after, "503 must carry Retry-After")
        self.assertIn(b"busy", body)
        release.set()
        worker.join(timeout=30)
        self.assertEqual(results[0][0], 200, "first request completes normally after release")

    def test_lock_released_after_request(self):
        status, _, _ = post(self.port, {"text": "a dress"})
        self.assertEqual(status, 200)
        self.assertFalse(gw.INFERENCE_LOCK.locked(), "lock must release after each request")

    def test_lock_released_after_failed_request(self):
        gw.embed = lambda text: (_ for _ in ()).throw(RuntimeError("boom"))
        status, _, _ = post(self.port, {"text": "a dress"})
        self.assertEqual(status, 500)
        self.assertFalse(gw.INFERENCE_LOCK.locked(), "lock must release even on failure")


if __name__ == "__main__":
    unittest.main(verbosity=2)