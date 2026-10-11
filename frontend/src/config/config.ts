/**
 * All the tunable settings in one place. Edit and save: the dev server reloads
 * instantly. For the Pi, rebuild with `npm run build`.
 *
 * These are the defaults. The in-app settings panel (gear, top right) saves
 * changes to many of them in the browser, which override these on load.
 *
 * Airports and their map positions are in frontend/airports.json; the default
 * airport is set in frontend/.env.
 */

import airports from '../../airports.json'

/** localStorage key for changes made in the settings panel, as { "MAP.planeSize": 12, ... }. */
export const SETTINGS_KEY = 'settings'

export function loadSavedSettings(): Record<string, unknown> {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    return saved && typeof saved === 'object' ? migrate(saved) : {}
  } catch {
    return {}
  }
}

/**
 * Settings that were once shared by every kind of traffic (and some by every
 * view), and the per-kind settings ("*" for each kind) they carry over to.
 */
const LEGACY_SETTINGS: Record<string, string[]> = {
  'MAP.arrivalColor': ['MAP.traffic.arrival.color', 'MAP3D.traffic.arrival.color', 'DIORAMA.traffic.arrival.color'],
  'MAP.departureColor': ['MAP.traffic.departure.color', 'MAP3D.traffic.departure.color', 'DIORAMA.traffic.departure.color'],
  'MAP.otherColor': ['MAP.traffic.other.color', 'MAP3D.traffic.other.color', 'DIORAMA.traffic.other.color'],
  'MAP.otherOpacity': ['MAP.traffic.other.opacity', 'MAP3D.traffic.other.opacity', 'DIORAMA.traffic.other.opacity'],
  'MAP.trailSeconds': ['MAP.traffic.*.trailSeconds', 'MAP3D.traffic.*.trailSeconds'],
  'MAP.trailOpacity': ['MAP.traffic.*.trailOpacity', 'MAP3D.traffic.*.trailOpacity'],
  'MAP.trailSmoothing': ['MAP.traffic.*.trailSmoothing', 'MAP3D.traffic.*.trailSmoothing'],
  'MAP.trailWidth': ['MAP.traffic.*.trailWidth'],
  'MAP3D.showCurtains': ['MAP3D.traffic.*.curtain'],
  'MAP3D.curtainOpacity': ['MAP3D.traffic.*.curtainOpacity'],
  'MAP3D.showRoutes': ['MAP3D.traffic.*.route'],
  'MAP3D.routeLengthNm': ['MAP3D.traffic.*.routeLengthNm'],
  'DIORAMA.parkedOpacity': ['DIORAMA.traffic.*.parkedOpacity'],
}

function migrate(saved: Record<string, unknown>): Record<string, unknown> {
  for (const [old, targets] of Object.entries(LEGACY_SETTINGS)) {
    if (!(old in saved)) continue
    for (const target of targets) {
      for (const kind of ['arrival', 'departure', 'other']) {
        const key = target.replace('*', kind)
        if (!(key in saved)) saved[key] = saved[old]
      }
    }
    delete saved[old]
  }
  return saved
}

// ---- Airport -------------------------------------------------------------------

export interface AirportPreset {
  name: string
  /** ICAO code, used for the weather report (METAR). */
  icao: string
  /** Field elevation, so aircraft altitudes can be shown as height above the ground. */
  elevationFt: number
  lat: number
  lon: number
  /** Nautical miles from the airport to the nearer edge of the visible map. */
  radiusNm: number
  /** IANA time zone, e.g. America/New_York: every time on screen is the airport's local time. */
  timeZone: string
  /** Groups the airport picker in the settings panel. */
  country: string
  /**
   * When it's usually busy or dead, as [from, to) local hours (a range may wrap
   * past midnight, e.g. [23, 5]); any other hour is slow. See traffic.ts.
   */
  traffic: { busy: number[][]; dead: number[][] }
  /** The airport's logo, shown in the top-left corner: a path under public/, e.g. "/logos/JFK.svg". */
  logo?: string
}

export const PRESETS: Record<string, AirportPreset> = airports

/** Chosen by ?airport=LAX in the URL, else in the settings panel, else VITE_AIRPORT in .env. */
function selectAirport(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('airport')
  const saved = loadSavedSettings().AIRPORT
  const requested = (fromUrl ?? (typeof saved === 'string' ? saved : null) ?? import.meta.env.VITE_AIRPORT ?? 'DFW').toUpperCase()
  if (requested in PRESETS) return requested
  console.warn(`No preset for airport "${requested}" in airports.json; showing DFW.`)
  return 'DFW'
}

/** IATA code of the airport whose arrivals and departures are highlighted. */
export const AIRPORT = selectAirport()
export const AIRPORT_PRESET = PRESETS[AIRPORT]

export const CENTER = { lat: AIRPORT_PRESET.lat, lon: AIRPORT_PRESET.lon }

/** Nautical miles from the center to the edge of the map's shorter side. */
export const VIEW_RADIUS_NM = AIRPORT_PRESET.radiusNm

/**
 * A 9:16 portrait screen's half-diagonal is ~2.04x half its short side, so fetch
 * a wider radius than we display to fill the corners.
 */
export const FETCH_RADIUS_NM = Math.ceil(VIEW_RADIUS_NM * 2.1)

// ---- Live data --------------------------------------------------------------

export const FEED = {
  /** How often to fetch aircraft positions. adsb.lol often rate-limits (HTTP 429) anything faster than ~10s. */
  pollMs: 11_000,
  /** Give up on a single fetch after this long. */
  requestTimeoutMs: 30_000,
  /** How long to remember a flight's origin/destination before looking it up again. */
  routeCacheMs: 60 * 60_000,
}

// ---- Aircraft on the map ----------------------------------------------------

type Kinds<T> = Record<'arrival' | 'departure' | 'other', T>

/** How one kind of traffic (arrivals, departures or everything else) is drawn, in every view. */
export interface TrafficStyle {
  show: boolean
  color: string
  opacity: number
  /** Times the view's aircraft size. */
  scale: number
}

/** The kind's colors in every view, from the 2D map's original defaults. */
function baseStyles(): Kinds<TrafficStyle> {
  return {
    arrival: { show: true, color: '#4ea2ff', opacity: 1, scale: 1 },
    departure: { show: true, color: '#ff8a33', opacity: 1, scale: 1 },
    other: { show: true, color: '#ffffff', opacity: 0.3, scale: 1 },
  }
}

/** The same extras for every kind, on top of its base style. */
function withExtras<T extends object>(extras: T): Kinds<TrafficStyle & T> {
  const base = baseStyles()
  return {
    arrival: { ...base.arrival, ...extras },
    departure: { ...base.departure, ...extras },
    other: { ...base.other, ...extras },
  }
}

/** Trails on the maps. */
interface TrailStyle {
  /** Callsign and altitude label next to it. */
  labels: boolean
  /** The path behind it. */
  trail: boolean
  /** How many seconds of path it leaves behind. */
  trailSeconds: number
  /** Opacity of the trail at the aircraft end; it fades to nothing at the tail. */
  trailOpacity: number
  /** Trail points are averaged with this many neighbours on each side (2 per second) to iron out kinks. 0 turns it off. */
  trailSmoothing: number
}

const TRAIL_DEFAULTS: TrailStyle = { labels: true, trail: true, trailSeconds: 180, trailOpacity: 0.55, trailSmoothing: 4 }

export type MapTrafficStyle = TrafficStyle & TrailStyle & { trailWidth: number }

export type Map3DTrafficStyle = TrafficStyle &
  TrailStyle & {
    /** A faint curtain from the trail down to the ground, showing its altitude profile. */
    curtain: boolean
    curtainOpacity: number
    /** A line from the aircraft straight down to the ground... */
    dropLine: boolean
    /** ...and a dot where it meets it. */
    groundDot: boolean
    /** A line toward its origin (arrivals) or destination (departures). */
    route: boolean
    /** How far it reaches, in nautical miles (origins can be across the world). */
    routeLengthNm: number
  }

export type DioramaTrafficStyle = TrafficStyle & {
  /** A shadow on the ground under airborne aircraft... */
  shadow: boolean
  /** ...and a line down to it. */
  dropLine: boolean
  /** Opacity once parked, times its opacity, so taxiing aircraft stand out. */
  parkedOpacity: number
}

/** A newly seen aircraft's trail keeps the longer of the maps' trail lengths for its kind. */
export function trailSecondsFor(kind: keyof Kinds<unknown>) {
  return Math.max(MAP.traffic[kind].trailSeconds, MAP3D.traffic[kind].trailSeconds)
}

export const MOTION = {
  /**
   * Off: aircraft are predicted ahead to where they should be when the next fetch lands.
   * On: each aircraft waits for two reports, then flies a smooth curve between its
   * reported positions, so the map runs about one fetch behind live.
   */
  delayed: false,
  /** Delayed view: how many reports an aircraft waits for, and so how many fetches (less one) the map runs behind. */
  delayedReports: 2 as 2 | 3,
  /**
   * Near the runways, line arrivals up with the glide path and centerline, and
   * departures with the climb-out, and play out takeoffs (roll, liftoff, climb)
   * between sparse reports. Off: drawn as reported.
   */
  runwayAssist: true,
  /** Keep moving ground traffic on the taxiway and runway centerlines. Off: drawn as reported. */
  taxiwaySnap: true,
  /** How long a newly seen (or just took off) aircraft takes to fade in. */
  fadeInMs: 1000,
  /**
   * Keep gliding an aircraft along its last heading this long after it drops out of
   * the feed (or this many gaps between updates, if longer: the feed is slow)...
   */
  staleMs: 30_000,
  staleUpdates: 2.5,
  /** ...then fade it out over this long. */
  fadeOutMs: 2000,
  /**
   * Aircraft in the latest update stay on screen however slow the next one is, unless
   * no update has arrived for this long: then the feed is down and they all fade.
   */
  feedDownMs: 120_000,
  /** How long an aircraft takes to fade away after it lands. */
  landingFadeMs: 4000,
  /** An aircraft that vanishes from the feed below this altitude (feet) is assumed to have landed. */
  landingAltitudeFt: 2000,
}

export const MAP = {
  /** Flat map ('2d') or a tilted 3D map with aircraft at altitude ('3d'); the 2D/3D button switches. */
  view: '2d' as '2d' | '3d',
  /** Arrivals at, departures from, and other traffic around AIRPORT, each styled separately. */
  traffic: withExtras<Omit<MapTrafficStyle, keyof TrafficStyle>>({ ...TRAIL_DEFAULTS, trailWidth: 1.5 }),

  /** Size of the aircraft arrows, in pixels. */
  planeSize: 9,
  /** Debug: draw the path each arrival/departure will fly until the next fetch lands, on both maps. */
  showPredictions: false,
  /**
   * The landing and takeoff paths aircraft are being guided along near the
   * runways (the glide path down to touchdown, the climb-out), in the arrival
   * and departure colors, 2D and 3D.
   */
  showAssistPaths: false,
  /** Show callsign + altitude (hundreds of feet) next to each aircraft. */
  showLabels: true,
  labelSize: 12,
  /**
   * Labels move to a free spot around their aircraft. If none is free right next
   * to it, they sit this many pixels farther out with a leader line back to it.
   */
  labelLeaderLength: 28,
  /** Hide labels of background (white) traffic when there's no free spot; arrivals/departures always show. */
  hideCrowdedLabels: true,
  /** Font for map labels; JetBrains Mono is bundled with the app (the board uses it too). */
  fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',


  /** Show the lie of the land: hill shading on the 2D map, real relief on the 3D map. */
  terrain: false,
  /** Strength of the hill shading. */
  terrainShading: 0.8,

  /** Distance between the range rings, in nautical miles. */
  ringSpacingNm: 10,

  /**
   * Weather radar under the aircraft: NOAA MRMS, all NEXRAD radars merged and
   * quality-controlled. Covers the continental US (and nearby, e.g. Toronto);
   * elsewhere, such as Frankfurt, there's no radar.
   */
  radar: {
    enabled: true,
    /** New MRMS scans arrive about every 2 minutes. */
    refreshMs: 2 * 60_000,
    opacity: 0.25,
    /** Hide the weakest returns (mostly clutter, birds and drizzle) and show only rain and storms. */
    hideLightEchoes: true,
  },
}

// ---- 3D map ---------------------------------------------------------------------------

export const MAP3D = {
  /** Aircraft size in pixels from the starting camera distance (separate from the 2D map's MAP.planeSize). */
  planeSize: 9,
  /** Arrivals, departures and other traffic, styled separately from the 2D map. */
  traffic: withExtras<Omit<Map3DTrafficStyle, keyof TrafficStyle>>({
    ...TRAIL_DEFAULTS,
    curtain: true,
    curtainOpacity: 0.12,
    dropLine: true,
    groundDot: true,
    route: false,
    routeLengthNm: 120,
  }),
  /** Heights are drawn this many times taller than real, so climbs and descents read at this scale. */
  altitudeScale: 4,
  /** Keep aircraft the same size on screen at any zoom, instead of a fixed size in the world that grows as you zoom in. */
  fixedScreenSize: false,
  /** Slowly circle the camera around the point it looks at, keeping its tilt and distance (the orbit button). */
  orbit: false,
  /** Which way the camera circles, seen from above. */
  orbitDirection: 'clockwise' as 'clockwise' | 'counterclockwise',
  /** How fast it circles, in degrees per second. */
  orbitSpeed: 4,
  /** A faint heading tape along the top, with the camera's altitude beside it. */
  showHud: true,
  /**
   * The airport's runways, taxiways, aprons and buildings on the map at true size
   * (flattening the terrain under them), drawn while the camera's within
   * airportRangeNm of it; further out, or when off, the map's simple runways show instead.
   */
  showAirport: true,
  /** Aircraft on the ground at the airport (taxiing and parked), drawn while the camera's within airportRangeNm of it. */
  showGroundTraffic: true,
  /** How close (nautical miles) the camera has to be to the airport for its model and ground traffic to be drawn. */
  airportRangeNm: 30,
  /**
   * With the camera within trueSizeRangeNm of the airport, aircraft that close
   * to it too (departing, or on final) are drawn at true size, matching its
   * runways, rather than enlarged.
   */
  trueSizeNearAirport: true,
  trueSizeRangeNm: 15,
}

// ---- 3D airport view ----------------------------------------------------------------
// The airport layout comes from frontend/public/basemaps/<CODE>-layout.json,
// built by scripts/build_airport_layout.py.

export const DIORAMA = {
  enabled: true,
  /** Stop the 3D view from being moved, resized or rotated (the lock button next to settings). */
  locked: false,
  /** Draw the outline of the box around the airport. */
  showBox: true,
  /** Blur the map behind the 3D view by this many pixels (0 = off), fading out toward its edges... */
  backdropBlur: 0,
  /** ...and/or darken it with a soft gradient this opaque in the middle (0 = off). */
  backdropDarkness: 0,
  /** Both fade in over this many pixels inside the box's outline, rather than stopping at a hard edge. */
  backdropFeather: 20,
  /** Aircraft within this many nm of the airport are shown (matches RADIUS_NM in the layout script). */
  radiusNm: 2.6,
  /** Starting view (and where double-click resets it): turned clockwise this many degrees; 0 has north straight up. */
  rotationDeg: 35,
  /** How steeply the view looks down: 90 is straight down, lower is more tilted. Dragging keeps it between 10 and 90. */
  elevationDeg: 42,
  /** Airborne aircraft below this height above the field (feet) fly inside the box. */
  maxHeightFt: 1500,
  /** Height of the box as a fraction of its longer side; maxHeightFt reaches the top. */
  boxHeight: 0.18,
  /** Buildings are drawn this many times taller than real so they stand out at this scale. */
  buildingHeightScale: 4,
  /** Arrivals, departures and other traffic, styled separately from the maps. */
  traffic: withExtras<Omit<DioramaTrafficStyle, keyof TrafficStyle>>({ shadow: true, dropLine: true, parkedOpacity: 0.45 }),
  /** Draw aircraft as shaded 3D models (WebGL); off draws flat silhouettes. */
  models3d: true,
  /**
   * Aircraft are drawn this many times their real size (from their type), so
   * a 777 is visibly bigger than an E175...
   */
  planeScale: 5,
  /** ...but never shorter than this many meters, so light aircraft stay visible. */
  minPlaneLengthM: 90,
  /** A ground aircraft slower than this (knots)... */
  parkedSpeedKt: 2,
  /** ...for this long counts as parked. */
  parkedAfterMs: 60_000,
  /** Parked aircraft often switch their transponders off; keep showing them this long after they vanish. */
  keepParkedMs: 3 * 3_600_000,
  /** Taxiing aircraft that vanish from the feed fade out after this long. */
  staleMs: 30_000,
}

// ---- Weather (METAR) --------------------------------------------------------------

export const METAR = {
  /** METARs are issued hourly (plus specials when weather changes); checking every 5 minutes catches both. */
  refreshMs: 5 * 60_000,
}

// ---- ATIS ---------------------------------------------------------------------------

export const ATIS = {
  /** ATIS is reissued hourly and whenever runways or conditions change. */
  refreshMs: 5 * 60_000,
  /** How long each sentence of the ATIS text stays up before the next fades in. */
  lineMs: 6000,
}

// ---- Arrivals / departures board ---------------------------------------------

export const BOARD = {
  rowsPerPage: 7,
  /** How long each page stays up before flipping to the next. */
  pageMs: 8000,
  /** Keep landed flights on the arrivals board this long, like a real airport board. */
  landedLingerMs: 3 * 60_000,
  /** How long a flight that just landed / took off is announced in its board's header (unless a newer one replaces it). */
  eventMs: 15_000,
  /** Arrivals closer than this (nautical miles) show "Approach" instead of "En route". */
  approachNm: 12,
  /**
   * Departures appear on the board while still on the ground within this many nm
   * of the airport (from when their transponder comes on, usually at pushback).
   */
  groundDepartureNm: 4,
  /** Departures below this altitude (feet) show "Climbing", above it "Departed". */
  climbingBelowFt: 10_000,
  /** Show times as 15:39 instead of 3:39 PM (leaves more room for city names). */
  use24Hour: false,

  /** Split-flap animation: how each changed character flips into place. */
  flip: {
    /** Duration of a single flap. */
    stepMs: 55,
    /** Each changed character flips through this many random characters (picked at random in range)... */
    minSteps: 2,
    maxSteps: 7,
    /** ...starting this much later than the character to its left... */
    charStaggerMs: 14,
    /** ...and this much later than the row above, so changes cascade down the board. */
    rowStaggerMs: 70,
  },
}

// ---- Saved settings -----------------------------------------------------------------

/** The setting groups above, by name, so settings can be addressed by path. */
export const CONFIG = { FEED, MOTION, MAP, MAP3D, DIORAMA, METAR, ATIS, BOARD }

/** The values above before any saved settings, for resetting. */
export const CONFIG_DEFAULTS: typeof CONFIG = structuredClone(CONFIG)

/** Reads a setting by path, e.g. "MAP.radar.opacity". */
export function getConfigValue(path: string, from: object = CONFIG): unknown {
  return path.split('.').reduce<unknown>((obj, key) => (obj as Record<string, unknown> | undefined)?.[key], from)
}

/** Changes a setting by path in place; everything reads the shared objects, so it takes effect at once. */
export function setConfigValue(path: string, value: unknown) {
  const keys = path.split('.')
  const last = keys.pop()!
  const parent = getConfigValue(keys.join('.')) as Record<string, unknown> | undefined
  if (!parent || !(last in parent)) return
  // Dropdowns hand over text, so "3" for a number setting is read as 3.
  if (typeof parent[last] === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    value = Number(value)
  }
  // Ignore paths that no longer exist (e.g. saved by an older version) or values of the wrong type.
  if (typeof parent[last] !== typeof value) return
  parent[last] = value
}

for (const [path, value] of Object.entries(loadSavedSettings())) {
  if (path !== 'AIRPORT') setConfigValue(path, value)
}
