import { FEED } from '../../config/config'
import { getImage, withTimeout } from '../http'

/**
 * NOAA's MRMS (Multi-Radar Multi-Sensor) products for the continental US,
 * every NEXRAD radar merged, updated about every 2 minutes:
 *
 * - Quality-controlled base reflectivity: how strong the echoes are, with
 *   ground clutter, birds and insects filtered out.
 * - Surface precipitation type: where precipitation is reaching the ground,
 *   and what kind (rain, snow, hail...), from the lowest radar beams and
 *   model temperatures. Echoes it leaves out evaporate before landing, or are
 *   too weak to be precipitation.
 *
 * Requested in plain lat/lon (EPSG:4326), which our map projection maps
 * linearly, so the images just stretch onto the map. The server allows browser requests.
 */
export const REFLECTIVITY_LAYER = 'conus_bref_qcd'
export const PRECIP_TYPE_LAYER = 'conus_pcpn_typ'
const wmsUrl = (layer: string) => `https://opengeo.ncep.noaa.gov/geoserver/conus/${layer}/ows`

/** The MRMS CONUS grid. Outside it (e.g. Europe) there's no radar to fetch. */
export const RADAR_COVERAGE = { west: -130, east: -60, south: 20, north: 55 }

export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

/** A square image of `layer` over `bounds`, `size` pixels across, of the scan at `time` (the nearest one; or the latest). */
export function fetchRadarImage(layer: string, bounds: Bounds, size: number, time: Date | null, signal: AbortSignal): Promise<HTMLImageElement> {
  const { west, south, east, north } = bounds
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.1',
    REQUEST: 'GetMap',
    LAYERS: layer,
    STYLES: '',
    SRS: 'EPSG:4326',
    BBOX: [west, south, east, north].map((v) => v.toFixed(4)).join(','),
    WIDTH: `${size}`,
    HEIGHT: `${size}`,
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
  })
  if (time) params.set('TIME', time.toISOString())
  return getImage(`${wmsUrl(layer)}?${params}`, { signal: withTimeout(signal, FEED.requestTimeoutMs * 2) })
}

/** The newest reflectivity scan's time, the default of the layer's time dimension in its capabilities; null if unknown. */
export async function fetchLatestRadarTime(signal: AbortSignal): Promise<Date | null> {
  try {
    const params = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetCapabilities' })
    const res = await fetch(`${wmsUrl(REFLECTIVITY_LAYER)}?${params}`, { signal: withTimeout(signal, FEED.requestTimeoutMs) })
    const match = (await res.text()).match(/<Dimension[^>]*name="time"[^>]*default="([^"]+)"/)
    const time = match ? new Date(match[1]) : null
    return time && !Number.isNaN(time.getTime()) ? time : null
  } catch (err) {
    if (signal.aborted) throw err
    // Without a time, ask for the default (latest) scan and show no timestamp.
    return null
  }
}
