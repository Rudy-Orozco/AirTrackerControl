import { fetchBasemap } from '../../services/api/basemap'
import type { Basemap } from '../../types/airport'
import { AIRPORT, MAP, MINIMAP } from '../../config/config'
import { loadRadar, RADAR_AVAILABLE, type Radar } from './radar'
import { loadTerrain, type Terrain } from './terrain'

export interface MapLayers {
  basemap: Basemap | null
  radar: Radar | null
  terrain: Terrain | null
}

/**
 * Loads the airport's basemap, keeps the weather radar fresh, and loads the
 * terrain once it's turned on, calling `onChange` whenever any arrives. All are
 * optional: maps draw without them until they load, or if they're missing.
 * Returns a function to stop.
 */
export function watchMapLayers(onChange: (layers: MapLayers) => void): () => void {
  const controller = new AbortController()
  let basemap: Basemap | null = null
  let radar: Radar | null = null
  let terrain: Terrain | null = null
  const changed = () => onChange({ basemap, radar, terrain })

  fetchBasemap(AIRPORT, controller.signal)
    .then((map) => {
      basemap = map
      changed()
    })
    .catch((err) => {
      if (!controller.signal.aborted) console.warn('Basemap unavailable:', err)
    })

  const refreshRadar = () =>
    loadRadar(controller.signal)
      .then((r) => {
        radar = r
        changed()
      })
      .catch((err) => {
        if (!controller.signal.aborted) console.warn('Radar unavailable:', err)
      })
  const radarOn = MAP.radar.enabled && RADAR_AVAILABLE
  const radarTimer = radarOn ? setInterval(refreshRadar, MAP.radar.refreshMs) : undefined
  if (radarOn) refreshRadar()

  // Terrain is ~1 MB of tiles, so it's only fetched once the setting is on (checked each second).
  let terrainState: 'idle' | 'loading' | 'done' = 'idle'
  const checkTerrain = () => {
    if (!(MAP.terrain || MINIMAP.terrain) || terrainState !== 'idle') return
    terrainState = 'loading'
    loadTerrain(controller.signal)
      .then((t) => {
        terrain = t
        terrainState = 'done'
        changed()
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        console.warn('Terrain unavailable:', err)
        // Try again in a minute.
        setTimeout(() => (terrainState = 'idle'), 60_000)
      })
  }
  const terrainTimer = setInterval(checkTerrain, 1000)
  checkTerrain()

  return () => {
    controller.abort()
    clearInterval(radarTimer)
    clearInterval(terrainTimer)
  }
}
