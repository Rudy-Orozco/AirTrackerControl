import { useSyncExternalStore } from 'react'

/**
 * Street view on the 3D map: standing on the ground at the airport, at eye
 * height, looking around and watching aircraft from there. Offered while the
 * camera is near the airport. Pressing the street button starts `placing`
 * (the next click on the ground picks the spot), then the camera stands there
 * until the button (or Escape) steps back out. Shared between that button and the map.
 */
export interface StreetView {
  state: 'off' | 'placing' | 'standing'
  /** Nautical miles east (x) and north (y) of the airport, while standing. */
  spot: { x: number; y: number } | null
  /** Whether the camera is near enough the airport to offer it (set by the map). */
  available: boolean
}

let view: StreetView = { state: 'off', spot: null, available: false }
const listeners = new Set<() => void>()

export function streetView() {
  return view
}

export function useStreetView() {
  return useSyncExternalStore(subscribeStreetView, streetView)
}

export function subscribeStreetView(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function update(next: Partial<StreetView>) {
  view = { ...view, ...next }
  for (const listener of listeners) listener()
}

/** The map says whether it's near enough the airport to offer street view. */
export function setStreetAvailable(available: boolean) {
  if (available !== view.available) update({ available })
}

/** The street button: picks a spot to stand, cancels picking one, or steps back out. */
export function toggleStreetView() {
  if (view.state === 'off') update({ state: 'placing', spot: null })
  else leaveStreetView()
}

/** Stands at `spot` (from a click on the ground while placing). */
export function standAt(spot: { x: number; y: number }) {
  update({ state: 'standing', spot })
}

export function leaveStreetView() {
  if (view.state !== 'off') update({ state: 'off', spot: null })
}
