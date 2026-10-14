import { useSyncExternalStore } from 'react'
import type { FlightKind } from '../tracking/flights'
import { AIRPORT, CONFIG_DEFAULTS, getConfigValue, loadSavedSettings, PRESETS, setConfigValue, SETTINGS_KEY } from './config'
import { TRAFFIC_ICONS, trafficLevel } from './traffic'
import { resetAirportStats } from '../tracking/airportStats'
import { downloadProcedures, pickProceduresFile, proceduresSummary, removeImportedProcedures } from '../procedures/procedures'

/**
 * The settings panel's catalogue: which config values it offers and how. Values
 * live in config.ts; changes are applied to those objects in place and saved in
 * this browser (see the end of config.ts).
 */
export type Setting = {
  /** Path into config.ts, e.g. "MAP.radar.opacity", or "AIRPORT". */
  path: string
  label: string
  hint?: string
  /** Takes effect only after the page reloads. */
  reload?: boolean
  /**
   * Only matters while another setting is on (or, with `is`, has that value):
   * shown indented under it, and dimmed while it doesn't apply.
   */
  when?: { path: string; is?: string }
} & (
  | { type: 'toggle' }
  | { type: 'color' }
  /** Up to three short options without groups show as a row of buttons; more, as a dropdown. */
  | { type: 'select'; options: { value: string; label: string; group?: string }[] }
  /**
   * A slider through a few named stops, each setting one or more config values
   * at once (`path` only names it). For choices that read as a scale, like how
   * far behind live to run.
   */
  | { type: 'steps'; stops: { label: string; values: Record<string, unknown> }[] }
  | {
      type: 'range'
      min: number
      max: number
      step: number
      /** Shown divided by this, e.g. 1000 to show milliseconds as seconds. */
      scale?: number
      unit?: string
    }
)

/** Also toggled by the 2D/3D button next to the settings button. */
export const VIEW_SETTING: Setting = {
  path: 'MAP.view',
  label: 'Map view',
  type: 'select',
  hint: 'Flat, or tilted with altitude',
  options: [
    { value: '2d', label: '2D' },
    { value: '3d', label: '3D' },
  ],
}

/** Also toggled by the terrain button in the toolbar. */
export const TERRAIN_SETTING: Setting = {
  path: 'MAP.terrain',
  label: 'Terrain',
  hint: 'Hill shading in 2D, relief in 3D',
  type: 'toggle',
}

/** Also toggled by the orbit button in the toolbar (3D map). */
export const ORBIT_SETTING: Setting = {
  path: 'MAP3D.orbit',
  label: 'Orbit',
  hint: 'Circle around the point the camera looks at',
  type: 'toggle',
}

/** Also toggled by the lock button next to the settings button. */
export const LOCK_SETTING: Setting = {
  path: 'DIORAMA.locked',
  label: 'Lock position',
  hint: 'No moving, resizing or rotating',
  type: 'toggle',
}

/** Also toggled by the minimap's own lock button. */
export const MINIMAP_LOCK_SETTING: Setting = {
  path: 'MINIMAP.locked',
  label: 'Lock position',
  hint: 'No moving or resizing',
  type: 'toggle',
}

/** Also toggled by the minimap's lock button while it's in the board. */
export const MINIMAP_TOWER_LOCK_SETTING: Setting = {
  path: 'MINIMAP.towerLocked',
  label: 'Lock position in the board',
  hint: 'Docked in the board until unlocked and moved',
  type: 'toggle',
}

/** Also toggled in the procedures panel. */
export const IDENTIFY_SETTING: Setting = {
  path: 'PROCEDURES.identify',
  label: 'Identify flights',
  hint: "Work out each flight's procedure, for a followed flight's route, its details and the stats. Off: just for study, nothing running",
  type: 'toggle',
}

/** Also toggled in the procedures panel. */
export const PREDICT_SETTING: Setting = {
  path: 'PROCEDURES.predict',
  label: 'Predicted path',
  hint: "A followed flight's likeliest procedure and branch. Off: only once its path shows one, with every branch",
  type: 'toggle',
}

/** The procedures panel's Waypoints tab: how waypoints on their own are shown. */
export const WAYPOINT_SETTINGS: Setting[] = [
  { path: 'PROCEDURES.showWaypoints', label: 'Show all', hint: 'Every waypoint in the procedures. Off: only those with their eye on below', type: 'toggle' },
  { path: 'PROCEDURES.waypointLabels', label: 'Names', type: 'toggle' },
  {
    path: 'PROCEDURES.waypointAltitude',
    label: 'Altitude (3D map)',
    hint: 'As charted (else on the ground), on the ground, or all at one altitude',
    type: 'select',
    options: [
      { value: 'charted', label: 'Charted' },
      { value: 'ground', label: 'Ground' },
      { value: 'fixed', label: 'Fixed' },
    ],
  },
  { path: 'PROCEDURES.waypointFixedFt', label: 'Altitude', type: 'range', min: 1000, max: 20_000, step: 500, unit: 'ft', when: { path: 'PROCEDURES.waypointAltitude', is: 'fixed' } },
  { path: 'PROCEDURES.waypointDropLine', label: 'Drop line', hint: 'Down to the ground, from one in the air (3D map)', type: 'toggle' },
  { path: 'PROCEDURES.waypointGroundDot', label: 'Ground dot', hint: 'Where the drop line meets the ground', type: 'toggle', when: { path: 'PROCEDURES.waypointDropLine' } },
  { path: 'PROCEDURES.waypointSize', label: 'Size', type: 'range', min: 1, max: 8, step: 0.5, unit: 'px' },
  { path: 'PROCEDURES.waypointOpacity', label: 'Opacity', type: 'range', min: 0.1, max: 1, step: 0.05 },
  { path: 'PROCEDURES.waypointColor', label: 'Color', type: 'color' },
]

/** Also toggled by the tower button in the toolbar (3D map). */
export const TOWER_SETTING: Setting = {
  path: 'MAP3D.tower',
  label: 'Tower view',
  hint: "From the airport's control tower cab, with the minimap docked in the board",
  type: 'toggle',
}

const SECONDS = { scale: 1000, unit: 's' }
const MINUTES = { scale: 60_000, unit: 'min' }
const HOURS = { scale: 3_600_000, unit: 'h' }

/** A titled block of settings, optionally with buttons (e.g. a reset) in its header. */
export interface SettingGroup {
  title: string
  settings: Setting[]
  /** Settings of the kind of traffic picked at the top of the tab (none for kinds it returns nothing for). */
  perKind?: (kind: FlightKind) => Setting[]
  actions?: { label: string; run: () => void; title?: string }[]
  /** A line of status under the title (e.g. what's loaded), worked out each time the panel draws. */
  note?: () => string
}

export const KINDS: FlightKind[] = ['arrival', 'departure', 'other']
export const KIND_LABELS: Record<FlightKind, string> = { arrival: 'Arrivals', departure: 'Departures', other: 'Other' }

/** Builds a group's per-kind settings, with `p` turning "color" into e.g. "MAP.traffic.arrival.color". */
function perKind(view: 'MAP' | 'MAP3D' | 'MINIMAP' | 'DIORAMA', settings: (p: (key: string) => string, kind: FlightKind) => Setting[]) {
  return (kind: FlightKind) => settings((key) => `${view}.traffic.${kind}.${key}`, kind)
}

/** Show, color, opacity and size, in every view. */
const styleSettings = (p: (key: string) => string): Setting[] => [
  { path: p('show'), label: 'Show', type: 'toggle' },
  { path: p('color'), label: 'Color', type: 'color', when: { path: p('show') } },
  { path: p('opacity'), label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05, when: { path: p('show') } },
  { path: p('scale'), label: 'Size', hint: 'Times the size above', type: 'range', min: 0.25, max: 3, step: 0.05, unit: '×', when: { path: p('show') } },
]

/** Trail settings on both maps; the rest only matter while the trail shows. */
const trailSettings = (p: (key: string) => string): Setting[] => [
  { path: p('trail'), label: 'Show trail', type: 'toggle' },
  { path: p('trailSeconds'), label: 'Length', type: 'range', min: 0, max: 600, step: 10, unit: 's', when: { path: p('trail') } },
  { path: p('trailOpacity'), label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05, when: { path: p('trail') } },
  { path: p('trailSmoothing'), label: 'Smoothing', type: 'range', min: 0, max: 16, step: 1, when: { path: p('trail') } },
]

/** Applies to both maps, so it's in both tabs. */
const ASSIST_PATHS_SETTING: Setting = {
  path: 'MAP.showAssistPaths',
  label: 'Landing and takeoff paths',
  hint: 'The glide path and climb-out aircraft are guided along near the runways, 2D and 3D',
  type: 'toggle',
}

/** Applies to both maps, so it's in both tabs. */
const RUNWAY_GUIDES_SETTING: Setting = {
  path: 'MAP.showRunwayGuides',
  label: 'Localizers and glide paths',
  hint: 'On runways in use: the extended centerline arrivals and departures are held to, the glide path (3D), mile bars and the 1000 ft gate',
  type: 'toggle',
}

/** The panel's tabs, each a few groups. */
export const SETTING_TABS: { title: string; groups: SettingGroup[] }[] = [
  {
    title: '2D Map',
    groups: [
      {
        title: 'View',
        settings: [
          VIEW_SETTING,
          TERRAIN_SETTING,
          { path: 'MAP.terrainShading', label: 'Shading', type: 'range', min: 0.1, max: 1.5, step: 0.05, when: { path: 'MAP.terrain' } },
          { path: 'MAP.ringSpacingNm', label: 'Range ring spacing', type: 'range', min: 5, max: 50, step: 5, unit: 'nm' },
          { path: 'MAP.showCompass', label: 'Compass', hint: 'N, E, S and W in the corner', type: 'toggle' },
        ],
      },
      {
        title: 'Aircraft',
        settings: [{ path: 'MAP.planeSize', label: 'Size', type: 'range', min: 4, max: 20, step: 1, unit: 'px' }],
        perKind: perKind('MAP', styleSettings),
      },
      {
        title: 'Guides',
        settings: [
          { path: 'MAP.showPredictions', label: 'Predicted positions', hint: 'Path to the next update for arrivals and departures, 2D and 3D', type: 'toggle' },
          ASSIST_PATHS_SETTING,
          RUNWAY_GUIDES_SETTING,
        ],
      },
      {
        title: 'Labels',
        settings: [
          { path: 'MAP.showLabels', label: 'Show labels', hint: 'All kinds, 2D and 3D', type: 'toggle' },
          { path: 'MAP.labelSize', label: 'Text size', type: 'range', min: 8, max: 20, step: 1, unit: 'px', when: { path: 'MAP.showLabels' } },
          { path: 'MAP.hideCrowdedLabels', label: 'Hide crowded labels', hint: 'Background traffic only', type: 'toggle', when: { path: 'MAP.showLabels' } },
          { path: 'MAP.labelLeaderLength', label: 'Leader line', type: 'range', min: 0, max: 80, step: 2, unit: 'px', when: { path: 'MAP.showLabels' } },
        ],
        perKind: perKind('MAP', (p) => [{ path: p('labels'), label: 'Show', type: 'toggle', when: { path: 'MAP.showLabels' } }]),
      },
      {
        title: 'Trails',
        settings: [],
        perKind: perKind('MAP', (p) => [
          ...trailSettings(p),
          { path: p('trailWidth'), label: 'Width', type: 'range', min: 0.5, max: 5, step: 0.25, unit: 'px', when: { path: p('trail') } },
        ]),
      },
      {
        title: 'Weather radar',
        settings: [
          { path: 'MAP.radar.enabled', label: 'Show radar', type: 'toggle', reload: true },
          { path: 'MAP.radar.opacity', label: 'Opacity', type: 'range', min: 0.05, max: 1, step: 0.05, when: { path: 'MAP.radar.enabled' } },
          { path: 'MAP.radar.hideLightEchoes', label: 'Hide light echoes', hint: 'Show only rain and storms', type: 'toggle', reload: true, when: { path: 'MAP.radar.enabled' } },
        ],
      },
    ],
  },
  {
    title: '3D Map',
    groups: [
      {
        title: 'Views',
        settings: [
          TOWER_SETTING,
          {
            path: 'MINIMAP.layout',
            label: 'Minimap',
            hint: 'A flat map of the airport, north up (always in the board in tower view); set it up in the Minimap tab',
            type: 'select',
            options: [
              { value: 'off', label: 'Off' },
              { value: 'floating', label: 'Floating' },
              { value: 'board', label: 'In board' },
            ],
          },
        ],
      },
      {
        title: 'Camera',
        settings: [
          ORBIT_SETTING,
          {
            path: 'MAP3D.orbitDirection',
            label: 'Direction',
            hint: 'Seen from above',
            type: 'select',
            options: [
              { value: 'clockwise', label: 'Clockwise' },
              { value: 'counterclockwise', label: 'Counter' },
            ],
            when: { path: 'MAP3D.orbit' },
          },
          { path: 'MAP3D.orbitSpeed', label: 'Speed', type: 'range', min: 0.01, max: 30, step: 0.01, unit: '°/s', when: { path: 'MAP3D.orbit' } },
          { path: 'MAP3D.showHud', label: 'Heading and altitude', hint: 'Where the camera faces, and how high it is', type: 'toggle' },
        ],
        actions: [{ label: 'Reset camera', run: resetMapCamera }],
      },
      {
        title: 'Aircraft',
        settings: [
          { path: 'MAP3D.planeSize', label: 'Size', hint: 'At the starting camera distance', type: 'range', min: 3, max: 30, step: 1, unit: 'px' },
          { path: 'MAP3D.fixedScreenSize', label: 'Same size at any zoom', hint: 'Off: aircraft grow as you zoom in', type: 'toggle' },
          { path: 'MAP3D.altitudeScale', label: 'Altitude exaggeration', hint: 'Terrain too', type: 'range', min: 1, max: 12, step: 0.5, unit: '×' },
        ],
        perKind: perKind('MAP3D', (p) => [
          ...styleSettings(p),
          { path: p('labels'), label: 'Labels', hint: 'Turned on for all in 2D Map › Labels', type: 'toggle', when: { path: 'MAP.showLabels' } },
        ]),
      },
      { title: 'Guides', settings: [ASSIST_PATHS_SETTING, RUNWAY_GUIDES_SETTING] },
      { title: 'Trails', settings: [], perKind: perKind('MAP3D', trailSettings) },
      {
        title: 'Curtains',
        settings: [],
        perKind: perKind('MAP3D', (p) => [
          { path: p('curtain'), label: 'Show', hint: 'Shade from the trail down to the ground', type: 'toggle' },
          { path: p('curtainOpacity'), label: 'Opacity', type: 'range', min: 0.02, max: 0.5, step: 0.02, when: { path: p('curtain') } },
        ]),
      },
      {
        title: 'Ground markers',
        settings: [],
        perKind: perKind('MAP3D', (p) => [
          { path: p('dropLine'), label: 'Drop line', hint: 'From the aircraft down to the ground', type: 'toggle' },
          { path: p('groundDot'), label: 'Ground dot', hint: 'Where the drop line meets the ground', type: 'toggle', when: { path: p('dropLine') } },
        ]),
      },
      {
        title: 'Routes',
        settings: [],
        // Other traffic has no origin or destination here to point at.
        perKind: perKind('MAP3D', (p, kind) =>
          kind === 'other'
            ? []
            : [
                { path: p('route'), label: 'Route line', hint: kind === 'arrival' ? 'Toward its origin' : 'Toward its destination', type: 'toggle' },
                { path: p('routeLengthNm'), label: 'Length', type: 'range', min: 20, max: 500, step: 10, unit: 'nm', when: { path: p('route') } },
              ],
        ),
      },
      {
        title: 'Up close',
        settings: [
          { path: 'MAP3D.showAirport', label: 'Airport model', hint: 'Runways, taxiways and buildings at true size', type: 'toggle' },
          { path: 'MAP3D.showGroundTraffic', label: 'Ground traffic', hint: 'Aircraft taxiing and parked at the airport', type: 'toggle' },
          {
            path: 'MAP3D.airportRangeNm',
            label: 'Detail range',
            hint: 'How close the camera must be to draw them; further out, the simple runways show',
            type: 'range',
            min: 2,
            max: 60,
            step: 1,
            unit: 'nm',
          },
          {
            path: 'MAP3D.trueSizeNearAirport',
            label: 'True-size aircraft',
            hint: 'Near the airport, aircraft departing or on final are drawn at their real size',
            type: 'toggle',
          },
          {
            path: 'MAP3D.trueSizeRangeNm',
            label: 'True-size range',
            hint: 'How close to the airport both the camera and an aircraft must be',
            type: 'range',
            min: 1,
            max: 60,
            step: 1,
            unit: 'nm',
            when: { path: 'MAP3D.trueSizeNearAirport' },
          },
        ],
      },
    ],
  },
  {
    title: 'Minimap',
    groups: [
      {
        title: 'View',
        settings: [
          MINIMAP_LOCK_SETTING,
          MINIMAP_TOWER_LOCK_SETTING,
          { path: 'MINIMAP.radiusNm', label: 'Range', hint: 'From the airport to its edges', type: 'range', min: 3, max: 120, step: 1, unit: 'nm' },
          { path: 'MINIMAP.opacity', label: 'Opacity', type: 'range', min: 0.2, max: 1, step: 0.05 },
          { path: 'MINIMAP.terrain', label: 'Terrain', hint: 'Hill shading', type: 'toggle' },
          { path: 'MINIMAP.terrainShading', label: 'Shading', type: 'range', min: 0.1, max: 1.5, step: 0.05, when: { path: 'MINIMAP.terrain' } },
          { path: 'MINIMAP.ringSpacingNm', label: 'Range ring spacing', type: 'range', min: 1, max: 50, step: 1, unit: 'nm' },
          { path: 'MINIMAP.showCompass', label: 'Compass', hint: 'N, E, S and W in the corner', type: 'toggle' },
        ],
        actions: [{ label: 'Reset position', run: () => resetMinimapPlacement(), title: 'Back to its corner at its starting size' }],
      },
      {
        title: 'Aircraft',
        settings: [{ path: 'MINIMAP.planeSize', label: 'Size', type: 'range', min: 2, max: 20, step: 1, unit: 'px' }],
        perKind: perKind('MINIMAP', styleSettings),
      },
      {
        title: 'Guides',
        settings: [
          { path: 'MINIMAP.showAssistPaths', label: 'Landing and takeoff paths', type: 'toggle' },
          { path: 'MINIMAP.showRunwayGuides', label: 'Localizers', type: 'toggle' },
        ],
      },
      {
        title: 'Labels',
        settings: [
          { path: 'MINIMAP.showLabels', label: 'Show labels', type: 'toggle' },
          { path: 'MINIMAP.labelSize', label: 'Text size', type: 'range', min: 6, max: 20, step: 1, unit: 'px', when: { path: 'MINIMAP.showLabels' } },
          { path: 'MINIMAP.hideCrowdedLabels', label: 'Hide crowded labels', hint: 'Background traffic only', type: 'toggle', when: { path: 'MINIMAP.showLabels' } },
          { path: 'MINIMAP.labelLeaderLength', label: 'Leader line', type: 'range', min: 0, max: 80, step: 2, unit: 'px', when: { path: 'MINIMAP.showLabels' } },
        ],
        perKind: perKind('MINIMAP', (p) => [{ path: p('labels'), label: 'Show', type: 'toggle', when: { path: 'MINIMAP.showLabels' } }]),
      },
      {
        title: 'Trails',
        settings: [],
        perKind: perKind('MINIMAP', (p) => [
          ...trailSettings(p),
          { path: p('trailWidth'), label: 'Width', type: 'range', min: 0.5, max: 5, step: 0.25, unit: 'px', when: { path: p('trail') } },
        ]),
      },
      {
        title: 'Weather radar',
        settings: [
          { path: 'MINIMAP.radar.opacity', label: 'Opacity', hint: 'Turned on in 2D Map › Weather radar', type: 'range', min: 0, max: 1, step: 0.05, when: { path: 'MAP.radar.enabled' } },
        ],
      },
    ],
  },
  {
    title: 'Airport',
    groups: [
      {
        title: '3D airport view',
        settings: [
          { path: 'DIORAMA.enabled', label: 'Show', type: 'toggle' },
          { ...LOCK_SETTING, when: { path: 'DIORAMA.enabled' } },
          { path: 'DIORAMA.showBox', label: 'Box outline', type: 'toggle', when: { path: 'DIORAMA.enabled' } },
          { path: 'DIORAMA.showCompass', label: 'Compass', hint: 'N, E, S and W, turning with the view', type: 'toggle', when: { path: 'DIORAMA.enabled' } },
          { path: 'DIORAMA.showWind', label: 'Wind vane', hint: 'Wind direction and speed from the METAR, under the caption', type: 'toggle', when: { path: 'DIORAMA.enabled' } },
          { path: 'DIORAMA.boxHeight', label: 'Box height', type: 'range', min: 0.05, max: 0.5, step: 0.01, when: { path: 'DIORAMA.enabled' } },
          { path: 'DIORAMA.buildingHeightScale', label: 'Building height', hint: 'Times real height', type: 'range', min: 1, max: 10, step: 0.5, unit: '×', when: { path: 'DIORAMA.enabled' } },
        ],
        actions: [{ label: 'Reset position', run: () => resetDioramaPlacement(), title: 'Back to its corner at its starting size and angle' }],
      },
      {
        title: 'Aircraft',
        settings: [
          { path: 'DIORAMA.planeScale', label: 'Size', hint: 'Times real size', type: 'range', min: 1, max: 12, step: 0.5, unit: '×' },
          { path: 'DIORAMA.minPlaneLengthM', label: 'Smallest aircraft', hint: 'So light aircraft stay visible', type: 'range', min: 0, max: 200, step: 10, unit: 'm' },
          { path: 'DIORAMA.models3d', label: '3D models', hint: 'Off draws flat silhouettes', type: 'toggle' },
          { path: 'DIORAMA.maxHeightFt', label: 'Show airborne below', type: 'range', min: 500, max: 5000, step: 100, unit: 'ft' },
          { path: 'DIORAMA.keepParkedMs', label: 'Keep parked aircraft', hint: 'After their transponder goes quiet', type: 'range', min: 1_800_000, max: 12 * 3_600_000, step: 1_800_000, ...HOURS },
        ],
        perKind: perKind('DIORAMA', (p) => [
          ...styleSettings(p),
          { path: p('parkedOpacity'), label: 'Parked opacity', hint: 'Times the opacity above', type: 'range', min: 0.1, max: 1, step: 0.05, when: { path: p('show') } },
          { path: p('shadow'), label: 'Shadow', hint: 'Under it while airborne', type: 'toggle', when: { path: p('show') } },
          { path: p('dropLine'), label: 'Drop line', hint: 'Down to its shadow', type: 'toggle', when: { path: p('show') } },
        ]),
      },
      {
        title: 'Backdrop',
        settings: [
          { path: 'DIORAMA.backdropBlur', label: 'Blur', hint: 'Blurs the map behind the airport', type: 'range', min: 0, max: 24, step: 1, unit: 'px' },
          { path: 'DIORAMA.backdropDarkness', label: 'Darkness', hint: 'Fades the map behind the airport', type: 'range', min: 0, max: 1, step: 0.05 },
          { path: 'DIORAMA.backdropFeather', label: 'Feather', hint: 'How gradually it fades in from the edge', type: 'range', min: 0, max: 60, step: 2, unit: 'px' },
        ],
      },
    ],
  },
  {
    title: 'Board',
    groups: [
      {
        title: 'Flights',
        settings: [
          { path: 'BOARD.rowsPerPage', label: 'Rows per page', type: 'range', min: 3, max: 15, step: 1 },
          {
            path: 'BOARD.towerRowsPerPage',
            label: 'Rows, with minimap',
            hint: 'Arrivals and departures stacked beside the minimap',
            type: 'range',
            min: 2,
            max: 10,
            step: 1,
          },
          { path: 'BOARD.pageMs', label: 'Page time', type: 'range', min: 3000, max: 30_000, step: 1000, ...SECONDS },
          { path: 'BOARD.landedLingerMs', label: 'Keep landed flights', type: 'range', min: 0, max: 15 * 60_000, step: 60_000, ...MINUTES },
          { path: 'BOARD.approachNm', label: '"Approach" within', type: 'range', min: 2, max: 40, step: 1, unit: 'nm' },
          { path: 'BOARD.use24Hour', label: '24-hour clock', type: 'toggle' },
        ],
      },
      {
        title: 'ATIS',
        settings: [{ path: 'ATIS.lineMs', label: 'Line time', type: 'range', min: 2000, max: 20_000, step: 500, ...SECONDS }],
      },
    ],
  },
  {
    title: 'General',
    groups: [
      {
        title: 'Airport',
        settings: [
          {
            path: 'AIRPORT',
            label: 'Airport',
            hint: `Grouped by country. Usually, at local time now: ${TRAFFIC_ICONS.busy} busy · ${TRAFFIC_ICONS.slow} slow · ${TRAFFIC_ICONS.dead} dead`,
            type: 'select',
            // A getter, so each time the panel draws it the busy/slow/dead marks are for the time then.
            get options() {
              return Object.entries(PRESETS)
                .sort(([a, p], [b, q]) => p.country.localeCompare(q.country) || a.localeCompare(b))
                .map(([code, p]) => ({ value: code, label: `${TRAFFIC_ICONS[trafficLevel(p)]} ${code} · ${p.name}`, group: p.country }))
            },
            reload: true,
          },
        ],
      },
      {
        title: 'Display',
        settings: [
          {
            path: 'MAP.fontFamily',
            label: 'Font',
            hint: 'For flight information: the board, map labels and panels. B612 is from Airbus cockpit displays',
            type: 'select',
            options: [
              { value: '"JetBrains Mono Variable", ui-monospace, monospace', label: 'JetBrains' },
              { value: '"B612 Mono", ui-monospace, monospace', label: 'B612' },
            ],
          },
          {
            path: 'METAR.position',
            label: 'Weather (METAR)',
            hint: 'Above the board in a row, or top right in a column',
            type: 'select',
            options: [
              { value: 'board', label: 'Board' },
              { value: 'corner', label: 'Top right' },
            ],
          },
          {
            path: 'METAR.spotlight',
            label: 'One reading at a time',
            hint: 'Each in turn, with its part of the raw report highlighted',
            type: 'toggle',
            when: { path: 'METAR.position', is: 'corner' },
          },
          { path: 'METAR.spotlightMs', label: 'Each reading for', type: 'range', min: 2000, max: 15_000, step: 1000, ...SECONDS, when: { path: 'METAR.spotlight' } },
        ],
      },
      {
        title: 'Airport stats',
        settings: [
          {
            path: 'STATS.enabled',
            label: 'Show stats',
            hint: 'Under the logo: landing and takeoff rates, traffic, runways in use and the session so far',
            type: 'toggle',
          },
          {
            path: 'STATS.rateUnit',
            label: 'Rates',
            hint: 'e.g. 62 arr/hr, 1.0 ldg/min or 1 ldg / 58s',
            type: 'select',
            options: [
              { value: 'hour', label: 'Hour' },
              { value: 'minute', label: 'Minute' },
              { value: 'interval', label: 'Interval' },
            ],
            when: { path: 'STATS.enabled' },
          },
          { path: 'STATS.rateWindowMs', label: 'Averaged over', type: 'range', min: 5 * 60_000, max: 60 * 60_000, step: 5 * 60_000, ...MINUTES, when: { path: 'STATS.enabled' } },
          {
            path: 'STATS.runwayHoldMs',
            label: 'Keep runways listed',
            hint: 'After an aircraft last landed on or took off from one',
            type: 'range',
            min: 0,
            max: 20 * 60_000,
            step: 60_000,
            ...MINUTES,
            when: { path: 'STATS.enabled' },
          },
        ],
        actions: [{ label: 'Reset stats', run: resetAirportStats, title: 'Start counting again from now' }],
      },
      {
        title: 'Procedures',
        note: proceduresSummary,
        settings: [
          {
            path: 'PROCEDURES.enabled',
            label: 'Procedures',
            hint: "STARs, SIDs and approaches: the procedures button, and each followed flight's: flown, ahead and where it may branch off",
            type: 'toggle',
          },
          { ...IDENTIFY_SETTING, when: { path: 'PROCEDURES.enabled' } },
          { ...PREDICT_SETTING, when: { path: 'PROCEDURES.enabled' } },
          { path: 'PROCEDURES.show2d', label: 'On the 2D map', hint: 'And the minimap', type: 'toggle', when: { path: 'PROCEDURES.enabled' } },
          { path: 'PROCEDURES.show3d', label: 'On the 3D map', hint: 'In the air, at their altitude restrictions', type: 'toggle', when: { path: 'PROCEDURES.enabled' } },
          { path: 'PROCEDURES.labels', label: 'Waypoint names', type: 'toggle', when: { path: 'PROCEDURES.enabled' } },
          { path: 'PROCEDURES.opacity', label: 'Opacity', type: 'range', min: 0.1, max: 1, step: 0.05, when: { path: 'PROCEDURES.enabled' } },
          { path: 'PROCEDURES.starColor', label: 'STAR color', type: 'color', when: { path: 'PROCEDURES.enabled' } },
          { path: 'PROCEDURES.sidColor', label: 'SID color', type: 'color', when: { path: 'PROCEDURES.enabled' } },
          { path: 'PROCEDURES.approachColor', label: 'Approach color', type: 'color', when: { path: 'PROCEDURES.enabled' } },
        ],
        actions: [
          { label: 'Import…', run: pickProceduresFile, title: 'Load STARs, SIDs and approaches for this airport from a JSON file (format in README.md)' },
          { label: 'Export', run: downloadProcedures, title: 'Save the ones in use as JSON, to edit and import again' },
          { label: 'Remove imported', run: removeImportedProcedures, title: 'Go back to the built-in ones, if there are any' },
        ],
      },
      {
        title: 'Live data',
        settings: [
          { path: 'FEED.pollMs', label: 'Update every', hint: 'adsb.lol rate-limits faster than ~10 s', type: 'range', min: 5000, max: 60_000, step: 1000, ...SECONDS },
          {
            path: 'MOTION.delay',
            label: 'Delay',
            hint: 'Behind live, aircraft fly smoothly between reported positions; further behind rides out a missed update',
            type: 'steps',
            stops: [
              { label: 'Live', values: { 'MOTION.delayed': false } },
              { label: '1 update', values: { 'MOTION.delayed': true, 'MOTION.delayedReports': 2 } },
              { label: '2 updates', values: { 'MOTION.delayed': true, 'MOTION.delayedReports': 3 } },
            ],
          },
          {
            path: 'MOTION.runwayAssist',
            label: 'Runway assist',
            hint: 'Lines approaches and climb-outs up with the runways, and plays out takeoffs between updates',
            type: 'toggle',
          },
          {
            path: 'MOTION.taxiwaySnap',
            label: 'Keep ground traffic on taxiways',
            hint: 'Moving aircraft follow the taxiway and runway centerlines',
            type: 'toggle',
          },
          {
            path: 'MOTION.taxiwayRoutes',
            label: 'Follow taxi routes',
            hint: 'Each move goes the shortest way along the lines, round corners, instead of to the nearest line',
            type: 'toggle',
            when: { path: 'MOTION.taxiwaySnap' },
          },
        ],
      },
    ],
  },
]

/** Every setting in the panel. */
const ALL_SETTINGS = SETTING_TABS.flatMap((tab) =>
  tab.groups.flatMap((g) => [...g.settings, ...KINDS.flatMap((kind) => g.perKind?.(kind) ?? [])]),
)

/** Sent to put the 3D view back in its corner at its starting size and angle. */
export const RESET_DIORAMA_EVENT = 'airportDiorama:reset'

/** Back to its corner at its starting size; the angle too, unless `keepAngle`. */
export function resetDioramaPlacement({ keepAngle = false } = {}) {
  window.dispatchEvent(new CustomEvent(RESET_DIORAMA_EVENT, { detail: { keepAngle } }))
}

/** Sent to put the minimap back in its corner at its starting size. */
export const RESET_MINIMAP_EVENT = 'minimap:reset'

export function resetMinimapPlacement() {
  window.dispatchEvent(new Event(RESET_MINIMAP_EVENT))
}

/** Sent to put the 3D map's camera back to its starting view. */
export const RESET_CAMERA_EVENT = 'map3d:resetCamera'

export function resetMapCamera() {
  window.dispatchEvent(new Event(RESET_CAMERA_EVENT))
}

// ---- Store ------------------------------------------------------------------------

let saved = loadSavedSettings()
let version = 0
const listeners = new Set<() => void>()

/** Bumped on every change, so the map canvases know to redraw what they cache. */
export function settingsVersion() {
  return version
}

/** Re-renders the calling component whenever a setting changes. */
export function useSettingsVersion() {
  return useSyncExternalStore(subscribe, settingsVersion)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function changed() {
  version++
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved))
  } catch {
    // Storage unavailable (private window): the change still applies until reload.
  }
  for (const listener of listeners) listener()
}

/**
 * The value the panel shows: what's saved (it may be waiting for a reload),
 * else the default. For a steps setting, the index of the stop it's at.
 */
export function getSetting(setting: Setting): unknown {
  if (setting.type === 'steps') {
    const at = setting.stops.findIndex((stop) => Object.entries(stop.values).every(([path, v]) => valueAt(path) === v))
    return Math.max(0, at)
  }
  return valueAt(setting.path)
}

/** A config value by path, as the panel shows it. */
function valueAt(path: string): unknown {
  if (path in saved) return saved[path]
  return defaultValue(path)
}

function defaultValue(path: string): unknown {
  if (path === 'AIRPORT') {
    const fromEnv = (import.meta.env.VITE_AIRPORT ?? 'DFW').toUpperCase()
    return fromEnv in PRESETS ? fromEnv : 'DFW'
  }
  return getConfigValue(path, CONFIG_DEFAULTS)
}

/** Whether a setting applies now: always, unless it's only `when` another is on (or has a value). */
export function settingApplies(setting: Setting): boolean {
  if (!setting.when) return true
  const value = valueAt(setting.when.path)
  return setting.when.is === undefined ? Boolean(value) : String(value) === setting.when.is
}

/** A setting's value; for a steps setting, the index of the stop to go to. */
export function setSetting(setting: Setting, value: unknown) {
  const values = setting.type === 'steps' ? (setting.stops[Number(value)]?.values ?? {}) : { [setting.path]: value }
  saved = { ...saved, ...values }
  if (!setting.reload) for (const [path, v] of Object.entries(values)) setConfigValue(path, v)
  changed()
}

/** The config values a setting changes. */
function settingPaths(setting: Setting): string[] {
  return setting.type === 'steps' ? [...new Set(setting.stops.flatMap((stop) => Object.keys(stop.values)))] : [setting.path]
}

/** Back to the defaults in config.ts (and .env for the airport). */
export function resetSettings() {
  for (const s of ALL_SETTINGS) if (!s.reload) for (const path of settingPaths(s)) setConfigValue(path, defaultValue(path))
  saved = {}
  changed()
}

/** Settings changed since the page loaded that only apply after a reload. */
export function needsReload(): boolean {
  return ALL_SETTINGS.some((s) => {
    if (!s.reload) return false
    // ?airport= in the URL wins over the saved airport, so reloading wouldn't change it.
    if (s.path === 'AIRPORT' && new URLSearchParams(window.location.search).has('airport')) return false
    const running = s.path === 'AIRPORT' ? AIRPORT : getConfigValue(s.path)
    return getSetting(s) !== running
  })
}
