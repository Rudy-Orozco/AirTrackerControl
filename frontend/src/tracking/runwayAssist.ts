import { AIRPORT_PRESET } from '../config/config'
import type { AirportLayout } from '../diorama/diorama'
import type { LatLon, Track } from './tracker'

/**
 * Lines arrivals and departures up with the runways near the ground, where
 * reports are too sparse and noisy to draw a convincing approach or climb-out.
 *
 * Every frame, each airborne aircraft is scored against every runway direction:
 * how well it's established on final (lined up, on the extended centerline,
 * descending, near the 3° glide path) or climbing out (lined up past the
 * departure end, climbing). The best score sets how strongly the drawn path
 * is pulled onto the runway's own geometry: sideways onto the centerline, the
 * nose onto the runway heading with the wings level, and on final, down the
 * glide path to the touchdown zone. The strength eases after the score, so a
 * go-around (climbing away), a sidestep to another runway or a turn off
 * lets go smoothly, and a just-captured approach settles on gently. Only the
 * drawn path changes: the tracker still follows the reports underneath.
 */
export class RunwayAssist {
  private readonly ends: RunwayEnd[]
  private readonly lat0 = AIRPORT_PRESET.lat
  private readonly lon0 = AIRPORT_PRESET.lon
  private readonly lonScale = Math.cos((AIRPORT_PRESET.lat * Math.PI) / 180)
  /** Each aircraft's eased assist strength (0 to 1), and the runway direction it's assisted onto. */
  /**
   * Per aircraft: how strongly it's assisted (`k`, 0 to 1, eased), onto which
   * runway direction, whether landing, and `slide`: how far (meters, right of
   * that runway's centerline) the line it's held to still sits, easing to 0
   * after moving across from a parallel runway.
   */
  private readonly state = new Map<Track, { k: number; end: RunwayEnd | null; landing: boolean; slide: number }>()

  constructor(layout: AirportLayout) {
    // A runway may come in several pieces sharing a name: its ends are its two furthest points.
    const byRef = new Map<string, Vec[]>()
    for (const r of layout.runways) {
      const points = byRef.get(r.ref) ?? []
      points.push(...r.line.map(([lon, lat]) => this.toMeters({ lat, lon })))
      byRef.set(r.ref, points)
    }
    this.ends = [...byRef.values()].flatMap((points) => {
      let [a, b] = [points[0], points[0]]
      for (const p of points) for (const q of points) if (dist(p, q) > dist(a, b)) [a, b] = [p, q]
      const length = dist(a, b)
      if (length < 500) return []
      // Landing toward either end, so a direction each way.
      return [end(a, b, length), end(b, a, length)]
    })
  }

  /**
   * Pulls `t`'s drawn position, altitude and heading toward the runway it's
   * landing on or departing from. Turned off (`enabled` false), lets go as it
   * would on a go-around, so nothing jumps.
   */
  apply(t: Track, dtMs: number, enabled = true) {
    const state = this.state.get(t) ?? { k: 0, end: null, landing: false, slide: 0 }
    this.state.set(t, state)
    const best = !enabled ? NO_FIT : t.landedAt === null ? this.best(t, state.end) : this.landed(t)
    if (best.end !== state.end) {
      if (state.end && best.end && state.k >= SWITCH_BELOW && isParallel(state.end, best.end)) {
        // Over to a parallel runway without letting go: the line it's held to slides across.
        const along = this.along(state.end, t.pos)
        const held = this.offLine(state.end, along, state.slide)
        state.end = best.end
        state.slide = signedAcross(best.end, held)
      } else if (state.k < SWITCH_BELOW) {
        // Anything else only once the last has let go, so the drawn aircraft never jumps across.
        state.end = best.end
        state.slide = 0
      }
    }
    state.slide *= dtMs > 0 ? Math.exp(-dtMs / SLIDE_MS) : 1
    const target = !enabled ? NO_FIT : best.end === state.end ? best : state.end ? this.fitTo(t, state.end) : NO_FIT
    if (target.end) state.landing = target.glideFt !== null
    const ease = target.score > state.k ? CAPTURE_MS : RELEASE_MS
    state.k += (target.score - state.k) * (dtMs > 0 ? 1 - Math.exp(-dtMs / ease) : 0)
    const k = state.k
    if (k < 0.001 || !state.end) return

    // Where it is along the runway it's assisted onto (even while letting go of it).
    const e = state.end
    const along = this.along(e, t.pos)
    const onLine = this.fromMeters(this.offLine(e, along, state.slide))
    t.pos = { lat: t.pos.lat + (onLine.lat - t.pos.lat) * k, lon: t.pos.lon + (onLine.lon - t.pos.lon) * k }
    t.heading = t.heading + angleTo(t.heading, e.bearing) * k
    // Wings level once established.
    t.turning *= 1 - k
    if (target.glideFt !== null && t.altitude !== null) {
      const glideAlt = AIRPORT_PRESET.elevationFt + target.glideFt
      t.altitude += (glideAlt - t.altitude) * k * target.glideWeight
    }
  }

  /**
   * The path the assist is guiding `t` along, for drawing: down the glide path
   * to the touchdown zone (landing), or out along the extended centerline,
   * climbing (takeoff); with how strongly it's engaged (0 to 1). Null when it
   * isn't, or once it's touched down. Still finishing its takeoff (see
   * TakeoffProfile), it's shown in full, carrying on from the ground's (groundPath).
   */
  path(t: Track): AssistPath | null {
    const state = this.state.get(t)
    const takingOff = t.takeoff !== null
    if (!state?.end || (state.k < MIN_SHOWN && !takingOff) || t.landedAt !== null || t.altitude === null) return null
    const e = state.end
    const along = this.along(e, t.pos)
    if (state.landing && !takingOff) {
      // From abeam the aircraft down to the touchdown zone, then along the runway.
      const start = Math.min(along, TOUCHDOWN_M)
      const points: LatLon[] = []
      const alts: number[] = []
      for (let i = 0; i <= PATH_POINTS; i++) {
        const s = start + ((e.length - start) * i) / PATH_POINTS
        points.push(this.at(e, s))
        alts.push(AIRPORT_PRESET.elevationFt + (Math.max(TOUCHDOWN_M - s, 0) * GLIDE_TAN) / M_PER_FT)
      }
      return { landing: true, points, alts, strength: state.k }
    }
    // Climbing out at its reported gradient (or a typical one); still rolling, from where it'll lift off.
    const fps = (t.info.groundSpeed ?? 0) * FPS_PER_KT
    const vs = t.info.verticalRate ?? 0
    const gradient = vs > 200 && fps > 50 ? vs / 60 / fps : TYPICAL_GRADIENT
    const rolling = t.takeoff && t.takeoff.liftedAt === null ? this.along(e, t.takeoff.liftoff) : null
    const from = rolling === null ? Math.max(t.altitude, AIRPORT_PRESET.elevationFt) : AIRPORT_PRESET.elevationFt
    return { landing: false, ...this.climbOut(e, along, from, rolling, gradient), strength: takingOff ? Math.max(state.k, 1) : state.k }
  }

  /**
   * A departure's takeoff path while it's still on the ground (the ground view's):
   * lined up on a runway, holding or rolling, down the runway to where it'll
   * lift off (see liftoffPoint), then climbing out. Null unless it's on a
   * runway, pointing along it.
   */
  groundPath(pos: LatLon, heading: number): AssistPath | null {
    const e = this.departing(pos, heading)
    if (!e) return null
    const along = this.along(e, pos)
    const liftoff = Math.max(e.length * LIFTOFF_FRACTION, along)
    return { landing: false, ...this.climbOut(e, along, AIRPORT_PRESET.elevationFt, liftoff, TYPICAL_GRADIENT), strength: 1 }
  }

  /**
   * Where a takeoff from this runway lifts off: two-thirds of the way down it
   * (about where airliners do), wherever its reports say it already is. Null
   * unless the aircraft at `pos` is on a runway, pointing along it.
   */
  liftoffPoint(pos: LatLon, heading: number): LatLon | null {
    const e = this.departing(pos, heading)
    return e ? this.at(e, e.length * LIFTOFF_FRACTION) : null
  }

  /** The runway direction an aircraft at `pos` heading `heading` is lined up on, or rolling down; null if none. */
  private departing(pos: LatLon, heading: number): RunwayEnd | null {
    const p = this.toMeters(pos)
    for (const e of this.ends) {
      const along = (p.x - e.from.x) * e.dir.x + (p.y - e.from.y) * e.dir.y
      const across = Math.abs((p.x - e.from.x) * e.dir.y - (p.y - e.from.y) * e.dir.x)
      if (along < -LINED_UP_BEHIND_M || along > e.length || across > ON_RUNWAY_M) continue
      if (Math.abs(angleTo(heading, e.bearing)) > LINED_UP_DEG) continue
      return e
    }
    return null
  }

  /**
   * Points out along runway `e`'s centerline from `along` to the end of the
   * climb-out: on the ground until `liftoff` (meters along; null if already
   * flying), then climbing from `fromAlt` at `gradient` (feet per foot).
   */
  private climbOut(e: RunwayEnd, along: number, fromAlt: number, liftoff: number | null, gradient: number) {
    const end = e.length + CLIMB_OUT_M
    const stations = Array.from({ length: PATH_POINTS + 1 }, (_, i) => along + ((end - along) * i) / PATH_POINTS)
    // The liftoff point itself, so the path leaves the runway exactly there.
    if (liftoff !== null && liftoff > along && liftoff < end) stations.push(liftoff)
    stations.sort((a, b) => a - b)
    const climbFrom = liftoff ?? along
    return {
      points: stations.map((s) => this.at(e, s)),
      alts: stations.map((s) => fromAlt + (Math.max(s - climbFrom, 0) * gradient) / M_PER_FT),
    }
  }

  private along(e: RunwayEnd, pos: LatLon | Vec) {
    if ('x' in pos) return (pos.x - e.from.x) * e.dir.x + (pos.y - e.from.y) * e.dir.y
    const p = this.toMeters(pos)
    return (p.x - e.from.x) * e.dir.x + (p.y - e.from.y) * e.dir.y
  }

  private at(e: RunwayEnd, s: number) {
    return this.fromMeters({ x: e.from.x + e.dir.x * s, y: e.from.y + e.dir.y * s })
  }

  /** Forgets aircraft no longer tracked. */
  prune(alive: (t: Track) => boolean) {
    for (const t of this.state.keys()) if (!alive(t)) this.state.delete(t)
  }

  /**
   * The runway direction this aircraft fits best, and how well. Nearer its
   * centerline counts for more (so parallels sort themselves out), and the one
   * it's already on (`current`) gets a head start, so it doesn't flicker between them.
   */
  private best(t: Track, current: RunwayEnd | null): Fit {
    // Which runway it's lined up for is judged from where it was last reported, which
    // this assist never moves: judging from where it's drawn would favor whichever
    // runway it's already being pulled onto, so it'd flip late between parallels.
    const reported = this.toMeters({ lat: t.info.lat, lon: t.info.lon })
    let best: Fit = NO_FIT
    let bestAcross = Infinity
    let stay: { fit: Fit; across: number } | null = null
    for (const e of this.ends) {
      const fit = this.fit(t, e)
      if (fit.score < MIN_SHOWN) continue
      const across = Math.abs(signedAcross(e, reported))
      if (e === current) stay = { fit, across }
      if (across < bestAcross) {
        best = fit
        bestAcross = across
      }
    }
    // Keeps to the runway it's on unless the reports are clearly nearer another.
    if (stay && stay.across < bestAcross + SWITCH_MARGIN_M) return stay.fit
    return best
  }

  /** The point `along` runway `e`, `slide` meters right of its centerline (meters east and north). */
  private offLine(e: RunwayEnd, along: number, slide: number): Vec {
    return { x: e.from.x + e.dir.x * along + e.dir.y * slide, y: e.from.y + e.dir.y * along - e.dir.x * slide }
  }

  /** How well this aircraft fits one runway direction, while letting go of it for another. */
  private fitTo(t: Track, e: RunwayEnd): Fit {
    return t.landedAt === null ? this.fit(t, e) : this.landed(t)
  }

  /** How well this aircraft fits one runway direction: on final for it, or climbing out from it. */
  private fit(t: Track, e: RunwayEnd): Fit {
    const altitude = t.altitude
    if (altitude === null) return NO_FIT
    const height = altitude - AIRPORT_PRESET.elevationFt
    if (height > MAX_HEIGHT_FT) return NO_FIT
    const p = this.toMeters(t.pos)
    const reported = t.info.track ?? t.heading
    const vs = t.info.verticalRate ?? 0
    const along = (p.x - e.from.x) * e.dir.x + (p.y - e.from.y) * e.dir.y
    const across = Math.abs((p.x - e.from.x) * e.dir.y - (p.y - e.from.y) * e.dir.x)
    // Lined up by both its last report and where it's drawn heading now (before this assist
    // turns it): a turn between reports lets go at once. On final, loosely (intercepting the
    // centerline); climbing out, tightly, so a turn straight after takeoff shows straight away.
    const off = Math.max(Math.abs(angleTo(reported, e.bearing)), Math.abs(angleTo(t.heading, e.bearing)))
    const lined = fade(off, 12, 25)
    const linedOut = fade(off, 6, 15)
    let best: Fit = { ...NO_FIT, along }
    if (lined === 0) return best

    // On final: before the far end, descending (not climbing away, so a go-around lets go),
    // and not just lifted off (low over the runway, it'd look like it's landing).
    if (along > -FINAL_M && along < e.length && t.liftoffAt === null) {
      const before = Math.max(TOUCHDOWN_M - along, 0)
      const glideFt = (before * GLIDE_TAN) / M_PER_FT
      const cone = CENTERLINE_M + before * CONE_SLOPE
      const score =
        lined *
        fade(across, cone * 0.5, cone) *
        fade(along < 0 ? -along : 0, FINAL_FULL_M, FINAL_M) *
        fade(Math.abs(height - glideFt), 400, 900) *
        fade(vs, 200, 700)
      if (score > best.score) best = { score, end: e, along, glideFt, glideWeight: 1, offCenter: across / cone }
    }
    // Climbing out: over the runway or past its far end, low, climbing (or just lifted off).
    if (along > 0 && along < e.length + CLIMB_OUT_M) {
      const past = Math.max(along - e.length, 0)
      const cone = CENTERLINE_M + past * CONE_SLOPE
      const climbing = Math.max(fade(-vs, -300, 200), height < 300 && (t.info.groundSpeed ?? 0) > 80 ? 1 : 0)
      const score = linedOut * climbing * fade(across, cone * 0.5, cone) * fade(past, CLIMB_OUT_M * 0.6, CLIMB_OUT_M) * fade(height, 1500, 2500)
      if (score > best.score) best = { score, end: e, along, glideFt: null, glideWeight: 0, offCenter: across / cone }
    }
    return best
  }

  /** Just touched down (fading out while the ground view takes over): keep rolling down the runway it landed on. */
  private landed(t: Track): Fit {
    const p = this.toMeters(t.pos)
    let best: Fit = NO_FIT
    for (const e of this.ends) {
      const along = (p.x - e.from.x) * e.dir.x + (p.y - e.from.y) * e.dir.y
      const across = Math.abs((p.x - e.from.x) * e.dir.y - (p.y - e.from.y) * e.dir.x)
      if (along < -FINAL_FULL_M || along > e.length || across > CENTERLINE_M * 2) continue
      if (Math.abs(angleTo(t.heading, e.bearing)) > 30) continue
      const score = 1 - across / (CENTERLINE_M * 2)
      if (score > best.score) best = { score, end: e, along, glideFt: 0, glideWeight: 1, offCenter: across / (CENTERLINE_M * 2) }
    }
    return best
  }

  private toMeters({ lat, lon }: LatLon): Vec {
    return { x: (lon - this.lon0) * M_PER_DEG * this.lonScale, y: (lat - this.lat0) * M_PER_DEG }
  }

  private fromMeters({ x, y }: Vec): LatLon {
    return { lat: this.lat0 + y / M_PER_DEG, lon: this.lon0 + x / (M_PER_DEG * this.lonScale) }
  }
}

/** The path the assist is guiding an aircraft along (see RunwayAssist.path). */
export interface AssistPath {
  /** Landing (down the glide path) or taking off (climbing out). */
  landing: boolean
  points: LatLon[]
  /** Feet, at each point. */
  alts: number[]
  /** How strongly the assist is engaged (0 to 1), for how boldly to draw it. */
  strength: number
}

interface Vec {
  x: number
  y: number
}

/** A runway seen from one end: landing at `from` (the threshold), rolling along `dir` (unit) for `length` meters. */
interface RunwayEnd {
  from: Vec
  dir: Vec
  length: number
  /** Degrees from north along `dir`. */
  bearing: number
}

interface Fit {
  score: number
  end: RunwayEnd | null
  /** Meters past the threshold (negative on final). */
  along: number
  /** Height (feet above the field) the glide path puts it at, on final; null climbing out. */
  glideFt: number | null
  glideWeight: number
  /** How far off the centerline, as a fraction of how far still counts (0 on it, 1 at the edge). */
  offCenter: number
}

const NO_FIT: Fit = { score: 0, end: null, along: 0, glideFt: null, glideWeight: 0, offCenter: 1 }

function end(from: Vec, to: Vec, length: number): RunwayEnd {
  const dir = { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
  return { from, dir, length, bearing: (Math.atan2(dir.x, dir.y) * 180) / Math.PI }
}

/** Meters right of runway `e`'s centerline (looking along it). */
function signedAcross(e: RunwayEnd, p: Vec) {
  return (p.x - e.from.x) * e.dir.y - (p.y - e.from.y) * e.dir.x
}

/** Whether two runway directions run side by side, the same way. */
function isParallel(a: RunwayEnd, b: RunwayEnd) {
  return Math.abs(angleTo(a.bearing, b.bearing)) < PARALLEL_DEG
}

function dist(a: Vec, b: Vec) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Signed shortest turn (degrees) from `from` to `to`. */
function angleTo(from: number, to: number) {
  return ((((to - from) % 360) + 540) % 360) - 180
}

/** 1 up to `full`, easing to 0 at `none` (and beyond). */
function fade(value: number, full: number, none: number) {
  if (value <= full) return 1
  if (value >= none) return 0
  const x = (value - full) / (none - full)
  return 1 - x * x * (3 - 2 * x)
}

const M_PER_DEG = 111_320
const M_PER_FT = 0.3048
/** The standard 3° glide path, aiming about 300 m past the threshold. */
const GLIDE_TAN = Math.tan((3 * Math.PI) / 180)
const TOUCHDOWN_M = 300
/** Only aircraft below this height above the field are assisted at all. */
const MAX_HEIGHT_FT = 3000
/** On final from this far out (meters before the threshold), fully from this close. */
const FINAL_M = 15_000
const FINAL_FULL_M = 9_000
/** Climbing out, assisted to this far past the departure end. */
const CLIMB_OUT_M = 5_000
/** How far off the centerline still counts, near the runway, widening this much per meter further out. */
const CENTERLINE_M = 120
const CONE_SLOPE = 0.06
/** How quickly the assist takes hold, and lets go. */
const CAPTURE_MS = 2500
const RELEASE_MS = 1500
/** Paths are drawn once the assist is at least this engaged, with this many points. */
const MIN_SHOWN = 0.05
const PATH_POINTS = 24
const FPS_PER_KT = 1.68781
/** About 7°: a typical airliner's initial climb, when no climb rate is sent. */
const TYPICAL_GRADIENT = 0.12
/** On a runway: within this far of its centerline (meters), up to this far behind its threshold, pointing within this of its heading. */
const ON_RUNWAY_M = 40
const LINED_UP_BEHIND_M = 60
const LINED_UP_DEG = 15
/** Takeoffs lift off this far down the runway (a fraction of its length). */
const LIFTOFF_FRACTION = 2 / 3
/** Only moves to another runway once the last has let go below this strength. */
const SWITCH_BELOW = 0.05
/** Moves to another runway only once the reports are this much (meters) nearer its centerline. */
const SWITCH_MARGIN_M = 60
/** Runways within this many degrees of each other are parallel: moving between them slides across. */
const PARALLEL_DEG = 5
/** How long (ms) sliding across to a parallel runway's centerline takes (time constant). */
const SLIDE_MS = 5000
