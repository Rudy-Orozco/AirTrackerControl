import { FEED } from '../../config/config'
import type { Metar, StationMetar } from '../../domain/weather/metar'
import { getJson, withTimeout } from '../http'

/** The airport's latest altimeter setting (hPa), for turning reported pressure altitudes into true ones; null until a METAR has one. */
let latestAltimeter: number | null = null

export function altimeterHpa() {
  return latestAltimeter
}

/** The newest METAR for `icao` from aviationweather.gov (relayed by the app's server, api-routes.mjs), or null if there's none. */
export async function fetchMetar(icao: string, signal: AbortSignal): Promise<Metar | null> {
  // The last two hours of reports; use the newest.
  const reports = await getJson<Metar[]>(`/api/metar?ids=${icao}`, { signal: withTimeout(signal, FEED.requestTimeoutMs) })
  const newest = reports.reduce<Metar | null>((newest, m) => (!newest || m.obsTime > newest.obsTime ? m : newest), null)
  if (!newest) return null
  // Fields the service couldn't decode are left out rather than null.
  const { temp, dewp, wdir, wspd, visib, altim } = newest
  if (altim != null) latestAltimeter = altim
  return { ...newest, temp: temp ?? null, dewp: dewp ?? null, wdir: wdir ?? null, wspd: wspd ?? null, visib: visib ?? null, altim: altim ?? null }
}

/** The newest METAR from each station inside `bounds` (degrees), via aviationweather.gov's area query. */
export async function fetchAreaMetars(
  bounds: { west: number; south: number; east: number; north: number },
  signal: AbortSignal,
): Promise<StationMetar[]> {
  const { west, south, east, north } = bounds
  const query = new URLSearchParams({ south: `${south}`, west: `${west}`, north: `${north}`, east: `${east}` })
  const reports = await getJson<StationMetar[]>(`/api/metar-area?${query}`, { signal: withTimeout(signal, FEED.requestTimeoutMs * 2) })
  // The last two hours come back, several reports per station; keep each one's newest.
  const newest = new Map<string, StationMetar>()
  for (const m of reports) {
    const kept = newest.get(m.icaoId)
    if (!kept || m.obsTime > kept.obsTime) newest.set(m.icaoId, m)
  }
  return [...newest.values()]
}
