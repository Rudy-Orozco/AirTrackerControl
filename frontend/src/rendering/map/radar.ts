import { CENTER, FETCH_RADIUS_NM, MAP } from '../../config/config'
import { fetchLatestRadarTime, fetchRadarImage, RADAR_COVERAGE } from '../../services/api/radar'

/** A radar image covering `bounds`, ready to draw, plus when it was scanned. */
export interface Radar {
  image: HTMLCanvasElement
  bounds: { west: number; south: number; east: number; north: number }
  validTime: Date | null
}

/** Same area as the aircraft query, so radar covers the whole screen. */
const BOUNDS = (() => {
  const dLat = FETCH_RADIUS_NM / 60
  const dLon = FETCH_RADIUS_NM / (60 * Math.cos((CENTER.lat * Math.PI) / 180))
  return { west: CENTER.lon - dLon, south: CENTER.lat - dLat, east: CENTER.lon + dLon, north: CENTER.lat + dLat }
})()
/** Roughly the radar's 1 km resolution across the area. */
const IMAGE_SIZE = 1024

/** Whether the radar covers the airport being shown. */
export const RADAR_AVAILABLE =
  CENTER.lon > RADAR_COVERAGE.west && CENTER.lon < RADAR_COVERAGE.east && CENTER.lat > RADAR_COVERAGE.south && CENTER.lat < RADAR_COVERAGE.north

export async function loadRadar(signal: AbortSignal): Promise<Radar> {
  // Ask for the latest scan by its time, so the image and the time shown match.
  const validTime = await fetchLatestRadarTime(signal)
  const image = await fetchRadarImage(BOUNDS, IMAGE_SIZE, validTime, signal)
  return { image: MAP.radar.hideLightEchoes ? withoutLightEchoes(image) : toCanvas(image), bounds: BOUNDS, validTime }
}

function toCanvas(image: HTMLImageElement) {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return canvas
}

/**
 * Drops the weakest returns, below about 20 dBZ: the blues, cyans and teals of
 * the color scale. MRMS already removes most clutter, birds and insects; what's
 * left down there is mostly drizzle and virga that never reaches the ground. Keeps rain and storms: pure green (~20 dBZ, light rain) through
 * yellow, red and purple.
 */
function withoutLightEchoes(image: HTMLImageElement) {
  const canvas = toCanvas(image)
  const ctx = canvas.getContext('2d')!
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = pixels.data
  for (let i = 0; i < d.length; i += 4) {
    // Weak returns all carry a strong blue component; only red/purple storms also do.
    if (d[i + 2] > 80 && d[i] < 150) d[i + 3] = 0
  }
  despeckle(d, canvas.width, canvas.height)
  ctx.putImageData(pixels, 0, 0)
  return canvas
}

/** Neighborhood checked around each pixel (an 11×11 square, about 5 km)... */
const SPECKLE_RADIUS = 5
/** ...of which at least this share must also be precipitation to keep it. */
const SPECKLE_MIN_FILL = 0.35

/**
 * Removes isolated returns. Rain and storms form solid areas, while leftover
 * clutter is scattered single radar cells, so a pixel survives only if enough
 * of its neighborhood is filled too. Uses a summed-area table, so it's one
 * pass however big the neighborhood is.
 */
function despeckle(d: Uint8ClampedArray, width: number, height: number) {
  const sums = new Uint32Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += d[(y * width + x) * 4 + 3] > 0 ? 1 : 0
      sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row
    }
  }

  const r = SPECKLE_RADIUS
  const minCount = (2 * r + 1) ** 2 * SPECKLE_MIN_FILL
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = (y * width + x) * 4 + 3
      if (d[alpha] === 0) continue
      const x0 = Math.max(0, x - r)
      const y0 = Math.max(0, y - r)
      const x1 = Math.min(width, x + r + 1)
      const y1 = Math.min(height, y + r + 1)
      const w = width + 1
      const count = sums[y1 * w + x1] - sums[y0 * w + x1] - sums[y1 * w + x0] + sums[y0 * w + x0]
      if (count < minCount) d[alpha] = 0
    }
  }
}
