import type { Aircraft } from './aircraft'
import { FEED } from '../../config/config'
import { getJson, withTimeout } from '../http'

export interface Airport {
  iata: string
  city: string
  /** Where it is, when the route database gives it (for drawing route lines). */
  lat: number | null
  lon: number | null
}

/** Every stop on the flight's published route, in order. */
export interface Route {
  airports: Airport[]
}

interface RawRoute {
  callsign: string
  plausible?: boolean | null
  _airports?: RawAirport[]
}

interface RawAirport {
  iata: string
  location: string
  lat?: number
  lon?: number
}

/** Airline callsigns look like AAL1514. Private tail numbers (N123AB) have no published route. */
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d/

export function isAirlineCallsign(callsign: string) {
  return AIRLINE_CALLSIGN.test(callsign)
}
const BATCH_SIZE = 100

/**
 * Looks up origin/destination by callsign from adsb.im's free route database,
 * caching results so each flight is only requested once.
 */
export class RouteCache {
  private cache = new Map<string, { route: Route | null; fetchedAt: number }>()

  async lookup(aircraft: Aircraft[], signal: AbortSignal): Promise<Map<string, Route>> {
    const now = Date.now()
    const missing = aircraft.filter((a) => {
      if (!isAirlineCallsign(a.callsign)) return false
      const cached = this.cache.get(a.callsign)
      return !cached || now - cached.fetchedAt > FEED.routeCacheMs
    })

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE)
      try {
        const results = await fetchRoutes(batch, signal)
        // Callsigns the service doesn't answer for (it may return null entries) have no known route.
        for (const a of batch) this.cache.set(a.callsign, { route: null, fetchedAt: now })
        for (const r of results) {
          if (!r?.plausible || !r._airports?.length) continue
          this.cache.set(r.callsign, { route: toRoute(r._airports), fetchedAt: now })
        }
      } catch (err) {
        if (signal.aborted) throw err
        // Leave these uncached so the next poll retries; the flights show as "other" meanwhile.
        console.warn('Route lookup failed:', err)
      }
    }

    const routes = new Map<string, Route>()
    for (const a of aircraft) {
      const route = this.cache.get(a.callsign)?.route
      if (route) routes.set(a.callsign, route)
    }
    return routes
  }
}

function fetchRoutes(aircraft: Aircraft[], signal: AbortSignal): Promise<(RawRoute | null)[]> {
  return getJson('/api/routeset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planes: aircraft.map((a) => ({ callsign: a.callsign, lat: a.lat, lng: a.lon })) }),
    signal: withTimeout(signal, FEED.requestTimeoutMs),
  })
}

function toRoute(airports: RawAirport[]): Route {
  return {
    airports: airports.map((a) => ({
      iata: a.iata,
      // Some locations carry stray separators, e.g. "Fayetteville/Springdale/".
      city: a.location.replace(/\/+$/, ''),
      lat: a.lat ?? null,
      lon: a.lon ?? null,
    })),
  }
}
