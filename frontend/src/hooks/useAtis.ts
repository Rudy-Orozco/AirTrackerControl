import { useEffect, useState } from 'react'
import { ATIS } from '../config/config'
import type { Atis } from '../domain/weather/atis'
import { fetchAtis } from '../services/api/atis'

const ORDER: Atis['type'][] = ['arr', 'combined', 'dep']

/** Current ATIS broadcasts for `icao`, arrival first, refreshed every ATIS.refreshMs. */
export function useAtis(icao: string): Atis[] {
  const [atis, setAtis] = useState<Atis[]>([])

  useEffect(() => {
    const controller = new AbortController()
    const load = () =>
      fetchAtis(icao, controller.signal)
        .then((list) => setAtis(list.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))))
        .catch((err) => {
          if (!controller.signal.aborted) console.warn('ATIS unavailable:', err)
        })
    load()
    const id = setInterval(load, ATIS.refreshMs)
    return () => {
      controller.abort()
      clearInterval(id)
    }
  }, [icao])

  return atis
}
