import { FEED } from '../../config/config'
import type { Metar } from '../../domain/weather/metar'
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
