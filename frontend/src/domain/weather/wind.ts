/** Wind drawing math shared by the METAR wind icon (components/weather/MetarIcons) and the airport view's vane (rendering/diorama). */

/** A wind barb's marks down a staff pointing straight up from (12, 12) to (12, 1.5): pennant = 50 kt, full = 10 kt, half = 5 kt. */
export interface BarbMark {
  kind: 'pennant' | 'full' | 'half'
  /** Where it meets the staff. */
  y: number
}

/** The barb marks for `knots` of wind (also drawn by the 3D airport view's vane). */
export function barbMarks(knots: number): BarbMark[] {
  let left = Math.round(knots / 5) * 5
  const marks: BarbMark[] = []
  let y = 1.5
  while (left >= 50) {
    marks.push({ kind: 'pennant', y })
    y += 3.5
    left -= 50
  }
  while (left >= 10) {
    marks.push({ kind: 'full', y })
    y += 2.5
    left -= 10
  }
  if (left >= 5) {
    // A lone half barb sits a little down the staff so it isn't mistaken for a full one.
    if (marks.length === 0) y += 2.5
    marks.push({ kind: 'half', y })
  }
  return marks
}

/** How long (seconds) each streak takes to drift past: about 2.4 s in a breeze, down to 0.6 s in a gale. */
export function windFlowS(knots: number) {
  return Math.min(Math.max(2.6 - knots / 20, 0.6), 2.4)
}

/** Streak positions across the wind, and how far through the cycle each starts (so they don't move in step). */
export const STREAKS: [number, number][] = [
  [8.5, -0.55],
  [12, 0],
  [15.5, -0.3],
]
