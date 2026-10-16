import { FEED } from '../../config/config'
import { withTimeout } from '../http'
import type { EchoTopsGrid, EchoTopsRequest, EchoTopsResult } from './echoTopsWorker'

/**
 * NOAA's MRMS echo tops: how high, over each ~1 km cell of the continental US,
 * the radars still see an echo of 30 dBZ (moderate rain) or more, every 2
 * minutes. That's the top of a shower's or storm's precipitation core, which
 * in a thunderstorm reaches far up into the cloud. Read from NOAA's open data
 * bucket on AWS (which allows browser requests) as a gzipped GRIB2 file of about
 * 300 KB, decoded in a worker (echoTopsWorker.ts) and cut down to the map's area.
 */
export type EchoTops = EchoTopsGrid & { time: Date }

const BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com'
const PRODUCT = 'CONUS/EchoTop_30_00.50'

/** The newest scan over `box`. */
export async function fetchEchoTops(box: EchoTopsRequest['box'], signal: AbortSignal): Promise<EchoTops> {
  const key = await latestKey(signal)
  const res = await fetch(`${BUCKET}/${key}`, { cache: 'no-store', signal: withTimeout(signal, FEED.requestTimeoutMs * 3) })
  if (!res.ok) throw new Error(`Echo tops: HTTP ${res.status}`)
  const buffer = await res.arrayBuffer()
  const worker = new Worker(new URL('./echoTopsWorker.ts', import.meta.url), { type: 'module' })
  try {
    const result = await new Promise<EchoTopsResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<EchoTopsResult>) => resolve(e.data)
      worker.onerror = (e) => reject(new Error(e.message))
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      const request: EchoTopsRequest = { buffer, box }
      // Handed over rather than copied: this side lets go of the download.
      worker.postMessage(request, [buffer])
    })
    if (!result.ok) throw new Error(result.error)
    return { ...result.grid, time: scanTime(key) }
  } finally {
    worker.terminate()
  }
}

/**
 * The newest file. Files are filed by UTC day, every 2 minutes (about 720 a
 * day): only those from the last half hour are listed, so the listing stays
 * small. Just after midnight, they're in the day before.
 */
async function latestKey(signal: AbortSignal) {
  const since = new Date(Date.now() - 30 * 60_000)
  // E.g. "20261016-050240", as in the file names.
  const stamp = since.toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-')
  for (const daysBack of [0, 1]) {
    const day = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '')
    const prefix = `${PRODUCT}/${day}/`
    const startAfter = `${prefix}MRMS_EchoTop_30_00.50_${stamp}`
    const res = await fetch(`${BUCKET}/?list-type=2&prefix=${prefix}&start-after=${encodeURIComponent(startAfter)}`, {
      cache: 'no-store',
      signal: withTimeout(signal, FEED.requestTimeoutMs),
    })
    if (!res.ok) throw new Error(`Echo tops listing: HTTP ${res.status}`)
    const keys = [...(await res.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).sort()
    if (keys.length) return keys[keys.length - 1]
  }
  throw new Error('No recent echo tops')
}

/** From the file name, e.g. "_20261016-050240.grib2.gz". */
function scanTime(key: string) {
  const m = /_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.grib2/.exec(key)
  if (!m) return new Date()
  const [year, month, day, h, min, s] = m.slice(1).map(Number)
  return new Date(Date.UTC(year, month - 1, day, h, min, s))
}

/**
 * The echo top around a point (feet above sea level) and how much of the area
 * around it has one (0–1), over the 5 × 5 cells (about 3 nm) around it, so the
 * cores taper at their edges; null where none of them has one.
 */
export function echoTopAround(tops: EchoTops, lat: number, lon: number): { heightFt: number; share: number } | null {
  const row = Math.round((tops.north - lat) / tops.step)
  const col = Math.round((lon - tops.west) / tops.step)
  let sum = 0
  let count = 0
  for (let r = row - 2; r <= row + 2; r++) {
    for (let c = col - 2; c <= col + 2; c++) {
      if (r < 0 || c < 0 || r >= tops.ny || c >= tops.nx) continue
      const v = tops.topsFt[r * tops.nx + c]
      if (Number.isNaN(v)) continue
      sum += v
      count++
    }
  }
  return count ? { heightFt: sum / count, share: count / 25 } : null
}
