import { CENTER, PROCEDURES } from '../../config/config'
import type { Flight } from '../tracking/flights'
import type { LatLon } from '../tracking/tracker'
import { activeProcedures, isSwitchedOn, pickedProcedures, pieceRole, procedurePieces, proceduresState, type Procedure, type ProcedureKind } from './procedures'

/** The procedure a flight is flying, as best its path so far shows. */
export interface ProcedureMatch {
  kind: ProcedureKind
  procedure: Procedure
  /** The named (enroute) transition it's on or was on, and its runway transition, where its path has shown them. */
  transition: string | null
  runway: string | null
  /** Not yet seen on it: the likeliest from where it's coming from or going to (see predict). */
  predicted?: boolean
}

/** The runways in use, by name (see Tracker.runwaysInUse). */
export interface RunwaysInUse {
  landing: string[]
  departing: string[]
}

/** Each flight's positions are kept this long, sampled at each update... */
const HISTORY_MS = 25 * 60_000
/** ...within this far (nm) of the airport. */
const HISTORY_NM = 120
/** A position this close (nm) to a procedure's line counts as on it. */
const ON_NM = 2
/**
 * A flight needs at least this many positions on a procedure, and this share
 * of those near it (within NEAR_NM: not counting cruise before it, far away),
 * to be matched to it.
 */
const MIN_ON = 4
const MIN_SHARE = 0.5
const NEAR_NM = 10

const NM_PER_DEG = 60
const LON_SCALE = Math.cos((CENTER.lat * Math.PI) / 180)

/** A flight's match counts once it's held for this many updates in a row (so a passing fit doesn't flicker on). */
const STEADY_UPDATES = 3
/** A transition counts as the one it's on once this many of its positions are on it. */
const ON_TRANSITION = 2

/**
 * Works out which STAR each arrival is flying, and which SID each departure:
 * its recent positions are compared with each procedure's lines, and the one
 * it's kept closest to (on it, within ON_NM, the most) wins. Shared stretches
 * near the airport fit several, so a flight's earlier path, further out, tells them apart.
 *
 * A match counts once it's held steady (STEADY_UPDATES). Only while
 * PROCEDURES.enabled.
 */
class ProcedureMatcher {
  private history = new Map<string, LatLon[]>()
  /** Each flight's latest fit, and for how many updates running it's been the same. */
  private fits = new Map<string, { match: ProcedureMatch; streak: number }>()
  /** Each arrival's and departure's likeliest procedure, until its path shows the one it's on. */
  private predictions = new Map<string, ProcedureMatch>()
  private runways: RunwaysInUse = { landing: [], departing: [] }

  update(flights: Flight[], runways: RunwaysInUse) {
    this.predictions.clear()
    // Off (or not identifying flights): nothing kept or worked out (paths start again from scratch when it's turned on).
    if (!identifying()) {
      this.history.clear()
      this.fits.clear()
      return
    }
    this.runways = runways
    const present = new Set<string>()
    for (const f of flights) {
      present.add(f.hex)
      const kind = f.kind === 'arrival' ? 'star' : f.kind === 'departure' ? 'sid' : null
      if (kind && PROCEDURES.predict) {
        const prediction = predict(kind, f, runways)
        if (prediction) this.predictions.set(f.hex, prediction)
      }
      if (!kind || f.onGround || f.distanceNm > HISTORY_NM) continue
      const points = this.history.get(f.hex) ?? []
      points.push({ lat: f.lat, lon: f.lon })
      // At most one position per update: HISTORY_MS of them.
      const keep = Math.ceil(HISTORY_MS / 10_000)
      if (points.length > keep) points.splice(0, points.length - keep)
      this.history.set(f.hex, points)
      this.fit(f.hex, best(kind, points))
      // An arrival's approach too, apart from its STAR: from its path once it's on one, else (predicting) from the runway it's likely bound for.
      if (kind === 'star') {
        this.fit(approachKey(f.hex), bestApproach(points))
        if (PROCEDURES.predict && !this.approachOf(f.hex)) {
          const prediction = predictApproach(this.likely(f.hex), runways)
          if (prediction) this.predictions.set(approachKey(f.hex), prediction)
        }
      }
    }
    for (const hex of this.history.keys()) {
      if (!present.has(hex)) {
        this.history.delete(hex)
        this.fits.delete(hex)
        this.fits.delete(approachKey(hex))
      }
    }
  }

  /** Records `match` as `key`'s latest fit, counting the updates running it's been the same. */
  private fit(key: string, match: ProcedureMatch | null) {
    const last = this.fits.get(key)
    if (!match) this.fits.delete(key)
    else this.fits.set(key, { match, streak: last?.match.procedure === match.procedure ? last.streak + 1 : 1 })
  }

  /** The approach arrival `hex` is steadily on, if any. */
  approachOf(hex: string) {
    return this.of(approachKey(hex))
  }

  /** The approach arrival `hex` is on, or else (with PROCEDURES.predict on) the one it's likeliest to fly (`predicted`). */
  likelyApproach(hex: string) {
    return this.likely(approachKey(hex))
  }

  /** The STAR or SID `hex` is steadily on, if any (or by approachKey, its approach). */
  of(hex: string) {
    const fit = identifying() ? this.fits.get(hex) : undefined
    return fit && fit.streak >= STEADY_UPDATES && isSwitchedOn(fit.match.kind, fit.match.procedure.name) ? fit.match : null
  }

  /** The runways in use as of the last update, for ruling out procedures' runway transitions. */
  runwaysInUse() {
    return this.runways
  }

  /** The procedure `hex` is on, or else (with PROCEDURES.predict on) the one it's likeliest to fly (`predicted`). */
  likely(hex: string): ProcedureMatch | null {
    const prediction = identifying() && PROCEDURES.predict ? this.predictions.get(hex) : undefined
    return this.of(hex) ?? (prediction && isSwitchedOn(prediction.kind, prediction.procedure.name) ? prediction : null)
  }

  /** The procedures flights are steadily on now, with how many, busiest first. */
  inUse(): { procedure: Procedure; kind: ProcedureKind; count: number }[] {
    if (!identifying()) return []
    const counts = new Map<Procedure, { procedure: Procedure; kind: ProcedureKind; count: number }>()
    for (const { match } of this.steady()) {
      if (!isSwitchedOn(match.kind, match.procedure.name)) continue
      const entry = counts.get(match.procedure) ?? { procedure: match.procedure, kind: match.kind, count: 0 }
      entry.count++
      counts.set(match.procedure, entry)
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.procedure.name.localeCompare(b.procedure.name))
  }

  /** How many flights are steadily on `procedure` now. */
  countOn(procedure: Procedure) {
    let count = 0
    for (const { match } of this.steady()) if (match.procedure === procedure) count++
    return count
  }

  private *steady() {
    for (const fit of this.fits.values()) if (fit.streak >= STEADY_UPDATES) yield fit
  }
}

export const procedureMatcher = new ProcedureMatcher()

/** Whether flights' procedures are being worked out at all (PROCEDURES.enabled and identify). */
export function identifying() {
  return PROCEDURES.enabled && PROCEDURES.identify
}

/** The procedure of `kind` that `points` keep closest to, if one fits well enough. */
function best(kind: ProcedureKind, points: LatLon[]): ProcedureMatch | null {
  const data = proceduresState().data
  if (!data || points.length < MIN_ON) return null
  const xy = points.map(toNm)
  let found: { match: ProcedureMatch; on: number; mean: number } | null = null
  for (const procedure of activeProcedures(kind)) {
    // Not an approach's missed approach: only a flight going around flies that.
    const pieces = procedurePieces(procedure)
      .filter((p) => pieceRole(p) !== 'missed')
      .map((p) => ({ piece: p, line: p.points.map(toNm) }))
    let on = 0
    let near = 0
    let total = 0
    const onPiece = new Map<string, number>()
    for (const p of xy) {
      let nearest = Infinity
      let nearestPiece: (typeof pieces)[number]['piece'] | null = null
      for (const { piece, line } of pieces) {
        const d = distanceToLine(p, line)
        if (d < nearest) {
          nearest = d
          nearestPiece = piece
        }
      }
      if (nearest <= NEAR_NM) near++
      if (nearest > ON_NM) continue
      on++
      total += nearest
      if (nearestPiece?.transition) onPiece.set(nearestPiece.transition, (onPiece.get(nearestPiece.transition) ?? 0) + 1)
    }
    if (on < MIN_ON || on / near < MIN_SHARE) continue
    const mean = total / on
    if (!found || on > found.on || (on === found.on && mean < found.mean)) {
      // The enroute and runway transitions it's spent most time on, if it's been on them a while.
      const most = (role: 'transition' | 'runway') =>
        pieces
          .filter(({ piece }) => piece.transition && pieceRole(piece) === role && (onPiece.get(piece.transition) ?? 0) >= ON_TRANSITION)
          .sort((a, b) => onPiece.get(b.piece.transition!)! - onPiece.get(a.piece.transition!)!)[0]?.piece.transition ?? null
      found = { match: { kind, procedure, transition: most('transition'), runway: most('runway') }, on, mean }
    }
  }
  return found?.match ?? null
}

/** Nautical miles east and north of the airport. */
function toNm(p: LatLon) {
  return { x: (p.lon - CENTER.lon) * NM_PER_DEG * LON_SCALE, y: (p.lat - CENTER.lat) * NM_PER_DEG }
}

/** Nautical miles from `p` to the nearest point of the line through `line`'s points. */
function distanceToLine(p: { x: number; y: number }, line: { x: number; y: number }[]) {
  if (line.length === 1) return Math.hypot(p.x - line[0].x, p.y - line[0].y)
  let nearest = Infinity
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    nearest = Math.min(nearest, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy))
  }
  return nearest
}

/** The procedures to draw: those picked in the panel, and apart from them the followed flight's (`focusHex`) STAR or SID and approach, if it's matched to them. */
export function proceduresToShow(focusHex: string | null): {
  shown: [Procedure, ProcedureKind][]
  focus: ProcedureMatch | null
  approach: ProcedureMatch | null
} {
  if (!PROCEDURES.enabled || !proceduresState().data) return { shown: [], focus: null, approach: null }
  const focus = focusHex ? procedureMatcher.likely(focusHex) : null
  const approach = focusHex ? procedureMatcher.likelyApproach(focusHex) : null
  return { shown: pickedProcedures().filter(([p]) => p !== focus?.procedure && p !== approach?.procedure), focus, approach }
}

// ---- Predicting ----------------------------------------------------------------

/** A prediction needs its entry (or exit) within this many degrees of the way the flight's coming from (or going). */
const PREDICT_WITHIN_DEG = 40
/** Beyond this far out (nm), where it is says which way it's coming from; nearer, where it came from has more say. */
const POSITION_FROM_NM = 15

/**
 * The likeliest procedure for flight `f` before its path shows which it's on.
 * A STAR starts (each of its transitions does) out in the direction arrivals
 * come from; a SID's exits lead off toward where departures go. So: the STAR
 * whose entry lies most nearly the way an arrival is coming in (where it is
 * now, and where it came from), or the SID whose exit lies most nearly toward
 * a departure's destination. Only procedures serving the runways in use, when
 * they're known, with the runway transition for one of them.
 */
function predict(kind: ProcedureKind, f: Flight, runways: RunwaysInUse): ProcedureMatch | null {
  const data = proceduresState().data
  if (!data) return null
  const inUse = kind === 'star' ? runways.landing : runways.departing
  const toward = (p: LatLon) => bearingFromAirport(p)
  // Which way it's coming from (or going): where it is, where it came from (or is bound).
  const directions: { bearing: number; weight: number }[] = []
  const away = f.distanceNm
  if (!f.onGround && away > 3) directions.push({ bearing: toward(f), weight: kind === 'star' && away > POSITION_FROM_NM ? 1 : 0.5 })
  const other = f.counterpart
  if (other?.lat != null && other.lon != null) directions.push({ bearing: toward({ lat: other.lat, lon: other.lon }), weight: 1 })
  if (directions.length === 0) return null

  let best: { match: ProcedureMatch; score: number } | null = null
  for (const procedure of activeProcedures(kind)) {
    const runwayPieces = procedurePieces(procedure).filter((p) => pieceRole(p) === 'runway')
    const serving = runwayPieces.filter((p) => inUse.some((r) => servesRunway(p.transition!, r)))
    // Runways known, and it has runway transitions, but none for those runways: not this one.
    if (inUse.length > 0 && runwayPieces.length > 0 && serving.length === 0) continue
    // Its ends that face out: each transition's first waypoint (STAR) or last (SID), else its route's.
    const ends = procedurePieces(procedure).filter((p) => pieceRole(p) === 'transition')
    const outer = (ends.length ? ends : procedurePieces(procedure).filter((p) => pieceRole(p) === 'route')).map((p) => ({
      transition: p.transition,
      at: kind === 'star' ? p.points[0] : p.points[p.points.length - 1],
    }))
    for (const { transition, at } of outer) {
      if (!at) continue
      const bearing = toward(at)
      const total = directions.reduce((sum, d) => sum + d.weight, 0)
      const score = directions.reduce((sum, d) => sum + d.weight * angleBetween(bearing, d.bearing), 0) / total
      if (score > PREDICT_WITHIN_DEG || (best && score >= best.score)) continue
      // The runway transition: for a runway in use, the one nearest the flight (on the ground, its runway's end).
      const runway =
        serving
          .map((p) => ({ name: p.transition!, d: Math.hypot(...offset(p.points[kind === 'star' ? p.points.length - 1 : 0], f)) }))
          .sort((a, b) => a.d - b.d)[0]?.name ?? null
      best = { match: { kind, procedure, transition, runway, predicted: true }, score }
    }
  }
  return best?.match ?? null
}

/** Whether runway transition `name` ("RW26R", "RW26B" for all the 26s, "ALL") serves runway `runway` ("26R"). */
export function servesRunway(name: string, runway: string) {
  if (name === 'ALL') return true
  const id = name.slice(2)
  return id === runway || (id.endsWith('B') && runway.replace(/[LCR]$/, '') === id.slice(0, -1))
}

/** Degrees clockwise from north, from the airport to `p`. */
function bearingFromAirport(p: LatLon) {
  const { x, y } = toNm(p)
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360
}

function angleBetween(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180)
}

/** East and north nautical miles from `b` to `a`. */
function offset(a: LatLon, b: LatLon): [number, number] {
  const p = toNm(a)
  const q = toNm(b)
  return [p.x - q.x, p.y - q.y]
}

// ---- Approaches ----------------------------------------------------------------

/**
 * Which final approach a flight's on is decided by its last APPROACH_RECENT
 * positions (about a minute): at least APPROACH_MIN_ON of them within
 * APPROACH_ON_NM of a final. Parallel runways' finals can be as little as
 * 1,000 ft (0.16 nm) apart, so the nearest wins; among approaches to the same
 * runway sharing a final (ILS, LOC, RNAV), within SAME_FINAL_NM, the likelier type.
 */
const APPROACH_RECENT = 6
const APPROACH_MIN_ON = 3
const APPROACH_ON_NM = 0.4
const SAME_FINAL_NM = 0.03
/** Its approach transition: the one with at least ON_TRANSITION positions this close (nm). */
const APPROACH_TRANSITION_NM = 1
/** Of approaches sharing a final, the order airliners are likeliest to fly them in. */
const APPROACH_PREFERENCE = ['ILS', 'RNAV (RNP)', 'RNAV (GPS)', 'GLS', 'LOC', 'LDA', 'VOR/DME', 'VOR']

function approachRank(p: Procedure) {
  const i = APPROACH_PREFERENCE.findIndex((type) => p.name.startsWith(type))
  return i === -1 ? APPROACH_PREFERENCE.length : i
}

/** The approach whose final `points` (an arrival's positions) are on now, if any (see APPROACH_RECENT). */
function bestApproach(points: LatLon[]): ProcedureMatch | null {
  const recent = points.slice(-APPROACH_RECENT).map(toNm)
  if (recent.length < APPROACH_MIN_ON) return null
  let found: { procedure: Procedure; on: number; mean: number } | null = null
  for (const procedure of activeProcedures('approach')) {
    const finals = procedurePieces(procedure)
      .filter((p) => pieceRole(p) === 'route')
      .map((p) => p.points.map(toNm))
    if (finals.length === 0) continue
    const near = recent.map((p) => Math.min(...finals.map((line) => distanceToLine(p, line)))).filter((d) => d <= APPROACH_ON_NM)
    if (near.length < APPROACH_MIN_ON) continue
    const mean = near.reduce((a, b) => a + b, 0) / near.length
    const better =
      !found ||
      near.length > found.on ||
      (near.length === found.on &&
        (procedure.runway === found.procedure.runway && Math.abs(mean - found.mean) < SAME_FINAL_NM
          ? approachRank(procedure) < approachRank(found.procedure)
          : mean < found.mean))
    if (better) found = { procedure, on: near.length, mean }
  }
  if (!found) return null
  // The transition it came in on: the one with most of its positions on it.
  const xy = points.map(toNm)
  const transition =
    procedurePieces(found.procedure)
      .filter((p) => pieceRole(p) === 'transition' && p.transition)
      .map((p) => {
        const line = p.points.map(toNm)
        return { name: p.transition!, on: xy.filter((q) => distanceToLine(q, line) <= APPROACH_TRANSITION_NM).length }
      })
      .filter((t) => t.on >= ON_TRANSITION)
      .sort((a, b) => b.on - a.on)[0]?.name ?? null
  return { kind: 'approach', procedure: found.procedure, transition, runway: null }
}

/** Where an arrival's approach is kept, apart from its STAR. */
function approachKey(hex: string) {
  return `${hex}:approach`
}

/**
 * The approach an arrival on STAR `star` is likeliest to fly: once the runway
 * it's bound for is down to one (its STAR's runway transition, among the
 * runways being landed on), that runway's likeliest type (ILS first).
 */
function predictApproach(star: ProcedureMatch | null, runways: RunwaysInUse): ProcedureMatch | null {
  const landing = star?.runway ? runways.landing.filter((r) => servesRunway(star.runway!, r)) : runways.landing
  if (landing.length !== 1) return null
  const procedure = activeProcedures('approach')
    .filter((p) => p.runway === landing[0])
    .sort((a, b) => approachRank(a) - approachRank(b))[0]
  return procedure ? { kind: 'approach', procedure, transition: null, runway: null, predicted: true } : null
}
