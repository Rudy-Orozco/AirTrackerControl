import { useEffect, useState } from 'react'
import { METAR } from '../config/config'
import type { Metar } from '../domain/weather/metar'
import { fetchMetar } from '../services/api/metar'

/** METARs come hourly; a newest report older than this is likely a stale cached copy. */
const EXPECTED_MAX_AGE_MS = 75 * 60_000
const STALE_RETRY_MS = 60_000

/**
 * The latest METAR for `icao`, refreshed every METAR.refreshMs, or after a
 * minute if the service handed back an out-of-date report (its CDN occasionally
 * serves an old cached copy). Keeps the last report if a refresh fails.
 */
export function useMetar(icao: string): Metar | null {
  const [metar, setMetar] = useState<Metar | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      let delay = METAR.refreshMs
      try {
        const m = await fetchMetar(icao, controller.signal)
        if (m) setMetar((prev) => (prev && prev.obsTime > m.obsTime ? prev : m))
        if (!m || Date.now() - m.obsTime * 1000 > EXPECTED_MAX_AGE_MS) delay = STALE_RETRY_MS
      } catch (err) {
        if (controller.signal.aborted) return
        console.warn('METAR unavailable:', err)
      }
      timer = setTimeout(load, delay)
    }
    load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [icao])

  return metar
}
