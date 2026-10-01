// Parent-origin gate for the fitting room iframe (Original Step 3, Requirement B).
//
// The room is embedded in arbitrary shop pages, so any window that holds its iframe
// reference can drive its postMessage namespace. The gate makes that fail-closed:
// a message is only processed once the parent origin has been ESTABLISHED and ONLY when
// `event.origin` — which the browser always sets from the posting document's REAL origin
// and which message content can never spoof — matches it exactly. Before establishment
// nothing is accepted except the `openwear:origin` handshake; a malformed handshake
// never arms the gate.
//
// Where the expected parent origin comes from (documented, never raw):
//   - The handshake claims `location.origin` of the embedding page. It is carried in
//     message DATA, so it is never trusted on its own: it is only stored when the
//     browser-asserted `event.origin` equals the claim, which the page cannot fake.
//   - The page always can establish its own origin (it posts as `window.parent` and
//     shares that origin with the content script). That is inherent and fine: origin
//     gating filters CROSS-origin actors, while page-vs-content discrimination stays
//     with one-time capabilities stored outside the page (chrome.storage.session).
//   - A page that arms a WRONG origin slows nothing to a leak: every later message is
//     then rejected by the exact-match (fail-closed DoS worst case, no exfiltration),
//     and outgoing postMessage targets its own claimed origin.
//
// The guard is a pure core so node unit tests drive the whole matrix without a browser.

/** A valid target-origin fragment for window.postMessage (the origin, or "*"). */
export type PostTarget = string

export type OriginGuardCore = {
  /** Established, browser-verified parent origin, or null before/if never established. */
  origin: string | null
  ready: () => boolean
  /** True only once armed: accepts events whose origin matches exactly. */
  accept: (eventOrigin: string) => boolean
  /** Outgoing postMessage targetOrigin: established origin once armed, "*" until then. */
  targetOrigin: () => PostTarget
  /**
   * openwear:origin handshake. Stores `claimedOrigin` only when it equals the browser
   * `eventOrigin` and both are http(s). Never arms on anything malformed, and a later
   * verified handshake may re-arm after the parent navigated to a new origin.
   */
  establish: (eventOrigin: string, claimedOrigin: unknown) => boolean
}

export function isHttpOrigin(origin: string): boolean {
  return /^https?:\/\//.test(origin)
}

export function createOriginGuardCore(): OriginGuardCore {
  let expected: string | null = null
  const self: OriginGuardCore = {
    get origin() {
      return expected
    },
    ready: () => expected !== null,
    accept: (eventOrigin: string) => expected !== null && eventOrigin === expected,
    targetOrigin: () => expected ?? "*",
    establish: (eventOrigin: string, claimedOrigin: unknown) => {
      if (typeof claimedOrigin !== "string" || claimedOrigin.length === 0) return false
      if (!isHttpOrigin(eventOrigin) || eventOrigin !== claimedOrigin) return false
      expected = claimedOrigin
      return true
    }
  }
  return self
}

/** Room-side source check: the browser's window.parent for the embedding frame. */
export function fromParent(source: unknown, parentWindow: unknown): boolean {
  return typeof source === "object" && source !== null && source === parentWindow
}