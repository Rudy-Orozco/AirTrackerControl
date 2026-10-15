import { mapStyle } from './mapStyle'
import type { Point } from './renderer'

/** Per-aircraft label state, kept between frames by the caller. */
export interface LabelState {
  /** Where the label is drawn now: box center relative to the aircraft. */
  offset: Point
  /** The slot it's gliding toward. */
  target: Point
  /** Index into the candidate slots, or -1 before its first placement. */
  slot: number
  /** 0..1, so hidden labels fade rather than pop. */
  alpha: number
  visible: boolean
}

export interface LabelItem {
  anchor: Point
  width: number
  height: number
  /** Lower goes first and gets the better slots. */
  priority: number
  /** May be hidden when there's no free slot (background traffic). */
  optional: boolean
  state: LabelState
}

export interface Bounds {
  width: number
  height: number
}

/** Slot directions in order of preference: right, left, the diagonals, then above and below. */
const DIRECTIONS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, -1],
  [-1, 1],
  [0, -1],
  [0, 1],
]
/** Space between the aircraft icon and a label right next to it. */
function nearGap() {
  return mapStyle().planeSize + 4
}
const PADDING = 3

/** Cost per square pixel of a label covering another label, an aircraft, or the screen edge. */
const OVERLAP_COST = 1
/** Cost per step down the preference list (and for the farther ring). */
const PREFERENCE_COST = 4
/** Extra cost to leave the current slot, so labels don't flicker between near-equal choices. */
const SWITCH_COST = 40

const LAYOUT_INTERVAL_MS = 200
/** Fraction of the remaining distance a label glides toward its slot each frame. */
const GLIDE = 0.18
const FADE = 0.12

export function newLabelState(width: number): LabelState {
  const offset = slotOffset(0, width, mapStyle().labelSize)
  return { offset, target: { ...offset }, slot: -1, alpha: 0, visible: true }
}

/** When labels were last placed, for each style (each map lays out its own). */
const lastLayout = new WeakMap<object, number>()

/**
 * Places labels in the best free slot around each aircraft, then glides them
 * there. Placement runs a few times a second, greedily in priority order; each
 * label weighs overlap with already-placed labels, every aircraft icon and the
 * screen edges against its slot preference and staying put. Mutates each
 * item's state.
 */
export function updateLabels(items: LabelItem[], aircraft: Point[], bounds: Bounds, now: number) {
  const style = mapStyle()
  if (now - (lastLayout.get(style) ?? -Infinity) >= LAYOUT_INTERVAL_MS || items.some((i) => i.state.slot === -1)) {
    lastLayout.set(style, now)
    place(items, aircraft, bounds)
  }
  for (const { state } of items) {
    state.offset.x += (state.target.x - state.offset.x) * GLIDE
    state.offset.y += (state.target.y - state.offset.y) * GLIDE
    state.alpha += ((state.visible ? 1 : 0) - state.alpha) * FADE
  }
}

function place(items: LabelItem[], aircraft: Point[], bounds: Bounds) {
  const placed: Box[] = []
  const iconRadius = mapStyle().planeSize + 1
  const icons: Box[] = aircraft.map((p) => ({
    left: p.x - iconRadius,
    top: p.y - iconRadius,
    right: p.x + iconRadius,
    bottom: p.y + iconRadius,
  }))
  const slotCount = DIRECTIONS.length * 2

  for (const item of [...items].sort((a, b) => a.priority - b.priority)) {
    let best = { slot: 0, cost: Infinity, overlap: 0 }
    for (let slot = 0; slot < slotCount; slot++) {
      const box = boxAt(item, slotOffset(slot, item.width, item.height))
      let overlap = offscreen(box, bounds)
      for (const other of placed) overlap += intersection(box, other)
      for (const icon of icons) overlap += intersection(box, icon)
      const cost = overlap * OVERLAP_COST + slot * PREFERENCE_COST + (slot === item.state.slot ? 0 : SWITCH_COST)
      if (cost < best.cost) best = { slot, cost, overlap }
    }

    const { state } = item
    state.visible = !(item.optional && best.overlap > 0)
    if (!state.visible) continue
    if (state.slot === -1) state.offset = slotOffset(best.slot, item.width, item.height)
    state.slot = best.slot
    state.target = slotOffset(best.slot, item.width, item.height)
    placed.push(boxAt(item, state.target))
  }
}

/** Box center for a slot: snug against the icon, or one leader-line length farther out. */
function slotOffset(slot: number, width: number, height: number): Point {
  const [dx, dy] = DIRECTIONS[slot % DIRECTIONS.length]
  const gap = nearGap() + (slot >= DIRECTIONS.length ? mapStyle().labelLeaderLength : 0)
  return { x: dx * (gap + width / 2), y: dy * (gap + height / 2) }
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

function boxAt(item: LabelItem, offset: Point): Box {
  const cx = item.anchor.x + offset.x
  const cy = item.anchor.y + offset.y
  return {
    left: cx - item.width / 2 - PADDING,
    top: cy - item.height / 2 - PADDING,
    right: cx + item.width / 2 + PADDING,
    bottom: cy + item.height / 2 + PADDING,
  }
}

function intersection(a: Box, b: Box) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

function offscreen(box: Box, bounds: Bounds) {
  const area = (box.right - box.left) * (box.bottom - box.top)
  return area - intersection(box, { left: 0, top: 0, right: bounds.width, bottom: bounds.height })
}

/**
 * Where a leader line from the aircraft should meet the label box, or null if
 * the label is snug against its aircraft and doesn't need one.
 */
export function leaderLine(item: LabelItem): { from: Point; to: Point } | null {
  const { anchor, width, height } = item
  const { offset } = item.state
  const cx = anchor.x + offset.x
  const cy = anchor.y + offset.y
  const to = {
    x: Math.max(cx - width / 2, Math.min(anchor.x, cx + width / 2)),
    y: Math.max(cy - height / 2, Math.min(anchor.y, cy + height / 2)),
  }
  const dx = to.x - anchor.x
  const dy = to.y - anchor.y
  const dist = Math.hypot(dx, dy)
  if (dist < nearGap() + 6) return null
  const start = mapStyle().planeSize + 2
  return { from: { x: anchor.x + (dx / dist) * start, y: anchor.y + (dy / dist) * start }, to }
}
