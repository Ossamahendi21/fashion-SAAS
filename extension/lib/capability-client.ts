// Content-script side of capability issuance.
//
// The content script is untrusted: it may not read or write `chrome.storage.session` (the
// API is not exposed to content scripts at all) and must not know storage keys or be able
// to enumerate or inspect other tokens. It only asks the background worker for one opaque
// token of a named scope and forwards it to the room, which validates it in a trusted
// context before doing anything.

import { ISSUE_CAPABILITY_MESSAGE, type CapabilityKind } from "./capability-service"

/** Requests a one-time capability from the service worker. Throws when issuance is refused. */
export async function requestCapability(kind: CapabilityKind): Promise<string> {
  const response = (await chrome.runtime.sendMessage({ type: ISSUE_CAPABILITY_MESSAGE, kind })) as
    | { ok?: unknown; token?: unknown }
    | undefined
  if (!response || response.ok !== true || typeof response.token !== "string" || response.token.length === 0) {
    throw new Error("Capability could not be issued")
  }
  return response.token
}
