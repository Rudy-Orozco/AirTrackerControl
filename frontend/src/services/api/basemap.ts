import type { AirportLayout, Basemap } from '../../types/airport'
import { getJson } from '../http'

/** Each airport preset has its own map, built by scripts/build_basemap.py. */
export function fetchBasemap(airport: string, signal: AbortSignal): Promise<Basemap> {
  return getJson(`/basemaps/${airport}.json`, { signal })
}

export function fetchAirportLayout(airport: string, signal: AbortSignal): Promise<AirportLayout> {
  return getJson(`/basemaps/${airport}-layout.json`, { signal })
}
