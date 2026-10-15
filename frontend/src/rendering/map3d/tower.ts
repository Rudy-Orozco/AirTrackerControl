import { AIRPORT_PRESET, MAP, MAP3D, MINIMAP } from '../../config/config'
import { local, type StreetSpot } from './map3d'

/**
 * Tower view (MAP3D.tower): standing in the airport's control tower cab, at
 * the controllers' eye height, first facing the middle of the airport. Null
 * for airports without a tower in airports.json.
 */
export const TOWER_SPOT: StreetSpot | null = (() => {
  const tower = AIRPORT_PRESET.tower
  if (!tower) return null
  const { x, y } = local(tower)
  return { x, y, eyeFt: tower.eyeFt, heading: ((Math.atan2(-x, -y) * 180) / Math.PI + 360) % 360 }
})()

/** Whether tower view is on, on the 3D map, at an airport with a tower. */
export function inTowerView() {
  return MAP.view === '3d' && MAP3D.tower && TOWER_SPOT !== null
}

/** Whether the 3D map has the minimap in the board: chosen as its layout, or in tower view. */
export function minimapInBoard() {
  return MAP.view === '3d' && (MINIMAP.layout === 'board' || inTowerView())
}

/** Whether the 3D map shows the minimap at all. */
export function minimapShown() {
  return MAP.view === '3d' && (MINIMAP.layout !== 'off' || inTowerView())
}
