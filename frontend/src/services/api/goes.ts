import { CENTER, FEED } from '../../config/config'
import { fixedGrid, sampleGrid, type Box, type GoesGrid } from '../../domain/geo/goesGrid'
import { withTimeout } from '../http'
import type { DecodeRequest, DecodeResult } from './goesWorker'

/**
 * GOES satellite clouds, from two of NOAA's products, both made every 5
 * minutes, day and night, over the continental US and nearby, and read
 * straight from NOAA's open data bucket on AWS (which allows browser requests):
 *
 * - Clear Sky Mask (ABI-L2-ACMC): whether each ~2 km cell is cloudy. Where the
 *   clouds are, edges and all. About 5 MB a scan.
 * - Cloud Cover Layers (ABI-L2-CCLC): how much of each ~10 km cell is cloudy
 *   in each of five height bands. Which height the clouds are at. About 440 KB.
 * - Cloud Top Height (ABI-L2-ACHAC): how high the tops of the clouds the
 *   satellite sees are, over each ~10 km cell. About 300 KB.
 *
 * Each is decoded in a worker (goesWorker.ts) and cut down to the map's area;
 * nothing else of the files is kept, and they're fetched past the browser's
 * cache so no copies pile up on disk.
 */

/** Each band's floor and ceiling, feet above sea level: CF1 to CF5. */
export const CLOUD_BANDS_FT: [number, number][] = [
  [0, 5000],
  [5000, 10_000],
  [10_000, 18_000],
  [18_000, 24_000],
  [24_000, 45_000],
]

export interface CloudCover {
  /** When the scan was taken. */
  time: Date
  /** Per band, row-major percentages (0–100) over `layersGrid`; anything over 100 is missing. */
  layersGrid: GoesGrid
  bands: Uint16Array[]
  /** The clear sky mask over `maskGrid`, if it loaded: 0 clear, 1 probably clear, 2 probably cloudy, 3 cloudy. */
  maskGrid: GoesGrid | null
  mask: Uint16Array | null
  /** Cloud top heights over `topsGrid`, if they loaded, packed (see topAt). */
  topsGrid: GoesGrid | null
  tops: Uint16Array | null
}

/** GOES West sees the western US best, GOES East the rest. */
const SATELLITES = [
  { bucket: 'noaa-goes18', lon: -137 },
  { bucket: 'noaa-goes19', lon: -75 },
]
const SPLIT_LON = -106

/** The satellite that covers the airport, or null outside GOES CONUS coverage (e.g. Europe, Alaska). */
function satellite() {
  const s = CENTER.lon < SPLIT_LON ? SATELLITES[0] : SATELLITES[1]
  const { x, y } = fixedGrid(CENTER.lat, CENTER.lon, s.lon)
  // Roughly the CONUS sectors' extent.
  return Math.abs(x) < 0.07 && y > 0.044 && y < 0.128 ? s : null
}

export const CLOUD_COVER_AVAILABLE = satellite() !== null

/**
 * The newest scan over `box`. The cloud mask and the cloud tops are optional:
 * without the mask, only the layers' 10 km cells are known; without the tops,
 * how thick the clouds are isn't.
 */
export async function fetchCloudCover(box: Box, signal: AbortSignal): Promise<CloudCover> {
  const sat = satellite()
  if (!sat) throw new Error('No GOES coverage here')
  const base = `https://${sat.bucket}.s3.amazonaws.com`
  const optional = (product: string, name: string, what: string) =>
    latestKey(base, product, signal)
      .then((key) => load(base, key, [name], box, sat.lon, signal))
      .catch((err) => {
        if (signal.aborted) throw err
        console.warn(`Satellite ${what} unavailable:`, err)
        return null
      })
  const layersKey = await latestKey(base, 'ABI-L2-CCLC', signal)
  const [layers, mask, tops] = await Promise.all([
    load(base, layersKey, ['CF1', 'CF2', 'CF3', 'CF4', 'CF5'], box, sat.lon, signal),
    optional('ABI-L2-ACMC', 'ACM', 'cloud mask'),
    optional('ABI-L2-ACHAC', 'HT', 'cloud tops'),
  ])
  return {
    time: scanTime(layersKey),
    layersGrid: layers.grid,
    bands: layers.values,
    maskGrid: mask?.grid ?? null,
    mask: mask?.values[0] ?? null,
    topsGrid: tops?.grid ?? null,
    tops: tops?.values[0] ?? null,
  }
}

/** The newest file of `product`. Files are filed by UTC hour; just after the hour, the newest is in the previous one. */
async function latestKey(base: string, product: string, signal: AbortSignal) {
  for (let hoursBack = 0; hoursBack < 3; hoursBack++) {
    const at = new Date(Date.now() - hoursBack * 3_600_000)
    const day = Math.floor((at.getTime() - Date.UTC(at.getUTCFullYear(), 0, 1)) / 86_400_000) + 1
    const prefix = `${product}/${at.getUTCFullYear()}/${String(day).padStart(3, '0')}/${String(at.getUTCHours()).padStart(2, '0')}/`
    const res = await fetch(`${base}/?list-type=2&prefix=${prefix}`, { cache: 'no-store', signal: withTimeout(signal, FEED.requestTimeoutMs) })
    if (!res.ok) throw new Error(`GOES listing: HTTP ${res.status}`)
    const keys = [...(await res.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).sort()
    if (keys.length) return keys[keys.length - 1]
  }
  throw new Error(`No recent ${product}`)
}

/** Downloads a file and decodes `names` from it, cut down to `box`, in a worker that's closed straight after. */
async function load(base: string, key: string, names: string[], box: Box, satelliteLon: number, signal: AbortSignal) {
  const res = await fetch(`${base}/${key}`, { cache: 'no-store', signal: withTimeout(signal, FEED.requestTimeoutMs * 6) })
  if (!res.ok) throw new Error(`GOES ${key}: HTTP ${res.status}`)
  const buffer = await res.arrayBuffer()
  const worker = new Worker(new URL('./goesWorker.ts', import.meta.url), { type: 'module' })
  try {
    const result = await new Promise<DecodeResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<DecodeResult>) => resolve(e.data)
      worker.onerror = (e) => reject(new Error(e.message))
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      const request: DecodeRequest = { buffer, names, box, satelliteLon }
      // Handed over rather than copied: this side lets go of the download.
      worker.postMessage(request, [buffer])
    })
    if (!result.ok) throw new Error(result.error)
    return result
  } finally {
    worker.terminate()
  }
}

/** From the file name's scan start, e.g. "_s20262890126176_" (year, day of year, hh mm ss, tenths). */
function scanTime(key: string) {
  const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/.exec(key)
  if (!m) return new Date()
  const [year, day, h, min, s] = m.slice(1).map(Number)
  return new Date(Date.UTC(year, 0, day, h, min, s))
}

/** How cloudy (0–1) the layers say `band` is at a point (its scan angles, from fixedGrid), blended between cells; null where there's no data. */
export function bandCoverAt(cover: CloudCover, band: number, x: number, y: number) {
  return sampleGrid(cover.layersGrid, cover.bands[band], x, y, (v) => (v > 100 ? null : v / 100))
}

/**
 * How cloudy (0–1) the mask says a point is, blended between its 2 km cells:
 * "probably" cloudy or clear count for part, so cloud edges come out soft.
 */
export function maskAt(cover: CloudCover, x: number, y: number) {
  if (!cover.maskGrid || !cover.mask) return null
  return sampleGrid(cover.maskGrid, cover.mask, x, y, (v) => MASK_CLOUDINESS[v] ?? null)
}

const MASK_CLOUDINESS = [0, 0.15, 0.65, 1]

/**
 * How high (feet above sea level) the tops of the clouds the satellite sees at
 * a point are, blended between cells; null where it sees none, or without the tops.
 */
export function topAt(cover: CloudCover, x: number, y: number) {
  if (!cover.topsGrid || !cover.tops) return null
  return sampleGrid(cover.topsGrid, cover.tops, x, y, (v) => (v > TOP_VALID_MAX ? null : v * TOP_SCALE_FT))
}

/** Tops are packed as whole numbers of 0.3052037 m (20 km over the range), 65535 for none. */
const TOP_SCALE_FT = 0.3052037 * 3.28084
const TOP_VALID_MAX = 65530
