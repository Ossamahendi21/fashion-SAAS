import { appError } from "./errors";

/**
 * Server-side shopping-image retrieval (Original Step 3, Requirement A).
 *
 * Replaces the background worker's retailer fetch with an authenticated server boundary.
 * The browser supplies only the remote public URL; identity, validation, fetching, and
 * storage all happen here. SSRF protection covers every initial URL AND every redirect:
 * hostname-text checks first, then DNS resolution with classification of EVERY resolved
 * address (never trust hostname text alone), then manual redirect handling that
 * re-validates each hop. Redirects are bounded; bodies are size-capped; only raster
 * image MIME types are accepted (never SVG); no cookies or credentials are ever sent.
 *
 * Pure except for injected I/O: root node tests drive the whole SSRF matrix with fake
 * fetch/DNS, and convex/shoppingImages.ts wires the real Node fetch + node:dns.
 *
 * Residual risk (documented, not silently weakened): resolve-then-fetch has an inherent
 * DNS-rebinding TOCTOU window. The Node runtime here offers no connection-level IP
 * pinning without an extra HTTP agent dependency, so a hostile DNS that flips between
 * resolve and connect is not covered. Every resolved address IS rejected when private,
 * which closes the steady-state bypass; only a racing record remains.
 */

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_URL_CHARS = 8192;
/** Matches the previous background-worker behavior (12 s per request). */
export const FETCH_TIMEOUT_MS = 12_000;
/** Hard ceiling on redirect hops; product-page resolution gets one HTML fetch on top. */
export const MAX_REDIRECTS = 5;

/** Raster only. SVG is rejected everywhere in Step 3 (server, normalize, drop, pill). */
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export function isAllowedImageType(value: string): value is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(value);
}

/** Hostnames that always resolve to link-local/cloud-metadata endpoints. */
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data.compute.internal",
  "instance-data",
  "metadata",
]);

/**
 * WHATWG URLs keep brackets on IPv6 literals ("[::1]"), so strip them (and any zone id)
 * before classification. Returns the bare literal, or null when the host is not an IP
 * literal at all. Malformed candidates are returned (not null) so isBlockedIp fails
 * them closed; only genuine hostnames return null here.
 */
export function literalIp(hostname: string): string | null {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const unzoned = bare.split("%")[0] ?? "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(unzoned)) return unzoned;
  if (unzoned.includes(":") && /^[0-9a-fA-F:.]+$/.test(unzoned)) return unzoned;
  return null;
}

/**
 * Classifies one IP literal (no DNS). True = must never be fetched. Covers loopback,
 * private, link-local, multicast, reserved/unspecified, CGNAT, benchmark/documentation,
 * IPv6 ULA, IPv4-mapped IPv6 (classified by the embedded address) and 6to4 embeds.
 */
export function isBlockedIp(raw: string): boolean {
  // Tolerate brackets ("[::1]") and strip any IPv6 zone id: the zone never changes scope.
  // Anything that is not a well-formed literal fails closed (returns true).
  const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const ip = bare.split("%")[0] ?? "";
  if (ipv4Parts(ip)) return isBlockedIpv4(ip);
  if (expandIpv6(ip.toLowerCase())) return isBlockedIpv6(ip);
  return true;
}

function ipv4Parts(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : NaN;
  });
  return numbers.every((value) => Number.isInteger(value)) ? (numbers as [number, number, number, number]) : null;
}

function inCidr(parts: [number, number, number, number], base: [number, number, number, number], bits: number): boolean {
  const address =
    ((parts[0] ?? 0) * 256 ** 3 + (parts[1] ?? 0) * 256 ** 2 + (parts[2] ?? 0) * 256 + (parts[3] ?? 0)) >>> 0;
  const network =
    ((base[0] * 256 ** 3 + base[1] * 256 ** 2 + base[2] * 256 + base[3]) >>> 0) &
    (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0);
  const mask = bits === 0 ? 0 : ((~0 << (32 - bits)) >>> 0);
  return (address & mask) === network;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ipv4Parts(ip);
  if (!parts) return true;
  const [a, b] = parts;
  if (a === 10) return true; // 10/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. cloud metadata)
  if (a >= 224 && a <= 239) return true; // 224/4 multicast
  if (a >= 240) return true; // 240/4 reserved
  if (a === 0) return true; // 0/8 unspecified ("0.0.0.0" and friends)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier-grade NAT
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true; // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100/24 documentation
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113/24 documentation
  if (a === 192 && b === 88 && parts[2] === 99) return true; // 192.88.99/24 deprecated 6to4 relay
  return false;
}

function expandIpv6(ip: string): number[] | null {
  // Returns the eight 16-bit groups, or null when malformed.
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (side: string): number[] | null => {
    if (side === "") return [];
    const out: number[] = [];
    for (const chunk of side.split(":")) {
      // Embedded IPv4 ("::ffff:10.0.0.1"): expand to two groups.
      if (chunk.includes(".")) {
        const v4 = ipv4Parts(chunk);
        if (!v4) return null;
        out.push((v4[0] ?? 0) * 256 + (v4[1] ?? 0), (v4[2] ?? 0) * 256 + (v4[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return null;
      out.push(parseInt(chunk, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (head.length + tail.length > 7) return null;
  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

function isBlockedIpv6(ip: string): boolean {
  const groups = expandIpv6(ip.toLowerCase());
  if (!groups) return true;
  const hex = groups.map((group) => group.toString(16).padStart(4, "0")).join("");
  if (/^0+$/.test(hex)) return true; // :: unspecified
  if (hex === "00000000000000000000000000000001") return true; // ::1 loopback
  if (hex.startsWith("fe8") || hex.startsWith("fe9") || hex.startsWith("fea") || hex.startsWith("feb")) return true; // fe80::/10 link-local
  if (hex.startsWith("ff")) return true; // ff00::/8 multicast
  if (hex.startsWith("fc") || hex.startsWith("fd")) return true; // fc00::/7 unique-local
  if (hex.startsWith("2002")) {
    // 6to4 (2002:V:V::/48): classify the embedded IPv4 address.
    const embedded = `${(groups[1] ?? 0) >> 8}.${(groups[1] ?? 0) & 0xff}.${(groups[2] ?? 0) >> 8}.${(groups[2] ?? 0) & 0xff}`;
    return isBlockedIpv4(embedded);
  }
  if (hex.startsWith("00000000000000000000ffff")) {
    // IPv4-mapped ("::ffff:a.b.c.d"): the embedded address decides.
    const embedded = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 0xff}`;
    return isBlockedIpv4(embedded);
  }
  // Documentation (2001:db8::/32) and other reserved corners are unroutable; block them.
  if (hex.startsWith("20010db8")) return true;
  if (hex.startsWith("0100") && groups[0] === 0x100) return true; // 100::/64 discard
  return false;
}

export type ResolveHost = (hostname: string) => Promise<string[]>;

/**
 * Validates one fetch target WITHOUT network access: scheme, credentials, length,
 * hostname-text blocklist, and literal-IP classification. Returns the parsed URL.
 * Hostnames that are not literals still need resolveAndCheckHost before connecting.
 */
export function validateFetchUrl(href: unknown): URL {
  if (typeof href !== "string" || href.length === 0 || href.length > MAX_URL_CHARS) {
    throw appError("INVALID_INPUT", "Drag a web image or upload a file.");
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw appError("INVALID_INPUT", "Drag a web image or upload a file.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw appError("INVALID_INPUT", "Drag a web image or upload a file.");
  }
  if (url.username || url.password) {
    throw appError("INVALID_INPUT", "Image addresses with credentials are not supported.");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    METADATA_HOSTS.has(host)
  ) {
    throw appError("INVALID_INPUT", "Private-network image URLs are not supported.");
  }
  // IP literals (v4 dword/octal/hex forms are already normalized by the URL parser)
  // are classified directly, no DNS involved. Bracketed IPv6 included via literalIp.
  const literal = literalIp(host);
  if (literal) {
    if (isBlockedIp(literal)) throw appError("INVALID_INPUT", "Private-network image URLs are not supported.");
    return url;
  }
  // Non-literal hostnames with a colon cannot occur after parsing; anything else odd fails here.
  if (host.includes(":")) throw appError("INVALID_INPUT", "Private-network image URLs are not supported.");
  return url;
}

/**
 * DNS half of SSRF protection: resolves the hostname and rejects when ANY resolved
 * address is blocked. Unresolvable names fail as unreachable, never as private (the
 * message must stay truthful). The resolver is injected so tests never touch real DNS.
 */
export async function resolveAndCheckHost(hostname: string, resolve: ResolveHost): Promise<string[]> {
  let addresses: string[];
  try {
    const found = await resolve(hostname.toLowerCase());
    addresses = [...new Set(found.map((address) => address.split("%")[0] ?? ""))].filter(
      (address) => address.length > 0,
    );
  } catch {
    throw appError("UPSTREAM_FAILED", "Couldn't reach that image address. Check the link and try again.");
  }
  if (addresses.length === 0) {
    throw appError("UPSTREAM_FAILED", "Couldn't reach that image address. Check the link and try again.");
  }
  for (const address of addresses) {
    // Resolvers answer with IP literals; anything else (or any blocked address) fails closed.
    if (isBlockedIp(address)) {
      throw appError("INVALID_INPUT", "Private-network image URLs are not supported.");
    }
  }
  return addresses;
}

export type FetchImpl = typeof fetch;

export type ImageFetchDeps = {
  fetchImpl?: FetchImpl;
  /** Required: DNS lives behind this seam so tests never touch real resolvers and the
   * "use node" action supplies node:dns. */
  resolveHost: ResolveHost;
};

export type FetchedImage = {
  bytes: Uint8Array;
  mimeType: AllowedImageType;
  /** Final URL after redirects (and og:image resolution for page URLs). */
  finalUrl: string;
};

/** Reads a response body up to `limit` bytes; images past the limit are rejected. */
async function readCapped(response: Response, limit: number, truncate: boolean): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > limit) {
    throw appError("INVALID_INPUT", "Image exceeds 8 MB.");
  }
  if (!response.body) throw appError("UPSTREAM_FAILED", "That image could not be read. Try again.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!truncate && total + value.length > limit) {
      await reader.cancel().catch(() => {});
      throw appError("INVALID_INPUT", "Image exceeds 8 MB.");
    }
    const part = value.subarray(0, limit - total);
    chunks.push(part);
    total += part.length;
    if (total >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Finds the page's share image in <meta property="og:image"> style tags (bounded input). */
export function previewImageUrl(html: string, pageUrl: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((match) => [
        match[1]?.toLowerCase() ?? "",
        match[2] || match[3] || match[4] || "",
      ]),
    );
    const name = (attributes.property || attributes.name || "").toLowerCase();
    if (!["og:image", "og:image:secure_url", "twitter:image"].includes(name) || !attributes.content) continue;
    const decoded = attributes.content
      .replace(/&amp;/gi, "&")
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
    try {
      return new URL(decoded, pageUrl).href;
    } catch {
      // Try the next tag.
    }
  }
  return null;
}

function mimeOf(response: Response): string {
  return response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
}

/**
 * Fetches one validated URL with manual redirect handling: every hop is re-validated
 * (text + DNS) before connecting, so a redirect-to-private dies at the gate instead of
 * at the socket. Plain fetch options only: no credentials, no cookie jar, no forwarded
 * headers. Never throws raw network errors; every failure is an appError with safe copy.
 */
async function fetchValidated(
  start: URL,
  deps: Required<ImageFetchDeps>,
  redirectsLeft: number,
): Promise<{ response: Response; finalUrl: string }> {
  let current = start;
  let remaining = redirectsLeft;
  for (;;) {
    validateFetchUrl(current.href);
    if (!literalIp(current.hostname)) {
      await resolveAndCheckHost(current.hostname, deps.resolveHost);
    }
    let response: Response;
    try {
      // redirect: "manual" + error mode keeps every hop visible for re-validation.
      // No credentials option: undici/Node fetch sends no cookies unless told to.
      response = await deps.fetchImpl(current.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw appError("UPSTREAM_FAILED", "That image took too long to load. Try again.");
      }
      throw appError("UPSTREAM_FAILED", "Couldn't load that image. Check your connection and try again.");
    }
    if (response.status >= 300 && response.status < 400) {
      if (remaining <= 0) throw appError("INVALID_INPUT", "That image address redirects too many times.");
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) throw appError("UPSTREAM_FAILED", "Couldn't load that image. Try a different one.");
      let next: URL;
      try {
        next = new URL(location, current.href);
      } catch {
        throw appError("UPSTREAM_FAILED", "Couldn't load that image. Try a different one.");
      }
      remaining -= 1;
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw appError("UPSTREAM_FAILED", "That image or page could not be loaded. Try a different one.");
    }
    return { response, finalUrl: current.href };
  }
}

/**
 * Full retrieval: validates the input, fetches it through the redirect gate, resolves
 * product-page URLs to their share image (then fetches THAT through the same gate),
 * enforces size caps and the raster-only MIME allowlist. Returns bytes + MIME only:
 * raw HTML is consumed here and never returned to the client.
 */
export async function fetchRemoteImage(href: string, deps: ImageFetchDeps): Promise<FetchedImage> {
  const full: Required<ImageFetchDeps> = {
    fetchImpl: deps.fetchImpl ?? fetch,
    resolveHost: deps.resolveHost,
  };
  const start = validateFetchUrl(href);
  const { response, finalUrl } = await fetchValidated(start, full, MAX_REDIRECTS);
  const mime = mimeOf(response);
  if (mime === "text/html") {
    const page = new TextDecoder().decode(await readCapped(response, MAX_PAGE_BYTES, true));
    const preview = previewImageUrl(page, finalUrl);
    if (!preview) throw appError("INVALID_INPUT", "This link has no public product image. Drag the photo itself or upload a file.");
    const imageUrl = validateFetchUrl(preview);
    const fetched = await fetchValidated(imageUrl, full, MAX_REDIRECTS);
    return readImageBytes(fetched.response, fetched.finalUrl);
  }
  return readImageBytes(response, finalUrl);
}

async function readImageBytes(response: Response, finalUrl: string): Promise<FetchedImage> {
  const mime = mimeOf(response);
  if (!isAllowedImageType(mime)) {
    await response.body?.cancel().catch(() => {});
    throw appError("INVALID_INPUT", "Use a JPG, PNG or WebP image.", { accepted: [...ALLOWED_IMAGE_TYPES] });
  }
  const bytes = await readCapped(response, MAX_IMAGE_BYTES, false);
  return { bytes, mimeType: mime, finalUrl };
}
