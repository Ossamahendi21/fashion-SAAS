// Settings page: local auto-freeze preference only.
//
// Step 2E3 removed the Decart API key input, key verification, and Fast Mode completely.
// The remaining setting is an optional local convenience: end live processing early and keep
// a frozen preview. It can only SHORTEN a session — the server grant always wins — and has
// no billing effect. 0 means "no early freeze, use the server limit".

import { useEffect, useState } from "react"
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./lib/settings"
import "./options.css"

const AUTO_FREEZE_OPTIONS = [
  { value: 0, label: "Server limit (no early freeze)" },
  { value: 15, label: "15 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 45, label: "45 seconds" },
  { value: 60, label: "60 seconds" },
]

export default function Options() {
  const [autoFreezeSeconds, setAutoFreezeSeconds] = useState(DEFAULT_SETTINGS.autoFreezeSeconds)
  const [saved, setSaved] = useState(false)

  useEffect(() => { loadSettings().then(value => setAutoFreezeSeconds(value.autoFreezeSeconds)).catch(() => {}) }, [])

  const update = async (value: number) => {
    setAutoFreezeSeconds(value)
    setSaved(false)
    await saveSettings({ autoFreezeSeconds: value })
    setSaved(true)
  }

  return <main className="options">
    <span className="kicker">OPENWEAR · SETTINGS</span>
    <h1>Your fitting room</h1>
    <p className="lede">Live sessions are authorized by your Fitcheck account. This page holds an optional local preference only.</p>

    <section className="card">
      <label className="select">Auto-freeze live session after
        <select value={autoFreezeSeconds} onChange={event => void update(Number(event.target.value))}>
          {AUTO_FREEZE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <p className="hint">Ends live processing early and keeps a frozen preview you can inspect for as long as you like. The server session limit always wins, and this never changes your monthly sessions.</p>
      {saved && <p className="status ok" role="status">Saved.</p>}
    </section>
  </main>
}
