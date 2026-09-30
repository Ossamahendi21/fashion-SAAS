// One-time capability issuance, executed only in the background service worker.
//
// `chrome.storage.session` is exposed to trusted extension contexts only, so a content
// script cannot mint into it (it fails closed with "Access to storage is not allowed from
// this context"). The content script therefore *asks* the worker, which mints the token
// and returns the opaque string. Two invariants hold by construction:
//
//   - storage.session's access level is never widened; the untrusted side never reads or
//     writes the store and never learns anything but the single token it just asked for.
//   - the untrusted side can never self-validate: only the room (a trusted extension page)
//     consumes tokens, and consumption is what authorises the garment handoff or the save.
//
// Issuance is deliberately a separate message case from the image-download path, which
// keeps its own stricter "extension pages only" gate.

import { issueCapability, type CapabilityKind, type TokenStore } from "./wardrobe-save"

export const ISSUE_CAPABILITY_MESSAGE = "openwear:issue-capability"

export type { CapabilityKind }

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return value === "save" || value === "garment"
}

/** The subset of `chrome.runtime.MessageSender` this gate inspects. */
export type CapabilitySender = {
  id?: string
  url?: string
  tab?: { id?: number } | null
  frameId?: number
}

export type IssueCapabilityDeps = {
  store: TokenStore
  runtimeId: string
  createId?: () => string
}

/**
 * True only for this extension's own top-frame content script.
 *
 * Rejected: any other extension (`id` mismatch), our own room page (extension:// url, no
 * web tab), a sub-frame, and external web pages — an external message never carries a
 * sender whose `id` is ours in the first place, so this fails closed by default.
 */
export function isOwnContentScript(sender: CapabilitySender | undefined | null, runtimeId: string): boolean {
  if (!sender || sender.id !== runtimeId) return false
  if (typeof sender.url !== "string" || sender.url.length > 8192) return false
  if (!sender.tab || typeof sender.tab.id !== "number") return false
  if (sender.frameId !== 0) return false
  let protocol: string
  try {
    protocol = new URL(sender.url).protocol
  } catch {
    return false
  }
  return protocol === "http:" || protocol === "https:"
}

export type IssueCapabilityResponse = { ok: true; token: string } | { ok: false; error: string }

/**
 * Handles one capability request. The response carries the opaque token and nothing else:
 * no storage contents, no other tokens, no identity, no JWT or Clerk data.
 */
export async function handleIssueCapability(
  message: unknown,
  sender: CapabilitySender | undefined | null,
  deps: IssueCapabilityDeps
): Promise<IssueCapabilityResponse> {
  const request = message as { type?: unknown; kind?: unknown } | null | undefined
  if (request?.type !== ISSUE_CAPABILITY_MESSAGE) return { ok: false, error: "Unknown OpenWear request" }
  if (!isOwnContentScript(sender, deps.runtimeId)) {
    return { ok: false, error: "Capability requests are limited to OpenWear's own content script" }
  }
  if (!isCapabilityKind(request.kind)) return { ok: false, error: "Unknown capability kind" }
  try {
    const token = await issueCapability(deps.store, request.kind, deps.createId)
    return { ok: true, token }
  } catch {
    return { ok: false, error: "Capability could not be issued" }
  }
}
