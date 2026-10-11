/** Helpers for touchscreens, where there's no hover or double-click to rely on. */

/** A press that moves less than this counts as a tap. */
export const TAP_SLOP_PX = 8

export interface Tap {
  /** The event's timeStamp (milliseconds, the same clock as performance.now()). */
  t: number
  x: number
  y: number
}

/** Whether `e` is the second of two quick taps in about the same spot, the first being `last`. */
export function isDoubleTap(last: Tap | null, e: { timeStamp: number; clientX: number; clientY: number }) {
  return last !== null && e.timeStamp - last.t < 350 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30
}
