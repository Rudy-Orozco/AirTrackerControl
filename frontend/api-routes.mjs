/**
 * The data APIs that don't allow browser requests (no CORS headers), relayed
 * through the app's own server: Vite's proxy while developing (vite.config.ts)
 * and the desktop app's main process (electron/main.mjs).
 *
 * Each route maps a path the page requests (/api/aircraft?lat=..) to the real
 * service URL, or to null for a malformed request.
 */

/** The largest query radius adsb.lol and adsb.fi allow. */
const MAX_RADIUS_NM = 250

/** lat, lon and radius (capped) from an /api/aircraft... request, or null if malformed. */
function pointQuery(path) {
  const params = new URL(path, 'http://localhost').searchParams
  const [lat, lon, radius] = ['lat', 'lon', 'radius'].map((k) => Number(params.get(k)))
  if (![lat, lon, radius].every(Number.isFinite)) return null
  return { lat, lon, radius: Math.min(Math.ceil(radius), MAX_RADIUS_NM) }
}

/** @type {Record<string, { target: string, rewrite: (path: string) => string | null }>} */
export const API_ROUTES = {
  // /api/aircraft?lat=..&lon=..&radius=.. -> adsb.lol's point query.
  '/api/aircraft': {
    target: 'https://api.adsb.lol',
    rewrite: (path) => {
      const q = pointQuery(path)
      return q && `/v2/point/${q.lat}/${q.lon}/${q.radius}`
    },
  },
  // The same from adsb.fi, used when adsb.lol is rate-limiting (src/services/api/aircraft.ts).
  '/api/aircraft-adsbfi': {
    target: 'https://opendata.adsb.fi',
    rewrite: (path) => {
      const q = pointQuery(path)
      return q && `/api/v2/lat/${q.lat}/lon/${q.lon}/dist/${q.radius}`
    },
  },
  // /api/metar?ids=KDFW -> current weather report from aviationweather.gov.
  '/api/metar': {
    target: 'https://aviationweather.gov',
    rewrite: (path) => {
      const ids = new URL(path, 'http://localhost').searchParams.get('ids') ?? ''
      if (!/^[A-Z0-9]{4}$/.test(ids)) return null
      return `/api/data/metar?ids=${ids}&format=json&hours=2`
    },
  },
  // Callsign -> origin/destination lookups.
  '/api/routeset': {
    target: 'https://adsb.im',
    rewrite: () => '/api/0/routeset',
  },
}
