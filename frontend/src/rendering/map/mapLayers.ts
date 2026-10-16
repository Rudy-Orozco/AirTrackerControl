import { fetchBasemap } from '../../services/api/basemap'
import type { Basemap } from '../../types/airport'
import { AIRPORT, MAP, MAP3D, MINIMAP } from '../../config/config'
import { fetchEchoTops, type EchoTops } from '../../services/api/echoTops'
import { watchClouds, type CloudField } from './clouds'
import { loadRadar, MAP_BOUNDS, RADAR_AVAILABLE, type Radar } from './radar'
import { loadTerrain, type Terrain } from './terrain'

export interface MapLayers {
  basemap: Basemap | null
  radar: Radar | null
  terrain: Terrain | null
  /** Where the clouds are (see clouds.ts), shared by every map. */
  clouds: CloudField | null
  /** How high showers' and storms' precipitation cores reach, for the 3D map's rain (see echoTops.ts). */
  echoTops: EchoTops | null
}

/** MRMS makes new echo tops every 2 minutes; every other one is plenty. */
const ECHO_TOPS_REFRESH_MS = 4 * 60_000

/**
 * Loads the airport's basemap, keeps the weather radar and the clouds fresh
 * (and the echo tops, while the 3D map's rain is on), and loads the terrain
 * once it's turned on, calling `onChange` whenever any arrives. All are
 * optional: maps draw without them until they load, or if they're missing.
 * Returns a function to stop.
 */
export function watchMapLayers(onChange: (layers: MapLayers) => void): () => void {
  const controller = new AbortController()
  let basemap: Basemap | null = null
  let radar: Radar | null = null
  let terrain: Terrain | null = null
  let clouds: CloudField | null = null
  let echoTops: EchoTops | null = null
  const changed = () => onChange({ basemap, radar, terrain, clouds, echoTops })

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

  const stopClouds = watchClouds((field) => {
    clouds = field
    changed()
  })

  // Only needed for the 3D map's rain (checked each second, so turning it on loads them straight away).
  let echoTopsLoadedAt = -Infinity
  let echoTopsLoading = false
  const checkEchoTops = () => {
    const wanted = RADAR_AVAILABLE && MAP.radar.enabled && MAP3D.precipitation.enabled
    if (!wanted || echoTopsLoading || Date.now() - echoTopsLoadedAt < ECHO_TOPS_REFRESH_MS) return
    echoTopsLoading = true
    fetchEchoTops(MAP_BOUNDS, controller.signal)
      .then((tops) => {
        echoTops = tops
        echoTopsLoadedAt = Date.now()
        changed()
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        console.warn('Echo tops unavailable:', err)
        // Try again in a minute.
        echoTopsLoadedAt = Date.now() - ECHO_TOPS_REFRESH_MS + 60_000
      })
      .finally(() => (echoTopsLoading = false))
  }
  const echoTopsTimer = setInterval(checkEchoTops, 1000)
  checkEchoTops()

  return () => {
    controller.abort()
    stopClouds()
    clearInterval(echoTopsTimer)
    clearInterval(radarTimer)
    clearInterval(terrainTimer)
  }
}
