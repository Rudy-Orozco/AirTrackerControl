import type { Aircraft } from '../feed/api'
import { AIRPORT, CENTER, MOTION } from '../config/config'
import { isAirlineCallsign, type Airport, type Route } from '../feed/routes'

export type FlightKind = 'arrival' | 'departure' | 'other'

export interface Flight extends Aircraft {
  kind: FlightKind
  /** The other end of the trip: the origin of an arrival, the destination of a departure. */
  counterpart: Airport | null
  /** Nautical miles to the airport. */
  distanceNm: number
}

/**
 * Fallback for airline flights whose route is unknown or wrong in the route
 * database (e.g. a reused flight number): judge by what the aircraft is doing
 * close to the airport.
 */
const INFER = {
  /** Only judge aircraft below this altitude (feet)... */
  maxAltitudeFt: 6000,
  /** ...climbing away within this distance (nm) as departures... */
  departureNm: 6,
  /** ...or descending toward the airport, within this many degrees, as arrivals. */
  arrivalNm: 8,
  arrivalAngleDeg: 30,
  /** Feet per minute that counts as clearly climbing or descending. */
  minVerticalRate: 300,
}

/**
 * Where a flight's route (arrival or departure here) disagrees with what it's
 * plainly doing near the airport, it's this low and close...
 */
const CHECK = {
  maxAltitudeFt: 15_000,
  withinNm: 40,
  /** ...descending toward the airport (within this many degrees) or climbing away from it... */
  towardDeg: 60,
  awayDeg: 90,
  minVerticalRate: 300,
  /** ...for this many updates in a row. */
  updates: 2,
}

/**
 * Classifies each flight as an arrival, departure, or other traffic, mainly from
 * its published route. Remembers flights classified by the fallback so they keep
 * their color after leaving the area near the airport.
 *
 * Route databases get the direction wrong now and then (a reused flight number,
 * or the legs of a round trip swapped), so a routed flight's motion near the
 * airport has the last word: the first clear verdict (descending in, or climbing
 * out) settles which it is for the rest of the leg, keeping the other end of its
 * trip. A go-around has already been seen coming in, so it stays an arrival.
 */
export class FlightClassifier {
  private inferred = new Map<string, FlightKind>()
  /** Per flight (hex and callsign): what its motion settled it as, and the verdict so far and how many updates running. */
  private settled = new Map<string, 'arrival' | 'departure'>()
  private verdicts = new Map<string, { kind: 'arrival' | 'departure'; count: number }>()
  /** Flights seen on the ground: lifting off again starts a new leg. */
  private onGround = new Set<string>()

  classify(aircraft: Aircraft[], routes: Map<string, Route>): Flight[] {
    const flights = aircraft.map((a) => {
      const flight = classifyByRoute(a, routes.get(a.callsign))
      if (routes.has(a.callsign)) return this.check(flight)
      // Only airline flights with no usable route; a valid route to another
      // airport (e.g. Love Field next to DFW) is trusted as is.
      if (!isAirlineCallsign(a.callsign) || a.onGround) return flight
      const kind = this.inferred.get(a.hex) ?? inferFromMotion(flight)
      if (kind !== 'other') this.inferred.set(a.hex, kind)
      flight.kind = kind
      return flight
    })

    // Forget aircraft that have left the feed.
    const present = new Set(aircraft.map((a) => a.hex))
    for (const hex of this.inferred.keys()) if (!present.has(hex)) this.inferred.delete(hex)
    const flying = new Set(aircraft.map(legKey))
    for (const map of [this.settled, this.verdicts]) for (const key of map.keys()) if (!flying.has(key)) map.delete(key)
    for (const key of this.onGround) if (!flying.has(key)) this.onGround.delete(key)
    return flights
  }

  /** A routed arrival or departure, turned the other way if its motion has settled it so. */
  private check(flight: Flight): Flight {
    if (flight.kind === 'other') return flight
    const key = legKey(flight)
    if (flight.onGround) this.onGround.add(key)
    else if (this.onGround.delete(key)) {
      // Took off again: a new leg, to be judged afresh.
      this.settled.delete(key)
      this.verdicts.delete(key)
    }
    if (!this.settled.has(key) && !flight.onGround) {
      const verdict = motionVerdict(flight)
      const last = this.verdicts.get(key)
      const count = verdict && last?.kind === verdict ? last.count + 1 : 1
      if (verdict) this.verdicts.set(key, { kind: verdict, count })
      else this.verdicts.delete(key)
      if (verdict && count >= CHECK.updates) this.settled.set(key, verdict)
    }
    const kind = this.settled.get(key)
    if (kind && kind !== flight.kind) flight.kind = kind
    return flight
  }
}

/** One flight leg of one aircraft. */
function legKey(a: Aircraft) {
  return `${a.hex}:${a.callsign}`
}

/** What a flight near the airport is plainly doing: coming in to land, or climbing out; null if it's not clear. */
function motionVerdict(f: Flight): 'arrival' | 'departure' | null {
  if (f.altitude === null || f.altitude > CHECK.maxAltitudeFt || f.distanceNm > CHECK.withinNm || f.verticalRate === null) return null
  const angle = angleToAirport(f)
  if (angle === null) return null
  if (f.verticalRate <= -CHECK.minVerticalRate && angle < CHECK.towardDeg) return 'arrival'
  if (f.verticalRate >= CHECK.minVerticalRate && angle > CHECK.awayDeg) return 'departure'
  return null
}

function inferFromMotion(f: Flight): FlightKind {
  if (f.altitude === null || f.altitude > INFER.maxAltitudeFt || f.verticalRate === null) return 'other'
  const angle = angleToAirport(f)
  if (angle === null) return 'other'
  if (f.verticalRate >= INFER.minVerticalRate && f.distanceNm < INFER.departureNm && angle > 90) return 'departure'
  if (f.verticalRate <= -INFER.minVerticalRate && f.distanceNm < INFER.arrivalNm && angle < INFER.arrivalAngleDeg) {
    return 'arrival'
  }
  return 'other'
}

function classifyByRoute(a: Aircraft, route: Route | undefined): Flight {
  const flight: Flight = { ...a, kind: 'other', counterpart: null, distanceNm: distanceToAirport(a) }
  if (!route) return flight

  const stops = route.airports
  const first = stops.findIndex((s) => s.iata === AIRPORT)
  const last = stops.findLastIndex((s) => s.iata === AIRPORT)
  if (first === -1) return flight

  // The airport starting the route means a departure, ending it an arrival. For
  // round trips (DFW-SMF-DFW) and through flights (ORD-DFW-LAX), go by which way it's flying.
  if (first === 0 && last !== stops.length - 1) flight.kind = 'departure'
  else if (last === stops.length - 1 && first !== 0) flight.kind = 'arrival'
  // On the ground a round trip could be either just landed or about to leave.
  else if (a.onGround) return flight
  else flight.kind = isHeadingToAirport(a) ? 'arrival' : 'departure'

  flight.counterpart = (flight.kind === 'arrival' ? stops[last - 1] : stops[first + 1]) ?? null
  return flight
}

/** True if a flight that just vanished from the feed was low enough that it probably landed. */
export function wasLanding(f: Flight) {
  return f.altitude !== null && f.altitude < MOTION.landingAltitudeFt
}

function distanceToAirport(a: Aircraft) {
  const { dx, dy } = offsetToAirportNm(a)
  return Math.hypot(dx, dy)
}

function isHeadingToAirport(a: Aircraft) {
  const angle = angleToAirport(a)
  if (angle === null) return (a.verticalRate ?? 0) < 0
  return angle < 90
}

/** Degrees between the aircraft's track and the direction to the airport (0 = straight at it). */
function angleToAirport(a: Aircraft): number | null {
  if (a.track === null) return null
  const { dx, dy } = offsetToAirportNm(a)
  const bearing = (Math.atan2(dx, dy) * 180) / Math.PI
  return Math.abs(((a.track - bearing + 540) % 360) - 180)
}

/** East (dx) and north (dy) nautical miles from the aircraft to the airport. */
function offsetToAirportNm(a: Aircraft) {
  return {
    dx: (CENTER.lon - a.lon) * 60 * Math.cos((CENTER.lat * Math.PI) / 180),
    dy: (CENTER.lat - a.lat) * 60,
  }
}
