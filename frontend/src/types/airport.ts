/** [lon, lat] pairs, as written by scripts/build_basemap.py. */
export type Line = [number, number][]

/** The map around an airport (public/basemaps/<CODE>.json), built by scripts/build_basemap.py. */
export interface Basemap {
  attribution: string
  water: Line[]
  /** Missing from maps built before coastlines were added. */
  coastlines?: Line[]
  rivers: Line[]
  highways: Line[]
  runways: Line[]
  cities: { name: string; lat: number; lon: number }[]
}

/** Detailed airport layout (public/basemaps/<CODE>-layout.json), as written by scripts/build_airport_layout.py. */
export interface AirportLayout {
  attribution: string
  runways: { ref: string; widthM: number; line: Line }[]
  taxiways: Line[]
  aprons: Line[]
  buildings: { kind: 'terminal' | 'hangar'; heightM: number; ring: Line }[]
  stands: { ref: string; lat: number; lon: number }[]
}
