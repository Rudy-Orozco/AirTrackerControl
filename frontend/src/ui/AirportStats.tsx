import { useEffect, useState, type CSSProperties } from 'react'
import { MAP, MAP3D, PROCEDURES, STATS } from '../config/config'
import { procedureMatcher } from '../procedures/matcher'
import { procedureColor } from '../map/procedureLayer'
import { proceduresState } from '../procedures/procedures'
import { RESET_STATS_EVENT, type AirportStatsState } from '../tracking/airportStats'
import type { Tracker } from '../tracking/tracker'
import './AirportStats.css'

/**
 * What's going on at the airport, in a few quiet lines under its logo:
 * landing and takeoff rates (per STATS.rateUnit, averaged over STATS.rateWindowMs),
 * aircraft inbound and waiting to leave, the runways in use, and any
 * go-arounds or rejected takeoffs in the last hour.
 */
export function AirportStats({ stats: fed, tracker }: { stats: AirportStatsState | null; tracker: Tracker }) {
  const now = useNow()
  const stats = useSinceReset(fed)
  // The runways in use change between updates, as aircraft line up and land.
  const runways = tracker.runwaysInUse(now, STATS.runwayHoldMs)
  // The busiest procedures right now.
  const procedures = PROCEDURES.enabled && proceduresState().data ? procedureMatcher.inUse().slice(0, STATS_PROCEDURES) : []
  if (!stats) return null

  const elapsed = now - stats.since
  const rateWindow = Math.min(STATS.rateWindowMs, elapsed)
  /** How many in the averaging window (null while it's too soon to say). */
  const counted = (times: number[]) => (rateWindow < MIN_RATE_WINDOW_MS ? null : times.filter((t) => t >= now - rateWindow).length)
  const rate = (times: number[], kind: 'arr' | 'dep') => {
    const count = counted(times)
    const unit = STATS.rateUnit
    if (unit === 'interval') {
      const label = kind === 'arr' ? 'ldg' : 'dep'
      return [count ? formatInterval(rateWindow / count) : '–', `1 ${label} /`] as const
    }
    const value = count === null ? '–' : unit === 'minute' ? (count / (rateWindow / 60_000)).toFixed(1) : String(Math.round(count / (rateWindow / 3_600_000)))
    return [value, unit === 'minute' ? `${kind === 'arr' ? 'ldg' : 'dep'}/min` : `${kind}/hr`] as const
  }
  // Until there's enough to go on, a countdown in the rates' place.
  const collecting = rateWindow < MIN_RATE_WINDOW_MS
  const [arrRate, arrUnit] = rate(stats.landings, 'arr')
  const [depRate, depUnit] = rate(stats.takeoffs, 'dep')
  const { traffic } = MAP.view === '3d' ? MAP3D : MAP
  // Only worth a mention once there's been one (in the last hour).
  const events = [
    stats.goArounds.length > 0 && `${stats.goArounds.length} go-around${stats.goArounds.length > 1 ? 's' : ''}`,
    stats.aborts.length > 0 && `${stats.aborts.length} rejected takeoff${stats.aborts.length > 1 ? 's' : ''}`,
  ].filter(Boolean)

  return (
    <section
      className="airport-stats"
      aria-label="Airport stats"
      style={{ '--arrival': traffic.arrival.color, '--departure': traffic.departure.color } as CSSProperties}
    >
      {collecting ? (
        <p>Collecting rates · {formatInterval(MIN_RATE_WINDOW_MS - rateWindow)}</p>
      ) : STATS.rateUnit === 'interval' ? (
        <p>
          {arrUnit} <b className="is-arrival">{arrRate}</b> · {depUnit} <b className="is-departure">{depRate}</b>
        </p>
      ) : (
        <p>
          <b className="is-arrival">{arrRate}</b> {arrUnit} · <b className="is-departure">{depRate}</b> {depUnit}
        </p>
      )}
      <p>
        <b>{stats.inbound}</b> inbound · <b>{stats.waiting}</b> waiting
      </p>
      {(runways.landing.length > 0 || runways.departing.length > 0) && (
        <p>
          rwy{runways.landing.length > 0 && <b className="is-arrival"> {runways.landing.join(' ')}</b>}
          {runways.departing.length > 0 && <b className="is-departure"> {runways.departing.join(' ')}</b>}
        </p>
      )}
      {procedures.length > 0 && (
        <p>
          via
          {procedures.map(({ procedure, kind, count }) => (
            <span key={procedure.name}>
              {' '}
              <b style={{ color: procedureColor(kind) }}>{procedure.name}</b> {count}
            </span>
          ))}
        </p>
      )}
      {events.length > 0 && <p className="is-notable">{events.join(' · ')}</p>}
    </section>
  )
}

/** "58s", "2m 10s". */
function formatInterval(ms: number) {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** How many of the busiest procedures to list. */
const STATS_PROCEDURES = 4

/** Rates need this much counting before they mean anything. */
const MIN_RATE_WINDOW_MS = 5 * 60_000

/**
 * The stats as fed, but straight after a reset (until the next update brings
 * the reset ones) as if counting started then.
 */
function useSinceReset(stats: AirportStatsState | null): AirportStatsState | null {
  const [resetAt, setResetAt] = useState<number | null>(null)
  useEffect(() => {
    const onReset = () => setResetAt(Date.now())
    window.addEventListener(RESET_STATS_EVENT, onReset)
    return () => window.removeEventListener(RESET_STATS_EVENT, onReset)
  }, [])
  if (!stats || resetAt === null || stats.since >= resetAt) return stats
  const after = (times: number[]) => times.filter((t) => t >= resetAt)
  return {
    ...stats,
    since: resetAt,
    landings: after(stats.landings),
    takeoffs: after(stats.takeoffs),
    goArounds: after(stats.goArounds),
    aborts: after(stats.aborts),
  }
}

/** The time now, ticking every few seconds so the rates and runways stay current between updates. */
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(id)
  }, [])
  return now
}
