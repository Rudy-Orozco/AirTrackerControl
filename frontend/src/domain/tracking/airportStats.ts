import { AIRPORT, AIRPORT_PRESET, FEED } from '../../config/config'
import type { Flight } from './flights'
import { localStore } from '../../services/storage'

/** What happened at the airport lately, for the stats under the logo. */
export interface AirportStatsState {
  /** When each landing, takeoff, go-around and rejected takeoff happened (epoch ms), within the last STATS_WINDOW_MS. */
  landings: number[]
  takeoffs: number[]
  goArounds: number[]
  aborts: number[]
  /** Since when they've been counted (epoch ms): the app's start, or STATS_WINDOW_MS ago if longer. */
  since: number
  /** When this session began (epoch ms): the app's start or the last reset, carried across reloads. */
  sessionStart: number
  /** Every landing and takeoff counted this session, not just the last STATS_WINDOW_MS. */
  totalLandings: number
  totalTakeoffs: number
  /** Arrivals in the air, and departures on the ground at the airport waiting to go. */
  inbound: number
  waiting: number
}

/** Sent to start counting again from now (the settings panel's reset button). */
export const RESET_STATS_EVENT = 'airportStats:reset'

export function resetAirportStats() {
  window.dispatchEvent(new Event(RESET_STATS_EVENT))
}

/** How far back the stats go. */
export const STATS_WINDOW_MS = 60 * 60_000

/** Go-around: an arrival that got this low (feet above the field) this close (nm)... */
const GO_AROUND_BELOW_FT = 1200
const GO_AROUND_WITHIN_NM = 6
/** ...then climbed this much higher, and is still climbing at least this fast (fpm), without landing. */
const GO_AROUND_CLIMB_FT = 400
const GO_AROUND_CLIMB_FPM = 500

/** Rejected takeoff: on the ground, from below this speed (knots)... */
const ROLL_FROM_KT = 40
/** ...up to a takeoff roll at least this fast... */
const ROLL_KT = 60
/** ...then back below this, still on the ground, without having lifted off. */
const ABORT_BELOW_KT = 35

/** Remembered across reloads (turning the screen reloads), unless the gap was long enough to have missed things. */
const STORAGE_KEY = `airportStats:${AIRPORT}`
const RESUME_WITHIN_MS = 3 * 60_000

/**
 * Counts landings and takeoffs (as the board sees them), and spots go-arounds
 * and rejected takeoffs in each update's flights.
 */
export class AirportStats {
  private landings: number[] = []
  private takeoffs: number[] = []
  private goArounds: number[] = []
  private aborts: number[] = []
  private since = Date.now()
  private sessionStart = this.since
  private totalLandings = 0
  private totalTakeoffs = 0
  /** Per arrival: the lowest it's been (feet above the field) on this approach, close in. */
  private lowest = new Map<string, number>()
  /** Per aircraft on the ground: how far through a takeoff roll it is. */
  private roll = new Map<string, 'slow' | 'rolling'>()

  constructor() {
    this.load()
    window.addEventListener(RESET_STATS_EVENT, this.reset)
  }

  dispose() {
    window.removeEventListener(RESET_STATS_EVENT, this.reset)
  }

  /** Forgets everything counted so far and starts again from now. */
  private reset = () => {
    this.landings = []
    this.takeoffs = []
    this.goArounds = []
    this.aborts = []
    this.since = Date.now()
    this.sessionStart = this.since
    this.totalLandings = 0
    this.totalTakeoffs = 0
    this.store(this.since)
  }

  landed(at: number) {
    this.landings.push(at)
    this.totalLandings++
  }

  tookOff(at: number) {
    this.takeoffs.push(at)
    this.totalTakeoffs++
  }

  update(flights: Flight[], now: number): AirportStatsState {
    const present = new Set<string>()
    for (const f of flights) {
      present.add(f.hex)
      this.watchApproach(f, now)
      this.watchRoll(f, now)
    }
    for (const hex of this.lowest.keys()) if (!present.has(hex)) this.lowest.delete(hex)
    for (const hex of this.roll.keys()) if (!present.has(hex)) this.roll.delete(hex)

    const from = now - STATS_WINDOW_MS
    const recent = (times: number[]) => times.filter((t) => t >= from)
    this.landings = recent(this.landings)
    this.takeoffs = recent(this.takeoffs)
    this.goArounds = recent(this.goArounds)
    this.aborts = recent(this.aborts)
    this.since = Math.max(this.since, from)
    this.store(now)

    return {
      landings: this.landings,
      takeoffs: this.takeoffs,
      goArounds: this.goArounds,
      aborts: this.aborts,
      since: this.since,
      sessionStart: this.sessionStart,
      totalLandings: this.totalLandings,
      totalTakeoffs: this.totalTakeoffs,
      inbound: flights.filter((f) => f.kind === 'arrival' && !f.onGround).length,
      waiting: flights.filter((f) => f.kind === 'departure' && f.onGround).length,
    }
  }

  /** An arrival that came down low and close in, then climbed away without landing, went around. */
  private watchApproach(f: Flight, now: number) {
    if (f.kind !== 'arrival' || f.onGround || f.altitude === null) {
      this.lowest.delete(f.hex)
      return
    }
    const height = f.altitude - AIRPORT_PRESET.elevationFt
    const lowest = this.lowest.get(f.hex)
    if (f.distanceNm < GO_AROUND_WITHIN_NM && (lowest === undefined || height < lowest)) this.lowest.set(f.hex, height)
    if (
      lowest !== undefined &&
      lowest < GO_AROUND_BELOW_FT &&
      height > lowest + GO_AROUND_CLIMB_FT &&
      (f.verticalRate ?? 0) >= GO_AROUND_CLIMB_FPM
    ) {
      this.goArounds.push(now)
      // Counted once: it has to come back down for another approach to count again.
      this.lowest.set(f.hex, Infinity)
    }
  }

  /** On the ground: speeding up from slow to a takeoff roll, then slowing right down again, is a rejected takeoff. */
  private watchRoll(f: Flight, now: number) {
    // Arrivals slow down after landing; that's not it.
    if (!f.onGround || f.kind === 'arrival' || f.groundSpeed === null) {
      this.roll.delete(f.hex)
      return
    }
    const state = this.roll.get(f.hex)
    if (f.groundSpeed < ROLL_FROM_KT) {
      if (state === 'rolling' && f.groundSpeed < ABORT_BELOW_KT) this.aborts.push(now)
      this.roll.set(f.hex, 'slow')
    } else if (f.groundSpeed >= ROLL_KT && state === 'slow') {
      this.roll.set(f.hex, 'rolling')
    }
  }

  private load() {
    try {
      const saved = localStore.getJson(STORAGE_KEY) as Record<string, unknown> | null
      if (!saved || Date.now() - (saved.savedAt as number) > Math.max(RESUME_WITHIN_MS, FEED.pollMs * 3)) return
      const times = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is number => typeof t === 'number') : [])
      this.landings = times(saved.landings)
      this.takeoffs = times(saved.takeoffs)
      this.goArounds = times(saved.goArounds)
      this.aborts = times(saved.aborts)
      if (typeof saved.since === 'number') this.since = saved.since
      this.sessionStart = typeof saved.sessionStart === 'number' ? saved.sessionStart : this.since
      const total = (v: unknown, atLeast: number) => (typeof v === 'number' ? Math.max(v, atLeast) : atLeast)
      this.totalLandings = total(saved.totalLandings, this.landings.length)
      this.totalTakeoffs = total(saved.totalTakeoffs, this.takeoffs.length)
    } catch {
      // Start counting afresh.
    }
  }

  private store(now: number) {
    // If storage is unavailable, the stats start again after a reload.
    const { landings, takeoffs, goArounds, aborts, since, sessionStart, totalLandings, totalTakeoffs } = this
    localStore.setJson(STORAGE_KEY, { landings, takeoffs, goArounds, aborts, since, sessionStart, totalLandings, totalTakeoffs, savedAt: now })
  }
}
