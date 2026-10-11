import { aircraftSize, SHAPES } from '../aircraft/aircraftShapes'
import type { Line } from '../map/basemap'
import { AIRPORT_PRESET, DIORAMA, MAP } from '../config/config'
import type { Flight } from '../tracking/flights'
import type { GroundTrack } from '../tracking/groundTracker'
import type { Point } from '../map/renderer'
import type { LatLon, Track } from '../tracking/tracker'

/** Detailed airport layout, as written by scripts/build_airport_layout.py. */
export interface AirportLayout {
  attribution: string
  runways: { ref: string; widthM: number; line: Line }[]
  taxiways: Line[]
  aprons: Line[]
  buildings: { kind: 'terminal' | 'hangar'; heightM: number; ring: Line }[]
  stands: { ref: string; lat: number; lon: number }[]
}

export async function fetchAirportLayout(airport: string, signal: AbortSignal): Promise<AirportLayout> {
  const res = await fetch(`/basemaps/${airport}-layout.json`, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ---- Projection -------------------------------------------------------------------

const M_PER_DEG_LAT = 111_320
const M_PER_FT = 0.3048

/** Meters east (x), north (y) and up (z) from the middle of the box. */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * A tilted (axonometric) view of a box standing on the airport: the layout is
 * its floor and low-flying aircraft fly inside it.
 */
export interface DioramaView {
  /** Screen position of a point given in meters from the middle of the box. */
  toScreen(v: Vec3): Point
  /** Larger is nearer the viewer; used to draw far things first. */
  depth(v: Vec3): number
  /** Meters east/north of the middle of the box. */
  toLocal(p: LatLon): { x: number; y: number }
  /** Half the box's width (east-west) and depth (north-south), in meters. */
  halfX: number
  halfY: number
  /** Box height in meters, and meters of box per meter of real altitude. */
  height: number
  altitudeScale: number
  /** The projection's parameters, so a WebGL camera can match it exactly (see aircraftModels.ts). */
  projection: {
    cosR: number
    sinR: number
    sinE: number
    cosE: number
    /** Pixels per meter, and where the box's middle lands, in CSS pixels. */
    scale: number
    offsetX: number
    offsetY: number
    /** Meters from the middle to the nearest/farthest point anything can be. */
    depthRange: number
  }
}

/** Which way the view faces: compass turn and how steeply it looks down, in degrees. */
export interface ViewAngle {
  rotation: number
  elevation: number
}

export function createDioramaView(layout: AirportLayout, width: number, height: number, angle: ViewAngle): DioramaView {
  const center = { lat: AIRPORT_PRESET.lat, lon: AIRPORT_PRESET.lon }
  const lonScale = M_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180)
  const toLocalRaw = ({ lat, lon }: LatLon) => ({ x: (lon - center.lon) * lonScale, y: (lat - center.lat) * M_PER_DEG_LAT })

  // Fit the floor around the runways and aprons, with a little margin.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const line of [...layout.runways.map((r) => r.line), ...layout.aprons]) {
    for (const [lon, lat] of line) {
      const { x, y } = toLocalRaw({ lat, lon })
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  if (!Number.isFinite(minX)) [minX, maxX, minY, maxY] = [-3000, 3000, -3000, 3000]
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2
  const halfX = ((maxX - minX) / 2) * 1.06
  const halfY = ((maxY - minY) / 2) * 1.06
  const boxHeight = Math.max(halfX, halfY) * 2 * DIORAMA.boxHeight

  const rot = (angle.rotation * Math.PI) / 180
  const elev = (angle.elevation * Math.PI) / 180
  const [cosR, sinR, sinE, cosE] = [Math.cos(rot), Math.sin(rot), Math.sin(elev), Math.cos(elev)]
  const rotate = (v: Vec3) => ({ x: v.x * cosR - v.y * sinR, y: v.x * sinR + v.y * cosR })
  const raw = (v: Vec3) => {
    const r = rotate(v)
    return { x: r.x, y: -r.y * sinE - v.z * cosE }
  }

  // Scale and center the box in the canvas. Fitting the circle around the floor
  // (rather than its corners) keeps the size steady while the view rotates.
  const radius = Math.hypot(halfX, halfY)
  const [left, right] = [-radius, radius]
  const [top, bottom] = [-radius * sinE - boxHeight * cosE, radius * sinE]
  const pad = 6
  const scale = Math.min((width - 2 * pad) / (right - left), (height - 2 * pad) / (bottom - top))
  const offsetX = width / 2 - ((left + right) / 2) * scale
  const offsetY = height / 2 - ((top + bottom) / 2) * scale

  return {
    toScreen(v) {
      const p = raw(v)
      return { x: offsetX + p.x * scale, y: offsetY + p.y * scale }
    },
    depth: (v) => -rotate(v).y,
    toLocal(p) {
      const { x, y } = toLocalRaw(p)
      return { x: x - midX, y: y - midY }
    },
    halfX,
    halfY,
    height: boxHeight,
    altitudeScale: boxHeight / (DIORAMA.maxHeightFt * M_PER_FT),
    projection: { cosR, sinR, sinE, cosE, scale, offsetX, offsetY, depthRange: (radius + boxHeight) * 1.2 },
  }
}

// ---- Static scene -------------------------------------------------------------------

const COLORS = {
  box: 'rgba(120, 160, 220, 0.3)',
  caption: 'rgba(160, 180, 215, 0.6)',
  apron: 'rgba(120, 145, 185, 0.13)',
  taxiway: 'rgba(150, 175, 215, 0.28)',
  runway: 'rgba(190, 205, 230, 0.6)',
  runwayLabel: 'rgba(190, 205, 230, 0.55)',
  stand: 'rgba(150, 175, 215, 0.3)',
  // Building walls are shaded by which way they face; roofs are lightest.
  terminal: [70, 95, 135],
  hangar: [55, 70, 95],
}

/** Draws the box, ground and buildings once to an offscreen canvas. */
export function renderDioramaBackground(
  layout: AirportLayout,
  view: DioramaView,
  width: number,
  height: number,
  dpr: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width * dpr
  canvas.height = height * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const floor = floorCorners(view)
  const lift = (vs: Vec3[], z: number) => vs.map((v) => ({ ...v, z }))

  // Back edges of the glass box go behind everything else.
  drawBoxEdges(ctx, view, floor, 'back')

  // Keep the layout on the floor even where OSM extends past the box.
  ctx.save()
  tracePolygon(ctx, view, floor)
  ctx.clip()

  const ground = (line: Line): Vec3[] => line.map(([lon, lat]) => ({ ...view.toLocal({ lat, lon }), z: 0 }))

  ctx.beginPath()
  for (const ring of layout.aprons) tracePolygon(ctx, view, ground(ring))
  ctx.fillStyle = COLORS.apron
  ctx.fill()

  ctx.beginPath()
  for (const line of layout.taxiways) tracePolyline(ctx, view, ground(line))
  ctx.strokeStyle = COLORS.taxiway
  ctx.lineWidth = 0.75
  ctx.stroke()

  for (const runway of layout.runways) drawRunway(ctx, view, ground(runway.line), runway.widthM)

  ctx.fillStyle = COLORS.stand
  for (const stand of layout.stands) {
    const p = view.toScreen({ ...view.toLocal(stand), z: 0 })
    ctx.fillRect(p.x - 0.5, p.y - 0.5, 1, 1)
  }

  // Buildings far to near, so nearer ones cover the ones behind.
  const buildings = layout.buildings
    .map((b) => ({ ...b, base: ground(b.ring) }))
    .sort((a, b) => view.depth(centroid(a.base)) - view.depth(centroid(b.base)))
  for (const b of buildings) drawBuilding(ctx, view, b.base, b.heightM * DIORAMA.buildingHeightScale, COLORS[b.kind])
  ctx.restore()

  ctx.font = `${MAP.labelSize - 3}px ${MAP.fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = COLORS.runwayLabel
  for (const runway of layout.runways) drawRunwayLabels(ctx, view, ground(runway.line), runway.ref)

  // The box's floor and top outlines.
  if (!DIORAMA.showBox) return canvas
  ctx.beginPath()
  tracePolygon(ctx, view, floor)
  ctx.strokeStyle = COLORS.box
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.beginPath()
  tracePolygon(ctx, view, lift(floor, view.height))
  ctx.strokeStyle = COLORS.box
  ctx.stroke()

  return canvas
}

/** The box's silhouette on screen (convex, clockwise), for masking the backdrop to it. */
export function boxSilhouette(view: DioramaView): Point[] {
  const floor = floorCorners(view)
  const points = [...floor, ...floor.map((v) => ({ ...v, z: view.height }))].map((v) => view.toScreen(v))
  return convexHull(points)
}

/** Andrew's monotone chain. */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (pts: Point[]) => {
    const hull: Point[] = []
    for (const p of pts) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop()
      hull.push(p)
    }
    hull.pop()
    return hull
  }
  return [...half(sorted), ...half([...sorted].reverse())]
}

/** Front edges of the glass box, drawn over the aircraft. */
export function drawDioramaFront(ctx: CanvasRenderingContext2D, view: DioramaView) {
  drawBoxEdges(ctx, view, floorCorners(view), 'front')
}

/**
 * Writes `text` flat on the ground just outside a floor edge facing the
 * viewer, as if painted there. As the view rotates it moves to whichever
 * front edge is longest on screen, and always reads left to right.
 */
export function drawDioramaCaption(ctx: CanvasRenderingContext2D, view: DioramaView, text: string) {
  const floor = floorCorners(view)
  // Of the (one or two) edges facing the viewer, the one longest on screen has the most room.
  const screenLength = (e: { a: Vec3; b: Vec3 }) => {
    const [p, q] = [view.toScreen(e.a), view.toScreen(e.b)]
    return Math.hypot(q.x - p.x, q.y - p.y)
  }
  const edges = floor.map((a, i) => ({ a, b: floor[(i + 1) % floor.length] }))
  const facing = edges.filter((e) => view.depth(midpoint(e.a, e.b)) > 0)
  const front = (facing.length ? facing : edges).reduce((best, e) => (screenLength(e) > screenLength(best) ? e : best))
  const mid = midpoint(front.a, front.b)
  const edgeLength = Math.hypot(front.b.x - front.a.x, front.b.y - front.a.y)
  const along = { x: (front.b.x - front.a.x) / edgeLength, y: (front.b.y - front.a.y) / edgeLength }
  // The floor is centered on the origin, so the edge's midpoint points straight out of it.
  const outLength = Math.hypot(mid.x, mid.y)
  const out = { x: mid.x / outLength, y: mid.y / outLength }

  // Screen directions of one step along the edge and one step out from it, so
  // the text lies in the floor's plane and foreshortens with it.
  const step = 100
  const o = view.toScreen(mid)
  const a = view.toScreen({ x: mid.x + along.x * step, y: mid.y + along.y * step, z: 0 })
  const n = view.toScreen({ x: mid.x + out.x * step, y: mid.y + out.y * step, z: 0 })
  const pxPerStep = Math.hypot(a.x - o.x, a.y - o.y)
  let [ux, uy] = [(a.x - o.x) / pxPerStep, (a.y - o.y) / pxPerStep]
  let [vx, vy] = [(n.x - o.x) / pxPerStep, (n.y - o.y) / pxPerStep]
  // Read left to right, with the letters standing up from the edge (not mirrored).
  if (ux < 0) [ux, uy] = [-ux, -uy]
  if (ux * vy - uy * vx < 0) [vx, vy] = [-vx, -vy]

  ctx.save()
  ctx.transform(ux, uy, vx, vy, o.x, o.y)
  ctx.font = `${MAP.labelSize - 2}px ${MAP.fontFamily}`
  ctx.letterSpacing = '2px'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.globalAlpha = 1
  ctx.fillStyle = COLORS.caption
  ctx.fillText(text, 0, 6)
  ctx.restore()
}

function floorCorners({ halfX, halfY }: DioramaView): Vec3[] {
  return [
    { x: -halfX, y: -halfY, z: 0 },
    { x: halfX, y: -halfY, z: 0 },
    { x: halfX, y: halfY, z: 0 },
    { x: -halfX, y: halfY, z: 0 },
  ]
}

/** Vertical box edges: the farthest corner's is behind the scene, the rest in front. */
function drawBoxEdges(ctx: CanvasRenderingContext2D, view: DioramaView, floor: Vec3[], which: 'back' | 'front') {
  if (!DIORAMA.showBox) return
  const farthest = floor.reduce((a, b) => (view.depth(a) < view.depth(b) ? a : b))
  ctx.beginPath()
  for (const corner of floor) {
    if ((corner === farthest) !== (which === 'back')) continue
    const a = view.toScreen(corner)
    const b = view.toScreen({ ...corner, z: view.height })
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
  }
  ctx.strokeStyle = COLORS.box
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawRunway(ctx: CanvasRenderingContext2D, view: DioramaView, line: Vec3[], widthM: number) {
  // A quad per segment, the real width wide (but at least a hairline).
  ctx.beginPath()
  for (let i = 0; i < line.length - 1; i++) {
    const [a, b] = [line[i], line[i + 1]]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const nx = (-(b.y - a.y) / len) * (widthM / 2)
    const ny = ((b.x - a.x) / len) * (widthM / 2)
    tracePolygon(ctx, view, [
      { x: a.x + nx, y: a.y + ny, z: 0 },
      { x: b.x + nx, y: b.y + ny, z: 0 },
      { x: b.x - nx, y: b.y - ny, z: 0 },
      { x: a.x - nx, y: a.y - ny, z: 0 },
    ])
  }
  ctx.fillStyle = COLORS.runway
  ctx.fill()
  ctx.strokeStyle = COLORS.runway
  ctx.lineWidth = 0.5
  ctx.stroke()
}

/**
 * Puts each runway designator ("17R") just beyond the end aircraft start from,
 * judged by which way the runway's heading points.
 */
function drawRunwayLabels(ctx: CanvasRenderingContext2D, view: DioramaView, line: Vec3[], ref: string) {
  if (line.length < 2 || !ref) return
  const [start, end] = [line[0], line[line.length - 1]]
  const len = Math.hypot(end.x - start.x, end.y - start.y) || 1
  const [ux, uy] = [(end.x - start.x) / len, (end.y - start.y) / len]
  const bearing = ((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360
  const gap = Math.min(view.halfX, view.halfY) * 0.06
  for (const name of ref.split('/')) {
    const number = parseInt(name, 10)
    if (!Number.isFinite(number)) continue
    const diff = Math.abs(((number * 10 - bearing + 540) % 360) - 180)
    // Runway 17 starts at the end from which the runway points toward 170°.
    const p = diff < 90 ? { x: start.x - ux * gap, y: start.y - uy * gap, z: 0 } : { x: end.x + ux * gap, y: end.y + uy * gap, z: 0 }
    const s = view.toScreen(p)
    ctx.fillText(name, s.x, s.y)
  }
}

function drawBuilding(ctx: CanvasRenderingContext2D, view: DioramaView, base: Vec3[], heightM: number, rgb: number[]) {
  const roof = base.map((v) => ({ ...v, z: heightM }))
  // Walls far to near; light comes from the upper left of the screen.
  const walls = base
    .map((a, i) => ({ a, b: base[(i + 1) % base.length] }))
    .sort((w1, w2) => view.depth(midpoint(w1.a, w1.b)) - view.depth(midpoint(w2.a, w2.b)))
  for (const { a, b } of walls) {
    const sa = view.toScreen(a)
    const sb = view.toScreen(b)
    const shade = 0.55 + 0.25 * Math.sign(sb.x - sa.x || 1)
    fillPolygon(ctx, view, [a, b, { ...b, z: heightM }, { ...a, z: heightM }], rgba(rgb, shade, 0.95))
  }
  fillPolygon(ctx, view, roof, rgba(rgb, 1.3, 0.95))
}

// ---- Aircraft -------------------------------------------------------------------

interface Drawable {
  depth: number
  draw: () => void
}

/**
 * Draws ground aircraft lying on the floor and low airborne arrivals and
 * departures at their height, with a shadow and a drop line to the ground.
 */
export function drawDioramaAircraft(
  ctx: CanvasRenderingContext2D,
  view: DioramaView,
  ground: Iterable<GroundTrack>,
  airborne: Iterable<Track>,
  /** False when the aircraft themselves are drawn as 3D models; shadows and drop lines are still drawn here. */
  drawPlanes = true,
): AircraftPose[] {
  const items: Drawable[] = []
  const poses: AircraftPose[] = []
  const inside = (p: { x: number; y: number }) => Math.abs(p.x) <= view.halfX && Math.abs(p.y) <= view.halfY

  const onGround = new Set<string>()
  for (const t of ground) {
    onGround.add(t.info.hex)
    const local = view.toLocal(t.pos)
    const { show, color, opacity: kindOpacity, scale, parkedOpacity } = DIORAMA.traffic[t.info.kind]
    if (t.opacity <= 0 || !show || !inside(local)) continue
    // Above zero only while settling onto the runway just after touchdown.
    const at = { ...local, z: t.heightFt * M_PER_FT * view.altitudeScale }
    const opacity = t.opacity * (t.parked ? parkedOpacity : 1) * kindOpacity
    poses.push({ id: `g${t.info.hex}`, info: t.info, at, heading: t.heading, pitch: 0, bank: 0, color, opacity, scale })
    if (drawPlanes) items.push({ depth: view.depth(at), draw: () => drawPlane(ctx, view, at, t.heading, t.info, color, opacity, scale) })
  }

  for (const t of airborne) {
    // Once on the ground, the ground tracker draws it (it carries on from here).
    const { show, color, opacity: kindOpacity, scale, shadow, dropLine } = DIORAMA.traffic[t.info.kind]
    if (t.opacity <= 0 || !show || t.altitude === null || onGround.has(t.info.hex)) continue
    const heightFt = t.altitude - AIRPORT_PRESET.elevationFt
    if (heightFt > DIORAMA.maxHeightFt) continue
    const local = view.toLocal(t.pos)
    if (!inside(local)) continue
    const at = { ...local, z: Math.max(heightFt, 0) * M_PER_FT * view.altitudeScale }
    const opacity = t.opacity * kindOpacity
    poses.push({ id: `a${t.info.hex}`, info: t.info, at, heading: t.heading, pitch: pitchOf(t, view.altitudeScale), bank: bankOf(t), color, opacity, scale })
    items.push({
      depth: view.depth(at),
      draw: () => {
        if (shadow) drawPlane(ctx, view, { ...at, z: 0 }, t.heading, t.info, '#000000', 0.35 * t.opacity, scale)
        if (dropLine) {
          const a = view.toScreen({ ...at, z: 0 })
          const b = view.toScreen(at)
          ctx.globalAlpha = 0.3 * t.opacity
          ctx.strokeStyle = color
          ctx.lineWidth = 0.75
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
        if (drawPlanes) drawPlane(ctx, view, at, t.heading, t.info, color, opacity, scale)
      },
    })
  }

  items.sort((a, b) => a.depth - b.depth)
  for (const item of items) item.draw()
  ctx.globalAlpha = 1
  return poses
}

/** Where and how an aircraft sits in the box, for drawing it as a 3D model. */
export interface AircraftPose {
  /** Stable while it stays on the ground or in the air. */
  id: string
  info: Flight
  /** Meters from the middle of the box. */
  at: Vec3
  /** Degrees: compass heading, nose up, and right wing down. */
  heading: number
  pitch: number
  bank: number
  color: string
  opacity: number
  /** Times the usual size (DIORAMA.traffic). */
  scale: number
}

const G = 9.81
const KT_TO_MS = 0.514444

/** Most airliners fly a couple of degrees nose-up even in level flight or on a descending approach. */
const NOSE_UP_DEG = 2

/**
 * Pitch for the drawn climb or descent, in degrees. `verticalScale` is how much
 * the view exaggerates altitude, so the nose follows the path as it's drawn
 * (along the trail) rather than the real, much shallower angle.
 */
export function pitchOf(t: Track, verticalScale: number) {
  if (!t.info.groundSpeed) return 0
  const climb = (t.climbing * M_PER_FT * 1000) * verticalScale
  const path = (Math.atan2(climb, t.info.groundSpeed * KT_TO_MS) * 180) / Math.PI
  return clampDeg(path + NOSE_UP_DEG, 30)
}

/** Bank angle for a coordinated turn at the drawn path's turn rate and speed, in degrees. */
export function bankOf(t: Track) {
  if (!t.info.groundSpeed) return 0
  const turnRadPerS = (t.turning * 1000 * Math.PI) / 180
  return clampDeg((Math.atan((t.info.groundSpeed * KT_TO_MS * turnRadPerS) / G) * 180) / Math.PI, 35)
}

function clampDeg(v: number, limit: number) {
  return Math.min(Math.max(v, -limit), limit)
}

/** How many times real size to draw an aircraft `lengthM` long, times its kind's `kindScale`. */
export function dioramaPlaneScale(lengthM: number, kindScale: number) {
  return Math.max(DIORAMA.planeScale, DIORAMA.minPlaneLengthM / lengthM) * kindScale
}

/**
 * An aircraft lying flat at `at` (so it foreshortens with the floor), in the
 * silhouette and proportions of its type, scaled up per DIORAMA.planeScale.
 */
function drawPlane(ctx: CanvasRenderingContext2D, view: DioramaView, at: Vec3, heading: number, info: Flight, color: string, opacity: number, kindScale: number) {
  const size = aircraftSize(info.aircraftType, info.emitterCategory)
  const shape = SHAPES[size.kind]
  const scale = dioramaPlaneScale(size.lengthM, kindScale)
  const [length, span] = [size.lengthM * scale, size.spanM * scale]
  const rad = (heading * Math.PI) / 180
  const [sin, cos] = [Math.sin(rad), Math.cos(rad)]
  // Rotate the shape clockwise from north by the heading.
  const point = (fx: number, fy: number) => {
    const [x, y] = [fx * span, fy * length]
    return view.toScreen({ x: at.x + x * cos + y * sin, y: at.y - x * sin + y * cos, z: at.z })
  }

  ctx.globalAlpha = opacity
  ctx.fillStyle = color
  ctx.beginPath()
  for (const polygon of shape.polygons) {
    polygon.forEach(([fx, fy], i) => {
      const p = point(fx, fy)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.closePath()
  }
  ctx.fill()

  if (shape.rotor) {
    // The rotor disc: a faint filled circle (an ellipse once tilted).
    ctx.beginPath()
    for (let i = 0; i <= ROTOR_SEGMENTS; i++) {
      const a = (i / ROTOR_SEGMENTS) * Math.PI * 2
      const p = point((Math.cos(a) * shape.rotor) / 2, ((Math.sin(a) * shape.rotor) / 2) * (span / length) + 0.1)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.globalAlpha = opacity * 0.3
    ctx.fill()
  }
}

const ROTOR_SEGMENTS = 20

// ---- Helpers -------------------------------------------------------------------

function tracePolygon(ctx: CanvasRenderingContext2D, view: DioramaView, vs: Vec3[]) {
  tracePolyline(ctx, view, vs)
  ctx.closePath()
}

function tracePolyline(ctx: CanvasRenderingContext2D, view: DioramaView, vs: Vec3[]) {
  vs.forEach((v, i) => {
    const p = view.toScreen(v)
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
}

function fillPolygon(ctx: CanvasRenderingContext2D, view: DioramaView, vs: Vec3[], color: string) {
  ctx.beginPath()
  tracePolygon(ctx, view, vs)
  ctx.fillStyle = color
  ctx.fill()
}

function centroid(vs: Vec3[]): Vec3 {
  const n = vs.length || 1
  return { x: vs.reduce((s, v) => s + v.x, 0) / n, y: vs.reduce((s, v) => s + v.y, 0) / n, z: 0 }
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 }
}

function rgba(rgb: number[], shade: number, alpha: number) {
  const [r, g, b] = rgb.map((c) => Math.min(255, Math.round(c * shade)))
  return `rgb(${r} ${g} ${b} / ${alpha})`
}
