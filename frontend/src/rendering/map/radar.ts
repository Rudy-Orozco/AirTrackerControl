import { CENTER, FETCH_RADIUS_NM } from '../../config/config'
import { fetchLatestRadarTime, fetchRadarImage, PRECIP_TYPE_LAYER, RADAR_COVERAGE, REFLECTIVITY_LAYER } from '../../services/api/radar'

/** What's falling at a point. */
export const PRECIP = { none: 0, rain: 1, snow: 2, hail: 3 } as const
export type PrecipKind = (typeof PRECIP)[keyof typeof PRECIP]

/**
 * The radar over `bounds`: the image the maps draw, and per pixel (row-major,
 * north row first, `size` across) what's reaching the ground there and how
 * hard (0–255, light to the heaviest storms); plus when it was scanned.
 */
export interface Radar {
  image: HTMLCanvasElement
  bounds: { west: number; south: number; east: number; north: number }
  validTime: Date | null
  size: number
  kind: Uint8Array
  intensity: Uint8Array
}

/** Same area as the aircraft query, so radar covers the whole screen (the 3D map's clouds use it too). */
export const MAP_BOUNDS = (() => {
  const dLat = FETCH_RADIUS_NM / 60
  const dLon = FETCH_RADIUS_NM / (60 * Math.cos((CENTER.lat * Math.PI) / 180))
  return { west: CENTER.lon - dLon, south: CENTER.lat - dLat, east: CENTER.lon + dLon, north: CENTER.lat + dLat }
})()
/** Roughly the radar's 1 km resolution across the area. */
const IMAGE_SIZE = 1024

/** Whether the radar covers the airport being shown. */
export const RADAR_AVAILABLE =
  CENTER.lon > RADAR_COVERAGE.west && CENTER.lon < RADAR_COVERAGE.east && CENTER.lat > RADAR_COVERAGE.south && CENTER.lat < RADAR_COVERAGE.north

/**
 * The latest scan: reflectivity colors for how hard it's coming down, shown
 * only where MRMS's surface precipitation type says it's reaching the ground
 * (echoes aloft that evaporate first, and weak non-precipitation echoes, are
 * left out), with snow and hail in colors of their own. Without the type (if
 * it fails to load), every echo shows, as rain.
 */
export async function loadRadar(signal: AbortSignal): Promise<Radar> {
  // Ask for the latest scan by its time, so the images and the time shown match.
  const validTime = await fetchLatestRadarTime(signal)
  const [reflectivity, type] = await Promise.all([
    fetchRadarImage(REFLECTIVITY_LAYER, MAP_BOUNDS, IMAGE_SIZE, validTime, signal),
    fetchRadarImage(PRECIP_TYPE_LAYER, MAP_BOUNDS, IMAGE_SIZE, validTime, signal).catch((err) => {
      if (signal.aborted) throw err
      console.warn('Radar precipitation type unavailable; showing every echo:', err)
      return null
    }),
  ])
  return { ...combine(reflectivity, type), bounds: MAP_BOUNDS, validTime }
}

function pixels(image: HTMLImageElement) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = IMAGE_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, IMAGE_SIZE, IMAGE_SIZE)
  return { canvas, ctx, data: ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE) }
}

/** The image to draw, and what's falling where, from the reflectivity and the precipitation type. */
function combine(reflectivity: HTMLImageElement, type: HTMLImageElement | null) {
  const out = pixels(reflectivity)
  const d = out.data.data
  const t = type && pixels(type).data.data
  const n = IMAGE_SIZE * IMAGE_SIZE
  const kind = new Uint8Array(n)
  const intensity = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const echo = d[o + 3] > 0
    const k = t ? (t[o + 3] > 0 ? precipKind(t[o], t[o + 1], t[o + 2]) : PRECIP.none) : echo ? PRECIP.rain : PRECIP.none
    if (k === PRECIP.none) {
      d[o + 3] = 0
      continue
    }
    // Reaching the ground with too weak an echo for the reflectivity to show: the lightest there is.
    const strength = echo ? strengthOf(d[o], d[o + 1], d[o + 2]) : 0
    kind[i] = k
    intensity[i] = Math.round(strength * 255)
    const color = k === PRECIP.snow ? snowColor(strength) : k === PRECIP.hail ? HAIL_COLOR : echo ? null : LIGHTEST_RAIN
    if (color) {
      d[o] = color[0]
      d[o + 1] = color[1]
      d[o + 2] = color[2]
    }
    d[o + 3] = 255
  }
  out.ctx.putImageData(out.data, 0, 0)
  return { image: out.canvas, size: IMAGE_SIZE, kind, intensity }
}

/**
 * The precipitation type layer's colors, by MRMS category (worked out from
 * where they fall against the weather airports report; the server publishes no
 * legend): stratiform rain warm and cold, convective rain, the two tropical
 * mixes, snow, and rain with hail.
 */
const TYPE_COLORS: [number, number, number, PrecipKind][] = [
  [4, 80, 164, PRECIP.rain],
  [110, 255, 255, PRECIP.rain],
  [0, 249, 0, PRECIP.rain],
  [0, 151, 0, PRECIP.rain],
  [255, 50, 50, PRECIP.rain],
  [200, 200, 200, PRECIP.snow],
  [150, 0, 150, PRECIP.hail],
]

function precipKind(r: number, g: number, b: number): PrecipKind {
  let best: PrecipKind = PRECIP.rain
  let bestDistance = Infinity
  for (const [cr, cg, cb, k] of TYPE_COLORS) {
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = k
    }
  }
  return best
}

/**
 * The standard radar reflectivity colors, every 5 dBZ from 5 to 70, which the
 * layer's are close to: how hard it's coming down (0–1, from light rain
 * at 15 dBZ to the heaviest storms at 60) is read from the nearest.
 */
const REFLECTIVITY_COLORS = [
  [4, 233, 231],
  [1, 159, 244],
  [3, 0, 244],
  [2, 253, 2],
  [1, 197, 1],
  [0, 142, 0],
  [253, 248, 2],
  [229, 188, 0],
  [253, 149, 0],
  [253, 0, 0],
  [212, 0, 0],
  [188, 0, 0],
  [248, 0, 253],
  [152, 84, 198],
]

function strengthOf(r: number, g: number, b: number) {
  let best = 0
  let bestDistance = Infinity
  REFLECTIVITY_COLORS.forEach(([cr, cg, cb], i) => {
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  })
  const dbz = 5 + best * 5
  return Math.min(Math.max((dbz - 15) / 45, 0), 1)
}

const LIGHTEST_RAIN: [number, number, number] = [60, 200, 90]
const HAIL_COLOR: [number, number, number] = [255, 70, 220]

/** Snow from pale (light) to deep blue (heavy). */
function snowColor(strength: number): [number, number, number] {
  const t = Math.min(strength * 1.5, 1)
  return [Math.round(215 - 125 * t), Math.round(230 - 100 * t), 255]
}
