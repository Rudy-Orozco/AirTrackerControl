import { CENTER, FETCH_RADIUS_NM } from '../../config/config'
import { fetchTerrainTile } from '../../services/api/terrain'

/**
 * Ground elevation around the airport from the AWS Terrain Tiles dataset
 * (Mapzen "terrarium" PNGs: free, worldwide, no key, browser requests allowed),
 * resampled onto a regular lat/lon grid covering the same area as the aircraft
 * query.
 */
export interface Terrain {
  /** Grid points per side. */
  size: number
  /** Meters above sea level, row by row from the north-west corner. */
  heights: Float32Array
  bounds: { west: number; south: number; east: number; north: number }
  /** Hill shading for the grid, as a canvas to stretch over the map. */
  shade: HTMLCanvasElement
}

/** Zoom 9 tiles are ~60 km across: about 25 tiles, at ~150 m per pixel, for the area. */
const ZOOM = 9
const TILE = 256
const GRID = 768

export const TERRAIN_BOUNDS = (() => {
  const dLat = FETCH_RADIUS_NM / 60
  const dLon = FETCH_RADIUS_NM / (60 * Math.cos((CENTER.lat * Math.PI) / 180))
  return { west: CENTER.lon - dLon, south: CENTER.lat - dLat, east: CENTER.lon + dLon, north: CENTER.lat + dLat }
})()

export async function loadTerrain(signal: AbortSignal): Promise<Terrain> {
  const { west, south, east, north } = TERRAIN_BOUNDS
  // Web Mercator tile coordinates covering the area.
  const scale = 2 ** ZOOM
  const tileX = (lon: number) => ((lon + 180) / 360) * scale
  const tileY = (lat: number) => {
    const φ = (lat * Math.PI) / 180
    return ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * scale
  }
  const [x0, x1] = [Math.floor(tileX(west)), Math.floor(tileX(east))]
  const [y0, y1] = [Math.floor(tileY(north)), Math.floor(tileY(south))]

  // Stitch the tiles into one image.
  const mosaic = document.createElement('canvas')
  mosaic.width = (x1 - x0 + 1) * TILE
  mosaic.height = (y1 - y0 + 1) * TILE
  const ctx = mosaic.getContext('2d', { willReadFrequently: true })!
  const jobs: Promise<void>[] = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(fetchTerrainTile(ZOOM, x, y, signal).then((img) => ctx.drawImage(img, (x - x0) * TILE, (y - y0) * TILE)))
    }
  }
  await Promise.all(jobs)
  const pixels = ctx.getImageData(0, 0, mosaic.width, mosaic.height).data

  // Terrarium encodes meters as (R × 256 + G + B / 256) − 32768.
  const at = (x: number, y: number) => {
    const i = (Math.min(Math.max(y, 0), mosaic.height - 1) * mosaic.width + Math.min(Math.max(x, 0), mosaic.width - 1)) * 4
    return pixels[i] * 256 + pixels[i + 1] + pixels[i + 2] / 256 - 32768
  }
  // Interpolated between tile pixels, so slopes shade smoothly instead of in steps.
  const elevation = (px: number, py: number) => {
    const [x, y] = [Math.floor(px - 0.5), Math.floor(py - 0.5)]
    const [u, v] = [px - 0.5 - x, py - 0.5 - y]
    return (at(x, y) * (1 - u) + at(x + 1, y) * u) * (1 - v) + (at(x, y + 1) * (1 - u) + at(x + 1, y + 1) * u) * v
  }
  const heights = new Float32Array(GRID * GRID)
  for (let j = 0; j < GRID; j++) {
    const lat = north - ((north - south) * j) / (GRID - 1)
    const py = (tileY(lat) - y0) * TILE
    for (let i = 0; i < GRID; i++) {
      const lon = west + ((east - west) * i) / (GRID - 1)
      // Water is often encoded as deep negative values; the sea surface is what we see.
      heights[j * GRID + i] = Math.max(elevation((tileX(lon) - x0) * TILE, py), 0)
    }
  }
  const terrain = { size: GRID, heights, bounds: TERRAIN_BOUNDS }
  return { ...terrain, shade: hillshade(terrain) }
}

/** Elevation in meters at a point, interpolated between grid points (0 outside the grid). */
export function elevationAt(t: Pick<Terrain, 'size' | 'heights' | 'bounds'>, lat: number, lon: number): number {
  const { west, south, east, north } = t.bounds
  const fx = ((lon - west) / (east - west)) * (t.size - 1)
  const fy = ((north - lat) / (north - south)) * (t.size - 1)
  if (fx < 0 || fy < 0 || fx > t.size - 1 || fy > t.size - 1) return 0
  const [i, j] = [Math.min(Math.floor(fx), t.size - 2), Math.min(Math.floor(fy), t.size - 2)]
  const [u, v] = [fx - i, fy - j]
  const h = (a: number, b: number) => t.heights[b * t.size + a]
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v
}

/** Relief is subtle at this scale (DFW's hills are ~100 m); exaggerate slopes for shading. */
const SHADE_EXAGGERATION = 4
/** Light from the north-west, 45° up: the cartographic convention. */
const SUN = (() => {
  const [azimuth, altitude] = [(315 * Math.PI) / 180, (45 * Math.PI) / 180]
  return { x: Math.sin(azimuth) * Math.cos(altitude), y: Math.cos(azimuth) * Math.cos(altitude), z: Math.sin(altitude) }
})()

/**
 * Hill shading: slopes facing away from the light darken, slopes facing it
 * lighten, flat ground is left clear.
 */
function hillshade({ size, heights, bounds }: Omit<Terrain, 'shade'>): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(size, size)
  const d = image.data
  const cellX = ((bounds.east - bounds.west) / (size - 1)) * 111_320 * Math.cos((CENTER.lat * Math.PI) / 180)
  const cellY = ((bounds.north - bounds.south) / (size - 1)) * 111_320
  const flat = SUN.z
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h = (a: number, b: number) =>
        heights[Math.min(Math.max(b, 0), size - 1) * size + Math.min(Math.max(a, 0), size - 1)]
      // Slope east and north (rows run north to south).
      const dzdx = ((h(i + 1, j) - h(i - 1, j)) / (2 * cellX)) * SHADE_EXAGGERATION
      const dzdy = ((h(i, j - 1) - h(i, j + 1)) / (2 * cellY)) * SHADE_EXAGGERATION
      const len = Math.hypot(dzdx, dzdy, 1)
      const light = (-dzdx * SUN.x - dzdy * SUN.y + SUN.z) / len
      const k = (j * size + i) * 4
      if (light < flat) {
        d[k + 3] = Math.min(255, (flat - light) * 420)
      } else {
        d[k] = d[k + 1] = 190
        d[k + 2] = 230
        d[k + 3] = Math.min(255, (light - flat) * 260)
      }
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}
