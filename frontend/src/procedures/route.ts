import { CENTER, PROCEDURES } from '../config/config'
import type { LatLon } from '../tracking/tracker'
import { procedureMatcher, servesRunway, type ProcedureMatch } from './matcher'
import { fixOf, pieceRole, procedurePieces, type ProcedurePiece } from './procedures'

/** A stretch of a procedure through its waypoints: positions, altitudes (feet) and names. */
export interface RouteLine {
  points: LatLon[]
  alts: number[]
  /** Per waypoint: whether its altitude is only estimated (see ProcedurePiece). */
  estimated: boolean[]
  names: string[]
  /** For a branch: which transition it is (e.g. "RW26R", or an exit fix's name). */
  label?: string
}

/**
 * Where a followed flight is along its procedure: the way it's come (`flown`,
 * through the waypoints it's passed), the way it's going (`ahead`, from the
 * last waypoint passed), and where it may still branch off (`branches`): a
 * STAR's runway transitions, or a SID's exit transitions, until its path
 * shows which. `next` is the next waypoint, with the altitude to cross it at.
 *
 * Runway transitions for runways not in use (landing, for a STAR; departing,
 * for a SID) are ruled out, when the runways in use are known. With
 * PROCEDURES.predict off, nothing is narrowed down (see everyBranch).
 */
export interface FocusRoute {
  flown: RouteLine
  ahead: RouteLine
  branches: RouteLine[]
  next: { name: string; alt: string | null } | null
  /** How many waypoints it's passed, so a map can tell when to redraw. */
  passed: number
}

/** A branch counts as the one it's taken once it's this close (nm) to it, closer than to the rest of the route. */
const ON_BRANCH_NM = 1.5

export function focusRoute(match: ProcedureMatch, pos: LatLon): FocusRoute | null {
  const pieces = procedurePieces(match.procedure)
  const role = (r: ReturnType<typeof pieceRole>) => pieces.filter((p) => pieceRole(p) === r)
  const named = (list: ProcedurePiece[], name: string | null) => (name ? list.find((p) => p.transition === name) : undefined)
  const route = role('route')
  const missed = role('missed').map((p) => ({ ...asLine(p), label: 'Missed approach' }))
  if (!PROCEDURES.predict) return everyBranch(match, route, [...role('transition'), ...role('runway')], pos, missed)
  // An approach: its transition (if it's been seen on one), the final approach, and the missed approach as a branch.
  if (match.kind === 'approach') {
    const head = named(role('transition'), match.transition)
    return splitAlong(match, join([...(head ? [head] : []), ...route]), missed, pos)
  }
  // A STAR: enroute transition, route, runway transition. A SID: runway transition, route, exit transition.
  const [first, last] = match.kind === 'sid' ? (['runway', 'transition'] as const) : (['transition', 'runway'] as const)
  const firstPieces = role(first)
  const lastPieces = role(last)
  const from = first === 'transition' ? match.transition : match.runway
  const to = last === 'transition' ? match.transition : match.runway
  // Runway transitions only for the runways in use, if they're known (and any fit).
  const inUse = match.kind === 'sid' ? procedureMatcher.runwaysInUse().departing : procedureMatcher.runwaysInUse().landing
  const forRunwaysInUse = (list: ProcedurePiece[]) => {
    const serving = list.filter((p) => pieceRole(p) !== 'runway' || inUse.some((r) => servesRunway(p.transition!, r)))
    return inUse.length > 0 && serving.length > 0 ? serving : list
  }
  const lastChoices = forRunwaysInUse(lastPieces)
  // A SID's runway transition not yet seen: the one for a runway in use nearest the flight (likely the one it's taxiing to).
  const head =
    named(firstPieces, from) ??
    (first === 'runway' && inUse.length > 0
      ? forRunwaysInUse(firstPieces)
          .filter((p) => inUse.some((r) => servesRunway(p.transition!, r)))
          .map((p) => ({ p, d: locate(asLine(p), pos).distance }))
          .sort((a, b) => a.d - b.d)[0]?.p
      : undefined)
  // Only one way left to go (one runway transition in use): it's the way ahead, not a branch.
  const tail = named(lastPieces, to) ?? (last === 'runway' && lastChoices.length === 1 ? lastChoices[0] : undefined)
  let chain = join([...(head ? [head] : []), ...route, ...(tail ? [tail] : [])])
  let branches = tail ? [] : lastChoices.map(asLine)
  if (chain.points.length === 0) {
    if (branches.length === 0) return null
    chain = branches.shift()!
  }

  // Already on a branch (past the end of the route, and nearer it): that's the way it's going.
  const along = locate(chain, pos)
  if (along.index === chain.points.length - 1 && branches.length > 0) {
    const onto = branches
      .map((b) => ({ b, d: locate(b, pos).distance }))
      .filter(({ d }) => d < ON_BRANCH_NM && d < along.distance)
      .sort((a, b) => a.d - b.d)[0]
    if (onto) {
      chain = join([chain, onto.b])
      branches = []
    }
  }
  const at = locate(chain, pos)
  const passed = at.index
  const slice = (start: number, end?: number): RouteLine => ({
    points: chain.points.slice(start, end),
    alts: chain.alts.slice(start, end),
    estimated: chain.estimated.slice(start, end),
    names: chain.names.slice(start, end),
  })
  const nextName = chain.names[passed + 1] ?? null
  return {
    flown: slice(0, passed + 1),
    ahead: slice(passed),
    branches,
    next: nextName ? { name: nextName, alt: legAlt(match, nextName) } : null,
    passed,
  }
}

/**
 * Not narrowed down (PROCEDURES.predict off): the common route as the way, and
 * every transition (entries and exits, runway transitions) as a branch it may
 * take, none ruled out.
 */
function everyBranch(match: ProcedureMatch, route: ProcedurePiece[], others: ProcedurePiece[], pos: LatLon, missed: RouteLine[]): FocusRoute | null {
  return splitAlong(match, join(route), [...others.map(asLine), ...missed], pos)
}

/** `chain` split where the flight at `pos` is along it (flown, ahead), with `branches` off it. */
function splitAlong(match: ProcedureMatch, chain: RouteLine, branches: RouteLine[], pos: LatLon): FocusRoute | null {
  if (chain.points.length === 0) return branches.length ? { flown: emptyLine(), ahead: emptyLine(), branches, next: null, passed: 0 } : null
  const passed = locate(chain, pos).index
  const slice = (start: number, end?: number): RouteLine => ({
    points: chain.points.slice(start, end),
    alts: chain.alts.slice(start, end),
    estimated: chain.estimated.slice(start, end),
    names: chain.names.slice(start, end),
  })
  const nextName = chain.names[passed + 1] ?? null
  return { flown: slice(0, passed + 1), ahead: slice(passed), branches, next: nextName ? { name: nextName, alt: legAlt(match, nextName) } : null, passed }
}

function emptyLine(): RouteLine {
  return { points: [], alts: [], estimated: [], names: [] }
}

function asLine(piece: ProcedurePiece): RouteLine {
  return { points: piece.points, alts: piece.alts, estimated: piece.estimated, names: piece.names, label: piece.transition ?? undefined }
}

/** Pieces end to end, the waypoint where two meet only once. */
function join(lines: RouteLine[]): RouteLine {
  const out: RouteLine = { points: [], alts: [], estimated: [], names: [] }
  for (const line of lines) {
    line.points.forEach((p, i) => {
      if (i === 0 && out.names[out.names.length - 1] === line.names[0]) return
      out.points.push(p)
      out.alts.push(line.alts[i])
      out.estimated.push(line.estimated[i])
      out.names.push(line.names[i])
    })
  }
  return out
}

/**
 * Where `pos` is along `line`: the last waypoint it's passed (the start of the
 * stretch it's nearest, or the waypoint itself if it's beyond the last), and how far off it is (nm).
 */
function locate(line: RouteLine, pos: LatLon): { index: number; distance: number } {
  const p = toNm(pos)
  const xy = line.points.map(toNm)
  if (xy.length === 1) return { index: 0, distance: Math.hypot(p.x - xy[0].x, p.y - xy[0].y) }
  let best = { index: 0, distance: Infinity }
  for (let i = 1; i < xy.length; i++) {
    const a = xy[i - 1]
    const b = xy[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
    // At the end of the last stretch, it's passed its last waypoint.
    if (d < best.distance) best = { index: t >= 1 && i === xy.length - 1 ? i : i - 1, distance: d }
  }
  return best
}

function legAlt(match: ProcedureMatch, fix: string): string | null {
  const { procedure } = match
  for (const legs of [procedure.route, ...Object.values(procedure.transitions ?? {}), ...Object.values(procedure.runwayTransitions ?? {}), procedure.missedApproach ?? []]) {
    for (const leg of legs) if (typeof leg !== 'string' && fixOf(leg) === fix && leg.alt) return leg.alt
  }
  return null
}

const LON_SCALE = Math.cos((CENTER.lat * Math.PI) / 180)

function toNm(p: LatLon) {
  return { x: (p.lon - CENTER.lon) * 60 * LON_SCALE, y: (p.lat - CENTER.lat) * 60 }
}
