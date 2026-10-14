import type { AirportLayout } from '../diorama/diorama'
import type { LatLon } from './tracker'

/**
 * The airport's taxiway, taxilane and runway centerlines as a connected
 * network, for keeping aircraft on them as they move on the ground: positions
 * between reports cut corners and drift with GPS error, while real aircraft
 * follow the painted lines.
 *
 * The layout's lines are simplified, so where two of them cross there's often
 * no shared point: crossings are found and the lines split there, and a line
 * that stops just short of another (a T-junction) is joined onto it. Each
 * stretch between junctions is an edge. Edges are kept in a grid of cells so
 * the nearest one is quick to find.
 */
export class TaxiNetwork {
  private readonly nodes: Node[] = []
  private readonly nodeAt = new Map<string, number>()
  private readonly cells = new Map<string, Edge[]>()
  private readonly lat0: number
  private readonly lon0: number
  private readonly lonScale: number

  constructor(layout: AirportLayout) {
    const lines = [...layout.taxiways, ...layout.runways.map((r) => r.line)]
    const first = lines[0]?.[0] ?? [0, 0]
    ;[this.lon0, this.lat0] = first
    this.lonScale = Math.cos((this.lat0 * Math.PI) / 180)

    // Every straight piece of every line, with the points it's to be split at.
    const pieces: Piece[] = []
    for (const [index, line] of lines.entries()) {
      for (let i = 1; i < line.length; i++) {
        const a = this.toMeters({ lon: line[i - 1][0], lat: line[i - 1][1] })
        const b = this.toMeters({ lon: line[i][0], lat: line[i][1] })
        if (Math.hypot(b.x - a.x, b.y - a.y) >= 0.5) pieces.push({ line: index, a, b, cuts: [] })
      }
    }
    const grid = new Map<string, number[]>()
    pieces.forEach((p, i) => {
      for (const key of cellsAround(p.a, p.b, JOIN_M)) {
        const list = grid.get(key)
        if (list) list.push(i)
        else grid.set(key, [i])
      }
    })

    // Where lines cross: both are split there.
    const checked = new Set<number>()
    for (const list of grid.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [p, q] = [pieces[list[i]], pieces[list[j]]]
          const pair = list[i] * pieces.length + list[j]
          if (p.line === q.line || checked.has(pair)) continue
          checked.add(pair)
          const hit = crossing(p.a, p.b, q.a, q.b)
          if (hit) {
            p.cuts.push(hit)
            q.cuts.push(hit)
          }
        }
      }
    }

    // Loose ends: a line ending just short of (or just past) another is joined onto it,
    // unless it already ends on another line's point.
    const linesAt = new Map<string, Set<number>>()
    for (const [index, line] of lines.entries()) {
      for (const [lon, lat] of line) {
        const key = keyOf(this.toMeters({ lat, lon }))
        const set = linesAt.get(key)
        if (set) set.add(index)
        else linesAt.set(key, new Set([index]))
      }
    }
    const links: [XY, XY][] = []
    for (const [index, line] of lines.entries()) {
      if (line.length < 2) continue
      for (const [lon, lat] of [line[0], line[line.length - 1]]) {
        const end = this.toMeters({ lat, lon })
        if ((linesAt.get(keyOf(end))?.size ?? 0) > 1) continue
        let best: { piece: Piece; at: XY; d: number } | null = null
        for (const i of grid.get(cellKey(end)) ?? []) {
          const p = pieces[i]
          if (p.line === index) continue
          const at = nearestOn(p.a, p.b, end)
          const d = Math.hypot(at.x - end.x, at.y - end.y)
          if (d <= JOIN_M && (!best || d < best.d)) best = { piece: p, at, d }
        }
        if (best) {
          best.piece.cuts.push(best.at)
          if (best.d > 0.1) links.push([end, best.at])
        }
      }
    }

    // Each piece, split at its cuts in order along it, becomes edges between junctions.
    for (const p of pieces) {
      const along = (c: XY) => (c.x - p.a.x) * (p.b.x - p.a.x) + (c.y - p.a.y) * (p.b.y - p.a.y)
      const points = [p.a, ...p.cuts.sort((c, d) => along(c) - along(d)), p.b]
      for (let i = 1; i < points.length; i++) this.addEdge(this.node(points[i - 1]), this.node(points[i]))
    }
    for (const [a, b] of links) this.addEdge(this.node(a), this.node(b))
  }

  /**
   * The nearest point on a centerline within reach of `pos`, and the line's
   * direction there (degrees from north, either way along it), or null when
   * there's none (out on an apron, say). Moving along `motion` (degrees from
   * north), lines running that way count as nearer than those crossing it, so
   * an aircraft going straight through an intersection stays on its own line
   * rather than being pulled onto the crossing one; turning, it moves over to
   * the new line as it comes round to it.
   */
  snap(pos: LatLon, motion: number | null = null): { pos: LatLon; bearing: number } | null {
    const hit = this.nearestEdge(this.toMeters(pos), motion)
    if (!hit) return null
    return { pos: this.fromMeters(hit.at.x, hit.at.y), bearing: (Math.atan2(hit.edge.dx, hit.edge.dy) * 180) / Math.PI }
  }

  /**
   * The way along the centerlines from `from` to `to`, as the points to pass
   * through (each end snapped onto its line), or null if either is off the
   * network or the way round is so much longer than the straight line that the
   * aircraft must have gone somewhere the layout doesn't show (across an apron,
   * say), or longer than `maxLength` (meters: how far it could have gone at
   * the speed it was going). `fromMotion` and `toMotion` are which way it was moving at each end
   * (degrees from north, or null if unknown): setting off or arriving the
   * other way, and U-turns along the way, count as much longer, since aircraft
   * rarely do them, so GPS jitter can't send it on a detour.
   */
  route(from: LatLon, fromMotion: number | null, to: LatLon, toMotion: number | null, maxLength = Infinity): LatLon[] | null {
    const p0 = this.toMeters(from)
    const p1 = this.toMeters(to)
    const start = this.nearestEdge(p0, fromMotion)
    const goal = this.nearestEdge(p1, toMotion)
    if (!start || !goal) return null
    const straight = Math.hypot(p1.x - p0.x, p1.y - p0.y)
    const limit = Math.min(Math.max(straight * MAX_DETOUR, straight + DETOUR_M), maxLength)
    const back = (dir: number, motion: number | null) =>
      motion !== null && !Number.isNaN(dir) && angleBetween(dir, motion) > AGAINST_DEG ? AGAINST_M : 0

    // Both on the same stretch: straight along it.
    if (start.edge === goal.edge) return [start.at, goal.at].map((p) => this.fromMeters(p.x, p.y))

    // A* from the start point (onto either end of its edge) to the goal point (from either end of its edge).
    // Turns and the wrong way only steer which way is chosen: the limit is on the distance.
    const labels = new Map<number, Label>()
    const open: { node: number; f: number }[] = []
    const heuristic = (n: number) => Math.hypot(this.nodes[n].x - goal.at.x, this.nodes[n].y - goal.at.y)
    const reach = (node: number, cost: number, length: number, prev: number, dir: number) => {
      const old = labels.get(node)
      if (old && old.cost <= cost) return
      if (length + heuristic(node) > limit) return
      labels.set(node, { cost, length, prev, dir })
      open.push({ node, f: cost + heuristic(node) })
    }
    for (const node of [start.edge.a, start.edge.b]) {
      const n = this.nodes[node]
      const dir = bearingDeg(start.at, n)
      const d = Math.hypot(n.x - start.at.x, n.y - start.at.y)
      reach(node, d + back(dir, fromMotion), d, START, dir)
    }
    let best: { node: number; cost: number; length: number } | null = null
    while (open.length > 0) {
      let k = 0
      for (let i = 1; i < open.length; i++) if (open[i].f < open[k].f) k = i
      const { node, f } = open.splice(k, 1)[0]
      if (best && f >= best.cost) break
      const label = labels.get(node)!
      // Stale entry (reached more cheaply since).
      if (f > label.cost + heuristic(node) + 1e-6) continue
      const n = this.nodes[node]
      if (node === goal.edge.a || node === goal.edge.b) {
        const dir = bearingDeg(n, goal.at)
        const d = Math.hypot(goal.at.x - n.x, goal.at.y - n.y)
        const cost = label.cost + d + back(dir, toMotion) + turnCost(label.dir, dir)
        if (!best || cost < best.cost) best = { node, cost, length: label.length + d }
      }
      for (const e of n.edges) {
        const m = this.nodes[e.to]
        const dir = bearingDeg(n, m)
        reach(e.to, label.cost + e.length + turnCost(label.dir, dir), label.length + e.length, node, dir)
      }
    }
    if (!best || best.length > limit) return null

    const path: XY[] = [goal.at]
    for (let node = best.node; node !== START; node = labels.get(node)!.prev) path.push(this.nodes[node])
    path.push(start.at)
    path.reverse()
    return path.filter((p, i) => i === 0 || Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y) > 0.05).map((p) => this.fromMeters(p.x, p.y))
  }

  /** The nearest point on an edge within SNAP_M of `p`, weighing edges across `motion` as further (see snap()). */
  private nearestEdge(p: XY, motion: number | null): { edge: Edge; at: XY } | null {
    const candidates = this.cells.get(cellKey(p))
    if (!candidates) return null
    const [mx, my] = motion === null ? [0, 0] : [Math.sin((motion * Math.PI) / 180), Math.cos((motion * Math.PI) / 180)]
    let best: { edge: Edge; at: XY } | null = null
    let bestCost = Infinity
    for (const edge of candidates) {
      const t = Math.min(Math.max((p.x - edge.ax) * edge.dx + (p.y - edge.ay) * edge.dy, 0), edge.length)
      const at = { x: edge.ax + edge.dx * t, y: edge.ay + edge.dy * t }
      const d = Math.hypot(p.x - at.x, p.y - at.y)
      if (d > SNAP_M) continue
      // 0 along the way it's moving (either way along the line), 1 straight across it.
      const across = motion === null ? 0 : 1 - Math.abs(edge.dx * mx + edge.dy * my)
      const cost = d + across * CROSSING_M
      if (cost < bestCost) {
        bestCost = cost
        best = { edge, at }
      }
    }
    return best
  }

  /** The junction at `p`, added if it's new (points within 10 cm are the same one). */
  private node(p: XY): number {
    const key = keyOf(p)
    const found = this.nodeAt.get(key)
    if (found !== undefined) return found
    this.nodes.push({ x: p.x, y: p.y, edges: [] })
    this.nodeAt.set(key, this.nodes.length - 1)
    return this.nodes.length - 1
  }

  private addEdge(a: number, b: number) {
    if (a === b) return
    const [na, nb] = [this.nodes[a], this.nodes[b]]
    const length = Math.hypot(nb.x - na.x, nb.y - na.y)
    if (na.edges.some((e) => e.to === b)) return
    na.edges.push({ to: b, length })
    nb.edges.push({ to: a, length })
    const edge: Edge = { a, b, ax: na.x, ay: na.y, dx: (nb.x - na.x) / length, dy: (nb.y - na.y) / length, length }
    // Filed under every cell its bounding box (plus the snapping reach) touches.
    for (const key of cellsAround(na, nb, SNAP_M)) {
      const list = this.cells.get(key)
      if (list) list.push(edge)
      else this.cells.set(key, [edge])
    }
  }

  private toMeters({ lat, lon }: LatLon): XY {
    return { x: (lon - this.lon0) * M_PER_DEG * this.lonScale, y: (lat - this.lat0) * M_PER_DEG }
  }

  private fromMeters(x: number, y: number): LatLon {
    return { lat: this.lat0 + y / M_PER_DEG, lon: this.lon0 + x / (M_PER_DEG * this.lonScale) }
  }
}

/**
 * A way along the centerlines (from TaxiNetwork.route), to move an aircraft
 * along by distance: where it is, and which way it's heading, so far along.
 */
export class TaxiRoute {
  readonly length: number
  private readonly points: XY[]
  /** Distance along the route (meters) to each point. */
  private readonly at: number[]
  private readonly lat0: number
  private readonly lon0: number
  private readonly lonScale: number

  constructor(path: LatLon[]) {
    ;({ lat: this.lat0, lon: this.lon0 } = path[0])
    this.lonScale = Math.cos((this.lat0 * Math.PI) / 180)
    // Points on top of each other have no way between them to head along.
    this.points = path
      .map(({ lat, lon }) => ({ x: (lon - this.lon0) * M_PER_DEG * this.lonScale, y: (lat - this.lat0) * M_PER_DEG }))
      .filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) >= 0.05)
    this.at = [0]
    for (let i = 1; i < this.points.length; i++) {
      const [a, b] = [this.points[i - 1], this.points[i]]
      this.at.push(this.at[i - 1] + Math.hypot(b.x - a.x, b.y - a.y))
    }
    this.length = this.at[this.at.length - 1]
  }

  /** Where it is `distance` meters along, and which way it's heading there (degrees from north; NaN on a route with no length). */
  pointAt(distance: number): { pos: LatLon; bearing: number } {
    const d = Math.min(Math.max(distance, 0), this.length)
    let i = 1
    while (i < this.points.length - 1 && this.at[i] < d) i++
    const [a, b] = [this.points[i - 1] ?? this.points[0], this.points[i] ?? this.points[0]]
    const span = this.at[i] - this.at[i - 1] || 1
    const u = Math.min(Math.max((d - this.at[i - 1]) / span, 0), 1)
    const x = a.x + (b.x - a.x) * u
    const y = a.y + (b.y - a.y) * u
    return {
      pos: { lat: this.lat0 + y / M_PER_DEG, lon: this.lon0 + x / (M_PER_DEG * this.lonScale) },
      bearing: bearingDeg(a, b),
    }
  }
}

interface XY {
  x: number
  y: number
}

interface Node extends XY {
  edges: { to: number; length: number }[]
}

interface Edge {
  /** The junctions at each end. */
  a: number
  b: number
  ax: number
  ay: number
  /** Unit direction from a to b, and its length (meters). */
  dx: number
  dy: number
  length: number
}

/** A straight piece of a layout line, and where other lines cross or join it. */
interface Piece {
  line: number
  a: XY
  b: XY
  cuts: XY[]
}

/**
 * Route search: the cheapest way found to a junction (its distance, plus what
 * turning and going the wrong way add), how far that is, where from, and which
 * way it arrived (degrees from north; NaN if it started right there).
 */
interface Label {
  cost: number
  length: number
  prev: number
  dir: number
}

/** The route search's starting point, as a label's `prev`. */
const START = -1

/** Where segments a–b and c–d cross, if they do. */
function crossing(a: XY, b: XY, c: XY, d: XY): XY | null {
  const [rx, ry, sx, sy] = [b.x - a.x, b.y - a.y, d.x - c.x, d.y - c.y]
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-9) return null
  const [qx, qy] = [c.x - a.x, c.y - a.y]
  const t = (qx * sy - qy * sx) / denom
  const u = (qx * ry - qy * rx) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { x: a.x + rx * t, y: a.y + ry * t }
}

/** The nearest point to `p` on segment a–b. */
function nearestOn(a: XY, b: XY, p: XY): XY {
  const [dx, dy] = [b.x - a.x, b.y - a.y]
  const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0), 1)
  return { x: a.x + dx * t, y: a.y + dy * t }
}

/** Degrees from north from `a` to `b`; NaN when they're the same point, so there's no way to speak of. */
function bearingDeg(a: XY, b: XY) {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 0.05) return NaN
  return (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI
}

/** The angle between two directions (0 to 180 degrees). */
function angleBetween(a: number, b: number) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180)
}

/** Turning from `from` to `to` (degrees from north): free up to a right angle, then dearer, a U-turn dearest. */
function turnCost(from: number, to: number) {
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  const turn = angleBetween(from, to)
  return turn <= 90 ? 0 : ((turn - 90) / 90) * U_TURN_M
}

function cellKey(p: XY) {
  return `${Math.floor(p.x / CELL_M)},${Math.floor(p.y / CELL_M)}`
}

/** Every cell the bounding box of a–b, grown by `pad` meters, touches. */
function cellsAround(a: XY, b: XY, pad: number): string[] {
  const keys: string[] = []
  const [x0, x1] = [Math.min(a.x, b.x) - pad, Math.max(a.x, b.x) + pad]
  const [y0, y1] = [Math.min(a.y, b.y) - pad, Math.max(a.y, b.y) + pad]
  for (let cx = Math.floor(x0 / CELL_M); cx <= Math.floor(x1 / CELL_M); cx++) {
    for (let cy = Math.floor(y0 / CELL_M); cy <= Math.floor(y1 / CELL_M); cy++) keys.push(`${cx},${cy}`)
  }
  return keys
}

/** Points within 10 cm of each other are the same junction. */
function keyOf(p: XY) {
  return `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`
}

const M_PER_DEG = 111_320
/**
 * How far off a centerline (meters) an aircraft is still taken to be on it:
 * about a wide taxiway's half-width, plus GPS error and corner-cutting.
 */
export const SNAP_M = 35
/** How much further off (meters) a line straight across the way it's moving counts as, choosing which to snap to. */
const CROSSING_M = 30
const CELL_M = 100
/** A line ending this close (meters) to another is joined onto it. */
const JOIN_M = 10
/** A route can be at most this many times the straight line between reports... */
const MAX_DETOUR = 2.5
/** ...or this much longer (meters), whichever allows more, before it's taken to be wrong. */
const DETOUR_M = 80
/** Setting off or arriving more than this far (degrees) from the way it's moving counts as the wrong way... */
const AGAINST_DEG = 100
/** ...adding this much (meters) to the route... */
const AGAINST_M = 100
/** ...as does a U-turn along the way (less for gentler turns past a right angle). */
const U_TURN_M = 150
