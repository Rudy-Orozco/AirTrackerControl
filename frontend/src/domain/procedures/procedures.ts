import { useSyncExternalStore } from 'react'
import { AIRPORT, AIRPORT_PRESET, PROCEDURES } from '../../config/config'
import type { LatLon } from '../tracking/tracker'
import { fetchBuiltInProcedures } from '../../services/api/procedures'
import { localStore } from '../../services/storage'

/**
 * The airport's STARs (standard arrivals) and SIDs (standard departures): the
 * waypoints they're made of and the order they're flown in. Built in from
 * public/procedures/<CODE>.json (made by scripts/build_procedures.py from the
 * FAA's CIFP), or imported in the settings panel, which wins. The format is
 * in README.md.
 */
export interface Procedures {
  airport: string
  /** Where it came from and when it took effect, for showing in the settings. */
  source?: string
  effective?: string
  waypoints: Record<string, { lat: number; lon: number }>
  stars: Procedure[]
  sids: Procedure[]
  approaches: Procedure[]
}

export interface Procedure {
  /** As charted: "CHPPR1"; for an approach, e.g. "ILS 08L" or "RNAV (RNP) Z 08L". */
  name: string
  /** An approach's identifier in the FAA's data, e.g. "I08L" (not shown). */
  id?: string
  /** The runway an approach is to. */
  runway?: string
  /** Named branches: into a STAR's common route, or out of a SID's; an approach's from its initial fixes. */
  transitions?: Record<string, Leg[]>
  /** The part every aircraft on it flies, in order; an approach's final approach, to the runway. */
  route: Leg[]
  /** An approach's missed approach (go-around), from the runway (or missed approach point) on. */
  missedApproach?: Leg[]
  /** Branches to (STAR) or from (SID) particular runways: "RW26R", "RW26B" (all the 26s), "ALL". */
  runwayTransitions?: Record<string, Leg[]>
  /** The runways it serves, e.g. ["26R", "27L"]. */
  runways?: string[]
}

/** A waypoint, by name, or with the altitude ("13000", "+5000" at or above, "-FL190" at or below, "5000-7000") and speed (knots) to cross it at. */
export type Leg = string | { fix: string; alt?: string; speed?: number }

export type ProcedureKind = 'star' | 'sid' | 'approach'

/** Every kind, and the list each is in. */
export const PROCEDURE_KINDS: ProcedureKind[] = ['star', 'sid', 'approach']
const LIST_OF = { star: 'stars', sid: 'sids', approach: 'approaches' } as const

/** The piece standing for an approach's missed approach (see pieceRole). */
const MISSED = '(missed approach)'

/** One stretch of a procedure (a transition, its route, or a runway transition), as positions and the altitudes to be at. */
export interface ProcedurePiece {
  points: LatLon[]
  /**
   * Feet, one per waypoint across the whole procedure (so pieces meet): as
   * charted, filled in between by distance flown, and carried on beyond at the
   * usual 3-to-1 profile (see profile).
   */
  alts: number[]
  /** Per waypoint: whether its altitude is only estimated (no charted altitude on either side of it). */
  estimated: boolean[]
  names: string[]
  /** Which transition this is (null for the common route). */
  transition: string | null
}

export interface ProceduresState {
  data: Procedures | null
  /** Imported in the settings (kept in this browser), or built into the app. */
  origin: 'imported' | 'built-in' | null
  /** What went wrong with the last import, if it did. */
  error: string | null
}

const STORAGE_KEY = `procedures:${AIRPORT}`

let state: ProceduresState = { data: null, origin: null, error: null }
let version = 0
const listeners = new Set<() => void>()

export function proceduresState() {
  return state
}

/** Bumped on every change, so maps know to redraw. */
export function proceduresVersion() {
  return version
}

export function useProcedures() {
  return useSyncExternalStore(subscribeProcedures, proceduresState)
}

export function subscribeProcedures(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function update(next: Partial<ProceduresState>) {
  state = { ...state, ...next }
  version++
  pieceCache = new WeakMap()
  for (const listener of listeners) listener()
}

/** Loads what was imported in this browser, else the built-in file, if there is one. */
function load() {
  try {
    const saved = localStore.getText(STORAGE_KEY)
    if (saved) {
      update({ data: validate(JSON.parse(saved)), origin: 'imported' })
      return
    }
  } catch (err) {
    console.warn('Imported procedures unreadable; using the built-in ones:', err)
  }
  fetchBuiltInProcedures(AIRPORT)
    .then((json) => {
      // Something was imported meanwhile.
      if (!json || state.origin === 'imported') return
      update({ data: validate(json), origin: 'built-in' })
    })
    .catch((err) => console.warn('Built-in procedures unavailable:', err))
}
load()

/** Checks and keeps `text` (JSON in the procedures format) as this airport's procedures, in this browser. Returns what was wrong, if anything. */
export function importProcedures(text: string): string | null {
  try {
    const data = validate(JSON.parse(text))
    if (!localStore.setJson(STORAGE_KEY, data)) throw new Error('Could not keep them: browser storage is unavailable or full')
    update({ data, origin: 'imported', error: null })
    return null
  } catch (err) {
    const error = err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : err instanceof Error ? err.message : String(err)
    update({ error })
    return error
  }
}

/** Opens a file picker and imports the JSON file chosen. */
export function pickProceduresFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = () => input.files?.[0]?.text().then(importProcedures)
  input.click()
}

/** Forgets the imported procedures, going back to the built-in ones (if any). */
export function removeImportedProcedures() {
  localStore.remove(STORAGE_KEY)
  update({ data: null, origin: null, error: null })
  load()
}

/** Saves the procedures in use as <CODE>-procedures.json, to edit and import again. */
export function downloadProcedures() {
  if (!state.data) return
  const blob = new Blob([JSON.stringify(state.data, null, 2) + '\n'], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${AIRPORT}-procedures.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

/** One line for the settings panel: what's loaded, or what went wrong. */
export function proceduresSummary(): string {
  const { data, origin, error } = state
  const loaded = data
    ? `${data.stars.length} STARs, ${data.sids.length} SIDs, ${data.approaches.length} approaches, ${Object.keys(data.waypoints).length} waypoints · ${origin === 'imported' ? 'imported' : 'built in'}${data.source ? ` · ${data.source}` : ''}`
    : `None for ${AIRPORT}: import a JSON file (format in README.md)`
  return error ? `Import failed: ${error}. ${loaded}` : loaded
}

// ---- Picked in the panel -------------------------------------------------------

/** Which procedures are picked to show on the maps (in the procedures panel), as "star:CHPPR1", kept per airport. */
const PICKED_KEY = `proceduresShown:${AIRPORT}`
const picked = loadSet(PICKED_KEY)

function storePicked() {
  // If not remembered, they still show until reload.
  localStore.setJson(PICKED_KEY, [...picked])
  update({})
}

export function isPicked(kind: ProcedureKind, name: string) {
  return picked.has(`${kind}:${name}`)
}

export function togglePicked(kind: ProcedureKind, name: string) {
  const key = `${kind}:${name}`
  if (!picked.delete(key)) picked.add(key)
  storePicked()
}

/** Picks (or unpicks) all of `names`. */
export function setPicked(kind: ProcedureKind, names: string[], on: boolean) {
  for (const name of names) {
    if (on) picked.add(`${kind}:${name}`)
    else picked.delete(`${kind}:${name}`)
  }
  storePicked()
}

/** The procedures picked to show, of those loaded and switched on. */
export function pickedProcedures(): [Procedure, ProcedureKind][] {
  const data = state.data
  if (!data) return []
  return PROCEDURE_KINDS.flatMap((kind) => activeProcedures(kind).filter((p) => isPicked(kind, p.name)).map((p): [Procedure, ProcedureKind] => [p, kind]))
}

// ---- Switched off in the panel -------------------------------------------------

/**
 * Procedures switched off in the panel (e.g. no longer flown, or not used in
 * the current flow): left out of matching, predicting and drawing. As
 * "star:CHPPR1", kept per airport.
 */
const OFF_KEY = `proceduresOff:${AIRPORT}`
const off = loadSet(OFF_KEY)

function loadSet(key: string): Set<string> {
  const saved = localStore.getJson(key)
  return new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : [])
}

export function isSwitchedOn(kind: ProcedureKind, name: string) {
  return !off.has(`${kind}:${name}`)
}

/** Switches all of `names` on (or off). */
export function setSwitchedOn(kind: ProcedureKind, names: string[], on: boolean) {
  for (const name of names) {
    if (on) off.delete(`${kind}:${name}`)
    else off.add(`${kind}:${name}`)
  }
  // If not remembered, it applies until reload.
  localStore.setJson(OFF_KEY, [...off])
  update({})
}

/** The loaded STARs (or SIDs) that are switched on. */
export function activeProcedures(kind: ProcedureKind): Procedure[] {
  return (state.data?.[LIST_OF[kind]] ?? []).filter((p) => isSwitchedOn(kind, p.name))
}

// ---- Waypoints on their own ----------------------------------------------------

/** A waypoint in the procedures, for the Waypoints tab and showing on its own. */
export interface WaypointInfo {
  name: string
  at: LatLon
  /** The altitude a procedure has aircraft cross it at, as charted (the first found), and as feet. */
  alt: string | null
  altFt: number | null
  /** The procedures using it, by name. */
  usedBy: string[]
}

let waypointCache: { version: number; list: WaypointInfo[] } | null = null

/** Every waypoint in the procedures (not runway thresholds, RW08L), by name. */
export function waypointInfo(): WaypointInfo[] {
  if (waypointCache?.version === version) return waypointCache.list
  const data = state.data
  const info = new Map<string, WaypointInfo>()
  if (data) {
    for (const [name, at] of Object.entries(data.waypoints)) {
      if (!/^RW\d/.test(name)) info.set(name, { name, at, alt: null, altFt: null, usedBy: [] })
    }
    for (const p of [...data.stars, ...data.sids, ...data.approaches]) {
      const legs = [...p.route, ...Object.values(p.transitions ?? {}).flat(), ...Object.values(p.runwayTransitions ?? {}).flat(), ...(p.missedApproach ?? [])]
      for (const leg of legs) {
        const w = info.get(fixOf(leg))
        if (!w) continue
        if (!w.usedBy.includes(p.name)) w.usedBy.push(p.name)
        if (w.alt === null && typeof leg !== 'string' && leg.alt) {
          w.alt = leg.alt
          w.altFt = altitudeFt(leg.alt)
        }
      }
    }
  }
  const list = [...info.values()].sort((a, b) => a.name.localeCompare(b.name))
  waypointCache = { version, list }
  return list
}

/** Waypoints picked to show on their own (their eye in the Waypoints tab), kept per airport. */
const WAYPOINTS_PICKED_KEY = `waypointsShown:${AIRPORT}`
const pickedWaypoints = loadSet(WAYPOINTS_PICKED_KEY)

export function isWaypointPicked(name: string) {
  return pickedWaypoints.has(name)
}

/** Picks (or unpicks) all of `names`. */
export function setWaypointsPicked(names: string[], on: boolean) {
  for (const name of names) {
    if (on) pickedWaypoints.add(name)
    else pickedWaypoints.delete(name)
  }
  // If not remembered, they still show until reload.
  localStore.setJson(WAYPOINTS_PICKED_KEY, [...pickedWaypoints])
  update({})
}

/** The waypoints to show on their own: all of them (PROCEDURES.showWaypoints), or those picked. */
export function shownWaypoints(): WaypointInfo[] {
  if (!PROCEDURES.enabled) return []
  return PROCEDURES.showWaypoints ? waypointInfo() : waypointInfo().filter((w) => pickedWaypoints.has(w.name))
}

/** What a stretch of a procedure is: an enroute (or approach) transition, the common route (final approach), a runway transition, or a missed approach. */
export function pieceRole(piece: ProcedurePiece): 'transition' | 'route' | 'runway' | 'missed' {
  if (piece.transition === null) return 'route'
  if (piece.transition === MISSED) return 'missed'
  return piece.transition.startsWith('RW') || piece.transition === 'ALL' ? 'runway' : 'transition'
}

// ---- Shape ---------------------------------------------------------------------

/** `json` as procedures, or an error saying what's wrong with it. */
export function validate(json: unknown): Procedures {
  const problems: string[] = []
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!obj(json)) throw new Error('Expected a JSON object')
  if (typeof json.airport === 'string' && json.airport.toUpperCase() !== AIRPORT && json.airport.toUpperCase() !== AIRPORT_PRESET.icao) {
    problems.push(`it's for ${json.airport}, not ${AIRPORT}`)
  }
  if (!obj(json.waypoints)) throw new Error('"waypoints" must be an object of { "NAME": { "lat": ..., "lon": ... } }')
  const waypoints: Procedures['waypoints'] = {}
  for (const [name, p] of Object.entries(json.waypoints)) {
    if (obj(p) && typeof p.lat === 'number' && typeof p.lon === 'number' && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180) {
      waypoints[name] = { lat: p.lat, lon: p.lon }
    } else problems.push(`waypoint ${name} needs "lat" and "lon" in degrees`)
  }

  const legs = (where: string, v: unknown): Leg[] => {
    if (!Array.isArray(v)) {
      problems.push(`${where} must be a list of waypoints`)
      return []
    }
    return v.flatMap((leg): Leg[] => {
      const fix = typeof leg === 'string' ? leg : obj(leg) && typeof leg.fix === 'string' ? leg.fix : null
      if (fix === null) {
        problems.push(`${where}: each waypoint is a name or { "fix": name, "alt"?, "speed"? }`)
        return []
      }
      if (!(fix in waypoints)) {
        problems.push(`${where}: no waypoint ${fix} in "waypoints"`)
        return []
      }
      if (typeof leg === 'string') return [leg]
      const out: Leg = { fix }
      if (typeof leg.alt === 'string' && leg.alt) out.alt = leg.alt
      if (typeof leg.speed === 'number') out.speed = leg.speed
      return [out]
    })
  }
  const branches = (where: string, v: unknown) => {
    if (v === undefined) return undefined
    if (!obj(v)) {
      problems.push(`${where} must be an object of { "NAME": [waypoints] }`)
      return undefined
    }
    return Object.fromEntries(Object.entries(v).map(([name, list]) => [name, legs(`${where} ${name}`, list)]))
  }
  const list = (key: 'stars' | 'sids' | 'approaches'): Procedure[] => {
    const v = json[key] ?? []
    if (!Array.isArray(v)) {
      problems.push(`"${key}" must be a list`)
      return []
    }
    return v.flatMap((p, i): Procedure[] => {
      if (!obj(p) || typeof p.name !== 'string') {
        problems.push(`${key}[${i}] needs a "name"`)
        return []
      }
      const where = `${key === 'stars' ? 'STAR' : key === 'sids' ? 'SID' : 'Approach'} ${p.name}`
      const proc: Procedure = { name: p.name, route: p.route === undefined ? [] : legs(`${where} route`, p.route) }
      const transitions = branches(`${where} transition`, p.transitions)
      if (transitions) proc.transitions = transitions
      const runwayTransitions = branches(`${where} runway transition`, p.runwayTransitions)
      if (runwayTransitions) proc.runwayTransitions = runwayTransitions
      if (Array.isArray(p.runways)) proc.runways = p.runways.filter((r): r is string => typeof r === 'string')
      if (p.missedApproach !== undefined) proc.missedApproach = legs(`${where} missed approach`, p.missedApproach)
      if (typeof p.runway === 'string') proc.runway = p.runway
      if (typeof p.id === 'string') proc.id = p.id
      return [proc]
    })
  }
  const data: Procedures = {
    airport: typeof json.airport === 'string' ? json.airport : AIRPORT,
    waypoints,
    stars: list('stars'),
    sids: list('sids'),
    approaches: list('approaches'),
  }
  if (typeof json.source === 'string') data.source = json.source
  if (typeof json.effective === 'string') data.effective = json.effective
  if (problems.length) {
    const shown = problems.slice(0, 3).join('; ')
    throw new Error(problems.length > 3 ? `${shown}; and ${problems.length - 3} more` : shown)
  }
  return data
}

// ---- Geometry ------------------------------------------------------------------

let pieceCache = new WeakMap<Procedure, ProcedurePiece[]>()

/**
 * A procedure's stretches as lines: each transition, its route and each runway
 * transition. They meet at shared waypoints, so drawn together they make the
 * whole procedure.
 */
export function procedurePieces(proc: Procedure): ProcedurePiece[] {
  const cached = pieceCache.get(proc)
  if (cached) return cached
  const waypoints = state.data?.waypoints ?? {}
  const kind: ProcedureKind = state.data?.sids.includes(proc) ? 'sid' : state.data?.approaches.includes(proc) ? 'approach' : 'star'
  const piece = (legs: Leg[], transition: string | null): ProcedurePiece => {
    const names = legs.map(fixOf).filter((n) => waypoints[n])
    return { points: names.map((n) => waypoints[n]), alts: [], estimated: [], names, transition }
  }
  const transitions = Object.entries(proc.transitions ?? {}).map(([name, legs]) => piece(legs, name))
  const route = piece(proc.route, null)
  const runways = Object.entries(proc.runwayTransitions ?? {}).map(([name, legs]) => piece(legs, name))
  const missed = proc.missedApproach ? [piece(proc.missedApproach, MISSED)] : []
  const pieces = [...transitions, route, ...runways, ...missed].filter((p) => p.points.length > 0)

  // One altitude per waypoint across the whole procedure, so the pieces meet: the
  // charted ones first, then the rest worked out piece by piece in the order flown
  // (a STAR's transitions, route, runway transitions; a SID's the other way round),
  // each reusing what the pieces before it worked out where they meet.
  const known = new Map<string, number>()
  for (const legs of [proc.route, ...Object.values(proc.transitions ?? {}), ...Object.values(proc.runwayTransitions ?? {}), proc.missedApproach ?? []]) {
    for (const leg of legs) {
      const alt = typeof leg === 'string' ? null : altitudeFt(leg.alt)
      if (alt !== null && !known.has(fixOf(leg))) known.set(fixOf(leg), alt)
    }
  }
  // An approach: its transitions, the final approach, then the missed approach (climbing again).
  const flown = kind === 'sid' ? [...runways, route, ...transitions] : [...transitions, route, ...runways, ...missed]
  const guessed = new Set<string>()
  for (const p of flown) if (p.points.length > 0) profile(p, kind === 'sid' || p.transition === MISSED ? 1 : -1, known, guessed)
  pieceCache.set(proc, pieces)
  return pieces
}

/** Feet per nautical mile flown: the usual 3-to-1 descent, and about a typical climb. */
const PROFILE_FT_PER_NM = 300
/** Procedures are flown below the flight levels' start, more or less. */
const PROFILE_MAX_FT = 18_000
/** Arrivals are this high (feet above the field) by the end of a STAR, at the least. */
const PROFILE_MIN_AGL_FT = 1500

/**
 * Altitudes along piece `p` (in the order flown): where `known` has a
 * waypoint's, that; between two, filled in by the distance flown; before the
 * first and past the last, carried on at PROFILE_FT_PER_NM (`sign`: -1
 * descending, along a STAR or approach; 1 climbing, along a SID or missed
 * approach). With none known at all, by distance from the
 * airport. Waypoints worked out are added to `known`, for the pieces after,
 * and those only carried on or estimated (not between two charted) to
 * `guessed`; sets `p.alts` and `p.estimated`.
 */
function profile(p: ProcedurePiece, sign: 1 | -1, known: Map<string, number>, guessed: Set<string>) {
  const along = [0]
  for (let i = 1; i < p.points.length; i++) along.push(along[i - 1] + distanceNm(p.points[i - 1], p.points[i]))
  const at = p.names.flatMap((n, i) => (known.has(n) ? [i] : []))
  const field = AIRPORT_PRESET.elevationFt
  const estimated = p.names.map((n) => guessed.has(n))
  const alts = p.names.map((name, i) => {
    const charted = known.get(name)
    if (charted !== undefined) return charted
    const before = at.findLast((k) => k < i)
    const after = at.find((k) => k > i)
    if (before !== undefined && after !== undefined) {
      const a = known.get(p.names[before])!
      const b = known.get(p.names[after])!
      // Between two charted, it's as good as charted; next to one only estimated, so is it.
      estimated[i] = guessed.has(p.names[before]) || guessed.has(p.names[after])
      const span = along[after] - along[before]
      return span > 0 ? a + ((b - a) * (along[i] - along[before])) / span : a
    }
    estimated[i] = true
    // Carried on from the nearest known, the way it's flown: a STAR keeps descending, a SID climbing.
    const from = after ?? before
    if (from !== undefined) {
      const alt = known.get(p.names[from])! + sign * (along[i] - along[from]) * PROFILE_FT_PER_NM
      return Math.min(Math.max(alt, field + PROFILE_MIN_AGL_FT), Math.max(PROFILE_MAX_FT, known.get(p.names[from])!))
    }
    return estimatedAltitude(p.points[i])
  })
  p.names.forEach((n, i) => {
    if (known.has(n)) return
    known.set(n, alts[i])
    if (estimated[i]) guessed.add(n)
  })
  p.alts = alts
  p.estimated = estimated
}

function distanceNm(a: LatLon, b: LatLon) {
  const lonScale = Math.cos((AIRPORT_PRESET.lat * Math.PI) / 180)
  return Math.hypot((b.lon - a.lon) * 60 * lonScale, (b.lat - a.lat) * 60)
}

export function fixOf(leg: Leg) {
  return typeof leg === 'string' ? leg : leg.fix
}

/** A charted altitude as feet: "FL190" 19000, "+5000" 5000, "5000-7000" 6000. */
export function altitudeFt(alt: string | undefined): number | null {
  if (!alt) return null
  const values = alt
    .replace(/^[+-]/, '')
    .split('-')
    .map((v) => (v.startsWith('FL') ? Number(v.slice(2)) * 100 : Number(v)))
    .filter(Number.isFinite)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

/** Where an aircraft on a procedure with no altitudes given would typically be, by its distance from the airport. */
function estimatedAltitude(p: LatLon) {
  const dx = (p.lon - AIRPORT_PRESET.lon) * 60 * Math.cos((AIRPORT_PRESET.lat * Math.PI) / 180)
  const dy = (p.lat - AIRPORT_PRESET.lat) * 60
  return Math.min(AIRPORT_PRESET.elevationFt + Math.hypot(dx, dy) * PROFILE_FT_PER_NM, PROFILE_MAX_FT)
}

