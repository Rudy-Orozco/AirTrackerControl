import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { atisSentences, type Atis } from '../../../domain/weather/atis'
import { useAtis } from '../../../hooks/useAtis'
import { AIRPORT_PRESET, ATIS } from '../../../config/config'
import { useTick } from '../../../hooks/useTick'
import { FlapText } from '../../board/FlapText/FlapText'
import './AtisStrip.css'

const LABELS: Record<Atis['type'], string> = { arr: 'Arr', dep: 'Dep', combined: 'ATIS' }
const SLIDE_MS = 700

/**
 * The airport's ATIS: each broadcast's information letter (flips when a new one
 * is issued), then its text as a vertical carousel: the current sentence in the
 * middle with the previous and next peeking above and below, sliding up one
 * sentence every ATIS.lineMs. The letter of the broadcast being read is
 * highlighted. Hidden for airports without digital ATIS.
 */
export function AtisStrip() {
  const atis = useAtis(AIRPORT_PRESET.icao)
  const lines = useMemo(() => atis.flatMap((a) => atisSentences(a.datis).map((text) => ({ type: a.type, text }))), [atis])

  const tick = useTick(() => ATIS.lineMs)

  const count = lines.length
  const index = count ? tick % count : 0
  const windowRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  useCarousel(windowRef, listRef, index, count, lines)

  if (count === 0) return null
  const line = lines[index]

  return (
    <div className="atis">
      {atis.map((a) => (
        <span key={a.type} className={`atis-code atis-code--${a.type}${a.type === line.type ? ' is-active' : ''}`}>
          <span className="atis-type">{LABELS[a.type]}</span>
          <FlapText text={a.code} length={1} delay={0} />
        </span>
      ))}
      <div className="atis-window" ref={windowRef}>
        {/* Three copies so there's always a sentence above and below, and the loop never jumps back. */}
        <ol className="atis-lines" ref={listRef}>
          {[0, 1, 2].flatMap((copy) =>
            lines.map((l, i) => (
              <li key={`${copy}-${i}`} className={i === index ? 'is-current' : ''}>
                {l.text}
              </li>
            )),
          )}
        </ol>
      </div>
      <span className="atis-count">
        {index + 1}/{count}
      </span>
    </div>
  )
}

/**
 * Slides the list so sentence `index` (in the middle copy) is centered in the
 * window. Wrapping from the last sentence to the first slides on into the third
 * copy, then snaps back to the middle copy unseen, so it always moves upward.
 */
function useCarousel(
  windowRef: RefObject<HTMLDivElement | null>,
  listRef: RefObject<HTMLOListElement | null>,
  index: number,
  count: number,
  lines: unknown,
) {
  const previous = useRef<number | null>(null)

  useLayoutEffect(() => {
    const win = windowRef.current
    const list = listRef.current
    if (!win || !list || count === 0) return

    const moveTo = (position: number, animate: boolean) => {
      const item = list.children[position] as HTMLElement | undefined
      if (!item) return
      const y = item.offsetTop + item.offsetHeight / 2 - win.clientHeight / 2
      list.style.transition = animate ? `transform ${SLIDE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)` : 'none'
      list.style.transform = `translateY(${-y}px)`
    }

    const wrapped = previous.current === count - 1 && index === 0 && count > 1
    const animate = previous.current !== null && previous.current !== index
    previous.current = index
    moveTo(wrapped ? 2 * count : count + index, animate)

    // Re-center without animation if the layout changes (resize, web font
    // loading). The observer also fires once on start; ignore that.
    const measure = () => `${win.clientWidth}x${win.clientHeight}/${list.offsetHeight}`
    let size = measure()
    const observer = new ResizeObserver(() => {
      const next = measure()
      if (next === size) return
      size = next
      moveTo(count + index, false)
    })
    observer.observe(win)
    observer.observe(list)
    const snap = wrapped ? setTimeout(() => moveTo(count, false), SLIDE_MS) : undefined
    return () => {
      observer.disconnect()
      clearTimeout(snap)
    }
  }, [windowRef, listRef, index, count, lines])
}
