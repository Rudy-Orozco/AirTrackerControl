import { MAP } from '../../config/config'

/**
 * The settings the flat map is drawn with. The 2D map uses MAP; the 3D map's
 * minimap draws the same map with its own (MINIMAP).
 */
export type MapStyle = Pick<
  typeof MAP,
  | 'traffic'
  | 'planeSize'
  | 'showPredictions'
  | 'showLabels'
  | 'labelSize'
  | 'labelLeaderLength'
  | 'hideCrowdedLabels'
  | 'fontFamily'
  | 'terrain'
  | 'terrainShading'
  | 'ringSpacingNm'
  | 'showCompass'
> & { radar: { opacity: number }; clouds: { opacity: number } }

let current: MapStyle = MAP

/** The settings the flat map is being drawn with right now. */
export function mapStyle(): MapStyle {
  return current
}

/** Runs `draw` with the flat map drawn in `style`, then goes back to the one before. */
export function withMapStyle<T>(style: MapStyle, draw: () => T): T {
  const was = current
  current = style
  try {
    return draw()
  } finally {
    current = was
  }
}
