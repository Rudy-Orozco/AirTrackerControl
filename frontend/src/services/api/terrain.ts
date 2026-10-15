import { FEED } from '../../config/config'
import { getImage, withTimeout } from '../http'

/** The AWS Terrain Tiles dataset (Mapzen "terrarium" PNGs: free, worldwide, no key, browser requests allowed). */
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

/** One 256-pixel elevation tile in Web Mercator tile coordinates. */
export function fetchTerrainTile(zoom: number, x: number, y: number, signal: AbortSignal): Promise<HTMLImageElement> {
  return getImage(`${TILE_URL}/${zoom}/${x}/${y}.png`, { signal: withTimeout(signal, FEED.requestTimeoutMs) })
}
