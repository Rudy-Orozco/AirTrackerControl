import { altimeterHpa } from './metar'
import { CENTER, FEED, FETCH_RADIUS_NM } from '../../config/config'
import { withTimeout } from '../http'

export interface Aircraft {
  hex: string
  callsign: string
  lat: number
  lon: number
  /** Degrees clockwise from true north, or null if unknown. */
  track: number | null
  /** Which way the nose points (degrees from true north), when the aircraft sends it; differs from `track` while pushing back. */
  trueHeading: number | null
  /** Ground speed in knots, or null if unknown. */
  groundSpeed: number | null
  /** Barometric altitude in feet, or null if unknown. */
  altitude: number | null
  onGround: boolean
  /** Feet per minute, positive when climbing, or null if unknown. */
  verticalRate: number | null
  /** ICAO type designator such as B738, or null if unknown. */
  aircraftType: string | null
  /** Seconds since the position was received (as of when the response arrived here), so we can project it to the present. */
  positionAge: number
  /** ADS-B emitter category: A1 light, A2 small, A3 large, A5 heavy, A7 rotorcraft... or null if not sent. */
  emitterCategory: string | null
  /** Airport service and emergency vehicles also broadcast ADS-B (emitter category C1-C3). */
  isVehicle: boolean
}

/** One aircraft in readsb's JSON format (used by adsb.lol, readsb, and our backend). */
interface RawAircraft {
  hex: string
  flight?: string
  r?: string
  lat?: number
  lon?: number
  track?: number
  true_heading?: number
  gs?: number
  alt_baro?: number | 'ground'
  baro_rate?: number
  geom_rate?: number
  t?: string
  seen_pos?: number
  category?: string
}

/**
 * Where aircraft positions come from, in order of preference. Both are free
 * community networks with the same readsb JSON, relayed by the app's server
 * (api-routes.mjs). Their rate limits are per IP address, which may be shared
 * (e.g. a cloud dev machine), so a 429 can come however slowly we poll.
 */
const SOURCES = [
  { name: 'adsb.lol', path: '/api/aircraft' },
  { name: 'adsb.fi', path: '/api/aircraft-adsbfi' },
]
/** After a 429, leave that source alone for this long. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000
const restingUntil = new Map<string, number>()
let currentSource = SOURCES[0].name
/** Per source, the smallest gap yet between its snapshot time and the response arriving: its clock offset plus its quickest delivery. */
const quickestDelivery = new Map<string, number>()

/** The source the latest aircraft came from, for crediting it. */
export function aircraftSource() {
  return currentSource
}

/**
 * Fetches from the first source that isn't resting after a rate limit, moving
 * on to the next if one fails. If every source is resting, tries them anyway.
 */
export async function fetchAircraft(signal: AbortSignal): Promise<Aircraft[]> {
  const query = new URLSearchParams({ lat: `${CENTER.lat}`, lon: `${CENTER.lon}`, radius: `${FETCH_RADIUS_NM}` })
  const now = Date.now()
  const awake = SOURCES.filter((s) => (restingUntil.get(s.name) ?? 0) <= now)
  let lastError: unknown = null
  for (const source of awake.length ? awake : SOURCES) {
    try {
      const res = await fetch(`${source.path}?${query}`, {
        signal: withTimeout(signal, FEED.requestTimeoutMs),
      })
      if (res.status === 429) restingUntil.set(source.name, Date.now() + RATE_LIMIT_COOLDOWN_MS)
      if (!res.ok) throw new Error(`${source.name}: HTTP ${res.status}`)
      const json = await res.json()
      const aircraft = parseAircraft(json, deliveryDelay(source.name, json))
      currentSource = source.name
      return aircraft
    } catch (err) {
      if (signal.aborted) throw err
      lastError = err
    }
  }
  throw lastError
}

/**
 * How much longer than its quickest this response took to arrive after the
 * server's snapshot, in seconds: positions are that much older than their
 * `seen_pos` says. Measured against the quickest rather than the clocks, which
 * needn't agree. Responses vary by several seconds, which would otherwise read
 * as planes moving faster or slower than they are.
 */
function deliveryDelay(source: string, json: unknown): number {
  const now = (json as { now?: number }).now
  if (typeof now !== 'number') return 0
  // adsb.lol and adsb.fi send milliseconds; a readsb aircraft.json sends seconds.
  const gap = Date.now() - (now < 1e12 ? now * 1000 : now)
  const quickest = Math.min(quickestDelivery.get(source) ?? gap, gap)
  quickestDelivery.set(source, quickest)
  return (gap - quickest) / 1000
}

/**
 * Aircraft report pressure altitude: measured against standard pressure
 * (1013.25 hPa, 29.92 inHg), not the day's. Low down that can be hundreds of
 * feet off the real height, enough to put a departure under the runway or an
 * arrival on it while still on final. Below the transition altitude, correct it
 * with the airport's altimeter setting (about 1,000 ft per inch of mercury);
 * above it, flight levels are pressure altitudes, so leave them, easing between.
 */
function trueAltitude(pressureFt: number) {
  const altim = altimeterHpa()
  if (altim === null) return pressureFt
  const correction = (altim - STANDARD_HPA) * FT_PER_HPA
  const weight = Math.min(Math.max((TRANSITION_FT - pressureFt) / TRANSITION_EASE_FT, 0), 1)
  return pressureFt + correction * weight
}

const STANDARD_HPA = 1013.25
const FT_PER_HPA = 1000 / 33.8639
/** US transition altitude, below which altitudes are set to the local altimeter; eased over the stretch below it. */
const TRANSITION_FT = 18_000
const TRANSITION_EASE_FT = 3_000

function parseAircraft(json: unknown, delaySeconds: number): Aircraft[] {
  // adsb.lol calls the list "ac"; adsb.fi and a local readsb aircraft.json call it "aircraft".
  const data = json as { ac?: RawAircraft[]; aircraft?: RawAircraft[] }
  const list = data.ac ?? data.aircraft ?? []

  return list
    .filter((a): a is RawAircraft & { lat: number; lon: number } => a.lat != null && a.lon != null)
    .map((a) => ({
      hex: a.hex,
      callsign: (a.flight ?? a.r ?? a.hex).trim(),
      lat: a.lat,
      lon: a.lon,
      track: a.track ?? a.true_heading ?? null,
      trueHeading: a.true_heading ?? null,
      groundSpeed: a.gs ?? null,
      altitude: typeof a.alt_baro === 'number' ? trueAltitude(a.alt_baro) : null,
      onGround: a.alt_baro === 'ground',
      // The GPS rate where it's sent: the barometric one is noisier.
      verticalRate: a.geom_rate ?? a.baro_rate ?? null,
      aircraftType: a.t ?? null,
      positionAge: (a.seen_pos ?? 0) + delaySeconds,
      emitterCategory: a.category ?? null,
      isVehicle: a.category?.startsWith('C') ?? false,
    }))
}
