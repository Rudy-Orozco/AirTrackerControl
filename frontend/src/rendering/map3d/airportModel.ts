import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  Points,
  PointsMaterial,
  Shape,
  ShapeGeometry,
  Vector2,
} from 'three'
import type { AirportLayout } from '../../types/airport'
import type { Line } from '../../types/airport'

/**
 * The airport itself on the 3D map, at true size: aprons, taxiways and runways
 * (with their centerline, edge and threshold markings and edge lights) laid on
 * the ground, and terminals and hangars standing up from it. Built from the
 * same OpenStreetMap layout as the airport view (scripts/build_airport_layout.py).
 *
 * `toLocal` turns [lon, lat] into nautical miles east and north of the airport.
 * Buildings are `buildings`, a group one true nautical mile tall per unit: the
 * map stretches it by its height exaggeration, like everything else's heights.
 */
export function buildAirportModel(layout: AirportLayout, toLocal: (p: [number, number]) => Vector2) {
  const group = new Group()
  const buildings = new Group()
  group.add(buildings)
  const local = (line: Line) => line.map(toLocal)

  // Flat layers, one above the other: each is pulled a little further toward the camera.
  const layer = (geometry: BufferGeometry, color: number, level: number) => {
    const mesh = new Mesh(
      geometry,
      // Both sides: strips and outlines come wound either way.
      new MeshBasicMaterial({ color, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -level, polygonOffsetUnits: -4 * level }),
    )
    mesh.frustumCulled = false
    group.add(mesh)
  }

  // Aprons: filled outlines.
  const aprons = layout.aprons.map((ring) => polygon(local(ring))).filter((g) => g !== null)
  if (aprons.length) layer(merge(aprons), APRON_COLOR, 1)

  // Taxiways: ribbons along their centerlines.
  const taxiways = new Ribbons()
  for (const line of layout.taxiways) taxiways.polyline(local(line), TAXIWAY_WIDTH_M / M_PER_NM)
  layer(taxiways.geometry(), TAXIWAY_COLOR, 2)

  // Runways: the pavement, then their markings and edge lights.
  const pavement = new Ribbons()
  const markings = new Ribbons()
  const lights: number[] = []
  const thresholdLights: number[] = []
  for (const runway of layout.runways) {
    // A runway's line can have points along it, not just its two ends.
    const path = along(local(runway.line))
    if (path.length === 0) continue
    const width = runway.widthM / M_PER_NM
    for (let i = 1; i < path.points.length; i++) pavement.segment(path.points[i - 1], path.points[i], width, 0)
    // Centerline: dashes down the middle.
    for (let d = THRESHOLD_LENGTH_M / M_PER_NM; d + DASH_M / M_PER_NM < path.length; d += (DASH_M + GAP_M) / M_PER_NM) {
      markings.segment(path.at(d).point, path.at(d + DASH_M / M_PER_NM).point, STRIPE_M / M_PER_NM, 0)
    }
    // Edge lines, and edge lights just outside them.
    for (const s of [-1, 1]) {
      for (let i = 1; i < path.points.length; i++) {
        const [a, b] = [path.points[i - 1], path.points[i]]
        const dir = b.clone().sub(a).normalize()
        const offset = new Vector2(-dir.y, dir.x).multiplyScalar((s * (width - STRIPE_M / M_PER_NM)) / 2)
        markings.segment(a.clone().add(offset), b.clone().add(offset), STRIPE_M / M_PER_NM, 0)
      }
      for (let d = 0; d <= path.length; d += LIGHT_SPACING_M / M_PER_NM) {
        const { point, dir } = path.at(d)
        const p = point.add(new Vector2(-dir.y, dir.x).multiplyScalar(s * (width / 2 + 3 / M_PER_NM)))
        lights.push(p.x, p.y, 0)
      }
    }
  }
  // Threshold stripes and lights at each runway's far ends (its pieces share a name).
  for (const ends of runwayEnds(layout, local)) {
    const [a, b] = ends.points
    const dir = b.clone().sub(a).normalize()
    const side = new Vector2(-dir.y, dir.x)
    const width = ends.widthM / M_PER_NM
    for (const [end, inward] of [
      [a, dir],
      [b, dir.clone().negate()],
    ] as const) {
      const start = end.clone().addScaledVector(inward, 6 / M_PER_NM)
      const stop = start.clone().addScaledVector(inward, THRESHOLD_LENGTH_M / M_PER_NM)
      const stripes = Math.max(4, Math.round(ends.widthM / 4))
      for (let i = 0; i < stripes; i++) {
        // Two banks of stripes either side of the middle, as painted.
        const f = (i + 0.5) / stripes - 0.5
        if (Math.abs(f) < 0.06) continue
        const offset = side.clone().multiplyScalar(f * width * 0.9)
        markings.segment(start.clone().add(offset), stop.clone().add(offset), (width * 0.9) / stripes / 2, 0)
      }
      for (let f = -0.5; f <= 0.5; f += 0.1) {
        const p = end.clone().add(side.clone().multiplyScalar(f * width))
        thresholdLights.push(p.x, p.y, 0)
      }
    }
  }
  layer(pavement.geometry(), RUNWAY_COLOR, 3)
  layer(markings.geometry(), MARKING_COLOR, 4)
  group.add(lightPoints(lights, EDGE_LIGHT_COLOR), lightPoints(thresholdLights, THRESHOLD_LIGHT_COLOR))

  // Terminals and hangars, true height.
  for (const kind of ['terminal', 'hangar'] as const) {
    const shapes = layout.buildings.filter((b) => b.kind === kind)
    const parts = shapes
      .map(({ ring, heightM }) => {
        const shape = new Shape(open(local(ring)))
        return new ExtrudeGeometry(shape, { depth: heightM / M_PER_NM, bevelEnabled: false })
      })
    if (!parts.length) continue
    const mesh = new Mesh(merge(parts), new MeshPhongMaterial({ color: BUILDING_COLORS[kind], flatShading: true, shininess: 10 }))
    mesh.geometry.computeVertexNormals()
    mesh.frustumCulled = false
    buildings.add(mesh)
  }

  // How far the airport reaches from its middle, so the terrain can be flattened under it.
  let extentNm = 0
  const reach = (line: Line) => {
    for (const p of local(line)) extentNm = Math.max(extentNm, p.length())
  }
  layout.runways.forEach((r) => reach(r.line))
  layout.aprons.forEach(reach)
  layout.buildings.forEach((b) => reach(b.ring))

  return { group, buildings, extentNm }
}

const M_PER_NM = 1852
const TAXIWAY_WIDTH_M = 23
/** Centerline dashes and gaps, and the width of painted stripes (meters), as on real runways. */
const DASH_M = 36
const GAP_M = 24
const STRIPE_M = 1
const THRESHOLD_LENGTH_M = 45
const LIGHT_SPACING_M = 60
const APRON_COLOR = 0x1b2029
const TAXIWAY_COLOR = 0x2a303b
const RUNWAY_COLOR = 0x20252e
const MARKING_COLOR = 0xc9d0dc
const EDGE_LIGHT_COLOR = 0xfff1d0
const THRESHOLD_LIGHT_COLOR = 0x6dff9a
const BUILDING_COLORS = { terminal: 0x7d8899, hangar: 0x5d6675 }

/**
 * The map's own simple runways (as on the flat map: pale bars, much wider than
 * real so they show from afar), laid flat on the ground. Shown in place of the
 * airport model when it's off or the camera's too far away for it.
 */
export function buildMapRunways(lines: Line[], toLocal: (p: [number, number]) => Vector2, widthNm: number) {
  const bars = new Ribbons()
  for (const line of lines) bars.polyline(line.map(toLocal), widthNm)
  const mesh = new Mesh(
    bars.geometry(),
    new MeshBasicMaterial({ color: MAP_RUNWAY_COLOR, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
  )
  mesh.frustumCulled = false
  return mesh
}

/** The flat map's runway color (pale blue-grey at 45%) as it comes out over the dark ground, solid so overlapping bars don't add up. */
const MAP_RUNWAY_COLOR = 0x58616f

/**
 * A line through `points` measured along its length: `at(d)` is the point `d`
 * along it and the direction it runs there.
 */
function along(points: Vector2[]) {
  const cumulative = [0]
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + points[i].distanceTo(points[i - 1]))
  const length = cumulative[cumulative.length - 1] ?? 0
  const at = (d: number) => {
    let i = 1
    while (i < points.length - 1 && cumulative[i] < d) i++
    const [a, b] = [points[i - 1], points[i]]
    const span = cumulative[i] - cumulative[i - 1]
    const f = span > 0 ? Math.min(Math.max((d - cumulative[i - 1]) / span, 0), 1) : 0
    return { point: a.clone().lerp(b, f), dir: b.clone().sub(a).normalize() }
  }
  return { points, length, at }
}

/** Quads along lines, merged into one geometry. */
class Ribbons {
  private positions: number[] = []

  /** A strip `width` wide from `a` to `b`, stretched `extend` past each end. */
  segment(a: Vector2, b: Vector2, width: number, extend: number) {
    const along = b.clone().sub(a)
    const length = along.length()
    if (length === 0) return
    const dir = along.divideScalar(length)
    const side = new Vector2(-dir.y, dir.x).multiplyScalar(width / 2)
    const p = a.clone().addScaledVector(dir, -extend)
    const q = b.clone().addScaledVector(dir, extend)
    const [p1, p2, q1, q2] = [p.clone().add(side), p.clone().sub(side), q.clone().add(side), q.clone().sub(side)]
    this.positions.push(p1.x, p1.y, 0, p2.x, p2.y, 0, q1.x, q1.y, 0, p2.x, p2.y, 0, q2.x, q2.y, 0, q1.x, q1.y, 0)
  }

  /** Each piece stretched half a width past its ends, so turns don't leave gaps. */
  polyline(points: Vector2[], width: number) {
    for (let i = 1; i < points.length; i++) this.segment(points[i - 1], points[i], width, width / 2)
  }

  geometry() {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3))
    return geometry
  }
}

/** A filled polygon on the ground, or null if it's degenerate. */
function polygon(points: Vector2[]) {
  const ring = open(points)
  return ring.length < 3 ? null : new ShapeGeometry(new Shape(ring))
}

/** Rings come closed (first point repeated); shapes want them open. */
function open(points: Vector2[]) {
  return points.length > 1 && points[0].equals(points[points.length - 1]) ? points.slice(0, -1) : points
}

/** Joins non-indexed geometries' positions into one. */
function merge(parts: BufferGeometry[]) {
  const arrays = parts.map((g) => (g.index ? g.toNonIndexed() : g).getAttribute('position').array as Float32Array)
  const all = new Float32Array(arrays.reduce((n, a) => n + a.length, 0))
  let at = 0
  for (const a of arrays) {
    all.set(a, at)
    at += a.length
  }
  for (const g of parts) g.dispose()
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(all, 3))
  return geometry
}

/** Small glowing dots, a couple of pixels across at any distance. */
function lightPoints(positions: number[], color: number) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  const points = new Points(geometry, new PointsMaterial({ color, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false }))
  points.frustumCulled = false
  return points
}

/** Each runway's two far ends (it may come in several pieces sharing a name), with its width. */
function runwayEnds(layout: AirportLayout, local: (line: Line) => Vector2[]) {
  const byRef = new Map<string, { points: Vector2[]; widthM: number }>()
  for (const r of layout.runways) {
    const entry = byRef.get(r.ref) ?? { points: [], widthM: r.widthM }
    entry.points.push(...local(r.line))
    entry.widthM = Math.max(entry.widthM, r.widthM)
    byRef.set(r.ref, entry)
  }
  return [...byRef.values()].map(({ points, widthM }) => {
    let best: [Vector2, Vector2] = [points[0], points[1] ?? points[0]]
    let bestLength = -1
    for (const p of points) {
      for (const q of points) {
        const d = p.distanceToSquared(q)
        if (d > bestLength) {
          best = [p, q]
          bestLength = d
        }
      }
    }
    return { points: best, widthM }
  })
}
