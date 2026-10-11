import type { AirportLayout } from '../diorama/diorama'
import type { LatLon } from './tracker'

/**
 * The airport's taxiway, taxilane and runway centerlines, for keeping
 * aircraft on them as they move on the ground: positions between reports cut
 * corners and drift with GPS error, while real aircraft follow the painted lines.
 * Segments are kept in a grid of cells so the nearest one is quick to find.
 */
export class TaxiNetwork {
  private readonly cells = new Map<string, Segment[]>()
  private readonly lat0: number
  private readonly lon0: number
  private readonly lonScale: number

  constructor(layout: AirportLayout) {
    const all = [...layout.taxiways, ...layout.runways.map((r) => r.line)]
    const first = all[0]?.[0] ?? [0, 0]
    ;[this.lon0, this.lat0] = first
    this.lonScale = Math.cos((this.lat0 * Math.PI) / 180)
    for (const line of all) {
      for (let i = 1; i < line.length; i++) {
        const a = this.toMeters({ lon: line[i - 1][0], lat: line[i - 1][1] })
        const b = this.toMeters({ lon: line[i][0], lat: line[i][1] })
        const length = Math.hypot(b.x - a.x, b.y - a.y)
        if (length < 0.5) continue
        const segment: Segment = { ax: a.x, ay: a.y, dx: (b.x - a.x) / length, dy: (b.y - a.y) / length, length }
        // Filed under every cell its bounding box (plus the snapping reach) touches.
        const [x0, x1] = [Math.min(a.x, b.x) - SNAP_M, Math.max(a.x, b.x) + SNAP_M]
        const [y0, y1] = [Math.min(a.y, b.y) - SNAP_M, Math.max(a.y, b.y) + SNAP_M]
        for (let cx = Math.floor(x0 / CELL_M); cx <= Math.floor(x1 / CELL_M); cx++) {
          for (let cy = Math.floor(y0 / CELL_M); cy <= Math.floor(y1 / CELL_M); cy++) {
            const key = `${cx},${cy}`
            const list = this.cells.get(key)
            if (list) list.push(segment)
            else this.cells.set(key, [segment])
          }
        }
      }
    }
  }

  /**
   * The nearest point on a centerline within reach of `pos`, and the line's
   * direction there (degrees from north, either way along it), or null when
   * there's none (out on an apron, say).
   */
  snap(pos: LatLon): { pos: LatLon; bearing: number } | null {
    const p = this.toMeters(pos)
    const candidates = this.cells.get(`${Math.floor(p.x / CELL_M)},${Math.floor(p.y / CELL_M)}`)
    if (!candidates) return null
    let best: { x: number; y: number; segment: Segment } | null = null
    let bestDistance = SNAP_M
    for (const s of candidates) {
      const t = Math.min(Math.max((p.x - s.ax) * s.dx + (p.y - s.ay) * s.dy, 0), s.length)
      const x = s.ax + s.dx * t
      const y = s.ay + s.dy * t
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < bestDistance) {
        bestDistance = d
        best = { x, y, segment: s }
      }
    }
    if (!best) return null
    return { pos: this.fromMeters(best.x, best.y), bearing: (Math.atan2(best.segment.dx, best.segment.dy) * 180) / Math.PI }
  }

  private toMeters({ lat, lon }: LatLon) {
    return { x: (lon - this.lon0) * M_PER_DEG * this.lonScale, y: (lat - this.lat0) * M_PER_DEG }
  }

  private fromMeters(x: number, y: number): LatLon {
    return { lat: this.lat0 + y / M_PER_DEG, lon: this.lon0 + x / (M_PER_DEG * this.lonScale) }
  }
}

interface Segment {
  ax: number
  ay: number
  /** Unit direction from a to b, and its length (meters). */
  dx: number
  dy: number
  length: number
}

const M_PER_DEG = 111_320
/**
 * How far off a centerline (meters) an aircraft is still taken to be on it:
 * about a wide taxiway's half-width, plus GPS error and corner-cutting.
 */
export const SNAP_M = 35
const CELL_M = 100
