import { useSyncExternalStore } from 'react'
import { AIRPORT_PRESET } from '../config/config'
import type { Flight, FlightKind } from '../domain/tracking/flights'
import { distanceNm, greatCircle } from '../domain/geo/greatCircle'
import type { GroundTracker } from '../domain/tracking/groundTracker'
import type { LatLon, Tracker } from '../domain/tracking/tracker'

/**
 * The aircraft picked on the map or the board (by its hex code), shown in the
 * info panel and followed by the map's camera until it's let go. Shared between
 * the maps, the board and the panel.
 */
let selected: string | null = null
/** Riding along with the selected aircraft, from its cockpit or behind its tail (the 3D map only); null to follow it from outside. */
export type RideView = 'cockpit' | 'tail'
let ride: RideView | null = null
const listeners = new Set<() => void>()

export function selectedAircraft() {
  return selected
}

export function useSelectedAircraft() {
  return useSyncExternalStore(subscribeSelection, selectedAircraft)
}

export function subscribeSelection(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function rideView() {
  return ride
}

export function useRideView() {
  return useSyncExternalStore(subscribeSelection, rideView)
}

/** Picks an aircraft to show and follow, or lets go of it (null), sending the camera back. Stops riding along either way. */
export function selectAircraft(hex: string | null) {
  if (hex === selected && !ride) return
  selected = hex
  ride = null
  notify()
}

/** Rides along with the selected aircraft from its cockpit or behind its tail, or goes back to following it from outside (null). */
export function setRideView(view: RideView | null) {
  if (view === ride || (view && !selected)) return
  ride = view
  notify()
}

function notify() {
  for (const listener of listeners) listener()
}

/** Where an aircraft is drawn right now, in the air or on the ground. */
export interface Located {
  info: Flight
  pos: LatLon
  heading: number
  /** Feet above sea level, or null if unknown. */
  altitude: number | null
  onGround: boolean
}

/**
 * Finds an aircraft in either tracker. The airborne one wins until it lands, so
 * a followed arrival carries on along the runway, and a departure up from it.
 */
export function locateAircraft(hex: string, tracker: Tracker, ground: GroundTracker): Located | null {
  const t = tracker.tracks.get(hex)
  if (t && t.landedAt === null && t.pos) {
    return { info: t.info, pos: t.pos, heading: t.heading, altitude: t.altitude, onGround: false }
  }
  const g = ground.tracks.get(hex)
  if (g?.pos) {
    return { info: g.info, pos: g.pos, heading: g.heading, altitude: AIRPORT_PRESET.elevationFt + g.heightFt, onGround: true }
  }
  if (t?.pos) return { info: t.info, pos: t.pos, heading: t.heading, altitude: t.altitude, onGround: false }
  return null
}

/** The followed flight's route: its origin (arrivals) or destination (departures), and the great circle to it. */
export interface FocusRoute {
  kind: FlightKind
  /** From the aircraft to the other airport. */
  points: LatLon[]
  /** e.g. "TO IAH HOUSTON" or "FROM ORD CHICAGO". */
  label: string
}

/** Null for overflights, or when the route database doesn't say where the other airport is. */
export function routeOf({ info, pos }: Located): FocusRoute | null {
  const { kind, counterpart } = info
  if (kind === 'other' || counterpart?.lat == null || counterpart.lon == null) return null
  const end = { lat: counterpart.lat, lon: counterpart.lon }
  const segments = Math.round(Math.min(Math.max(distanceNm(pos, end) / 10, 16), 256))
  const name = [counterpart.iata, counterpart.city].filter(Boolean).join(' ').toUpperCase()
  return { kind, points: greatCircle(pos, end, Infinity, segments), label: `${kind === 'arrival' ? 'FROM' : 'TO'} ${name}` }
}
