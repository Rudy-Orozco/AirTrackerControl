/**
 * Top-down aircraft silhouettes for the 3D airport view, picked by ICAO type
 * designator (B738, A359, CRJ7...) and sized from real length and wingspan.
 */

export type ShapeKind = 'jet' | 'widebody' | 'regional' | 'turboprop' | 'light' | 'helicopter'

export interface AircraftShape {
  /**
   * Outlines in fractions of the aircraft's size: x across the wingspan (-0.5
   * to 0.5), y along the length (-0.5 tail to 0.5 nose).
   */
  polygons: [number, number][][]
  /** Helicopters: the rotor disc, as a fraction of the span (the rotor diameter). */
  rotor?: number
}

export interface AircraftSize {
  kind: ShapeKind
  lengthM: number
  spanM: number
}

/** Mirror a right-hand outline (from the nose round to the tail) into a whole one. */
function symmetric(right: [number, number][]): [number, number][] {
  const left = right
    .slice(1, -1)
    .reverse()
    .map(([x, y]): [number, number] => [-x, y])
  return [...right, ...left]
}

/** Swept wings and tailplane, slim fuselage. */
const SWEPT = symmetric([
  [0, 0.5],
  [0.045, 0.43],
  [0.05, 0.14],
  [0.5, -0.1],
  [0.5, -0.15],
  [0.05, -0.04],
  [0.04, -0.33],
  [0.19, -0.44],
  [0.19, -0.49],
  [0.02, -0.46],
  [0, -0.5],
])

/** Widebodies: a fatter fuselage and broader wing root. */
const WIDE = symmetric([
  [0, 0.5],
  [0.055, 0.42],
  [0.06, 0.16],
  [0.5, -0.12],
  [0.5, -0.17],
  [0.06, -0.06],
  [0.045, -0.33],
  [0.2, -0.43],
  [0.2, -0.49],
  [0.025, -0.46],
  [0, -0.5],
])

/** Regional and business jets: less sweep, engines on the tail, T-tail. */
const REGIONAL = symmetric([
  [0, 0.5],
  [0.05, 0.42],
  [0.05, 0.08],
  [0.5, -0.08],
  [0.5, -0.13],
  [0.05, -0.08],
  [0.05, -0.2],
  [0.11, -0.22],
  [0.11, -0.34],
  [0.04, -0.36],
  [0.2, -0.45],
  [0.2, -0.5],
  [0, -0.5],
])

/** Straight wings and tailplane. */
const STRAIGHT = symmetric([
  [0, 0.5],
  [0.05, 0.4],
  [0.05, 0.14],
  [0.5, 0.12],
  [0.5, 0.02],
  [0.05, 0.0],
  [0.035, -0.36],
  [0.17, -0.38],
  [0.17, -0.47],
  [0.02, -0.47],
  [0, -0.5],
])

/** Small piston aircraft: stubby fuselage, wide straight wing. */
const LIGHT = symmetric([
  [0, 0.5],
  [0.07, 0.42],
  [0.07, 0.22],
  [0.5, 0.2],
  [0.5, 0.06],
  [0.07, 0.04],
  [0.03, -0.36],
  [0.17, -0.38],
  [0.17, -0.48],
  [0, -0.5],
])

/** A slim cabin and tail boom; the rotor disc is drawn around it. */
const HELICOPTER_BODY = symmetric([
  [0, 0.32],
  [0.12, 0.22],
  [0.12, -0.02],
  [0.03, -0.1],
  [0.025, -0.44],
  [0.08, -0.46],
  [0.08, -0.5],
  [0, -0.5],
])

export const SHAPES: Record<ShapeKind, AircraftShape> = {
  jet: { polygons: [SWEPT] },
  widebody: { polygons: [WIDE] },
  regional: { polygons: [REGIONAL] },
  turboprop: { polygons: [STRAIGHT] },
  light: { polygons: [LIGHT] },
  helicopter: { polygons: [HELICOPTER_BODY], rotor: 1 },
}

/** Length and wingspan (rotor diameter for helicopters) in meters of common types. */
const TYPES: Record<string, [ShapeKind, number, number]> = {
  // Airbus narrowbodies
  A318: ['jet', 31.4, 34.1],
  A319: ['jet', 33.8, 35.8],
  A19N: ['jet', 33.8, 35.8],
  A320: ['jet', 37.6, 35.8],
  A20N: ['jet', 37.6, 35.8],
  A321: ['jet', 44.5, 35.8],
  A21N: ['jet', 44.5, 35.8],
  BCS1: ['jet', 35.0, 35.1],
  BCS3: ['jet', 38.7, 35.1],
  // Boeing / McDonnell Douglas narrowbodies
  B712: ['jet', 37.8, 28.4],
  B733: ['jet', 33.4, 28.9],
  B737: ['jet', 33.6, 35.8],
  B738: ['jet', 39.5, 35.8],
  B739: ['jet', 42.1, 35.8],
  B37M: ['jet', 35.6, 35.9],
  B38M: ['jet', 39.5, 35.9],
  B39M: ['jet', 42.2, 35.9],
  B3XM: ['jet', 43.8, 35.9],
  B752: ['jet', 47.3, 38.1],
  B753: ['jet', 54.4, 38.1],
  MD82: ['jet', 45.1, 32.9],
  MD83: ['jet', 45.1, 32.9],
  MD88: ['jet', 45.1, 32.9],
  MD90: ['jet', 46.5, 32.9],
  // Widebodies
  A306: ['widebody', 54.1, 44.8],
  A332: ['widebody', 58.8, 60.3],
  A333: ['widebody', 63.7, 60.3],
  A338: ['widebody', 58.8, 64.0],
  A339: ['widebody', 63.7, 64.0],
  A343: ['widebody', 63.7, 60.3],
  A346: ['widebody', 75.4, 63.5],
  A359: ['widebody', 66.8, 64.8],
  A35K: ['widebody', 73.8, 64.8],
  A388: ['widebody', 72.7, 79.8],
  B744: ['widebody', 70.7, 64.4],
  B748: ['widebody', 76.3, 68.4],
  B762: ['widebody', 48.5, 47.6],
  B763: ['widebody', 54.9, 47.6],
  B764: ['widebody', 61.4, 51.9],
  B772: ['widebody', 63.7, 60.9],
  B77L: ['widebody', 63.7, 64.8],
  B773: ['widebody', 73.9, 60.9],
  B77W: ['widebody', 73.9, 64.8],
  B778: ['widebody', 70.9, 71.8],
  B779: ['widebody', 76.7, 71.8],
  B788: ['widebody', 56.7, 60.1],
  B789: ['widebody', 62.8, 60.1],
  B78X: ['widebody', 68.3, 60.1],
  MD11: ['widebody', 61.6, 51.7],
  // Regional jets
  CRJ2: ['regional', 26.8, 21.2],
  CRJ7: ['regional', 32.5, 23.2],
  CRJ9: ['regional', 36.4, 24.9],
  CRJX: ['regional', 39.1, 26.2],
  E135: ['regional', 26.3, 20.0],
  E145: ['regional', 29.9, 20.0],
  E170: ['regional', 29.9, 26.0],
  E75L: ['regional', 31.7, 26.0],
  E75S: ['regional', 31.7, 26.0],
  E190: ['regional', 36.2, 28.7],
  E195: ['regional', 38.7, 28.7],
  E290: ['regional', 36.2, 33.7],
  E295: ['regional', 41.5, 35.1],
  // Business jets
  C25A: ['regional', 14.4, 15.5],
  C25B: ['regional', 15.6, 16.3],
  C56X: ['regional', 16.0, 17.2],
  C68A: ['regional', 19.4, 22.0],
  C700: ['regional', 22.3, 21.0],
  CL30: ['regional', 20.9, 19.5],
  CL35: ['regional', 20.9, 21.0],
  CL60: ['regional', 20.9, 19.6],
  E55P: ['regional', 15.6, 16.2],
  E545: ['regional', 20.7, 20.0],
  F2TH: ['regional', 20.2, 19.3],
  F900: ['regional', 20.2, 19.3],
  FA7X: ['regional', 23.2, 26.2],
  GL5T: ['regional', 29.5, 28.7],
  GL7T: ['regional', 33.8, 31.7],
  GLEX: ['regional', 30.3, 28.7],
  GLF4: ['regional', 26.9, 23.7],
  GLF5: ['regional', 29.4, 28.5],
  GLF6: ['regional', 30.4, 30.4],
  G280: ['regional', 20.3, 19.2],
  LJ45: ['regional', 17.7, 14.6],
  LJ60: ['regional', 17.9, 13.4],
  // Turboprops
  AT43: ['turboprop', 22.7, 24.6],
  AT45: ['turboprop', 22.7, 24.6],
  AT72: ['turboprop', 27.2, 27.1],
  AT75: ['turboprop', 27.2, 27.1],
  AT76: ['turboprop', 27.2, 27.1],
  DH8A: ['turboprop', 22.3, 25.9],
  DH8C: ['turboprop', 25.7, 27.4],
  DH8D: ['turboprop', 32.8, 28.4],
  SF34: ['turboprop', 19.7, 21.4],
  B190: ['turboprop', 17.6, 17.7],
  BE20: ['turboprop', 13.3, 16.6],
  BE9L: ['turboprop', 10.8, 15.3],
  C208: ['turboprop', 11.5, 15.9],
  PC12: ['turboprop', 14.4, 16.3],
  TBM9: ['turboprop', 10.7, 12.8],
  C130: ['turboprop', 29.8, 40.4],
  // Light aircraft
  C150: ['light', 7.3, 10.2],
  C152: ['light', 7.3, 10.1],
  C172: ['light', 8.3, 11.0],
  C182: ['light', 8.8, 11.0],
  C206: ['light', 8.6, 11.0],
  C210: ['light', 8.6, 11.2],
  P28A: ['light', 7.3, 10.7],
  P28R: ['light', 7.6, 10.8],
  PA32: ['light', 8.4, 11.0],
  PA34: ['light', 8.7, 11.9],
  PA44: ['light', 8.4, 11.8],
  BE35: ['light', 8.4, 10.2],
  BE36: ['light', 8.4, 10.2],
  BE58: ['light', 9.1, 11.5],
  SR20: ['light', 7.9, 11.7],
  SR22: ['light', 7.9, 11.7],
  DA40: ['light', 8.0, 11.9],
  DA42: ['light', 8.6, 13.4],
  M20P: ['light', 7.5, 11.0],
  AA1: ['light', 5.9, 7.5],
  // Helicopters (span = rotor diameter)
  R22: ['helicopter', 8.8, 7.7],
  R44: ['helicopter', 11.7, 10.1],
  R66: ['helicopter', 11.6, 10.1],
  B06: ['helicopter', 12.1, 10.2],
  B407: ['helicopter', 12.7, 10.7],
  B429: ['helicopter', 13.1, 11.0],
  AS50: ['helicopter', 10.9, 10.7],
  AS65: ['helicopter', 13.7, 11.9],
  EC30: ['helicopter', 10.9, 10.7],
  EC35: ['helicopter', 12.2, 10.2],
  EC45: ['helicopter', 13.0, 11.0],
  EC55: ['helicopter', 14.3, 11.0],
  A109: ['helicopter', 13.0, 11.0],
  A139: ['helicopter', 16.7, 13.8],
  S76: ['helicopter', 16.0, 13.4],
  H60: ['helicopter', 19.8, 16.4],
}

/** Typical size of each kind, for types not in the table. */
const DEFAULTS: Record<ShapeKind, [number, number]> = {
  jet: [38, 35],
  widebody: [63, 60],
  regional: [30, 25],
  turboprop: [22, 24],
  light: [8, 11],
  helicopter: [12, 10.5],
}

/**
 * Picks the shape and size for an aircraft from its type designator, falling
 * back to its ADS-B emitter category (A1 light, A2 small, A3 large, A5 heavy,
 * A7 rotorcraft) when the type isn't known.
 */
export function aircraftSize(type: string | null, emitterCategory: string | null): AircraftSize {
  const known = type ? TYPES[type.toUpperCase()] : undefined
  if (known) return { kind: known[0], lengthM: known[1], spanM: known[2] }
  const kind = kindFromType(type) ?? kindFromCategory(emitterCategory)
  const [lengthM, spanM] = DEFAULTS[kind]
  return { kind, lengthM, spanM }
}

/** Families by designator prefix, for variants missing from the table. */
function kindFromType(type: string | null): ShapeKind | null {
  if (!type) return null
  const t = type.toUpperCase()
  if (/^(A30|A33|A34|A35|A38|B74|B76|B77|B78|MD11|IL96|A124)/.test(t)) return 'widebody'
  if (/^(A31|A32|A2[01]N|A19N|B73|B3[789X]M|B75|MD8|MD9|BCS)/.test(t)) return 'jet'
  if (/^(CRJ|E1[3-9]|E[27]|GLF|GL[57X]|C25|C5|C6|C7|CL[36]|FA|F2|F9|LJ|G28|E5)/.test(t)) return 'regional'
  if (/^(AT[47]|DH8|SF3|B19|BE[29]|C208|PC12|TBM)/.test(t)) return 'turboprop'
  return null
}

function kindFromCategory(category: string | null): ShapeKind {
  switch (category) {
    case 'A1':
      return 'light'
    case 'A2':
      return 'regional'
    case 'A5':
      return 'widebody'
    case 'A7':
      return 'helicopter'
    default:
      return 'jet'
  }
}
