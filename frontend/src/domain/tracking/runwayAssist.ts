import { AIRPORT_PRESET } from '../../config/config'
import type { AirportLayout } from '../../types/airport'
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
 * glide path to the touchdown zone. Its height is its reports' until it's
 * low on final, then eased onto the glide path, and kept from going below it
 * (see glideWeight): reported altitudes near the ground are rough, and it has
 * to meet the runway's surface at touchdown. The strength eases after the score, so a
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
  /** How strongly each runway direction's guides are shown (see guides), eased, and when they were last worked out. */
  private readonly guideShown = new Map<string, number>()
  private guidesAt: number | null = null
  /** When each runway direction was last in use ("L27L" landing, "D26L" departing), for runwaysInUse. */
  private readonly lastUsed = new Map<string, number>()

  constructor(layout: AirportLayout) {
    // A runway may come in several pieces sharing a name: its ends are its two furthest points.
    // Unnamed pieces each stand alone: they're not all one runway.
    const byRef = new Map<string, Vec[]>()
    layout.runways.forEach((r, i) => {
      const ref = r.ref || `unnamed ${i}`
      const points = byRef.get(ref) ?? []
      points.push(...r.line.map(([lon, lat]) => this.toMeters({ lat, lon })))
      byRef.set(ref, points)
    })
    this.ends = [...byRef].flatMap(([ref, points]) => {
      let [a, b] = [points[0], points[0]]
      for (const p of points) for (const q of points) if (dist(p, q) > dist(a, b)) [a, b] = [p, q]
      const length = dist(a, b)
      if (length < 500) return []
      // Landing toward either end, so a direction each way.
      return [end(a, b, length, ref), end(b, a, length, ref)]
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
      // Its reported height, dragged onto the glide path as it gets low on final, and kept
      // from going below it just as gradually (it may well be below it further out, flying
      // level to intercept it from below, as on an ILS: lifting it then would pop it up).
      // Where it settles onto it, rounded off, less and less so nearer the runway.
      const glideAlt = AIRPORT_PRESET.elevationFt + target.glideFt
      const w = target.glideWeight
      const dragged = t.altitude + (glideAlt - t.altitude) * w
      const round = SETTLE_FT * (1 - w)
      const h = round > 0 ? Math.min(Math.max(0.5 + (dragged - glideAlt) / (2 * round), 0), 1) : dragged >= glideAlt ? 1 : 0
      const floored = glideAlt + (dragged - glideAlt) * h + round * h * (1 - h)
      const held = dragged + (floored - dragged) * w
      t.altitude += (held - t.altitude) * k
      // Descending as the glide path does, as fast as it's moving along it (rounding out in the
      // flare): its nose follows, and the ground view carries on from it at touchdown.
      const cos = Math.cos((t.pos.lat * Math.PI) / 180)
      const speed = Math.max((t.vel.lon * cos * e.dir.x + t.vel.lat * e.dir.y) * M_PER_DEG, 0)
      t.altSpeed += (glideSlope(along) * speed - t.altSpeed) * k * w
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
      // From abeam the aircraft down the glide path and through the flare to touchdown, then along the runway.
      return { landing: true, ...this.glideLine(e, Math.min(along, TOUCHDOWN_AT_M), e.length), strength: state.k }
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
   * What the assist guides aircraft along, for each runway direction it's
   * guiding any onto (or did lately: they fade in and out with its use). Landing:
   * the localizer (the extended centerline, and how far either side of it still
   * counts), the glide path with a bar every nautical mile from touchdown, the
   * gate where it starts holding them to it (GLIDE_FROM_FT) and the touchdown
   * aiming point. Taking off: the climb-out (centerline and edges).
   */
  /**
   * The runways aircraft are landing on and taking off from, by name (e.g.
   * "27L"): in use right now, or within the last `holdMs` (so one stays listed
   * between aircraft, rather than going the moment one has taken off).
   */
  runwaysInUse(now: number, holdMs: number): { landing: string[]; departing: string[] } {
    for (const [t, s] of this.state) {
      if (!s.end?.name || t.opacity <= 0) continue
      if ((t.takeoff && !s.landing ? 1 : s.k) < IN_USE_FROM) continue
      this.lastUsed.set(`${s.landing ? 'L' : 'D'}${s.end.name}`, now)
    }
    const landing = new Set<string>()
    const departing = new Set<string>()
    for (const [key, at] of this.lastUsed) {
      if (now - at > holdMs) this.lastUsed.delete(key)
      else (key[0] === 'L' ? landing : departing).add(key.slice(1))
    }
    const sorted = (names: Set<string>) => [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return { landing: sorted(landing), departing: sorted(departing) }
  }

  guides(now: number): RunwayGuide[] {
    const dt = this.guidesAt === null ? 0 : Math.max(now - this.guidesAt, 0)
    this.guidesAt = now
    const using = new Map<string, number>()
    for (const [t, s] of this.state) {
      if (!s.end) continue
      // Still finishing its takeoff, it's on its climb-out however much it's being pulled (see path).
      const k = (t.takeoff && !s.landing ? 1 : s.k) * t.opacity
      if (k < MIN_SHOWN) continue
      const id = `${this.ends.indexOf(s.end)}${s.landing ? 'L' : 'D'}`
      using.set(id, Math.max(using.get(id) ?? 0, k))
    }
    const ease = 1 - Math.exp(-dt / GUIDE_FADE_MS)
    for (const id of new Set([...this.guideShown.keys(), ...using.keys()])) {
      const shown = (this.guideShown.get(id) ?? 0) + ((using.get(id) ?? 0) - (this.guideShown.get(id) ?? 0)) * ease
      if (shown < MIN_SHOWN && !using.has(id)) this.guideShown.delete(id)
      else this.guideShown.set(id, shown)
    }
    return [...this.guideShown].map(([id, strength]) => {
      const e = this.ends[Number(id.slice(0, -1))]
      return id.endsWith('L') ? this.landingGuide(id, e, strength) : this.climbOutGuide(id, e, strength)
    })
  }

  private landingGuide(id: string, e: RunwayEnd, strength: number): RunwayGuide {
    const glide = (s: number) => AIRPORT_PRESET.elevationFt + glideHeight(s)
    const width = (s: number) => CENTERLINE_M + Math.max(TOUCHDOWN_M - s, 0) * CONE_SLOPE
    const bar = (s: number, half: number, kind: GuideBar['kind']): GuideBar => ({
      from: this.fromMeters(this.offLine(e, s, -half)),
      to: this.fromMeters(this.offLine(e, s, half)),
      alt: glide(s),
      kind,
    })
    const bars: GuideBar[] = []
    for (let s = TOUCHDOWN_M - M_PER_NM; s > -FINAL_M; s -= M_PER_NM) bars.push(bar(s, MILE_BAR_M, 'mile'))
    bars.push(bar(TOUCHDOWN_M - (GLIDE_FROM_FT * M_PER_FT) / GLIDE_TAN, GATE_BAR_M, 'gate'))
    bars.push(bar(TOUCHDOWN_M, TOUCHDOWN_BAR_M, 'touchdown'))
    return {
      id,
      landing: true,
      strength,
      centerline: [this.at(e, -FINAL_M), this.at(e, 0)],
      edges: [-1, 1].map((side) => [-FINAL_M, 0].map((s) => this.fromMeters(this.offLine(e, s, side * width(s))))) as [LatLon[], LatLon[]],
      glide: this.glideLine(e, -FINAL_M, TOUCHDOWN_AT_M),
      bars,
    }
  }

  /**
   * Points down runway `e`'s glide path from `from` to `to` (meters along), with
   * their heights (feet): straight, but closely spaced through the flare, so it
   * rounds out smoothly.
   */
  private glideLine(e: RunwayEnd, from: number, to: number) {
    const stations = Array.from({ length: PATH_POINTS + 1 }, (_, i) => from + ((to - from) * i) / PATH_POINTS)
    for (let i = 0; i <= FLARE_POINTS; i++) {
      const s = FLARE_START_M + ((TOUCHDOWN_AT_M - FLARE_START_M) * i) / FLARE_POINTS
      if (s > from && s < to) stations.push(s)
    }
    stations.sort((a, b) => a - b)
    return { points: stations.map((s) => this.at(e, s)), alts: stations.map((s) => AIRPORT_PRESET.elevationFt + glideHeight(s)) }
  }

  private climbOutGuide(id: string, e: RunwayEnd, strength: number): RunwayGuide {
    const width = (s: number) => CENTERLINE_M + Math.max(s - e.length, 0) * CONE_SLOPE
    const end = e.length + CLIMB_OUT_M
    return {
      id,
      landing: false,
      strength,
      centerline: [this.at(e, e.length * LIFTOFF_FRACTION), this.at(e, end)],
      edges: [-1, 1].map((side) => [e.length, end].map((s) => this.fromMeters(this.offLine(e, s, side * width(s))))) as [LatLon[], LatLon[]],
      glide: null,
      bars: [],
    }
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
      const glideFt = glideHeight(along)
      const cone = CENTERLINE_M + before * CONE_SLOPE
      const score =
        lined *
        fade(across, cone * 0.5, cone) *
        fade(along < 0 ? -along : 0, FINAL_FULL_M, FINAL_M) *
        fade(Math.abs(height - glideFt), 400, 900) *
        fade(vs, 200, 700)
      if (score > best.score) best = { score, end: e, along, glideFt, glideWeight: glideWeight(glideFt), offCenter: across / cone }
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
      // Still finishing its flare, if it's reported down before it's drawn touching down.
      if (score > best.score) best = { score, end: e, along, glideFt: glideHeight(along), glideWeight: 1, offCenter: across / (CENTERLINE_M * 2) }
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

/** What the assist guides aircraft along on one runway direction, for drawing (see RunwayAssist.guides). */
export interface RunwayGuide {
  /** Stays the same for the same runway direction, landing or taking off. */
  id: string
  landing: boolean
  /** How boldly to draw it (0 to 1): as strongly as it's guiding anyone, eased. */
  strength: number
  /** Down the extended centerline, on the ground: the localizer (landing), or the climb-out. */
  centerline: LatLon[]
  /** How far either side of it still counts, on the ground. */
  edges: [LatLon[], LatLon[]]
  /** Landing: the glide path, from furthest out to the touchdown aiming point, with its heights (feet). */
  glide: { points: LatLon[]; alts: number[] } | null
  /** Across the centerline, each with the glide path's height there (feet). */
  bars: GuideBar[]
}

/** A bar across a landing guide: every nautical mile from touchdown, the gate where it's held to the glide path, the touchdown aiming point. */
export interface GuideBar {
  from: LatLon
  to: LatLon
  alt: number
  kind: 'mile' | 'gate' | 'touchdown'
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
  /** Its name, e.g. "27L", if the runway has one. */
  name: string | null
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

function end(from: Vec, to: Vec, length: number, ref: string): RunwayEnd {
  const dir = { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
  const bearing = (Math.atan2(dir.x, dir.y) * 180) / Math.PI
  return { from, dir, length, bearing, name: endName(ref, bearing) }
}

/**
 * The name of the end of runway `ref` (e.g. "09R/27L") flown along `bearing`:
 * of its two names, the one whose number (magnetic, in tens of degrees) is
 * nearer. Unnamed runways have none.
 */
function endName(ref: string, bearing: number): string | null {
  const names = ref.split('/').filter((n) => /^\d{1,2}/.test(n))
  if (names.length === 0) return null
  const off = (n: string) => Math.abs(angleTo(bearing, parseInt(n, 10) * 10))
  return names.reduce((best, n) => (off(n) < off(best) ? n : best))
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

/**
 * Height (feet above the field) of the glide path `s` meters past the
 * threshold: 3° down toward the aiming point until it's FLARE_FT up, then
 * rounding out (the flare), descending less and less steeply the further it
 * goes, to touch down at a fraction of the rate (FLARE_SINK) at TOUCHDOWN_AT_M.
 */
function glideHeight(s: number) {
  if (s <= FLARE_START_M) return ((TOUCHDOWN_M - s) * GLIDE_TAN) / M_PER_FT
  if (s >= TOUCHDOWN_AT_M) return 0
  return Math.max((FLARE_H_M + FLARE_BELOW_M) * Math.exp(-(s - FLARE_START_M) / FLARE_TAU_M) - FLARE_BELOW_M, 0) / M_PER_FT
}

/** How steeply (feet per meter along, negative: descending) the glide path descends `s` meters past the threshold. */
function glideSlope(s: number) {
  if (s <= FLARE_START_M) return -GLIDE_TAN / M_PER_FT
  if (s >= TOUCHDOWN_AT_M) return 0
  return -((FLARE_H_M + FLARE_BELOW_M) / FLARE_TAU_M) * Math.exp(-(s - FLARE_START_M) / FLARE_TAU_M) / M_PER_FT
}

/**
 * How strongly (0 to 1) an aircraft on final is held to the glide path, rather
 * than its reported altitude, where the glide path is `glideFt` above the
 * field: not at all until it's low on final, then more and more strongly,
 * gently at first, until it's fully on it just before the threshold.
 */
function glideWeight(glideFt: number) {
  return fade(glideFt, GLIDE_FULL_FT, GLIDE_FROM_FT)
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
/**
 * The flare: from this high (feet) over the runway, the glide path rounds out,
 * easing its descent smoothly (exponentially, with distance) to touch down at
 * this fraction of the approach's descent rate (about 150 ft a minute), around
 * 500 m past the threshold, rather than flying into the runway at 3°.
 */
const FLARE_FT = 40
const FLARE_SINK = 0.2
const FLARE_H_M = FLARE_FT * M_PER_FT
const FLARE_START_M = TOUCHDOWN_M - FLARE_H_M / GLIDE_TAN
/** It eases toward a line this far (meters) below the runway, so it reaches it still sinking a little, at TOUCHDOWN_AT_M. */
const FLARE_BELOW_M = (FLARE_H_M * FLARE_SINK) / (1 - FLARE_SINK)
const FLARE_TAU_M = (FLARE_H_M + FLARE_BELOW_M) / GLIDE_TAN
const TOUCHDOWN_AT_M = FLARE_START_M + FLARE_TAU_M * Math.log((FLARE_H_M + FLARE_BELOW_M) / FLARE_BELOW_M)
/** Drawn glide paths have this many extra points through the flare. */
const FLARE_POINTS = 12
/**
 * On final, held to its reported altitude until the glide path is this low
 * (feet above the field; about where airliners must be stable on the approach,
 * and pilots usually take over by hand), then eased onto the glide path, fully
 * from this low (just before the threshold).
 */
const GLIDE_FROM_FT = 1000
const GLIDE_FULL_FT = 50
/** Reported below the glide path low on final, it settles onto it, the corner rounded off over about this many feet (less nearer the runway). */
const SETTLE_FT = 150
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
/** How strongly an aircraft must be held to a runway for that runway to count as in use. */
const IN_USE_FROM = 0.5
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
/** Guides (see RunwayAssist.guides) fade in and out over about this long (ms, time constant). */
const GUIDE_FADE_MS = 1500
const M_PER_NM = 1852
/** Half the width (meters) of a landing guide's bars: each nautical mile, the gate, the touchdown aiming point. */
const MILE_BAR_M = 150
const GATE_BAR_M = 350
const TOUCHDOWN_BAR_M = 30
/** Runways within this many degrees of each other are parallel: moving between them slides across. */
const PARALLEL_DEG = 5
/** How long (ms) sliding across to a parallel runway's centerline takes (time constant). */
const SLIDE_MS = 5000
