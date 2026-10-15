import { FEED } from '../../config/config'
import type { Atis } from '../../domain/weather/atis'
import { withTimeout } from '../http'

/**
 * Digital ATIS from atis.info (formerly datis.clowd.io), which covers the larger
 * US airports. It allows browser requests, so no proxy is needed.
 */
export async function fetchAtis(icao: string, signal: AbortSignal): Promise<Atis[]> {
  const res = await fetch(`https://atis.info/api/${icao}`, { signal: withTimeout(signal, FEED.requestTimeoutMs) })
  // Airports without D-ATIS (e.g. outside the US) answer 404: nothing to show, not an error.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  // Airports without D-ATIS return an error object instead of a list.
  return Array.isArray(data) ? data : []
}
