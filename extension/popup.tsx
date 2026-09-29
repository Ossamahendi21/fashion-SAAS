// Toolbar popup: opens the fitting room on the current tab. The extension is a Fitcheck SaaS
// companion: without public Clerk/Convex configuration it fails closed with a setup error.
// There is no provider-key setup anymore — Step 2E3 removed the browser-stored Decart
// credential completely.

import { useClerk, useUser } from "@clerk/chrome-extension"
import { useConvex } from "convex/react"
import { useEffect, useState } from "react"
import { getAuthConfig, fitcheckSignInUrl, isAuthConfigured } from "./lib/auth-config"
import { ExtensionAuthProvider, useExtensionAuthStatus } from "./lib/auth-provider"
import { liveMirrorStatus, quotaStatusCopy } from "./lib/live-mirror"
import "./popup.css"

/** Minimal Clerk state: loading / signed out (with web sign-in link) / signed in + Convex. */
function AuthSection() {
  const status = useExtensionAuthStatus()
  const { user } = useUser()
  const { signOut } = useClerk()
  if (status.state === "loading") return <p className="popup-hint">Checking Fitcheck sign-in…</p>
  if (status.state === "signed-out") {
    return <>
      <p className="popup-hint">Not signed in. Sign in on the Fitcheck web app and the extension picks it up automatically.</p>
      <button className="popup-action secondary" onClick={() => void chrome.tabs.create({ url: fitcheckSignInUrl(getAuthConfig()) })}><span>Sign in on Fitcheck</span></button>
    </>
  }
  const identity = user?.primaryEmailAddress?.emailAddress || user?.username || user?.firstName || "Signed in"
  return <>
    <p className="popup-hint">Signed in as {identity} · Convex {status.convexAuthenticated ? "connected" : "connecting…"}</p>
    <button className="popup-action secondary" onClick={() => void signOut()}><span>Sign out</span></button>
  </>
}

/** Informational allowance line. Read-only query: never mints, never decides. */
function AllowanceLine() {
  const convex = useConvex()
  const status = useExtensionAuthStatus()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (status.state !== "signed-in" || !status.convexAuthenticated) {
      setText(null)
      return
    }
    let cancelled = false
    convex.query(liveMirrorStatus, {})
      .then(value => { if (!cancelled) setText(quotaStatusCopy(value)) })
      .catch(() => { if (!cancelled) setText(null) })
    return () => { cancelled = true }
  }, [convex, status])
  if (!text) return null
  return <p className="popup-hint">{text}</p>
}

/** Asks the tab's content script to open the room, injecting the script first if the tab
 *  was open before the extension was installed or reloaded. */
async function openFittingRoom() {
  const type = "openwear:open"
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) throw Error("Open a normal shopping page first.")
  try {
    await chrome.tabs.sendMessage(tab.id, { type })
  } catch {
    const script = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0]
    if (!script) throw Error("Extension content script is missing. Reload the extension.")
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [script] })
      let sent = false
      for (let attempt = 0; attempt < 5; attempt++) {
        try { await chrome.tabs.sendMessage(tab.id, { type }); sent = true; break }
        catch { await new Promise(resolve => setTimeout(resolve, 80)) }
      }
      if (!sent) throw Error("Refresh this page and try again.")
    } catch (error: any) {
      throw Error(error.message?.includes("Cannot access") ? "This browser page does not allow extensions. Open a shopping page." : error.message || "Could not open the fitting room.")
    }
  }
}

/** Fails closed when the Fitcheck connection is not configured. Never exposes env values. */
function SetupError() {
  let detail = ""
  try {
    getAuthConfig()
  } catch (error) {
    detail = error instanceof Error ? error.message : ""
  }
  return <main className="popup">
    <div className="eyebrow">VIRTUAL TRY-ON ·<br /> OPENWEAR</div>
    <p className="popup-hint">The fitting room is not set up yet. Ask your Fitcheck administrator to configure the extension.</p>
    {detail && <p className="popup-hint">{detail}</p>}
  </main>
}

function Popup() {
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const open = async () => {
    if (busy) return
    setBusy(true); setError("")
    try { await openFittingRoom(); window.close() }
    catch (error: any) { setError(error.message || "Could not reach this page") }
    finally { setBusy(false) }
  }
  return <main className="popup">
    <div className="eyebrow">VIRTUAL TRY-ON ·<br /> OPENWEAR</div>
    <button className="popup-action primary" disabled={busy} onClick={() => void open()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/></svg>
      <span>Open fitting room</span>
    </button>
    <button className="popup-action secondary" onClick={() => chrome.runtime.openOptionsPage()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></svg>
      <span>Settings</span>
    </button>
    <p className="popup-hint">Open a shopping page, then drag any product photo in.</p>
    {error && <p role="alert" className="popup-error">{error}</p>}
    <AuthSection />
    <AllowanceLine />
  </main>
}

export default function PopupRoot() {
  if (!isAuthConfigured()) return <SetupError />
  return <ExtensionAuthProvider><Popup /></ExtensionAuthProvider>
}
