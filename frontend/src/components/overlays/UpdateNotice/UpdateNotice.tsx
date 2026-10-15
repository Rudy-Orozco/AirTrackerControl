import { useEffect, useState } from 'react'
import { desktop, type UpdateStatus } from '../../../services/desktop'
import './UpdateNotice.css'

/**
 * A small notice at the top of the screen about a new version (desktop app
 * only): as soon as one is found (at startup or later) while it downloads, then
 * a countdown to installing it, with Install now and, while there are any
 * left, Later (see electron/main.mjs). Nobody at the screen: it installs itself
 * when the countdown runs out.
 */
export function UpdateNotice() {
  const status = useUpdateStatus()
  // The download notice can be closed; the countdown can't (Later puts it off instead).
  const [dismissed, setDismissed] = useState<string | null>(null)
  const now = useSecondClock(status?.state === 'ready')
  if (!status) return null

  const version = status.next ? `v${status.next}` : 'A new version'
  if (status.state === 'downloading') {
    if (dismissed === status.next) return null
    return (
      <aside className="update-notice" role="status">
        <div className="update-notice-text">
          <b>Update available</b>
          <span>
            {version} · downloading {status.percent ?? 0}%
          </span>
        </div>
        <button type="button" className="update-notice-close" aria-label="Dismiss" onClick={() => setDismissed(status.next ?? '')}>
          ×
        </button>
        <span className="update-notice-bar" style={{ width: `${status.percent ?? 0}%` }} />
      </aside>
    )
  }

  if (status.state === 'ready') {
    const total = COUNTDOWN_MS
    const left = Math.max(0, (status.installAt ?? now) - now)
    const defersLeft = status.defersLeft ?? 0
    return (
      <aside className="update-notice" role="alertdialog" aria-label="Update ready">
        <div className="update-notice-text">
          <b>{version} ready</b>
          <span>Installing and restarting in {Math.ceil(left / 1000)}s</span>
        </div>
        <div className="update-notice-actions">
          {defersLeft > 0 && (
            <button type="button" onClick={() => desktop!.deferUpdate()}>
              Later ({defersLeft})
            </button>
          )}
          <button type="button" className="is-primary" onClick={() => desktop!.installUpdate()}>
            Install now
          </button>
        </div>
        <span className="update-notice-bar" style={{ width: `${(left / total) * 100}%` }} />
      </aside>
    )
  }

  if (status.state === 'installing') {
    return (
      <aside className="update-notice" role="status">
        <div className="update-notice-text">
          <b>Installing {version}</b>
          <span>The app restarts in a moment</span>
        </div>
      </aside>
    )
  }

  return null
}

/** The countdown's length (UPDATE_COUNTDOWN_MS in electron/main.mjs), for its bar. */
const COUNTDOWN_MS = 30_000

function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    if (!desktop) return
    desktop.updateStatus().then(setStatus, () => {})
    return desktop.onUpdateStatus(setStatus)
  }, [])
  return status
}

/** The time now, ticking every second while `running`. */
function useSecondClock(running: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  return now
}
