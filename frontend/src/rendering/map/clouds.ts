import { CENTER, FETCH_RADIUS_NM, MAP, MAP3D, METAR } from '../../config/config'
import { fixedGrid } from '../../domain/geo/goesGrid'
import type { StationMetar } from '../../domain/weather/metar'
import { bandCoverAt, CLOUD_BANDS_FT, CLOUD_COVER_AVAILABLE, fetchCloudCover, maskAt, topAt, type CloudCover } from '../../services/api/goes'
import { fetchAreaMetars } from '../../services/api/metar'
import { MAP_BOUNDS } from './radar'

/**
 * Where the clouds are over the map, worked out once for every view that
 * shows them: the 3D map draws each height band as a sheet at its height
 * (map3d/clouds.ts); the 2D map and the minimap draw them all flattened, seen
 * from above (cloudImage).
 *
 * The clouds are the satellite's alone: where there's cloud comes from its
 * 2 km cloud mask; which band it's in, from its 10 km Cloud Cover Layers, and
 * how high its tops are, from its 10 km Cloud Top Height (see goes.ts). A
 * cloudy spot is cloud in a band as far as that band holds the cloud around it
 * (all of it if the band has it all; where several bands share it, each partly
 * see-through). Without the mask, the layers' 10 km cover alone is drawn, as
 * see-through as it's partial. Without the satellite (outside its coverage, or
 * while it's unavailable), there are no clouds.
 *
 * The METARs of the airports around only say what height each band's cloud
 * base is at, which the satellite can't see (see map3d/clouds.ts).
 */
export interface CloudField {
  /** The field is a square this far (nm) from the airport each way: MAP_BOUNDS. */
  radiusNm: number
  /** Pixels across, north row first. */
  size: number
  /** Per height band (CLOUD_BANDS_FT), how opaque (0–1) its cloud is at each pixel; null where a band has none. */
  bands: (Float32Array | null)[]
  /** Per band, the layers the stations report in it, for its cloud base. */
  layers: StationLayer[][]
  /** How high the satellite sees the cloud tops at each pixel, feet above sea level; NaN where it sees none. Null without the tops. */
  topsFt: Float32Array | null
  /** When the satellite scan was taken, if there is one. */
  satelliteTime: Date | null
}

/** A cloud layer an airport reports, placed on the map: nautical miles east (x) and north (y) of the airport shown. */
export interface StationLayer {
  icao: string
  x: number
  y: number
  /** Its base, feet above sea level. */
  baseFt: number
}

/** The field covers the same square as the radar. */
export const CLOUD_BOUNDS = MAP_BOUNDS

/** The METAR covers that are cloud layers (not CLR, SKC and the like). */
const LAYER_COVERS = new Set(['FEW', 'SCT', 'BKN', 'OVC', 'OVX', 'VV'])
const FT_PER_M = 3.28084
const FIELD_PX = 512
const LON_SCALE = Math.cos((CENTER.lat * Math.PI) / 180)
/** Half the width of the area a pixel's cloud is compared with, nautical miles (a 10 km layers cell across)... */
const AROUND_NM = 2.7
/** ...and that cloud edges are softened over. */
const SOFTEN_NM = 0.6

function local(lat: number, lon: number) {
  return { x: (lon - CENTER.lon) * 60 * LON_SCALE, y: (lat - CENTER.lat) * 60 }
}

/** Works out the field from the satellite's `cover` (none without it), with the cloud bases the METARs of `stations` report. */
function buildCloudField(stations: StationMetar[], cover: CloudCover | null): CloudField {
  const radiusNm = FETCH_RADIUS_NM
  const layers: StationLayer[][] = CLOUD_BANDS_FT.map(() => [])
  for (const s of stations) {
    const at = local(s.lat, s.lon)
    for (const { cover: reported, base } of s.clouds ?? []) {
      if (base === null || !LAYER_COVERS.has(reported)) continue
      const baseFt = base + s.elev * FT_PER_M
      const band = CLOUD_BANDS_FT.findIndex(([, top]) => baseFt < top)
      layers[band === -1 ? CLOUD_BANDS_FT.length - 1 : band].push({ icao: s.icaoId, ...at, baseFt })
    }
  }
  const samples = cover ? scanAngles(radiusNm, cover.layersGrid.satelliteLon) : null
  const mask = cover && samples ? maskField(cover, samples, radiusNm) : null
  const bands = CLOUD_BANDS_FT.map((_, band) => (cover && samples ? bandAlpha(band, cover, samples, mask) : null))
  return {
    radiusNm,
    size: FIELD_PX,
    bands,
    layers,
    topsFt: cover?.tops && samples ? topsField(cover, samples, bands) : null,
    satelliteTime: cover?.time ?? null,
  }
}

/** The satellite's scan angles of each pixel. */
type Samples = { x: Float64Array; y: Float64Array }
let cachedSamples: (Samples & { key: string }) | null = null

/**
 * The satellite's scan angles of each pixel, which every product's cells are
 * found from (projecting once instead of per product and band keeps working
 * out the field from stalling the map).
 */
function scanAngles(radiusNm: number, satelliteLon: number) {
  const key = `${radiusNm} ${satelliteLon}`
  if (cachedSamples?.key === key) return cachedSamples
  const n = FIELD_PX
  const x = new Float64Array(n * n)
  const y = new Float64Array(n * n)
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      // Rows run north to south.
      const px = ((col + 0.5) / n - 0.5) * 2 * radiusNm
      const py = (0.5 - (row + 0.5) / n) * 2 * radiusNm
      const scan = fixedGrid(CENTER.lat + py / 60, CENTER.lon + px / (60 * LON_SCALE), satelliteLon)
      x[row * n + col] = scan.x
      y[row * n + col] = scan.y
    }
  }
  cachedSamples = { key, x, y }
  return cachedSamples
}

/**
 * The cloud mask at each pixel, and how much of the area around it (about a
 * layers cell, 10 km) is cloudy; null without the mask.
 */
function maskField(cover: CloudCover, samples: Samples, radiusNm: number) {
  const n = FIELD_PX
  const here = new Float32Array(n * n)
  let any = false
  for (let i = 0; i < here.length; i++) {
    const v = maskAt(cover, samples.x[i], samples.y[i])
    if (v === null) continue
    here[i] = v
    any = true
  }
  if (!any) return null
  const nmPerPx = (2 * radiusNm) / n
  return {
    // Softened a little, so the 2 km cells' square edges don't show.
    here: boxBlur(here, n, Math.max(1, Math.round(SOFTEN_NM / nmPerPx))),
    around: boxBlur(here, n, Math.max(1, Math.round(AROUND_NM / nmPerPx))),
  }
}

/** The satellite's cloud tops at each pixel with cloud in any of `bands`, feet above sea level; NaN elsewhere. */
function topsField(cover: CloudCover, samples: Samples, bands: (Float32Array | null)[]) {
  const tops = new Float32Array(FIELD_PX * FIELD_PX).fill(NaN)
  const cloudy = bands.filter((b): b is Float32Array => b !== null)
  for (let i = 0; i < tops.length; i++) {
    if (cloudy.some((b) => b[i] > 0)) tops[i] = topAt(cover, samples.x[i], samples.y[i]) ?? NaN
  }
  return tops
}

/** How opaque (0–1) each pixel of `band` is: the satellite's cloud in that band. Null if there's none anywhere. */
function bandAlpha(band: number, cover: CloudCover, samples: Samples, mask: ReturnType<typeof maskField>): Float32Array | null {
  const n = FIELD_PX
  const alpha = new Float32Array(n * n)
  let any = false
  for (let i = 0; i < alpha.length; i++) {
    const amount = bandCoverAt(cover, band, samples.x[i], samples.y[i]) ?? 0
    if (mask) {
      // Cloud only where the mask sees it; in this band as far as the band holds the cloud around here.
      if (mask.here[i] < 0.01) continue
      alpha[i] = mask.here[i] * Math.min(amount / Math.max(mask.around[i], 0.05), 1)
    } else alpha[i] = amount
    if (alpha[i] > 0.02) any = true
  }
  return any ? alpha : null
}

/** The mean of the (2r + 1)-pixel square around each pixel, via a summed-area table. */
export function boxBlur(values: Float32Array, n: number, r: number) {
  const sums = new Float64Array((n + 1) * (n + 1))
  for (let y = 0; y < n; y++) {
    let row = 0
    for (let x = 0; x < n; x++) {
      row += values[y * n + x]
      sums[(y + 1) * (n + 1) + x + 1] = sums[y * (n + 1) + x + 1] + row
    }
  }
  const out = new Float32Array(n * n)
  for (let y = 0; y < n; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(n, y + r + 1)
    for (let x = 0; x < n; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(n, x + r + 1)
      const total = sums[y1 * (n + 1) + x1] - sums[y0 * (n + 1) + x1] - sums[y1 * (n + 1) + x0] + sums[y0 * (n + 1) + x0]
      out[y * n + x] = total / ((y1 - y0) * (x1 - x0))
    }
  }
  return out
}

/** Cloud gets past the density threshold over this much more than it, so cut-off cloud has soft edges, not jagged ones. */
export const DENSITY_SOFTNESS = 0.05

/** How much of cloud `density` (0–1) thick is drawn under threshold `minDensity`: none below it, all of it a little above. */
export function densityGate(density: number, minDensity: number) {
  return minDensity <= 0 ? 1 : smoothstep((density - minDensity) / DENSITY_SOFTNESS)
}

export function smoothstep(x: number) {
  const t = Math.min(Math.max(x, 0), 1)
  return t * t * (3 - 2 * t)
}

// ---- Seen from above ---------------------------------------------------------------------

const CLOUD_RGB = [223, 230, 238]
/** The flat maps can be dragged past the field's edges: it fades out over this share of each side. */
const EDGE_FADE = 0.04
const images = new WeakMap<CloudField, { minDensity: number; canvas: HTMLCanvasElement }>()

/**
 * All the bands flattened into one picture, as the 2D map and minimap show
 * them: each pixel as opaque as the cloud in all the bands over it together,
 * leaving out cloud thinner than MAP3D.clouds.minDensity. Covers
 * CLOUD_BOUNDS, north up; made once per field and threshold.
 */
export function cloudImage(field: CloudField): HTMLCanvasElement {
  const minDensity = MAP3D.clouds.minDensity
  const made = images.get(field)
  if (made?.minDensity === minDensity) return made.canvas
  const n = field.size
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = n
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(n, n)
  const d = image.data
  const fade = (k: number) => smoothstep(Math.min(k + 0.5, n - k - 0.5) / (n * EDGE_FADE))
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col
      let clear = 1
      for (const band of field.bands) if (band) clear *= 1 - band[i] * densityGate(band[i], minDensity)
      d[i * 4] = CLOUD_RGB[0]
      d[i * 4 + 1] = CLOUD_RGB[1]
      d[i * 4 + 2] = CLOUD_RGB[2]
      d[i * 4 + 3] = Math.round(255 * (1 - clear) * fade(row) * fade(col))
    }
  }
  ctx.putImageData(image, 0, 0)
  images.set(field, { minDensity, canvas })
  return canvas
}

// ---- Loading -----------------------------------------------------------------------------

/** GOES makes a new scan every 5 minutes; every other one is plenty for clouds (~5.7 MB each, mostly the mask). */
const SATELLITE_REFRESH_MS = 10 * 60_000

/** Clouds are loaded while any view shows them, or the 3D map's rain does: it falls from their bases. */
function cloudsWanted() {
  return MAP.clouds.enabled || MAP3D.clouds.enabled || (MAP3D.precipitation.enabled && MAP.radar.enabled)
}

const listeners = new Set<(field: CloudField | null) => void>()
let field: CloudField | null = null
let stopLoading: (() => void) | null = null

/**
 * Calls `onChange` with the clouds now (if they've loaded) and whenever they
 * change. All the views share one loader, running while any of them watches.
 * Returns a function to stop watching.
 */
export function watchClouds(onChange: (field: CloudField | null) => void): () => void {
  listeners.add(onChange)
  if (field) onChange(field)
  stopLoading ??= startLoading((f) => {
    field = f
    for (const listener of listeners) listener(f)
  })
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) {
      stopLoading?.()
      stopLoading = null
      // Nothing needs them: let the downloads and the field go.
      field = null
    }
  }
}

/**
 * Keeps the satellite's cloud cover, and the METARs of the stations across the
 * map (for the cloud bases), fresh while clouds are on anywhere (checked each
 * second, so turning them on loads them straight away), calling `onChange`
 * with a new field whenever either arrives. Without the satellite (outside its
 * coverage, or until it loads), the field has no clouds. Returns a function to stop.
 */
function startLoading(onChange: (field: CloudField) => void): () => void {
  const controller = new AbortController()
  let stations: StationMetar[] = []
  let cover: CloudCover | null = null
  const update = () => onChange(buildCloudField(stations, cover))
  const feeds = [
    {
      wanted: cloudsWanted,
      refreshMs: METAR.refreshMs,
      load: async () => {
        stations = await fetchAreaMetars(CLOUD_BOUNDS, controller.signal)
      },
      name: 'Cloud reports',
    },
    {
      wanted: () => cloudsWanted() && CLOUD_COVER_AVAILABLE,
      refreshMs: SATELLITE_REFRESH_MS,
      load: async () => {
        cover = await fetchCloudCover(CLOUD_BOUNDS, controller.signal)
      },
      name: 'Satellite cloud cover',
    },
  ].map((feed) => ({ ...feed, loadedAt: -Infinity, loading: false }))

  const check = () => {
    for (const feed of feeds) {
      if (!feed.wanted() || feed.loading || Date.now() - feed.loadedAt < feed.refreshMs) continue
      feed.loading = true
      feed
        .load()
        .then(() => {
          feed.loadedAt = Date.now()
          update()
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          console.warn(`${feed.name} unavailable:`, err)
          // Try again in a minute.
          feed.loadedAt = Date.now() - feed.refreshMs + 60_000
        })
        .finally(() => (feed.loading = false))
    }
  }
  const timer = setInterval(check, 1000)
  check()
  return () => {
    controller.abort()
    clearInterval(timer)
  }
}
