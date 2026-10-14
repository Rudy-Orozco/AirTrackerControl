import { useEffect, useRef, type CSSProperties } from 'react'
import { AIRPORT, MAP, MAP3D } from '../config/config'
import { setSetting, VIEW_SETTING } from '../config/settings'
import { leaveStreetView, useStreetView } from '../map3d/streetView'
import type { BoardRow, BoardState } from '../board/flightBoard'
import { formatLocalTime } from '../board/localTime'
import type { GroundTracker } from '../tracking/groundTracker'
import {
  locateAircraft,
  rideView,
  selectAircraft,
  setRideView,
  useRideView,
  useSelectedAircraft,
  type Located,
  type RideView,
} from '../tracking/selection'
import type { Tracker } from '../tracking/tracker'
import { useTick } from '../lib/useTick'
import { procedureMatcher } from '../procedures/matcher'
import { focusRoute } from '../procedures/route'
import './AircraftPanel.css'

/**
 * Details of the aircraft picked on the map or the board (see selection.ts),
 * updated live while the map follows it. The cockpit and tail buttons ride
 * along with it on the 3D map (switching to it from the flat one). The close
 * button or Escape lets it go and sends the camera back (Escape stops riding
 * along first); so does losing it from the feed for a while.
 */
export function AircraftPanel({ tracker, ground, board }: { tracker: Tracker; ground: GroundTracker; board: BoardState }) {
  const hex = useSelectedAircraft()
  const ride = useRideView()
  const inStreet = useStreetView().state === 'standing'
  const cockpit = ride === 'cockpit'
  useTick(() => REFRESH_MS)
  const missingSince = useRef<number | null>(null)
  // Riding along needs the 3D map: started from the 2D map, it goes back there after.
  const from2d = useRef(false)
  useEffect(() => {
    if (ride || !from2d.current) return
    from2d.current = false
    if (MAP.view === '3d') setSetting(VIEW_SETTING, '2d')
  }, [ride])

  useEffect(() => {
    if (!hex) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (rideView()) setRideView(null)
      else selectAircraft(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hex])

  const located = hex ? locateAircraft(hex, tracker, ground) : null
  const row = hex ? [...board.arrivals, ...board.departures].find((r) => r.hex === hex) : undefined

  // Gone from both trackers (out of range, or the transponder went quiet): let it go after a while.
  useEffect(() => {
    if (!hex || located) {
      missingSince.current = null
      return
    }
    missingSince.current ??= Date.now()
    if (Date.now() - missingSince.current > LOST_AFTER_MS) selectAircraft(null)
  })

  if (!hex) return null
  return (
    <aside className={`aircraft-panel${cockpit ? ' is-cockpit' : ''}`} aria-label="Selected aircraft">
      <Header hex={hex} located={located} row={row} />
      {/* In the cockpit the head-up display shows the figures, so the panel shrinks out of its way. */}
      {cockpit ? null : located ? <Details located={located} /> : <p className="aircraft-lost">Signal lost · not on the map right now</p>}
      <div className="aircraft-views" role="group" aria-label="Ride along">
        {RIDE_VIEWS.map(({ view, label, title, icon }) => (
          <button
            key={view}
            type="button"
            className={`aircraft-view${ride === view ? ' is-on' : ''}`}
            aria-pressed={ride === view}
            disabled={!located}
            onClick={() => {
              if (ride !== view && MAP.view !== '3d') {
                from2d.current = true
                setSetting(VIEW_SETTING, '3d')
              }
              // Riding along takes over from the street.
              if (ride !== view) leaveStreetView()
              setRideView(ride === view ? null : view)
            }}
            title={ride === view ? 'Back to following from outside (Esc)' : title}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d={icon} />
            </svg>
            {label}
          </button>
        ))}
      </div>
      <footer className="aircraft-footer">
        <span>{ride === 'cockpit' ? 'In the cockpit' : ride === 'tail' ? 'Behind the tail' : inStreet ? 'Watching from the street' : 'Following'}</span>
        <span>{ride ? 'Esc to step out' : 'Esc to exit'}</span>
      </footer>
    </aside>
  )
}

function Header({ hex, located, row }: { hex: string; located: Located | null; row: BoardRow | undefined }) {
  const info = located?.info
  const kind = info?.kind ?? 'other'
  const { traffic } = MAP.view === '3d' ? MAP3D : MAP
  const counterpart = info?.counterpart
  const route =
    kind === 'arrival'
      ? `${counterpart?.iata || '???'} → ${AIRPORT}`
      : kind === 'departure'
        ? `${AIRPORT} → ${counterpart?.iata || '???'}`
        : null

  return (
    <header className="aircraft-header" style={{ '--kind': traffic[kind].color } as CSSProperties}>
      <div className="aircraft-title">
        <span className="aircraft-kind">{KIND_LABELS[kind]}</span>
        <h2>{info?.callsign || row?.flight || hex.toUpperCase()}</h2>
        {route && (
          <div className="aircraft-route">
            {route}
            {counterpart?.city && <small>{counterpart.city}</small>}
          </div>
        )}
      </div>
      <button type="button" className="aircraft-close" onClick={() => selectAircraft(null)} title="Stop following (Esc)" aria-label="Stop following">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      {row && (
        <div className="aircraft-status">
          <span>{row.status}</span>
          {row.time !== null && (
            <span>
              {row.landed ? 'Landed' : kind === 'arrival' ? 'Est' : 'Dep'} {formatLocalTime(row.time)}
            </span>
          )}
        </div>
      )}
    </header>
  )
}

function Details({ located }: { located: Located }) {
  const { info, heading, altitude, onGround } = located
  const items: [string, string][] = [
    ['Type', info.aircraftType ?? '—'],
    ['Altitude', onGround ? 'Ground' : formatAltitude(altitude)],
    ['Speed', info.groundSpeed === null ? '—' : `${Math.round(info.groundSpeed)} kt`],
    ['Vertical', formatVerticalRate(info.verticalRate, onGround)],
    ['Heading', `${String(Math.round(heading + 360) % 360).padStart(3, '0')}°`],
    ['To field', `${info.distanceNm.toFixed(1)} nm`],
    ['ICAO hex', info.hex.toUpperCase()],
    ['Category', info.emitterCategory ? `${info.emitterCategory} · ${CATEGORY_NAMES[info.emitterCategory] ?? ''}`.replace(/ · $/, '') : '—'],
  ]
  // The STAR or SID it's flying, as its path shows (or the likeliest, until it does), and the next waypoint on it.
  const procedure = procedureMatcher.likely(info.hex)
  const approach = procedureMatcher.likelyApproach(info.hex)
  const named = (m: NonNullable<typeof procedure>, label: string): [string, string] => [
    `${label}${m.predicted ? ' · predicted' : ''}`,
    `${m.procedure.name}${m.transition ? ` · ${m.transition}` : ''}`,
  ]
  if (procedure) items.push(named(procedure, procedure.kind === 'star' ? 'STAR' : 'SID'))
  if (approach) items.push(named(approach, 'Approach'))
  // The next waypoint: on its approach once it's seen flying it, else on its STAR or SID.
  const flying = approach && !approach.predicted ? approach : (procedure ?? approach)
  if (flying) {
    const next = focusRoute(flying, located.pos)?.next
    items.push(['Next fix', next ? `${next.name}${next.alt ? ` · ${next.alt}` : ''}` : '—'])
  }
  return (
    <dl className="aircraft-details">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function formatAltitude(feet: number | null) {
  if (feet === null) return '—'
  if (feet >= 18_000) return `FL${String(Math.round(feet / 100)).padStart(3, '0')}`
  return `${(Math.round(feet / 10) * 10).toLocaleString('en-US')} ft`
}

function formatVerticalRate(fpm: number | null, onGround: boolean) {
  if (onGround || fpm === null) return '—'
  if (Math.abs(fpm) < 100) return 'Level'
  return `${fpm > 0 ? '▲' : '▼'} ${Math.abs(Math.round(fpm / 10) * 10).toLocaleString('en-US')} fpm`
}

/** The ways to ride along, with their buttons' icons: a HUD aircraft symbol, and an aircraft seen from behind. */
const RIDE_VIEWS: { view: RideView; label: string; title: string; icon: string }[] = [
  { view: 'cockpit', label: 'Cockpit', title: 'Ride along in the cockpit (3D map)', icon: 'M2 12h7M15 12h7M9 12l1.5 3h3L15 12M12 9v-5' },
  { view: 'tail', label: 'Tail', title: 'Ride along behind the tail (3D map)', icon: 'M2 13l10-2 10 2M12 7v8M9 18l3-3 3 3' },
]

const KIND_LABELS = { arrival: 'Arrival', departure: 'Departure', other: 'Overflight' } as const

/** ADS-B emitter categories worth naming. */
const CATEGORY_NAMES: Record<string, string> = {
  A1: 'Light',
  A2: 'Small',
  A3: 'Large',
  A4: 'B757',
  A5: 'Heavy',
  A6: 'High perf.',
  A7: 'Rotorcraft',
  B1: 'Glider',
  B2: 'Balloon',
  B6: 'Drone',
}

/** How often the figures refresh. */
const REFRESH_MS = 250
/** How long an aircraft can be missing from both trackers before the panel lets it go. */
const LOST_AFTER_MS = 8000
