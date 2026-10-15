import { useSyncExternalStore } from 'react'
import { localStore } from '../services/storage'

/**
 * The orbit point: the point the 3D map's camera circles around while orbiting.
 * Placed in two clicks after pressing the axis button: one on the ground for a
 * vertical axis, then one for how high up that axis the point (a ball) sits.
 * Shared between that button and the map, and remembered in this browser.
 */
export interface OrbitAnchor {
  /** Nautical miles east (x) and north (y) of the airport, drawn height of the ball (z) and of the ground under it. */
  anchor: { x: number; y: number; z: number; groundZ: number } | null
  /** Placing it: 'axis' waits for a click on the ground, 'height' for one along the axis planted there. */
  picking: false | 'axis' | 'height'
  /** Where the axis was planted, while picking its height. */
  foot: { x: number; y: number; z: number } | null
}

const ANCHOR_KEY = 'map3dOrbitAnchor'

let state: OrbitAnchor = { anchor: loadAnchor(), picking: false, foot: null }
const listeners = new Set<() => void>()

export function orbitAnchor() {
  return state
}

export function useOrbitAnchor() {
  return useSyncExternalStore(subscribeOrbitAnchor, orbitAnchor)
}

export function subscribeOrbitAnchor(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function update(next: Partial<OrbitAnchor>) {
  state = { ...state, ...next }
  // If storage is unavailable, the axis just won't be remembered.
  if (state.anchor) localStore.setJson(ANCHOR_KEY, state.anchor)
  else localStore.remove(ANCHOR_KEY)
  for (const listener of listeners) listener()
}

export function startPicking() {
  update({ picking: 'axis', foot: null })
}

export function cancelPicking() {
  if (state.picking) update({ picking: false, foot: null })
}

/** First click: the axis stands here; next, its height. */
export function plantAxis(foot: { x: number; y: number; z: number }) {
  update({ picking: 'height', foot })
}

/** Second click: the ball sits `z` up the planted axis. */
export function setAnchorHeight(z: number) {
  if (!state.foot) return
  const { x, y, z: groundZ } = state.foot
  update({ anchor: { x, y, z, groundZ }, picking: false, foot: null })
}

export function clearAnchor() {
  update({ anchor: null, picking: false, foot: null })
}

/** The axis button: cancels a pick in progress, else starts picking a (new) point. */
export function toggleAnchor() {
  if (state.picking) cancelPicking()
  else startPicking()
}

function loadAnchor(): OrbitAnchor['anchor'] {
  try {
    const saved = localStore.getJson(ANCHOR_KEY) as Record<string, number> | null
    if (saved && [saved.x, saved.y, saved.z].every(Number.isFinite)) {
      return { x: saved.x, y: saved.y, z: saved.z, groundZ: Number.isFinite(saved.groundZ) ? saved.groundZ : saved.z }
    }
  } catch {
    // Fall through: no axis.
  }
  return null
}
