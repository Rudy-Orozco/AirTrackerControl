import { useEffect, useState, type RefObject } from 'react'
import { MOTION } from '../config/config'
import type { FeedStatus } from '../feed/useAircraftFeed'
import { MapFlag } from './MapFlag'

/**
 * Over the map once the aircraft feed has been down long enough that every
 * aircraft has gone (MOTION.feedDownMs), the way a cockpit display flags a lost
 * source: a red cross over the map and an amber failure message, with how long
 * since the last update and when it's next tried (see MapFlag). The board's own
 * status line says what went wrong.
 */
export function FeedLost({ status, board }: { status: FeedStatus; board: RefObject<HTMLElement | null> }) {
  const now = useSecondClock()
  const last = status.updatedAt?.getTime() ?? null
  const downFor = last === null ? 0 : now - last
  if (last === null || downFor < MOTION.feedDownMs + MOTION.fadeOutMs) return null

  return (
    <MapFlag board={board}>
      <b>ADS-B DATA FAIL</b>
      <span>Traffic unavailable</span>
      <span className="map-flag-detail">
        Last update {formatDuration(downFor)} ago ·{' '}
        {status.fetching ? 'retrying…' : status.nextPoll ? <Retry key={status.nextPoll.id} delayMs={status.nextPoll.delayMs} /> : 'retrying'}
      </span>
    </MapFlag>
  )
}

/** "Retry in 8s", counting down. Remounted (via its key) for each attempt. */
function Retry({ delayMs }: { delayMs: number }) {
  const [due] = useState(() => Date.now() + delayMs)
  const now = useSecondClock()
  return <>retry in {Math.max(0, Math.ceil((due - now) / 1000))}s</>
}

/** "2:05", "1:02:05". */
function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)]
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function useSecondClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}
