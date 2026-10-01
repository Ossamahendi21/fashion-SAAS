// Product-image heuristics for contextual shopping actions.
//
// Decides whether a hovered image is likely a fashion/product photo worth a small
// "Try on / Save" pill. Conservative by design: false negatives are preferable to covering
// a page with buttons, so the gates below reject anything that is not clearly a sizable,
// visible, real product photo. Retailer-specific selectors are deliberately avoided; the
// signals are generic (size, shape, visibility, filename, nearby text).
//
// Also home to the shared target builders (best image URL, product title, canonical page
// URL) so the hover flow, the drag flow and the tests all use one implementation.

/** Conservative minimum: the short side must be at least this many rendered pixels. */
export const MIN_PRODUCT_SHORT_SIDE = 160
/** Extremely wide banners and stripes are never products. */
export const MAX_PRODUCT_ASPECT = 4
/** Product titles are capped exactly like the server's `sourceTitle`. */
export const MAX_PRODUCT_TITLE_CHARS = 160

/** Filename fragments of things that are never the product: icons, logos, trackers, chrome. */
const FILENAME_DENY = /(sprite|logo|icon|avatar|favicon|pixel|track(ing)?|spacer|transparent|placeholder|badge|button|arrow|loader|spinner)/i

export type ProductImageSignals = {
  /** Rendered size in CSS pixels. */
  width: number
  height: number
  /** Actually painted on screen (non-zero, in-viewport area). */
  visible: boolean
  /** Resolved image URL. */
  src: string
  alt?: string | null
  title?: string | null
  /** Text near the image (card title, heading) when the caller already resolved one. */
  nearbyText?: string | null
  /** True for anything inside the extension's own UI. */
  extensionOwned?: boolean
}

/** True when the image is worth a contextual action pill. */
export function isEligibleProductImage(signals: ProductImageSignals): boolean {
  if (!signals.visible) return false
  if (!Number.isFinite(signals.width) || !Number.isFinite(signals.height)) return false
  if (signals.width <= 0 || signals.height <= 0) return false
  if (Math.min(signals.width, signals.height) < MIN_PRODUCT_SHORT_SIDE) return false
  const aspect = Math.max(signals.width, signals.height) / Math.min(signals.width, signals.height)
  if (aspect >= MAX_PRODUCT_ASPECT) return false
  if (signals.extensionOwned) return false
  let url: URL
  try {
    url = new URL(signals.src)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const filename = url.pathname.split("/").pop() ?? ""
  // SVG never becomes a hover/try-on candidate: it is active markup, not a raster photo. This is
  // a filename sniff, so it is only an early filter — the server MIME allowlist and the client's
  // normalizeImage both refuse SVG on content regardless of what the URL claims to be.
  if (/\.svg(\?|$)/i.test(filename)) return false
  if (FILENAME_DENY.test(filename) || FILENAME_DENY.test(url.pathname)) return false
  return true
}

/** Keeps short, descriptive text; drops empty or generic labels like "image" or Pinterest's "Pin". */
export function usefulText(value?: string | null): string {
  const text = value?.replace(/\s+/g, " ").trim() || ""
  return text.length >= 3 && text.length <= MAX_PRODUCT_TITLE_CHARS && !/^(image|photo|picture|product|thumbnail|img|pin)\b/i.test(text) ? text : ""
}

type NameNode = {
  alt?: string | null
  title?: string | null
  textContent?: string | null
  content?: string
  parentElement?: NameNode | null
  querySelector?: (selectors: string) => { textContent?: string | null } | null
}

type NameDocument = {
  querySelector: (selectors: string) => { textContent?: string | null; content?: string } | null
}

/** Best-effort product name: alt text, the nearest product-card title, then document fallbacks. */
export function productName(
  image: NameNode | null,
  link: { textContent?: string | null } | null,
  doc: NameDocument | null,
  isLargeImage: boolean
): string {
  const alt = usefulText(image?.alt) || usefulText(image?.title)
  if (alt) return alt
  let node: NameNode | null | undefined = image
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const title = node.querySelector?.("h1, h2, h3, h4, [class*='name' i], [class*='title' i], [data-testid*='name' i]")
    const text = usefulText(title?.textContent)
    if (text) return text
  }
  if (isLargeImage && doc) {
    return (
      usefulText(doc.querySelector("h1")?.textContent) ||
      usefulText(doc.querySelector("meta[property='og:title']")?.content) ||
      ""
    )
  }
  return usefulText(link?.textContent)
}

type ImageSource = { srcset: string; currentSrc: string; src: string }

/** The sharpest version of an image: its largest srcset candidate, resolved against the page. */
export function bestImageUrl(image: ImageSource, baseURI: string): string {
  const candidates = image.srcset.split(",").map(entry => entry.trim().split(/\s+/)).filter(([url]) => url)
    .map(([url, size]) => ({ url, size: parseFloat(size) || 0 })).sort((a, b) => b.size - a.size)
  let url = candidates[0]?.url || image.currentSrc || image.src
  try { url = new URL(url, baseURI).href } catch { return "" }
  return url.replace(/^(https:\/\/i\.pinimg\.com\/)(\d+x\d*|\d+x)\//, "$1736x/")
}

export type ProductTarget = {
  imageUrl: string
  productTitle: string
  sourcePageUrl?: string
}

/**
 * Builds the save/try-on target from already-resolved signals. Returns null when there is no
 * usable image URL; titles may be empty (the server treats the title as an optional hint).
 */
export function buildProductTarget(input: {
  imageUrl: string
  productTitle?: string
  sourcePageUrl?: string
}): ProductTarget | null {
  let url: URL
  try {
    url = new URL(input.imageUrl)
  } catch {
    return null
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null
  const target: ProductTarget = { imageUrl: url.href, productTitle: (input.productTitle || "").slice(0, MAX_PRODUCT_TITLE_CHARS) }
  if (input.sourcePageUrl) target.sourcePageUrl = input.sourcePageUrl
  return target
}
