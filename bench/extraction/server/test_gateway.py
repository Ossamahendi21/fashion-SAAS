"""Focused gateway tests: auth, validation, empty-box mapping, busy guard, health.

No torch/models needed: _ground/_segment are monkeypatched with slow fakes and the
server runs on an ephemeral localhost port. Run: python test_gateway.py
"""
import base64
import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import florencesam_gateway as gw

os.environ["FLORENCESAM_API_KEY"] = "test-key"

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
BOX = [10.0, 10.0, 50.0, 50.0]


def post(port, body, key="test-key", raw_body=None):
    data = raw_body if raw_body is not None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/extract", data=data,
        headers={"Content-Type": "application/json", "X-API-Key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.headers.get("Retry-After"), res.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("Retry-After"), error.read()


class GatewayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_ground, cls._orig_segment = gw._ground, gw._segment
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), gw.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        gw._ground, gw._segment = cls._orig_ground, cls._orig_segment

    def setUp(self):
        gw._ground = lambda image_png, prompt: {"boxes": [BOX], "labels": ["tee"]}
        gw._segment = lambda image_png, box: TINY_PNG

    def body(self):
        return {"image": base64.b64encode(TINY_PNG).decode(), "prompt": "a photo of a tee"}

    def test_health_needs_no_key(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/v1/healthz", timeout=10) as res:
            self.assertEqual(res.status, 200)
            self.assertEqual(json.loads(res.read()), {"ok": True})

    def test_wrong_key_is_401(self):
        status, _, _ = post(self.port, self.body(), key="wrong")
        self.assertEqual(status, 401)

    def test_bad_body_is_400(self):
        status, _, _ = post(self.port, None, raw_body=b"not json")
        self.assertEqual(status, 400)

    def test_empty_boxes_are_422(self):
        gw._ground = lambda image_png, prompt: {"boxes": [], "labels": []}
        status, _, body = post(self.port, self.body())
        self.assertEqual(status, 422)
        self.assertIn("no garment", body.decode())

    def test_second_concurrent_request_gets_503_with_retry_after(self):
        entered, release = threading.Event(), threading.Event()

        def slow_segment(image_png, box):
            entered.set()
            release.wait(timeout=30)
            return TINY_PNG

        gw._segment = slow_segment
        results = []

        def first():
            results.append(post(self.port, self.body()))

        worker = threading.Thread(target=first, daemon=True)
        worker.start()
        self.assertTrue(entered.wait(timeout=30), "first request never reached inference")

        # Health stays responsive while inference is busy.
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/v1/healthz", timeout=10) as res:
            self.assertEqual(res.status, 200)

        status, retry_after, body = post(self.port, self.body())
        self.assertEqual(status, 503)
        self.assertTrue(retry_after, "503 must carry Retry-After")
        self.assertIn("busy", body.decode())
        release.set()
        worker.join(timeout=30)
        self.assertEqual(results[0][0], 200, "first request completes normally after release")

    def test_lock_released_after_request(self):
        status, _, _ = post(self.port, self.body())
        self.assertEqual(status, 200)
        self.assertFalse(gw.INFERENCE_LOCK.locked(), "lock must release after each request")


if __name__ == "__main__":
    unittest.main(verbosity=2)
