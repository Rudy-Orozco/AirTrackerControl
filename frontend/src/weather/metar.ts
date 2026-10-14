import { useEffect, useState } from 'react'
import { AIRPORT_PRESET, FEED, METAR } from '../config/config'

export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR'

/** The fields we use from aviationweather.gov's METAR JSON. */
export interface Metar {
  rawOb: string
  /** Observation time, seconds since the epoch. */
  obsTime: number
  temp: number | null
  dewp: number | null
  /** Degrees, or "VRB" for variable. */
  wdir: number | 'VRB' | null
  wspd: number | null
  wgst?: number | null
  /** Statute miles; "10+" means 10 or more. */
  visib: number | string | null
  /** Hectopascals. */
  altim: number | null
  /** Left out when a layer's height couldn't be measured (e.g. "FEW///TCU" from an automatic station). */
  clouds?: { cover: string; base: number | null }[]
  fltCat?: FlightCategory
}

/** The airport's latest altimeter setting (hPa), for turning reported pressure altitudes into true ones; null until a METAR has one. */
let latestAltimeter: number | null = null

export function altimeterHpa() {
  return latestAltimeter
}

async function fetchMetar(icao: string, signal: AbortSignal): Promise<Metar | null> {
  const res = await fetch(`/api/metar?ids=${icao}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(FEED.requestTimeoutMs)]),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // The last two hours of reports; use the newest.
  const reports: Metar[] = await res.json()
  const newest = reports.reduce<Metar | null>((newest, m) => (!newest || m.obsTime > newest.obsTime ? m : newest), null)
  if (!newest) return null
  // Fields the service couldn't decode are left out rather than null.
  const { temp, dewp, wdir, wspd, visib, altim } = newest
  if (altim != null) latestAltimeter = altim
  return { ...newest, temp: temp ?? null, dewp: dewp ?? null, wdir: wdir ?? null, wspd: wspd ?? null, visib: visib ?? null, altim: altim ?? null }
}

/** METARs come hourly; a newest report older than this is likely a stale cached copy. */
const EXPECTED_MAX_AGE_MS = 75 * 60_000
const STALE_RETRY_MS = 60_000

/**
 * The latest METAR for `icao`, refreshed every METAR.refreshMs, or after a
 * minute if the service handed back an out-of-date report (its CDN occasionally
 * serves an old cached copy). Keeps the last report if a refresh fails.
 */
export function useMetar(icao: string): Metar | null {
  const [metar, setMetar] = useState<Metar | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      let delay = METAR.refreshMs
      try {
        const m = await fetchMetar(icao, controller.signal)
        if (m) setMetar((prev) => (prev && prev.obsTime > m.obsTime ? prev : m))
        if (!m || Date.now() - m.obsTime * 1000 > EXPECTED_MAX_AGE_MS) delay = STALE_RETRY_MS
      } catch (err) {
        if (controller.signal.aborted) return
        console.warn('METAR unavailable:', err)
      }
      timer = setTimeout(load, delay)
    }
    load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [icao])

  return metar
}

// ---- Decoding for display ----------------------------------------------------------

const HPA_TO_INHG = 0.02953

export function formatWind({ wdir, wspd, wgst }: Metar) {
  if (wspd === null) return '—'
  if (wspd === 0) return 'CALM'
  const dir = wdir === 'VRB' || wdir === null ? 'VRB' : `${String(wdir).padStart(3, '0')}°`
  return `${dir} ${wspd}${wgst ? `G${wgst}` : ''} KT`
}

export function formatVisibility({ visib }: Metar) {
  return visib === null ? '—' : `${visib} SM`
}

/** The lowest broken, overcast or obscured layer, which is what counts as a ceiling. */
export function formatCeiling({ clouds }: Metar) {
  if (!clouds) return '—'
  const ceiling = clouds.find((c) => ['BKN', 'OVC', 'OVX', 'VV'].includes(c.cover) && c.base !== null)
  if (ceiling) return `${ceiling.cover} ${ceiling.base!.toLocaleString()} FT`
  return clouds.length === 0 || clouds[0].cover === 'CLR' || clouds[0].cover === 'SKC' ? 'CLEAR' : 'NONE'
}

export function formatTemperature({ temp }: Metar) {
  return temp === null ? '—' : `${Math.round(temp)}°C`
}

export function formatDewpoint({ dewp }: Metar) {
  return dewp === null ? '—' : `${Math.round(dewp)}°C`
}

/** North America (ICAO K..., C..., P... for Alaska/Hawaii) reports inches of mercury; most of the world hPa. */
const USES_INHG = /^[KCP]/.test(AIRPORT_PRESET.icao)

export function formatAltimeter({ altim }: Metar) {
  if (altim === null) return '—'
  return USES_INHG ? `${(altim * HPA_TO_INHG).toFixed(2)} INHG` : `${Math.round(altim)} HPA`
}

// ---- Where each reading comes from in the raw report --------------------------------

export type MetarField = 'wind' | 'visibility' | 'ceiling' | 'temp' | 'dewpoint' | 'altimeter'

/** Character offsets into the raw report, start inclusive, end exclusive. */
export type RawSpan = [start: number, end: number]

/**
 * The parts of a raw METAR each reading was decoded from, e.g. "06003KT" for
 * the wind, the "17" of "17/08" for the temperature. Only the body is read,
 * not the remarks after RMK.
 */
export function rawSpans(raw: string): Record<MetarField, RawSpan[]> {
  const spans: Record<MetarField, RawSpan[]> = { wind: [], visibility: [], ceiling: [], temp: [], dewpoint: [], altimeter: [] }
  const tokens = [...raw.matchAll(/\S+/g)]
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i][0]
    const at = tokens[i].index
    const span: RawSpan = [at, at + text.length]
    if (text === 'RMK') break
    const temps = /^(M?\d{2})\/(M?\d{2})?$/.exec(text)
    if (/^(VRB|\d{3})\d{2,3}(G\d{2,3})?(KT|MPS)$/.test(text)) spans.wind.push(span)
    // Variable wind direction, e.g. 020V090, straight after the wind.
    else if (/^\d{3}V\d{3}$/.test(text) && spans.wind.length > 0) spans.wind.push(span)
    else if (/^[MP]?\d+(\/\d+)?SM$/.test(text) || text === 'CAVOK') spans.visibility.push(span)
    // The whole miles of "1 1/2SM".
    else if (/^\d$/.test(text) && /^\d\/\dSM$/.test(tokens[i + 1]?.[0] ?? '')) spans.visibility.push(span)
    // Meters, outside North America, e.g. 9999 (after the wind, so not the time).
    else if (/^\d{4}$/.test(text) && spans.wind.length > 0 && spans.visibility.length === 0) spans.visibility.push(span)
    else if (/^(SKC|CLR|NSC|NCD|FEW|SCT|BKN|OVC|VV)(\d{3}|\/{3})?(CB|TCU|\/{3})?$/.test(text)) spans.ceiling.push(span)
    else if (temps) {
      spans.temp.push([at, at + temps[1].length])
      if (temps[2]) spans.dewpoint.push([at + temps[1].length + 1, span[1]])
    } else if (/^[AQ]\d{4}$/.test(text)) spans.altimeter.push(span)
  }
  return spans
}
