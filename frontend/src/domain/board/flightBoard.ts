import { BOARD } from '../../config/config'
import { wasLanding, type Flight } from '../tracking/flights'

export interface BoardRow {
  hex: string
  /** Estimated arrival, actual landing, or estimated takeoff (epoch ms), if known. */
  time: number | null
  flight: string
  city: string
  iata: string
  aircraftType: string | null
  status: string
  detail: string
  landed: boolean
}

/** A flight that just landed or took off, announced in its board's header. */
export interface BoardEvent {
  flight: string
  /** The other end of the trip: where it came from (landing) or is headed (takeoff). */
  iata: string
  at: number
}

export interface BoardState {
  arrivals: BoardRow[]
  departures: BoardRow[]
  /** The most recent landing / takeoff, while still within BOARD.eventMs. */
  landing: BoardEvent | null
  takeoff: BoardEvent | null
}

/**
 * A departure first spotted already airborne counts as having just taken off if
 * it's this low and close (ground coverage at airports is patchy).
 */
const TAKEOFF_MAX_ALTITUDE_FT = 2500
const TAKEOFF_MAX_NM = 5

/** Builds the arrivals/departures board, remembering recent landings and takeoffs. */
export class FlightBoard {
  private arrivals = new Map<string, Flight>()
  private landed = new Map<string, { flight: Flight; at: number }>()
  private takeoffTimes = new Map<string, number>()
  private groundDepartures = new Set<string>()
  private seenDepartures = new Set<string>()
  private lastLanding: BoardEvent | null = null
  private lastTakeoff: BoardEvent | null = null

  private readonly events?: { landed(at: number): void; tookOff(at: number): void }

  /** `events` hears of each landing and takeoff as it's spotted (for the airport's stats). */
  constructor(events?: { landed(at: number): void; tookOff(at: number): void }) {
    this.events = events
  }

  update(flights: Flight[], now: number): BoardState {
    const current = new Map(flights.map((f) => [f.hex, f]))

    // An arrival that reports "ground", or vanishes while low, has landed.
    for (const [hex, prev] of this.arrivals) {
      const f = current.get(hex)
      if (f ? f.onGround : wasLanding(prev)) {
        this.landed.set(hex, { flight: prev, at: now })
        this.lastLanding = boardEvent(prev, now)
        this.events?.landed(now)
      }
    }
    for (const [hex, { at }] of this.landed) {
      const f = current.get(hex)
      if (now - at > BOARD.landedLingerMs || (f && !f.onGround)) this.landed.delete(hex)
    }

    const airborne = flights.filter((f) => !f.onGround)
    const arrivals = airborne.filter((f) => f.kind === 'arrival').sort((a, b) => a.distanceNm - b.distanceNm)
    const departures = airborne.filter((f) => f.kind === 'departure').sort((a, b) => a.distanceNm - b.distanceNm)
    this.arrivals = new Map(arrivals.map((f) => [f.hex, f]))

    // Departures still on the ground at the airport (from pushback, once their
    // transponder is on), taxiing ones first since they'll leave soonest. The
    // feed sometimes reports two airframes under one callsign; list it once.
    const onGround = flights
      .filter((f) => f.onGround && f.kind === 'departure' && f.distanceNm < BOARD.groundDepartureNm)
      .sort((a, b) => (b.groundSpeed ?? 0) - (a.groundSpeed ?? 0))
      .filter((f, i, all) => all.findIndex((g) => g.callsign === f.callsign) === i)

    // A departure that was on the ground last time, or first shows up climbing
    // out low and close to the airport, has just taken off.
    for (const f of departures) {
      const wasOnGround = this.groundDepartures.has(f.hex)
      const justClimbingOut =
        !this.seenDepartures.has(f.hex) &&
        f.altitude !== null &&
        f.altitude < TAKEOFF_MAX_ALTITUDE_FT &&
        f.distanceNm < TAKEOFF_MAX_NM
      if (wasOnGround || justClimbingOut) {
        this.lastTakeoff = boardEvent(f, now)
        this.events?.tookOff(now)
      }
    }
    this.groundDepartures = new Set(onGround.map((f) => f.hex))
    this.seenDepartures = new Set([...departures, ...onGround].map((f) => f.hex))

    // Estimate each departure's takeoff time once, when it first appears.
    const takeoffTimes = new Map<string, number>()
    for (const f of departures) {
      const flown = flightTimeMs(f)
      const estimate = flown === null ? null : now - flown
      takeoffTimes.set(f.hex, this.takeoffTimes.get(f.hex) ?? estimate ?? now)
    }
    this.takeoffTimes = takeoffTimes

    const landed = [...this.landed.values()].sort((a, b) => b.at - a.at)
    const recent = (e: BoardEvent | null) => (e && now - e.at < BOARD.eventMs ? e : null)
    return {
      landing: recent(this.lastLanding),
      takeoff: recent(this.lastTakeoff),
      arrivals: [
        ...landed.map(({ flight, at }) => row(flight, at, 'Landed', '', true)),
        ...arrivals.map((f) => {
          const remaining = flightTimeMs(f)
          return row(
            f,
            remaining === null ? null : now + remaining,
            f.distanceNm < BOARD.approachNm ? 'Approach' : 'En route',
            `${Math.round(f.distanceNm)} nm`,
          )
        }),
      ],
      departures: [
        ...onGround.map((f) => row(f, null, (f.groundSpeed ?? 0) >= TAXI_SPEED_KT ? 'Taxiing' : 'At gate', '')),
        ...departures.map((f) =>
          row(
            f,
            takeoffTimes.get(f.hex) ?? null,
            f.altitude !== null && f.altitude < BOARD.climbingBelowFt ? 'Climbing' : 'Departed',
            formatAltitude(f.altitude),
          ),
        ),
      ],
    }
  }
}

function boardEvent(f: Flight, at: number): BoardEvent {
  return { flight: f.callsign, iata: f.counterpart?.iata ?? '', at }
}

/** Ground speed (knots) above which a departure on the ground counts as taxiing. */
const TAXI_SPEED_KT = 3

function row(f: Flight, time: number | null, status: string, detail: string, landed = false): BoardRow {
  return {
    hex: f.hex,
    time,
    flight: f.callsign,
    // Flights classified from their motion (no usable route) have no known origin/destination.
    city: f.counterpart?.city ?? 'Unknown',
    iata: f.counterpart?.iata ?? '',
    aircraftType: f.aircraftType,
    status,
    detail,
    landed,
  }
}

/** Straight-line time between the aircraft and the airport at its current speed. */
function flightTimeMs(f: Flight) {
  if (f.groundSpeed === null || f.groundSpeed < 50) return null
  return (f.distanceNm / f.groundSpeed) * 3_600_000
}

function formatAltitude(feet: number | null) {
  if (feet === null) return ''
  if (feet >= 18_000) return `FL${Math.round(feet / 100)}`
  return `${(Math.round(feet / 100) * 100).toLocaleString()} ft`
}
