import { useEffect, useRef, type CSSProperties } from 'react'
import { AIRPORT, MAP, MAP3D } from '../config/config'
import type { BoardRow, BoardState } from '../board/flightBoard'
import { formatLocalTime } from '../board/localTime'
import type { GroundTracker } from '../tracking/groundTracker'
import { locateAircraft, selectAircraft, useSelectedAircraft, type Located } from '../tracking/selection'
import type { Tracker } from '../tracking/tracker'
import { useTick } from '../lib/useTick'
import './AircraftPanel.css'

/**
 * Details of the aircraft picked on the map or the board (see selection.ts),
 * updated live while the map follows it. The close button or Escape lets it go
 * and sends the camera back; so does losing it from the feed for a while.
 */
export function AircraftPanel({ tracker, ground, board }: { tracker: Tracker; ground: GroundTracker; board: BoardState }) {
  const hex = useSelectedAircraft()
  useTick(() => REFRESH_MS)
  const missingSince = useRef<number | null>(null)

  useEffect(() => {
    if (!hex) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') selectAircraft(null)
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
    <aside className="aircraft-panel" aria-label="Selected aircraft">
      <Header hex={hex} located={located} row={row} />
      {located ? <Details located={located} /> : <p className="aircraft-lost">Signal lost · not on the map right now</p>}
      <footer className="aircraft-footer">
        <span>Following</span>
        <span>Esc to exit</span>
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
