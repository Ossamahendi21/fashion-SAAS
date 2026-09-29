// Contextual hover overlay controller for shopping images.
//
// One compact pill ("Try on" / "Save") follows the hovered product image. Framework-free and
// DOM-agnostic: the content script supplies a pill implementation and a frame scheduler, so
// every behavior below is unit-testable with fakes — singleton overlay, retargeting,
// repositioning, detach handling, and teardown. Performance rules live here by construction:
// no per-image listeners (the page uses one delegated pointer handler), no DOM scans on
// pointer movement (targets arrive pre-resolved), and reposition work is rAF-throttled.

export type OverlayRect = { x: number; y: number; width: number; height: number }

/** A product image the pill is currently anchored to. */
export type HoverTarget = {
  /** Stable identity for one image (its resolved URL): retargeting compares keys. */
  key: string
  imageUrl: string
  productTitle: string
  sourcePageUrl?: string
  /** Current viewport rect, or null when it cannot be measured. */
  rect: () => OverlayRect | null
  /** False once the underlying node left the document. */
  alive: () => boolean
}

export type SavePillState = "idle" | "busy" | "done" | "error"

/** The single pill element. The content script builds the real DOM version of this contract. */
export type OverlayPill = {
  show: (title: string) => void
  move: (rect: OverlayRect) => void
  hide: () => void
  setSaveState: (state: SavePillState, label: string) => void
  setTryOnEnabled: (enabled: boolean) => void
  destroy: () => void
  readonly shown: boolean
}

export type HoverOverlayDeps = {
  createPill: (actions: { onTryOn: () => void; onSave: () => void }) => OverlayPill
  requestFrame: (callback: () => void) => void
  onTryOn: (target: HoverTarget) => void
  onSave: (target: HoverTarget) => void
  /** Fires on show/hide transitions so the page can scope observers to visible time only. */
  onVisibility?: (visible: boolean) => void
}

/** Compact pill copy. No provider, Convex, or storage names ever reach the page. */
export const OVERLAY_COPY = {
  tryOn: "Try on",
  save: "Save",
  saving: "Saving…",
  saved: "Saved ✓",
  needsCredit: "Needs 1 credit",
  noTarget: "Couldn't identify",
  tryAgain: "Try again",
  signIn: "Sign in to save",
  untitled: "This product"
} as const

export function createHoverOverlay(deps: HoverOverlayDeps) {
  let pill: OverlayPill | null = null
  let current: HoverTarget | null = null
  let frameQueued = false

  function ensurePill(): OverlayPill {
    if (!pill) {
      pill = deps.createPill({
        onTryOn: () => { if (current) deps.onTryOn(current) },
        onSave: () => { if (current) deps.onSave(current) }
      })
    }
    return pill
  }

  function hide() {
    pill?.hide()
    current = null
    deps.onVisibility?.(false)
  }

  /**
   * A new hover target (or null when leaving product imagery). Same-key hovers are no-ops;
   * a different key retargets the one pill and resets its save state for the new product.
   */
  function hover(target: HoverTarget | null) {
    if (!target) {
      hide()
      return
    }
    if (current && current.key === target.key) return
    current = target
    const anchored = ensurePill()
    anchored.show(target.productTitle || OVERLAY_COPY.untitled)
    anchored.setSaveState("idle", OVERLAY_COPY.save)
    anchored.setTryOnEnabled(true)
    deps.onVisibility?.(true)
    const rect = target.alive() ? target.rect() : null
    if (!rect) {
      hide()
      return
    }
    anchored.move(rect)
  }

  /**
   * Re-read the anchor position (scroll, resize, layout shift). rAF-throttled so rapid scroll
   * events collapse into one measurement; a detached or unmeasurable target removes the pill.
   */
  function reposition() {
    if (!current || frameQueued) return
    frameQueued = true
    deps.requestFrame(() => {
      frameQueued = false
      const target = current
      if (!target) return
      const rect = target.alive() ? target.rect() : null
      if (!rect) {
        hide()
        return
      }
      pill?.move(rect)
    })
  }

  /** Removes the pill and drops all references. Safe to call repeatedly. */
  function teardown() {
    hide()
    if (pill) {
      pill.destroy()
      pill = null
    }
  }

  return {
    hover,
    hide,
    reposition,
    teardown,
    get current() {
      return current
    }
  }
}

export type HoverOverlay = ReturnType<typeof createHoverOverlay>
