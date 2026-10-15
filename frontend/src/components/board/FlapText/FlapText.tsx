import { useEffect, useRef } from 'react'
import { BOARD } from '../../../config/config'
import './FlapText.css'

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** One flap falling: the tile squashes to its hinge and springs back with the new character. */
const FLAP_FRAMES: Keyframe[] = [
  { transform: 'scaleY(1)', filter: 'brightness(1)' },
  { transform: 'scaleY(0.08)', filter: 'brightness(0.45)', offset: 0.5 },
  { transform: 'scaleY(1)', filter: 'brightness(1)' },
]

/**
 * Text on split-flap tiles, one per character, padded or cut to `length`.
 *
 * When `text` changes, every tile whose character differs flips through a few
 * random characters before landing on the new one. Tiles start `delay` ms from
 * now plus a per-tile stagger, so a change cascades left to right. Tiles are
 * updated directly rather than through React, so a full-board cascade costs no
 * re-renders.
 */
export function FlapText({ text, length, delay, className = '' }: { text: string; length: number; delay: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const tiles = Array.from(ref.current!.children) as HTMLElement[]
    const target = text.toUpperCase().padEnd(length).slice(0, length)
    const { stepMs, charStaggerMs, minSteps, maxSteps } = BOARD.flip
    const timers: ReturnType<typeof setTimeout>[] = []

    tiles.forEach((tile, i) => {
      // Compare against what's actually showing, which may be mid-flip from an
      // interrupted cascade.
      if ((tile.textContent || ' ') === target[i]) return
      const steps = minSteps + Math.floor(Math.random() * (maxSteps - minSteps + 1))
      for (let step = 1; step <= steps; step++) {
        const at = delay + i * charStaggerMs + (step - 1) * stepMs
        timers.push(
          setTimeout(() => {
            tile.textContent = step === steps ? target[i] : CHARSET[Math.floor(Math.random() * CHARSET.length)]
            tile.animate(FLAP_FRAMES, stepMs)
          }, at),
        )
      }
    })

    return () => timers.forEach(clearTimeout)
  }, [text, length, delay])

  return (
    <span ref={ref} className={`flaps ${className}`}>
      {Array.from({ length }, (_, i) => (
        <span key={i} className="flap" />
      ))}
    </span>
  )
}
