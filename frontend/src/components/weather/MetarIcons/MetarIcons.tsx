import type { CSSProperties, ReactNode } from 'react'
import type { Metar } from '../../../domain/weather/metar'
import { barbMarks, STREAKS, windFlowS } from '../../../domain/weather/wind'
import './MetarIcons.css'

/**
 * Small line icons for the weather readings, drawn in currentColor on a 24×24
 * grid. Wind and sky cover use the standard station-model symbols.
 *
 * Each one's moving part is set through a CSS variable or class, so the weather
 * shown one reading at a time can play it in: the vane swinging round to the
 * wind, the thermometer filling, the needle sweeping to the setting (see
 * .metar-spot in MetarIcons.css).
 */

function Icon({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg className="metar-icon" viewBox="0 0 24 24" role="img" aria-label={label}>
      {children}
    </svg>
  )
}

/**
 * Wind barb: the staff points into the wind (the direction it blows from).
 * Pennant = 50 kt, full barb = 10 kt, half barb = 5 kt. Calm is a double circle.
 * Streaks drift away downwind, faster the stronger it blows, pulsing when it gusts;
 * variable wind's dashed ring slowly turns.
 */
export function WindIcon({ wdir, wspd, wgst }: Metar) {
  if (!wspd) {
    return (
      <Icon label="Calm">
        <circle cx="12" cy="12" r="2" />
        <circle cx="12" cy="12" r="5.5" />
      </Icon>
    )
  }
  if (wdir === 'VRB' || wdir === null) {
    return (
      <Icon label="Variable wind">
        <circle cx="12" cy="12" r="2" />
        <circle className="wind-variable" cx="12" cy="12" r="8" strokeDasharray="2.5 2.5" />
      </Icon>
    )
  }

  // Build the barbs for a staff pointing straight up, then rotate to the wind direction.
  const marks = barbMarks(wspd).map((m) =>
    m.kind === 'pennant' ? (
      <path key={`p${m.y}`} d={`M12 ${m.y} L19 ${m.y + 1.5} L12 ${m.y + 3} Z`} className="filled" />
    ) : m.kind === 'full' ? (
      <line key={`f${m.y}`} x1="12" y1={m.y} x2="19" y2={m.y - 2} />
    ) : (
      <line key={`h${m.y}`} x1="12" y1={m.y} x2="15.5" y2={m.y - 1} />
    ),
  )

  const flowS = windFlowS(wspd)
  const flow = { '--wind-flow': `${flowS}s` } as CSSProperties

  return (
    <Icon label={`Wind from ${wdir}°`}>
      <g className="wind-vane" style={{ '--wind-dir': `${wdir}deg` } as CSSProperties}>
        <line x1="12" y1="12" x2="12" y2="1.5" />
        {marks}
        {/* Downwind of the station (below the staff before rotating), where the icon is empty. */}
        <g className={`wind-streaks${wgst ? ' is-gusting' : ''}`} style={flow} aria-hidden>
          {STREAKS.map(([x, delay]) => (
            <line key={x} x1={x} y1="14.5" x2={x} y2="18" style={{ animationDelay: `${delay * flowS}s` }} />
          ))}
        </g>
      </g>
      <circle cx="12" cy="12" r="2" className="filled" />
    </Icon>
  )
}

/** An eye in good visibility; fog lines under 3 statute miles. */
export function VisibilityIcon({ visib }: Metar) {
  const miles = typeof visib === 'number' ? visib : parseFloat(String(visib ?? '10'))
  if (miles < 3) {
    return (
      <Icon label="Reduced visibility">
        <path className="vis-fog" d="M3 8h18M5 12h14M3 16h18" />
      </Icon>
    )
  }
  return (
    <Icon label="Good visibility">
      <g className="vis-eye">
        <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" />
        <circle cx="12" cy="12" r="2.6" />
      </g>
    </Icon>
  )
}

const COVER_ORDER = ['SKC', 'CLR', 'FEW', 'SCT', 'BKN', 'OVC', 'OVX', 'VV']
const COVER_FRACTION: Record<string, number> = { FEW: 0.25, SCT: 0.5, BKN: 0.75, OVC: 1 }

/** Station-model sky cover for the most covered layer: empty, ¼, ½, ¾ or fully filled; ✕ if obscured. */
export function SkyCoverIcon({ clouds = [] }: Metar) {
  const cover = clouds.reduce(
    (most, c) => (COVER_ORDER.indexOf(c.cover) > COVER_ORDER.indexOf(most) ? c.cover : most),
    'CLR',
  )
  const fraction = COVER_FRACTION[cover] ?? 0
  return (
    <Icon label={`Sky cover ${cover}`}>
      <circle cx="12" cy="12" r="8" />
      {(cover === 'VV' || cover === 'OVX') && <path d="M6.3 6.3l11.4 11.4M17.7 6.3L6.3 17.7" />}
      {fraction === 1 && <circle cx="12" cy="12" r="8" className="filled sky-fill" />}
      {fraction > 0 && fraction < 1 && <path d={pieSlice(fraction)} className="filled sky-fill" />}
    </Icon>
  )
}

/** A clockwise wedge from 12 o'clock covering `fraction` of the r=8 circle. */
function pieSlice(fraction: number) {
  const angle = fraction * 2 * Math.PI
  const x = 12 + 8 * Math.sin(angle)
  const y = 12 - 8 * Math.cos(angle)
  return `M12 12 L12 4 A8 8 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`
}

/** Thermometer filled in proportion to the temperature (−20 °C to 45 °C). */
export function TemperatureIcon({ temp }: Metar) {
  const level = Math.min(1, Math.max(0, ((temp ?? 0) + 20) / 65))
  const top = 15 - level * 11
  return (
    <Icon label="Temperature">
      <path d="M10 14.5V4a2 2 0 0 1 4 0v10.5a4 4 0 1 1-4 0Z" />
      {/* Drawn from the bulb up, so it can fill like mercury rising. */}
      <line x1="12" y1="17.5" x2="12" y2={top} pathLength={1} className="thick temp-level" />
      <circle cx="12" cy="17.5" r="1.8" className="filled" />
    </Icon>
  )
}

export function DewpointIcon() {
  return (
    <Icon label="Dew point">
      <path className="dew-drop" d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11Z" />
    </Icon>
  )
}

/** A dial whose needle sweeps from 29.00 to 31.00 inHg (standard pressure 29.92 is near straight up). */
export function AltimeterIcon({ altim }: Metar) {
  const inHg = (altim ?? 1013.25) * 0.02953
  const angle = Math.min(1, Math.max(0, (inHg - 29) / 2)) * 240 - 120
  return (
    <Icon label="Altimeter">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 4.5v1.5M4.5 12H6M19.5 12H18M6.7 6.7l1 1M17.3 6.7l-1 1" />
      <line
        x1="12"
        y1="12"
        x2="12"
        y2="6.5"
        className="thick altimeter-needle"
        style={{ '--needle': `${angle.toFixed(1)}deg` } as CSSProperties}
      />
      <circle cx="12" cy="12" r="1.3" className="filled" />
    </Icon>
  )
}
