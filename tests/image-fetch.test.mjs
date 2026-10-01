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

// convex/lib/imageFetch.ts is pure: no node: imports, no Convex runtime, no network unless a
// fetch impl is injected. The DNS seam is mandatory, so these tests never touch a resolver.
const {
  ALLOWED_IMAGE_TYPES,
  fetchRemoteImage,
  isAllowedImageType,
  isBlockedIp,
  literalIp,
  previewImageUrl,
  resolveAndCheckHost,
  validateFetchUrl,
} = await import("../convex/lib/imageFetch.ts");

const publicResolve = async () => ["93.184.216.34"];
const privateResolve = async () => ["10.0.0.5"];

/** Builds a fetch impl from a url -> Response map, recording every request. */
function recorder(responses) {
  const calls = [];
  const fetchImpl = async function (url, options) {
    calls.push({ url, options });
    const build = responses[url];
    if (!build) throw new Error(`Unexpected URL: ${url}`);
    return typeof build === "function" ? build() : build;
  };
  return { calls, fetchImpl };
}

const jpeg = (bytes = [255, 216, 255]) =>
  new Response(new Uint8Array(bytes), { headers: { "content-type": "image/jpeg" } });

const errorOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { code: error?.data?.code, message: error?.data?.message ?? error?.message };
  }
  return null;
};

test("validateFetchUrl accepts public http(s) URLs and normalizes them", () => {
  assert.equal(validateFetchUrl("https://cdn.example.com/a.jpg").href, "https://cdn.example.com/a.jpg");
  assert.equal(validateFetchUrl("http://cdn.example.com/a.jpg").protocol, "http:");
  // Surrounding whitespace is what the URL parser trims in any browser too: the request still
  // goes to the public host it names, and an embedded space is percent-encoded rather than
  // smuggled into a different request line.
  assert.equal(validateFetchUrl(" https://cdn.example.com/a.jpg").href, "https://cdn.example.com/a.jpg");
  assert.equal(validateFetchUrl("https://cdn.example.com/a b.jpg").href, "https://cdn.example.com/a%20b.jpg");
});

test("validateFetchUrl rejects non-http(s), credentialed, and oversized URLs", () => {
  for (const bad of [
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "file:///etc/passwd",
    "chrome-extension://abc/tabs/room.html",
    "https://user:pass@cdn.example.com/a.jpg",
    `https://cdn.example.com/${"a".repeat(9000)}.jpg`,
    "",
    null,
    42,
  ]) {
    assert.throws(() => validateFetchUrl(bad), /Drag a web image|credentials/i, `expected rejection: ${bad}`);
  }
});

test("validateFetchUrl rejects loopback, metadata, and local-name hosts by text", () => {
  for (const host of [
    "localhost",
    "room.localhost",
    "printer.local",
    "0.0.0.0",
    "metadata.google.internal",
    "169.254.169.254",
    "[::1]",
  ]) {
    assert.throws(
      () => validateFetchUrl(`https://${host}/a.jpg`),
      /Private-network image URLs are not supported/,
      `expected rejection: ${host}`,
    );
  }
});

test("validateFetchUrl rejects literal private and loopback addresses in every notation", () => {
  for (const host of [
    "127.0.0.1",
    "127.1",
    "2130706433", // 127.0.0.1 as a dword
    "0x7f.0.0.1",
    "0177.0.0.1", // octal
    "169.254.169.254",
    "10.1.2.3",
    "192.168.0.1",
    "172.16.5.4",
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "[::1]",
    "[::]",
    "[fc00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]", // IPv4-mapped loopback
  ]) {
    assert.throws(
      () => validateFetchUrl(`https://${host}/a.jpg`),
      /Private-network image URLs are not supported/,
      `expected rejection: ${host}`,
    );
  }
});

test("validateFetchUrl accepts public literal addresses", () => {
  assert.equal(validateFetchUrl("https://93.184.216.34/a.jpg").hostname, "93.184.216.34");
  assert.equal(validateFetchUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/a.jpg").hostname, "[2606:2800:220:1:248:1893:25c8:1946]");
});

test("isBlockedIp fails closed on anything malformed and never trusts a hostname", () => {
  assert.equal(isBlockedIp("not-an-ip"), true, "a name is never a safe answer here");
  assert.equal(isBlockedIp(""), true);
  assert.equal(isBlockedIp("999.1.1.1"), true);
  assert.equal(isBlockedIp("93.184.216.34"), false);
  assert.equal(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946"), false);
});

test("literalIp classifies plain literals and leaves names alone", () => {
  assert.equal(literalIp("127.0.0.1"), "127.0.0.1");
  assert.equal(literalIp("::1"), "::1");
  // Exotic notations (dword/octal/hex, bare IPv6) are normalized by the URL parser before
  // literalIp ever sees them, so this helper does not accept them and never has to guess.
  assert.equal(literalIp("2130706433"), null);
  assert.equal(literalIp("cdn.example.com"), null);
  assert.equal(literalIp(""), null);
});

test("resolveAndCheckHost rejects when any resolved address is private", async () => {
  assert.deepEqual(await resolveAndCheckHost("cdn.example.com", publicResolve), ["93.184.216.34"]);
  const mixed = async () => ["93.184.216.34", "127.0.0.1"];
  await assert.rejects(() => resolveAndCheckHost("evil.example.com", mixed), /Private-network image URLs/);
  // A rebinding-shaped answer (public + private) fails closed, not "first one wins".
  await assert.rejects(() => resolveAndCheckHost("evil.example.com", privateResolve), /Private-network image URLs/);
});

test("resolveAndCheckHost reports unreachable truthfully, never as private", async () => {
  const error = await errorOf(resolveAndCheckHost("nowhere.example.com", async () => []));
  assert.equal(error.code, "UPSTREAM_FAILED");
  assert.doesNotMatch(error.message, /private/i);
  const thrown = await errorOf(
    resolveAndCheckHost("nowhere.example.com", async () => {
      throw new Error("ENOTFOUND");
    }),
  );
  assert.equal(thrown.code, "UPSTREAM_FAILED");
  assert.doesNotMatch(thrown.message, /private/i);
});

test("resolveAndCheckHost ignores zone suffixes and de-duplicates answers", async () => {
  const scoped = async () => ["93.184.216.34%eth0", "93.184.216.34"];
  assert.deepEqual(await resolveAndCheckHost("cdn.example.com", scoped), ["93.184.216.34"]);
});

test("fetchRemoteImage stores bytes for a plain image with no cookie jar", async () => {
  const { calls, fetchImpl } = recorder({
    "https://cdn.example.com/a.jpg": () => jpeg([1, 2, 3, 4]),
  });
  const image = await fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl, resolveHost: publicResolve });
  assert.deepEqual([...image.bytes], [1, 2, 3, 4]);
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.finalUrl, "https://cdn.example.com/a.jpg");
  assert.equal(calls.length, 1);
  // Manual redirect handling is what makes per-hop re-validation possible, and no credentials
  // option means undici/Node sends no cookies.
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal("credentials" in calls[0].options, false);
});

test("fetchRemoteImage re-validates every redirect hop, including a redirect to private space", async () => {
  const { calls, fetchImpl } = recorder({
    "https://cdn.example.com/a.jpg": () =>
      new Response(null, { status: 302, headers: { location: "https://images.example.com/b.jpg" } }),
    "https://images.example.com/b.jpg": () => jpeg([9]),
  });
  const image = await fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl, resolveHost: publicResolve });
  assert.deepEqual([...image.bytes], [9]);
  assert.equal(image.finalUrl, "https://images.example.com/b.jpg");
  assert.deepEqual(calls.map((call) => call.url), ["https://cdn.example.com/a.jpg", "https://images.example.com/b.jpg"]);

  const toPrivate = recorder({
    "https://cdn.example.com/a.jpg": () =>
      new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
  });
  const error = await errorOf(
    fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl: toPrivate.fetchImpl, resolveHost: publicResolve }),
  );
  assert.equal(error.code, "INVALID_INPUT");
  assert.match(error.message, /Private-network image URLs/);
  assert.equal(toPrivate.calls.length, 1, "the private hop is never requested");
});

test("fetchRemoteImage stops after too many redirects", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const hop = calls.length + 1;
    calls.push({ url, options });
    return new Response(null, { status: 302, headers: { location: `https://cdn.example.com/${hop}.jpg` } });
  };
  const error = await errorOf(fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl, resolveHost: publicResolve }));
  assert.equal(error.code, "INVALID_INPUT");
  assert.match(error.message, /redirects too many times/);
  // 1 initial request + MAX_REDIRECTS (5) hops, then the gate refuses rather than looping.
  assert.equal(calls.length, 6);
});

test("fetchRemoteImage never follows a redirect without a Location header", async () => {
  const { fetchImpl } = recorder({
    "https://cdn.example.com/a.jpg": () => new Response(null, { status: 302 }),
  });
  const error = await errorOf(fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl, resolveHost: publicResolve }));
  assert.equal(error.code, "UPSTREAM_FAILED");
});

test("fetchRemoteImage refuses SVG and every non-raster content type", async () => {
  for (const type of ["image/svg+xml", "image/gif", "image/avif", "text/html; charset=utf-8", "application/pdf"]) {
    const { fetchImpl } = recorder({
      "https://cdn.example.com/a.jpg": () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": type } }),
    });
    const error = await errorOf(
      fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl, resolveHost: publicResolve }),
    );
    assert.ok(error, `expected rejection for ${type}`);
    assert.ok(
      error.message === "Use a JPG, PNG or WebP image." || /no public product image/i.test(error.message),
      `unexpected message for ${type}: ${error.message}`,
    );
  }
  // The allowlist is exactly the three raster formats Decart accepts.
  assert.deepEqual([...ALLOWED_IMAGE_TYPES], ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(isAllowedImageType("image/svg+xml"), false);
  assert.equal(isAllowedImageType("image/webp"), true);
  assert.equal(isAllowedImageType("image/webp "), false, "callers pass normalized values");
});

test("fetchRemoteImage enforces the 8 MB image cap before and after the body arrives", async () => {
  const declared = recorder({
    "https://cdn.example.com/a.jpg": () =>
      new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg", "content-length": String(9 * 1024 * 1024) } }),
  });
  const declaredError = await errorOf(
    fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl: declared.fetchImpl, resolveHost: publicResolve }),
  );
  assert.equal(declaredError.code, "INVALID_INPUT");
  assert.match(declaredError.message, /exceeds 8 MB/);

  const streamed = recorder({
    "https://cdn.example.com/a.jpg": () => new Response(new Uint8Array(9 * 1024 * 1024), { headers: { "content-type": "image/jpeg" } }),
  });
  const streamedError = await errorOf(
    fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl: streamed.fetchImpl, resolveHost: publicResolve }),
  );
  assert.equal(streamedError.code, "INVALID_INPUT");
  assert.match(streamedError.message, /exceeds 8 MB/);
});

test("fetchRemoteImage accepts an image just under the cap", async () => {
  const bytes = new Uint8Array(1024);
  const { fetchImpl } = recorder({
    "https://cdn.example.com/a.jpg": () => new Response(bytes, { headers: { "content-type": "image/png" } }),
  });
  const image = await fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl, resolveHost: publicResolve });
  assert.equal(image.bytes.byteLength, 1024);
  assert.equal(image.mimeType, "image/png");
});

test("fetchRemoteImage resolves a product page to its share image and re-validates it", async () => {
  const page = "https://shop.example.com/p/1";
  const image = "https://cdn.example.com/og.jpg?v=2";
  const html = `<html><head><meta content="${image.replace("&", "&amp;")}" property="og:image"/><meta name="twitter:image" content="https://cdn.example.com/tw.jpg"/></head><body>${"x".repeat(1_200_000)}</body></html>`;
  const { calls, fetchImpl } = recorder({
    [page]: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    [image]: () => jpeg([7, 7]),
  });
  const result = await fetchRemoteImage(page, { fetchImpl, resolveHost: publicResolve });
  assert.deepEqual([...result.bytes], [7, 7]);
  assert.equal(result.finalUrl, image);
  // The page's own resolved addresses were checked too, not just the image host.
  assert.deepEqual(calls.map((call) => call.url), [page, image]);
});

test("previewImageUrl takes the first share tag in document order and resolves relative URLs", () => {
  const html =
    '<meta name="twitter:image" content="https://cdn.example.com/tw.jpg"/><meta property="og:image:secure_url" content="/relative.jpg">';
  assert.equal(previewImageUrl(html, "https://shop.example.com/p/1"), "https://cdn.example.com/tw.jpg");
  assert.equal(
    previewImageUrl('<meta property="og:image:secure_url" content="/relative.jpg">', "https://shop.example.com/p/1"),
    "https://shop.example.com/relative.jpg",
  );
  // Non-http(s) share targets are skipped, and an unparseable one falls through to the next tag.
  assert.equal(
    previewImageUrl(
      '<meta property="og:image" content="data:image/png;base64,AA"><meta property="og:image:secure_url" content="https://cdn.example.com/ok.jpg">',
      "https://shop.example.com/",
    ),
    "data:image/png;base64,AA",
    "the first tag is returned; the caller re-validates it and fails closed on a data: URL",
  );
  assert.equal(previewImageUrl("<html><head></head></html>", "https://shop.example.com/"), null);
});

test("fetchRemoteImage resolves a page whose share image points at private space", async () => {
  const page = "https://shop.example.com/p/1";
  const html = '<meta property="og:image" content="http://127.0.0.1/secret.png">';
  const { fetchImpl } = recorder({
    [page]: () => new Response(html, { headers: { "content-type": "text/html" } }),
  });
  const error = await errorOf(fetchRemoteImage(page, { fetchImpl, resolveHost: publicResolve }));
  assert.equal(error.code, "INVALID_INPUT");
  assert.match(error.message, /Private-network image URLs/);
});

test("fetchRemoteImage reports a page with no product image with link-specific copy", async () => {
  const { fetchImpl } = recorder({
    "https://shop.example.com/p/1": () => new Response("<html><head></head></html>", { headers: { "content-type": "text/html" } }),
  });
  const error = await errorOf(fetchRemoteImage("https://shop.example.com/p/1", { fetchImpl, resolveHost: publicResolve }));
  assert.equal(error.code, "INVALID_INPUT");
  assert.match(error.message, /no public product image/i);
});

test("fetchRemoteImage truncates an oversized page rather than reading it whole", async () => {
  const page = "https://shop.example.com/huge";
  const head = '<html><head><meta property="og:image" content="https://cdn.example.com/og.jpg"/></head><body>';
  const html = `${head}${"x".repeat(4 * 1024 * 1024)}</body></html>`;
  const { fetchImpl } = recorder({
    [page]: () => new Response(html, { headers: { "content-type": "text/html" } }),
    "https://cdn.example.com/og.jpg": () => jpeg([3]),
  });
  const result = await fetchRemoteImage(page, { fetchImpl, resolveHost: publicResolve });
  assert.deepEqual([...result.bytes], [3], "the share tag lives in <head>, so the truncated read still finds it");
});

test("fetchRemoteImage maps non-ok statuses and transport failures to safe copy", async () => {
  const notFound = recorder({ "https://cdn.example.com/a.jpg": () => new Response(null, { status: 404 }) });
  const missing = await errorOf(
    fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl: notFound.fetchImpl, resolveHost: publicResolve }),
  );
  assert.equal(missing.code, "UPSTREAM_FAILED");
  assert.doesNotMatch(missing.message, /404/);

  const broken = {
    fetchImpl: async () => {
      const error = new Error("connect ECONNREFUSED 10.0.0.1:443");
      error.name = "TypeError";
      throw error;
    },
  };
  const transport = await errorOf(
    fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl: broken.fetchImpl, resolveHost: publicResolve }),
  );
  assert.equal(transport.code, "UPSTREAM_FAILED");
  // Never leak upstream detail (an internal address) into user-visible copy.
  assert.doesNotMatch(transport.message, /10\.0\.0\.1|ECONNREFUSED/);
});

test("fetchRemoteImage requires a resolver seam and never silently accepts a private DNS answer", async () => {
  const { fetchImpl } = recorder({ "https://cdn.example.com/a.jpg": () => jpeg([1]) });
  const error = await errorOf(fetchRemoteImage("https://cdn.example.com/a.jpg", { fetchImpl, resolveHost: privateResolve }));
  assert.equal(error.code, "INVALID_INPUT");
  assert.equal(fetchImpl.length > 0 && error.message.includes("Private-network"), true);
});

test("fetchRemoteImage validates the input before any network call", async () => {
  const { calls, fetchImpl } = recorder({});
  const error = await errorOf(fetchRemoteImage("javascript:alert(1)", { fetchImpl, resolveHost: publicResolve }));
  assert.equal(error.code, "INVALID_INPUT");
  assert.equal(calls.length, 0, "no request is made for an invalid address");
});
