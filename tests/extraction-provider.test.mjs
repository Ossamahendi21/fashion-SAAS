// Provider-selection and withoutBG adapter seam, exercised without any network. Assertions cover
// config gating (default openai, fail-closed), HTTP/error normalization, cost honesty, and the
// 1024×1024 cutout contract that applies to every provider.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      for (const extension of [".ts", ".js"]) {
        const candidate = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
});

const {
  ExtractionError,
  EXTRACTION_CUTOUT_SIZE,
  WITHOUTBG_COST_USD_PER_IMAGE_DEFAULT,
  ensureSquareCutout,
  extractionProvider,
  parseWithoutBgBytes,
  withoutBgConfig,
  withoutBgEndpoint,
  withoutBgHeaders,
  withoutBgRequest,
  withoutBgExtract,
} = await import("../convex/ai/extraction.ts");

const sharp = (await import("sharp")).default;

/** A PNG buffer: rgba (true) or rgb (false), optionally a specific size. */
async function pngBytes({ width = 64, height = 64, rgba = true, alpha = 1 } = {}) {
  const background = rgba ? { r: 30, g: 60, b: 90, alpha } : { r: 30, g: 60, b: 90 };
  return sharp({ create: { width, height, channels: rgba ? 4 : 3, background } }).png().toBuffer();
}

const baseEnv = {
  WITHOUTBG_BASE_URL: "https://gw.example",
  WITHOUTBG_API_KEY: "secret-key-value",
  WITHOUTBG_COST_USD_PER_IMAGE: "0.002",
};

const config = () => withoutBgConfig({ ...baseEnv });

/** Stub transport recording the request; `body` may be empty for an empty-response test. */
function transportOf(body, { status = 200, throwError = null } = {}) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (throwError) throw throwError;
    return new Response(body, { status, headers: { "content-type": "image/png" } });
  };
  return { transport, calls };
}

const kindOf = (error) => (error instanceof ExtractionError ? error.kind : undefined);

test("extraction provider defaults to gpt-image-2 (openai) with no env", () => {
  assert.equal(extractionProvider({}), "openai");
});

test("EXTRACTION_PROVIDER=withoutbg selects the withoutBG adapter", () => {
  assert.equal(extractionProvider({ EXTRACTION_PROVIDER: "withoutbg" }), "withoutbg");
});

test("an unknown EXTRACTION_PROVIDER fails closed with a clear message", () => {
  assert.throws(() => extractionProvider({ EXTRACTION_PROVIDER: "ideogram" }), /not supported/);
  const error = (() => {
    try {
      extractionProvider({ EXTRACTION_PROVIDER: "fal" });
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof ExtractionError);
  assert.equal(kindOf(error), "auth-config");
});

test("withoutBG config fails closed when a required server env var is missing", () => {
  assert.throws(() => withoutBgConfig({ WITHOUTBG_BASE_URL: "https://x", WITHOUTBG_COST_USD_PER_IMAGE: "0.001" }), /WITHOUTBG_API_KEY/);
  assert.throws(() => withoutBgConfig({ WITHOUTBG_API_KEY: "k", WITHOUTBG_COST_USD_PER_IMAGE: "0.001" }), /WITHOUTBG_BASE_URL/);
});

test("withoutBG cost defaults to the documented estimate and guards malformed/negative env", () => {
  assert.equal(withoutBgConfig({ WITHOUTBG_BASE_URL: "x", WITHOUTBG_API_KEY: "k" }).costUsdPerImage, WITHOUTBG_COST_USD_PER_IMAGE_DEFAULT);
  assert.equal(withoutBgConfig({ ...baseEnv, WITHOUTBG_COST_USD_PER_IMAGE: "0" }).costUsdPerImage, 0);
  assert.equal(withoutBgConfig({ ...baseEnv, WITHOUTBG_COST_USD_PER_IMAGE: "-2" }).costUsdPerImage, WITHOUTBG_COST_USD_PER_IMAGE_DEFAULT);
});

test("withoutBG request targets {baseUrl}/v1/remove-background with X-API-Key and image/png", () => {
  assert.equal(withoutBgEndpoint("https://gw.example"), "https://gw.example/v1/remove-background");
  assert.equal(withoutBgEndpoint("https://gw.example/"), "https://gw.example/v1/remove-background");
  const headers = withoutBgHeaders("k");
  assert.equal(headers["X-API-Key"], "k");
  assert.equal(headers["Content-Type"], "image/png");
  assert.equal(headers["Accept"], "image/png");
  const { url, init } = withoutBgRequest(config(), new Uint8Array([1, 2, 3]));
  assert.equal(url, "https://gw.example/v1/remove-background");
  assert.equal(init.method, "POST");
  assert.deepEqual(new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength), new Uint8Array([1, 2, 3]));
});

test("withoutBG 200 transparent PNG resolves to a transparent cutout with the configured cost", async () => {
  const body = await pngBytes({ width: 200, height: 300 });
  const { transport } = transportOf(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  const result = await withoutBgExtract({ bytes: new Uint8Array([0]), prompt: "p" }, config(), transport);
  assert.equal(result.provider, "withoutbg");
  assert.equal(result.background, "transparent");
  assert.equal(result.width, 200);
  assert.equal(result.height, 300);
  assert.equal(result.costUsd, 0.002);
  assert.equal("usage" in result, false, "a self-hosted gateway has no token usage to report");
});

test("withoutBG 200 opaque PNG is classified opaque but still accepted", async () => {
  const body = await pngBytes({ rgba: false });
  const { transport } = transportOf(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  const result = await withoutBgExtract({ bytes: new Uint8Array([0]), prompt: "p" }, config(), transport);
  assert.equal(result.background, "opaque");
});

test("withoutBG non-image or empty bodies are malformed-output, never silently accepted", async () => {
  for (const body of [new TextEncoder().encode("not an image"), new Uint8Array(0)]) {
    const { transport } = transportOf(body);
    await assert.rejects(
      () => withoutBgExtract({ bytes: new Uint8Array([0]), prompt: "p" }, config(), transport),
      (error) => kindOf(error) === "malformed-output" && error.retryable === false,
    );
  }
});

const statusKind = async (status) => {
  const { transport } = transportOf(new Uint8Array(0), { status });
  try {
    await withoutBgExtract({ bytes: new Uint8Array([0]), prompt: "p" }, config(), transport);
  } catch (error) {
    return error;
  }
  return null;
};

test("withoutBG 401/403 are auth/config with no secret in the message", async () => {
  for (const status of [401, 403]) {
    const error = await statusKind(status);
    assert.equal(kindOf(error), "auth-config");
    assert.equal(error.retryable, false);
    assert.equal(error.message.includes("secret-key-value"), false, "the api key must never leak into an error");
  }
});

test("withoutBG 408/429 are rate-limited and retryable", async () => {
  for (const status of [408, 429]) {
    const error = await statusKind(status);
    assert.equal(kindOf(error), "rate-limited");
    assert.equal(error.retryable, true);
  }
});

test("withoutBG 5xx and network failures are transient and retryable", async () => {
  const error = await statusKind(502);
  assert.equal(kindOf(error), "transient");
  assert.equal(error.retryable, true);
  const { transport } = transportOf(new Uint8Array(0), { throwError: new Error("ECONNREFUSED") });
  await assert.rejects(
    () => withoutBgExtract({ bytes: new Uint8Array([0]), prompt: "p" }, config(), transport),
    (caught) => kindOf(caught) === "transient" && caught.retryable,
  );
});

test("withoutBG 400/415 reject the image permanently without a paid retry semantics", async () => {
  for (const status of [400, 415]) {
    const error = await statusKind(status);
    assert.equal(kindOf(error), "invalid-input");
    assert.equal(error.retryable, false);
  }
});

test("withoutBG 413 reports the image as unsupported (too large)", async () => {
  const error = await statusKind(413);
  assert.equal(kindOf(error), "unsupported-image");
});

test("withoutBG timeout surfaces as a transient error", async () => {
  const fakeAbort = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      });
    });
  await assert.rejects(
    () => withoutBgExtract({ bytes: new Uint8Array([0]), prompt: "p" }, { ...config(), timeoutMs: 25 }, fakeAbort),
    (caught) => kindOf(caught) === "transient" && caught.retryable,
  );
});

test("ensureSquareCutout passes an already 1024×1024 PNG through byte-identical", async () => {
  const size = EXTRACTION_CUTOUT_SIZE;
  const original = await pngBytes({ width: size, height: size });
  const input = new Uint8Array(original.buffer, original.byteOffset, original.byteLength);
  const { bytes, width, height } = await ensureSquareCutout(input);
  assert.equal(width, size);
  assert.equal(height, size);
  assert.ok(Buffer.compare(Buffer.from(bytes), Buffer.from(input)) === 0, "openai path must not be re-encoded");
});

test("ensureSquareCutout pads a smaller cutout onto a centered 1024×1024 transparent canvas, preserving alpha", async () => {
  const size = EXTRACTION_CUTOUT_SIZE;
  const small = await pngBytes({ width: 300, height: 200, rgba: true });
  const { bytes, width, height } = await ensureSquareCutout(new Uint8Array(small.buffer, small.byteOffset, small.byteLength));
  assert.equal(width, size);
  assert.equal(height, size);
  assert.equal(parseWithoutBgBytes(bytes).hasAlpha, true);
});

test("ensureSquareCutout rejects non-image bytes as malformed-output", async () => {
  await assert.rejects(
    () => ensureSquareCutout(new Uint8Array(new TextEncoder().encode("garbage"))),
    (error) => kindOf(error) === "malformed-output" && error.retryable === false,
  );
});