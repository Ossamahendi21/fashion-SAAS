// Turns whatever the user dropped (a file, a dragged web image, or an image link) into something the
// fitting room can load. Used by both the page script (drags from the shop page) and the fitting room
// itself (files dragged in from the desktop).

export type Incoming = { file?: Blob; url?: string; name?: string; sourcePageUrl?: string }

/** "slim-straight_jeans.jpg" → "slim straight jeans" */
export function nameFromFile(file: File) {
  return file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ")
}

export function parseDrop(transfer: DataTransfer): Incoming | null {
  const file = [...transfer.files].find(item => item.type.startsWith("image/"))
  if (file) return { file, name: nameFromFile(file) }
  // Dragged web images carry HTML (<img src alt>); dragged links carry a URL list or plain text.
  const html = transfer.getData("text/html")
  const image = html ? new DOMParser().parseFromString(html, "text/html").querySelector("img") : null
  const source = image?.getAttribute("src") || image?.getAttribute("data-src")
  const uri = transfer.getData("text/uri-list").split("\n").find(line => line && !line.startsWith("#")) || transfer.getData("text/plain")
  const url = [source, uri].map(value => value?.trim()).find(value => value && /^https?:\/\//.test(value))
  return url ? { url, name: image?.getAttribute("alt") || "" } : null
}

/**
 * Canonical same-page provenance for a dragged garment: the current http(s) page URL with the
 * fragment stripped and credentials rejected, capped before the server persists it. Obviously
 * local/private hosts carry no useful provenance and are dropped, mirroring the server's own
 * sanitizer. Sends no cookies, storage, HTML, or headers — just the address the user was
 * looking at. Local file uploads carry no page URL.
 */
export function canonicalSourcePageUrl(href: string): string | undefined {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (url.username || url.password) return undefined
  const host = url.hostname.toLowerCase()
  if (
    host === "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":")
  ) {
    return undefined
  }
  url.hash = ""
  const canonical = url.href
  return canonical.length > 0 && canonical.length <= 2048 ? canonical : undefined
}
