import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { AIRPORT_PRESET, METAR } from '../../../config/config'
import {
  formatAltimeter,
  formatCeiling,
  formatDewpoint,
  formatTemperature,
  formatVisibility,
  formatWind,
  rawSpans,
  type Metar,
  type MetarField,
  type RawSpan,
} from '../../../domain/weather/metar'
import { useMetar } from '../../../hooks/useMetar'
import {
  AltimeterIcon,
  DewpointIcon,
  SkyCoverIcon,
  TemperatureIcon,
  VisibilityIcon,
  WindIcon,
} from '../MetarIcons/MetarIcons'
import './MetarStrip.css'

/** Reports older than this are probably missing an update, so their age is highlighted. */
const STALE_MINUTES = 90

/**
 * Current weather at the airport: decoded readings over the raw METAR, in a
 * centered row above the board, or a column in the screen's top-right corner.
 */
export function MetarStrip({ layout = 'row' }: { layout?: 'row' | 'column' }) {
  const metar = useMetar(AIRPORT_PRESET.icao)
  const now = useMinuteClock()
  if (!metar) return null

  const ageMinutes = Math.max(0, Math.round((now - metar.obsTime * 1000) / 60_000))
  const category = metar.fltCat ?? null
  const cat = category && (
    <div className={`metar-cat metar-cat--${category.toLowerCase()}`}>
      <span className="metar-dot" />
      {category}
    </div>
  )
  const cells = (
    <>
      {readings(metar).map((r) => (
        <Cell key={r.field} icon={r.icon} label={r.label} value={r.value} />
      ))}
    </>
  )
  const age = <span className={`metar-age${ageMinutes > STALE_MINUTES ? ' is-stale' : ''}`}>{ageMinutes} min ago</span>

  // In a column, one at a time: the category and age, the raw report with the reading's part highlighted, then the reading.
  if (layout === 'column' && METAR.spotlight) {
    return (
      <div className="metar metar--column">
        <div className="metar-head">
          {cat}
          {age}
        </div>
        <Spotlight metar={metar} />
      </div>
    )
  }

  // In a column: the category and age, the raw report, then the readings one a line.
  if (layout === 'column') {
    return (
      <div className="metar metar--column">
        <div className="metar-head">
          {cat}
          {age}
        </div>
        <div className="metar-raw-text">{metar.rawOb}</div>
        <div className="metar-cells">{cells}</div>
      </div>
    )
  }

  return (
    <div className="metar metar--row">
      <div className="metar-cells">
        {cat}
        {cells}
      </div>
      <div className="metar-raw">
        <span className="metar-raw-text">{metar.rawOb}</span>
        {age}
      </div>
    </div>
  )
}

/** The decoded readings, in the order they're shown (and come in the raw report). */
function readings(metar: Metar): { field: MetarField; icon: ReactNode; label: string; value: string }[] {
  return [
    { field: 'wind', icon: <WindIcon {...metar} />, label: 'Wind', value: formatWind(metar) },
    { field: 'visibility', icon: <VisibilityIcon {...metar} />, label: 'Visibility', value: formatVisibility(metar) },
    { field: 'ceiling', icon: <SkyCoverIcon {...metar} />, label: 'Ceiling', value: formatCeiling(metar) },
    { field: 'temp', icon: <TemperatureIcon {...metar} />, label: 'Temp', value: formatTemperature(metar) },
    { field: 'dewpoint', icon: <DewpointIcon />, label: 'Dew pt', value: formatDewpoint(metar) },
    { field: 'altimeter', icon: <AltimeterIcon {...metar} />, label: 'Altimeter', value: formatAltimeter(metar) },
  ]
}

/**
 * One reading at a time, each for METAR.spotlightMs, under the raw report with
 * the part it was decoded from highlighted: its label and value, and its icon
 * large beside them, popping in one after the other. Dots show which it's on.
 */
function Spotlight({ metar }: { metar: Metar }) {
  const [step, setStep] = useState(0)
  const [leaving, setLeaving] = useState(false)
  // Each reading plays out for SPOT_OUT_MS at the end of its turn, then the next comes in.
  useEffect(() => {
    const out = setTimeout(() => setLeaving(true), Math.max(0, METAR.spotlightMs - SPOT_OUT_MS))
    const next = setTimeout(() => {
      setLeaving(false)
      setStep((s) => s + 1)
    }, METAR.spotlightMs)
    return () => {
      clearTimeout(out)
      clearTimeout(next)
    }
  }, [step])

  const all = readings(metar)
  const index = step % all.length
  const shown = all[index]
  const spans = rawSpans(metar.rawOb)[shown.field]
  return (
    <div className={`metar-spotlight${leaving ? ' is-leaving' : ''}`}>
      <div className="metar-raw-text">
        <Highlighted text={metar.rawOb} spans={spans} />
      </div>
      {/* Keyed by turn, so each one pops in afresh. */}
      <div className="metar-spot" key={step}>
        <div className="metar-spot-text">
          <span className="metar-label">{shown.label}</span>
          <span className="metar-spot-value">{shown.value}</span>
        </div>
        <div className="metar-spot-icon">{shown.icon}</div>
      </div>
      <div className="metar-spot-dots" aria-hidden>
        {all.map((r, i) => (
          <i key={r.field} className={i === index ? 'is-on' : undefined} />
        ))}
      </div>
    </div>
  )
}

/** How long a reading takes to play out before the next one comes in (matches .is-leaving in MetarStrip.css). */
const SPOT_OUT_MS = 350

/** `text` with `spans` (in order, not overlapping) marked. */
function Highlighted({ text, spans }: { text: string; spans: RawSpan[] }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of spans) {
    parts.push(text.slice(at, start), <mark key={start}>{text.slice(start, end)}</mark>)
    at = end
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

function Cell({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metar-cell">
      {icon}
      <span className="metar-label">{label}</span>
      <span className="metar-value">{value}</span>
    </div>
  )
}

/** The current time, updated every 30 seconds (enough for a "minutes ago" readout). */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}
