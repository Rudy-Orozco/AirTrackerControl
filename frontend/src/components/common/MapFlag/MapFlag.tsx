import type { ReactNode, RefObject } from 'react'
import './MapFlag.css'

/**
 * A flag over the map, the way a cockpit display flags a source it hasn't got:
 * a red cross corner to corner, and an amber caution boxed in the middle that
 * flashes a few times as it appears. It covers only the map, not the board (`board`).
 */
export function MapFlag({ board, children }: { board: RefObject<HTMLElement | null>; children: ReactNode }) {
  return (
    <div className="map-flag" style={mapArea(board.current)} role="alert">
      <svg className="map-flag-cross" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <line x1="0" y1="0" x2="100" y2="100" />
        <line x1="100" y1="0" x2="0" y2="100" />
      </svg>
      <div className="map-flag-box">{children}</div>
    </div>
  )
}

/**
 * The part of the screen the map shows in: all of it but the board, which is
 * down the right side on a landscape screen (from where its tiles start, not
 * its fade) and along the bottom on a portrait one.
 */
function mapArea(board: HTMLElement | null) {
  const inner = board?.querySelector('.board-inner')?.getBoundingClientRect()
  if (!inner) return {}
  return window.innerWidth > window.innerHeight
    ? { right: Math.max(window.innerWidth - inner.left, 0) }
    : { bottom: Math.max(window.innerHeight - inner.top, 0) }
}
