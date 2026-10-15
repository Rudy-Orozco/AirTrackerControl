import { useEffect, useState, type CSSProperties, type RefObject } from 'react'

/**
 * Shared by the floating panels over the map (the 3D airport view and the 3D
 * map's minimap): where they sit, and keeping their buttons on screen.
 */

/** Where the panel sits and how big it is, in pixels. */
export interface Placement {
  left: number
  top: number
  size: number
}

/**
 * The same as fractions of the window (left and size of its width, top of its
 * height), so it lands in the same spot on any screen size. Null until first
 * moved, while CSS places it.
 */
export type SavedPlacement = Placement

/** Room to keep between the buttons and the panel's top-right corner. */
const BUTTONS_INSET = { top: 26, right: 6 }
/** The toolbar along the top of the window ends this far down. */
const TOOLBAR_CLEARANCE = 54
/** The button column's size, so it never slides out of the panel itself. */
const BUTTONS_SIZE = { width: 24, height: 54 }

/**
 * Keeps the reset and lock buttons in the part of the panel that's on screen:
 * normally its top-right corner, but if that corner is past the window's top or
 * right edge, the top-right of whatever part is still visible.
 */
export function buttonsStyle(p: SavedPlacement | null, win: { width: number; height: number }): CSSProperties | undefined {
  // Placed by CSS in its default corner: always fully on screen.
  if (!p) return undefined
  const left = p.left * win.width
  const top = p.top * win.height
  const size = p.size * win.width
  const hiddenRight = clamp(left + size - win.width, 0, size)
  // Below the window's top edge, and below the toolbar buttons that sit along it.
  const hiddenTop = clamp(TOOLBAR_CLEARANCE - BUTTONS_INSET.top - top, 0, size)
  return {
    top: Math.min(hiddenTop + BUTTONS_INSET.top, size - BUTTONS_SIZE.height - 4),
    right: Math.min(hiddenRight + BUTTONS_INSET.right, size - BUTTONS_SIZE.width - 4),
  }
}

export function toFractions(p: Placement): SavedPlacement {
  return {
    left: p.left / window.innerWidth,
    top: p.top / window.innerHeight,
    size: p.size / window.innerWidth,
  }
}

/** A saved placement, if it's fractions of the window (possibly past its edges); null for anything else (e.g. pixels saved by an earlier version). */
export function validPlacement(p: SavedPlacement | null | undefined): SavedPlacement | null {
  const valid = p && [p.left, p.top].every((v) => Number.isFinite(v) && v > -4 && v < 5) && Number.isFinite(p.size) && p.size > 0 && p.size <= 4
  return valid ? p : null
}

/**
 * Whether the pointer is over the panel while it's locked. A locked panel lets
 * the mouse through to the map, so CSS :hover can't tell; this watches the
 * pointer instead, so hovering the panel can still reveal its lock button.
 */
export function usePointerOverWhileLocked(ref: RefObject<HTMLElement | null>, locked: boolean) {
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (!locked) return
    const onMove = (e: PointerEvent) => {
      const rect = ref.current?.getBoundingClientRect()
      const inside = !!rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
      setOver((was) => (was === inside ? was : inside))
    }
    const onLeave = () => setOver(false)
    window.addEventListener('pointermove', onMove)
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    }
  }, [ref, locked])
  // Only meaningful while locked; a stale value from before unlocking is ignored.
  return locked && over
}

/** The window's size, kept up to date. */
export function useWindowSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return size
}

/** Up to three times the window's shorter side. */
export function maxPanelSize() {
  return Math.min(window.innerWidth, window.innerHeight) * 3
}

export function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max)
}
