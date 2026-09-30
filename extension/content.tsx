// Content script: runs on every website. It draws the "AI fitting room" launcher and the floating
// window, and hosts the fitting room (tabs/room.html) inside that window as an iframe.
//
// Drags that start on the shop page are caught here, in the page's own frame, because the browser
// won't reliably hand a page drag to a cross-origin iframe. The image URL and product name are then
// posted to the fitting room.

import { useCallback, useEffect, useRef, useState } from "react"
import type { PlasmoCSConfig, PlasmoGetRootContainer } from "plasmo"
import styleText from "data-text:./style.css"
import { canonicalSourcePageUrl, nameFromFile, parseDrop } from "./lib/drop"
import { requestCapability } from "./lib/capability-client"
import { createHoverOverlay, isExtensionOwnedUi, OVERLAY_COPY, UI_ATTR, type HoverOverlay, type HoverTarget, type OverlayPill } from "./lib/hover-overlay"
import {
  bestImageUrl,
  buildProductTarget,
  isEligibleProductImage,
  productName,
  usefulText
} from "./lib/product-image"
import {
  createReplyWaiter,
  requestRemoteSave,
  type SavePhase
} from "./lib/wardrobe-save"

export const config: PlasmoCSConfig = { matches: ["http://*/*", "https://*/*"], all_frames: false, run_at: "document_idle" }

// Mount into <body> once the page has settled (load, or 8s for pages whose load event drags on).
// Inserting during load breaks sites that hydrate the whole document with React, and SPA re-renders
// such as Pinterest's can wipe foreign nodes, so the host re-attaches itself whenever it is removed.
export const getRootContainer: PlasmoGetRootContainer = async () => {
  const loaded = document.readyState === "complete" ? Promise.resolve() : new Promise(resolve => window.addEventListener("load", resolve, { once: true }))
  await Promise.race([loaded, new Promise(resolve => setTimeout(resolve, 8000))])
  await new Promise(resolve => setTimeout(resolve, 400))
  document.querySelectorAll("openwear-root").forEach(stale => stale.remove())
  const host = document.createElement("openwear-root")
  // Ownership marker: pointer events entering our Shadow DOM are retargeted to this host, so
  // it must be recognizable as extension UI or the pill hides itself before it can be clicked.
  host.setAttribute(UI_ATTR, "host")
  host.style.cssText = "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646;"
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = styleText
  const container = document.createElement("div")
  shadow.append(style, container)
  const attach = () => {
    if (host.isConnected || !(document.body || document.documentElement)) return
    ;(document.body || document.documentElement).append(host)
  }
  attach()
  // Observe the document itself so a replaced <html> or <body> is still noticed, with a slow poll as backup.
  new MutationObserver(attach).observe(document, { childList: true, subtree: true })
  setInterval(attach, 1000)
  return container
}

type Rect = { x: number; y: number; width: number; height: number }
type DraggedGarment = { url: string; name: string }

const ROOM_URL = chrome.runtime.getURL("tabs/room.html")
const ROOM_ORIGIN = new URL(ROOM_URL).origin
const HEADER = 52

function defaultRect(): Rect {
  const width = Math.min(520, window.innerWidth - 32)
  const height = Math.min(600, window.innerHeight - 48)
  return { x: window.innerWidth - width - 24, y: Math.max(16, (window.innerHeight - height) / 2), width, height }
}

function clampRect(rect: Rect): Rect {
  const width = Math.max(320, Math.min(rect.width, window.innerWidth - 16))
  const height = Math.max(380, Math.min(rect.height, window.innerHeight - 16))
  return { width, height, x: Math.max(8, Math.min(rect.x, window.innerWidth - width - 8)), y: Math.max(8, Math.min(rect.y, window.innerHeight - height - 8)) }
}

/** Best-effort product name for a dragged image: alt text, the nearest product-card title, then the page title. */
function draggedProductName(image: HTMLImageElement | null, link: HTMLAnchorElement | null) {
  return productName(image, link, document, (image?.getBoundingClientRect().width ?? 0) > 280)
}

/** The sharpest version of a dragged image, resolved against the page. */
function draggedImageUrl(image: HTMLImageElement) {
  return bestImageUrl(image, document.baseURI)
}

/** Contexts where contextual actions must never run: non-web pages and local dev UI. */
function isExcludedContext(): boolean {
  try {
    if (window.location.protocol !== "http:" && window.location.protocol !== "https:") return true
    const host = window.location.hostname.toLowerCase()
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  } catch {
    return true
  }
  return false
}

/**
 * Builds the one contextual pill inside the extension shadow root. Plain DOM (no React) so
 * hover tracking never re-renders the shell; implements the OverlayPill contract exactly.
 */
function buildContextualPill(
  shadow: ShadowRoot,
  actions: { onTryOn: () => void; onSave: () => void }
): OverlayPill {
  const pill = document.createElement("div")
  pill.className = "ow-contextual"
  pill.setAttribute("data-ow-ui", "contextual")
  pill.style.display = "none"
  const title = document.createElement("span")
  title.className = "ow-contextual-title"
  const tryOn = document.createElement("button")
  tryOn.type = "button"
  tryOn.className = "ow-contextual-btn"
  tryOn.textContent = OVERLAY_COPY.tryOn
  tryOn.setAttribute("aria-label", "Try on this product")
  tryOn.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); actions.onTryOn() })
  const save = document.createElement("button")
  save.type = "button"
  save.className = "ow-contextual-btn"
  save.textContent = OVERLAY_COPY.save
  save.setAttribute("aria-label", "Save this product to your wardrobe")
  save.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); actions.onSave() })
  pill.append(title, tryOn, save)
  shadow.appendChild(pill)
  const place = (rect: { x: number; y: number; width: number; height: number }) => {
    const width = pill.offsetWidth || 220
    const height = pill.offsetHeight || 44
    const left = Math.max(8, Math.min(rect.x, window.innerWidth - width - 8))
    const above = rect.y - height - 8
    pill.style.left = `${left}px`
    pill.style.top = `${(above >= 8 ? above : rect.y + rect.height + 8)}px`
  }
  return {
    get shown() { return pill.style.display !== "none" },
    show: (label: string) => { title.textContent = label; pill.style.display = "" },
    move: (rect) => place(rect),
    hide: () => { pill.style.display = "none" },
    setSaveState: (state, label: string) => {
      save.textContent = label
      save.disabled = state === "busy"
      if (state === "idle") save.removeAttribute("data-state")
      else save.setAttribute("data-state", state)
    },
    setTryOnEnabled: (enabled: boolean) => { tryOn.disabled = !enabled },
    destroy: () => pill.remove()
  }
}

function OpenWearShell() {
  const [open, setOpen] = useState(false)
  const [minimizedLauncher, setMinimizedLauncher] = useState(false)
  const [rect, setRect] = useState<Rect>(defaultRect)
  const [dragActive, setDragActive] = useState(false)
  const [moving, setMoving] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const draggedRef = useRef<DraggedGarment | null>(null)
  // A docked (never dragged/resized) room hugs the right edge, so a viewport change
  // re-anchors it there instead of stranding it mid-canvas over page content.
  const dockedRef = useRef(true)
  const openRef = useRef(open)
  openRef.current = open
  // ---------- Contextual shopping actions (Step 3B) ----------
  const [actionsEnabled, setActionsEnabled] = useState(true)
  const actionsEnabledRef = useRef(true)
  actionsEnabledRef.current = actionsEnabled
  const overlayRef = useRef<HoverOverlay | null>(null)
  const pillRef = useRef<OverlayPill | null>(null)
  const lastHoverImgRef = useRef<HTMLImageElement | null>(null)
  const pointerPosRef = useRef<{ x: number; y: number } | null>(null)
  const roomReadyRef = useRef(false)
  const pendingTryOnRef = useRef<{ file?: Blob; url?: string; name?: string; sourcePageUrl?: string; capability: string } | null>(null)
  const pendingSaveRef = useRef<{ targetKey: string; clientImportId: string } | null>(null)
  const readyWaiterRef = useRef(createReplyWaiter<boolean>())
  const saveWaiterRef = useRef(createReplyWaiter<SavePhase | "signed_out" | "timeout">())
  const domObserverRef = useRef<MutationObserver | null>(null)

  const postToRoom = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(message, ROOM_ORIGIN)
  }, [])

  /**
   * Forwards one garment to the room with a one-time garment capability. The room consumes the
   * capability before acting, so a hostile page forging the message shape gets nothing: shape
   * alone never authorizes. Posts immediately when the room listens, else queues for the
   * ready handshake after opening it.
   */
  const forwardGarment = useCallback(async (base: { file?: Blob; url?: string; name?: string; sourcePageUrl?: string }) => {
    let capability: string
    try {
      capability = await requestCapability("garment")
    } catch {
      return
    }
    const message = { type: "openwear:garment", ...base, capability }
    if (openRef.current && roomReadyRef.current) {
      postToRoom(message)
      return
    }
    pendingTryOnRef.current = message
    setOpen(true)
  }, [postToRoom])

  /** Try on: behaves exactly like a dragged garment — no auth, camera, or mint involved. */
  const sendTryOn = useCallback((target: HoverTarget) => {
    void forwardGarment({
      url: target.imageUrl,
      name: target.productTitle,
      ...(target.sourcePageUrl ? { sourcePageUrl: target.sourcePageUrl } : {})
    })
  }, [forwardGarment])

  /** Save: authenticated room-side save through the Step 3A pipeline, with overlay feedback. */
  const sendSave = useCallback(async (target: HoverTarget) => {
    const pill = pillRef.current
    const reused = pendingSaveRef.current?.targetKey === target.key
      ? pendingSaveRef.current.clientImportId
      : undefined
    const clientImportId = reused ?? crypto.randomUUID()
    pendingSaveRef.current = { targetKey: target.key, clientImportId }
    pill?.setSaveState("busy", OVERLAY_COPY.saving)
    const { phase } = await requestRemoteSave(
      {
        openRoom: () => { if (!openRef.current) setOpen(true) },
        postToRoom,
        // Ping rather than wait passively: the room only announces readiness on mount, and by
        // the time a save starts the room is usually already open, so an unsolicited reply
        // would never come. The waiter is registered first so a fast reply cannot be missed.
        awaitRoomReady: (timeoutMs) => {
          const ready = readyWaiterRef.current.wait("ready", timeoutMs ?? 5000, false)
          postToRoom({ type: "openwear:room-ping" })
          return ready
        },
        issueToken: () => requestCapability("save"),
        awaitSaveStatus: (id, timeoutMs) => saveWaiterRef.current.wait(id, timeoutMs ?? 150000, "timeout")
      },
      {
        imageUrl: target.imageUrl,
        ...(target.productTitle ? { productTitle: target.productTitle } : {}),
        ...(target.sourcePageUrl ? { sourcePageUrl: target.sourcePageUrl } : {})
      },
      clientImportId
    )
    // A retargeted overlay owns newer UI; stale completions stay silent.
    if (pendingSaveRef.current?.clientImportId !== clientImportId) return
    // The pill may have retargeted to another product while this save was in flight
    // (hover resets it to idle but starts no save, so the id above still matches).
    // Painting "Saved" onto a different product's pill would be a lie: stay silent.
    if (overlayRef.current?.current && overlayRef.current.current.key !== target.key) return
    const live = pillRef.current
    if (!live) return
    if (phase === "ready") live.setSaveState("done", OVERLAY_COPY.saved)
    else if (phase === "needs_credits") live.setSaveState("error", OVERLAY_COPY.needsCredit)
    else if (phase === "no_item") live.setSaveState("error", OVERLAY_COPY.noTarget)
    else if (phase === "signed_out") live.setSaveState("error", OVERLAY_COPY.signIn)
    else live.setSaveState("error", OVERLAY_COPY.tryAgain)
  }, [postToRoom])

  // Messages to the fitting room are addressed to the extension origin, so no other frame can read them.
  const toRoom = (message: Record<string, unknown>) => frameRef.current?.contentWindow?.postMessage(message, ROOM_ORIGIN)

  // The toolbar popup opens the room by messaging this script.
  useEffect(() => {
    const listener = (message: { type?: string }, _sender: chrome.runtime.MessageSender, sendResponse: (response: { ok: boolean }) => void) => {
      if (message.type === "openwear:open") { setMinimizedLauncher(false); setOpen(true) }
      if (message.type?.startsWith("openwear:")) sendResponse({ ok: true })
    }
    chrome.runtime.onMessage.addListener(listener)
    const onResize = () => setRect(current => dockedRef.current ? defaultRect() : clampRect(current))
    window.addEventListener("resize", onResize)
    return () => { chrome.runtime.onMessage.removeListener(listener); window.removeEventListener("resize", onResize) }
  }, [])

  // Record what is being dragged on the page so the drop target can forward a clean image URL and name.
  useEffect(() => {
    const onDragStart = (event: DragEvent) => {
      if (!openRef.current) return
      const path = event.composedPath()
      const target = event.target as Element | null
      const link = (path.find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined) || null
      const image = (path.find(node => node instanceof HTMLImageElement) as HTMLImageElement | undefined)
        || (target instanceof Element ? target.querySelector("img") : null)
      const url = (image && draggedImageUrl(image)) || link?.href || ""
      draggedRef.current = /^https?:\/\//.test(url) ? { url, name: draggedProductName(image || null, link) } : null
      setDragActive(true)
      toRoom({ type: "openwear:drag", active: true })
    }
    const onDragEnd = () => { setDragActive(false); toRoom({ type: "openwear:drag", active: false }) }
    document.addEventListener("dragstart", onDragStart, true)
    document.addEventListener("dragend", onDragEnd, true)
    return () => { document.removeEventListener("dragstart", onDragStart, true); document.removeEventListener("dragend", onDragEnd, true) }
  }, [])

  // A transparent layer over the iframe during page drags, so the drop lands in this frame.
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setDragActive(false)
    toRoom({ type: "openwear:drag", active: false })
    const file = [...event.dataTransfer.files].find(item => item.type.startsWith("image/"))
    if (file) { void forwardGarment({ file, name: nameFromFile(file) }); return }
    // Prefer what dragstart recorded (sharpest image URL + product name), else read the drop data.
    const dragged = draggedRef.current
    draggedRef.current = null
    const incoming = dragged || parseDrop(event.dataTransfer)
    // Page provenance only: the canonical address, never cookies, storage, HTML or headers.
    const sourcePageUrl = canonicalSourcePageUrl(window.location.href)
    if (incoming?.url) void forwardGarment({ url: incoming.url, name: usefulText(incoming.name), ...(sourcePageUrl ? { sourcePageUrl } : {}) })
  }

  // ---------- Contextual shopping actions (Step 3B) ----------

  // Local-only preference: hiding the hover buttons never affects billing or auth.
  useEffect(() => {
    chrome.storage.local.get("shoppingActionsEnabled")
      .then(value => setActionsEnabled(value.shoppingActionsEnabled !== false))
      .catch(() => {})
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ("shoppingActionsEnabled" in changes) setActionsEnabled(changes.shoppingActionsEnabled.newValue !== false)
    }
    chrome.storage.onChanged.addListener(onStorage)
    return () => chrome.storage.onChanged.removeListener(onStorage)
  }, [])

  // Room replies (ready ping + save statuses) come from our iframe only.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (event.origin !== ROOM_ORIGIN) return
      const data = event.data
      if (!data || typeof data !== "object") return
      if (data.type === "openwear:room-ready") {
        roomReadyRef.current = true
        readyWaiterRef.current.resolve("ready", true)
        const pending = pendingTryOnRef.current
        if (pending) {
          pendingTryOnRef.current = null
          postToRoom({ type: "openwear:garment", ...pending })
        }
      }
      if (data.type === "openwear:save-status" && typeof data.clientImportId === "string") {
        saveWaiterRef.current.resolve(data.clientImportId, data.phase)
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [postToRoom])

  useEffect(() => {
    if (!open) roomReadyRef.current = false
  }, [open ])

  // Track the pointer even while the overlay is disabled: re-arming needs to re-probe the
  // element under a stationary cursor (a toggle lands with the mouse already parked).
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      pointerPosRef.current = { x: event.clientX, y: event.clientY }
    }
    window.addEventListener("pointermove", onPointerMove, { passive: true })
    return () => window.removeEventListener("pointermove", onPointerMove)
  }, [])

  useEffect(() => {
    if (!actionsEnabled) {
      overlayRef.current?.teardown()
      overlayRef.current = null
      pillRef.current = null
      lastHoverImgRef.current = null
      return
    }
    const shadow = document.querySelector("openwear-root")?.shadowRoot
    if (!shadow) return
    const overlay = createHoverOverlay({
      createPill: (actions) => {
        const pill = buildContextualPill(shadow, actions)
        pillRef.current = pill
        return pill
      },
      requestFrame: (callback) => requestAnimationFrame(callback),
      onTryOn: (target) => void sendTryOn(target),
      onSave: (target) => void sendSave(target),
      // The document observer runs only while the pill is visible, childList only.
      onVisibility: (visible) => {
        if (visible) {
          if (!domObserverRef.current) {
            domObserverRef.current = new MutationObserver(() => refreshParked())
          }
          domObserverRef.current.observe(document, { childList: true, subtree: true })
        } else {
          domObserverRef.current?.disconnect()
        }
      }
    })
    overlayRef.current = overlay

    const findTarget = (img: HTMLImageElement) => {
      const rect = img.getBoundingClientRect()
      const visible =
        rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth
      const src = draggedImageUrl(img)
      const anchor = img.closest("a")
      const extensionOwned =
        src.startsWith("chrome-extension://") || !!img.closest("openwear-root")
      const signals = {
        width: rect.width,
        height: rect.height,
        visible,
        src,
        alt: img.alt,
        title: img.getAttribute("title"),
        extensionOwned
      }
      if (!isEligibleProductImage(signals)) return null
      const title = draggedProductName(img, anchor)
      const pageUrl = canonicalSourcePageUrl(window.location.href)
      const built = buildProductTarget({
        imageUrl: src,
        productTitle: title,
        ...(pageUrl ? { sourcePageUrl: pageUrl } : {})
      })
      if (!built) return null
      return {
        key: built.imageUrl,
        imageUrl: built.imageUrl,
        productTitle: built.productTitle,
        ...(built.sourcePageUrl ? { sourcePageUrl: built.sourcePageUrl } : {}),
        rect: () => {
          const r = img.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        },
        alive: () => img.isConnected
      }
    }

    // A DOM change while the pill is visible (SPA swap, hydration, lazy load) can replace the
    // anchored image under a stationary cursor: no pointerover fires, so re-probe the parked
    // point and retarget if a different eligible product now sits there.
    const refreshParked = () => {
      const parked = pointerPosRef.current
      if (!parked) {
        overlayRef.current?.reposition()
        return
      }
      const under = document.elementFromPoint(parked.x, parked.y)
      if (!(under instanceof HTMLImageElement) || !under.isConnected) {
        overlayRef.current?.reposition()
        return
      }
      const current = overlayRef.current?.current
      if (current && !current.alive()) {
        // The anchored node died (SPA swap replaced it). Same-key dedupe would swallow a
        // retarget on the replacement, so clear the overlay first, then re-probe.
        overlayRef.current?.hide()
        lastHoverImgRef.current = under
        const target = findTarget(under)
        if (target) overlayRef.current?.hover(target)
        return
      }
      if (under === lastHoverImgRef.current) {
        overlayRef.current?.reposition()
        return
      }
      lastHoverImgRef.current = under
      overlayRef.current?.hover(findTarget(under))
    }

    // One delegated listener: per-image listeners are forbidden (thousands of images per page).
    const onPointerOver = (event: PointerEvent) => {
      if (!actionsEnabledRef.current || isExcludedContext()) return
      const path = typeof event.composedPath === "function" ? event.composedPath() : []
      if (path.some(node => node instanceof HTMLElement && (node.tagName === "OPENWEAR-ROOT" || node.hasAttribute?.("data-ow-ui")))) return
      const fromPath = path.find((node): node is HTMLImageElement => node instanceof HTMLImageElement)
      const target = event.target
      const img = fromPath ?? (target instanceof Element ? target.closest?.("img") : null)
      if (!img || !(img instanceof HTMLImageElement)) return
      if (img === lastHoverImgRef.current) return
      lastHoverImgRef.current = img
      overlayRef.current?.hover(findTarget(img))
    }
    // Hide only when leaving the image somewhere other than our own pill: no flicker on gaps.
    const onPointerOut = (event: PointerEvent) => {
      const img = lastHoverImgRef.current
      if (!img || event.target !== img) return
      const related = event.relatedTarget
      if (isExtensionOwnedUi(related)) return
      lastHoverImgRef.current = null
      overlayRef.current?.hide()
    }
    const onScrollResize = () => overlayRef.current?.reposition()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && overlayRef.current?.current) {
        lastHoverImgRef.current = null
        overlayRef.current.hide()
      }
    }
    document.addEventListener("pointerover", onPointerOver)
    document.addEventListener("pointerout", onPointerOut)
    window.addEventListener("scroll", onScrollResize, { passive: true, capture: true })
    window.addEventListener("resize", onScrollResize)
    document.addEventListener("keydown", onKeyDown)
    // Re-armed (toggle flipped back on, or first enable): if the cursor is already parked on
    // a product, no new pointerover will fire, so probe the element under it directly.
    const parked = pointerPosRef.current
    if (parked) {
      const under = document.elementFromPoint(parked.x, parked.y)
      if (under instanceof HTMLImageElement) {
        lastHoverImgRef.current = under
        overlayRef.current?.hover(findTarget(under))
      }
    }
    return () => {
      document.removeEventListener("pointerover", onPointerOver)
      document.removeEventListener("pointerout", onPointerOut)
      window.removeEventListener("scroll", onScrollResize, { capture: true })
      window.removeEventListener("resize", onScrollResize)
      document.removeEventListener("keydown", onKeyDown)
      domObserverRef.current?.disconnect()
      overlayRef.current?.teardown()
      overlayRef.current = null
      pillRef.current = null
      lastHoverImgRef.current = null
    }
  }, [actionsEnabled, sendTryOn, sendSave])

  // Drag the window by its header; resize from the bottom-left corner (the window hugs the right edge).
  const startMove = (event: React.PointerEvent) => {
    if ((event.target as Element).closest("button")) return
    event.preventDefault()
    const startX = event.clientX, startY = event.clientY, origin = rect
    setMoving(true)
    dockedRef.current = false
    const move = (next: PointerEvent) => setRect(clampRect({ ...origin, x: origin.x + next.clientX - startX, y: origin.y + next.clientY - startY }))
    const end = () => { setMoving(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end) }
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end)
  }

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX, startY = event.clientY, origin = rect
    setMoving(true)
    dockedRef.current = false
    const move = (next: PointerEvent) => setRect(clampRect({ ...origin, x: origin.x + (next.clientX - startX), width: origin.width - (next.clientX - startX), height: origin.height + next.clientY - startY }))
    const end = () => { setMoving(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end) }
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end)
  }

  return <div className="ow-root">
    {!open && !minimizedLauncher && <div className="ow-launcher">
      <button className="ow-launcher-main" onClick={() => setOpen(true)} aria-label="Open AI fitting room">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13" r="3.5" /></svg>
        <span>AI fitting room</span>
      </button>
      <button className="ow-launcher-close" onClick={() => setMinimizedLauncher(true)} aria-label="Hide fitting-room button">×</button>
    </div>}

    {open && <section className={`ow-window ${moving ? "is-moving" : ""}`} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} aria-label="OpenWear fitting room">
      <header className="ow-header" onPointerDown={startMove}>
        <strong>Try-On <span aria-hidden="true">✦</span> OpenWear</strong>
        <button onClick={() => setOpen(false)} title="Close fitting room" aria-label="Close fitting room">−</button>
      </header>
      <div className="ow-body" style={{ height: rect.height - HEADER }}>
        <iframe ref={frameRef} src={ROOM_URL} allow="camera; autoplay; clipboard-write" title="OpenWear fitting room" />
        {dragActive && <div className="ow-drop-catcher" onDragEnter={e => e.preventDefault()} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy" }} onDrop={onDrop} />}
      </div>
      <div className="ow-resize" onPointerDown={startResize} title="Drag to resize" />
    </section>}
  </div>
}

export default OpenWearShell
