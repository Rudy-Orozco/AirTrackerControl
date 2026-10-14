import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type Ref, type WheelEvent } from 'react'
import { AIRPORT, AIRPORT_PRESET, BOARD, MAP, MAP3D, METAR, MOTION, STATS } from '../config/config'
import { FlapText } from './FlapText'
import type { BoardEvent, BoardRow, BoardState } from './flightBoard'
import { AtisStrip } from '../weather/AtisStrip'
import { MetarStrip } from '../weather/MetarStrip'
import { formatLocalDate, formatLocalTime, localZoneName } from './localTime'
import { selectAircraft, useSelectedAircraft } from '../tracking/selection'
import { PING_HISTORY, type FeedStatus } from '../feed/useAircraftFeed'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { BOARD_SLOT_CLASS } from '../map3d/Minimap'
import { minimapInBoard } from '../map3d/tower'
import './Board.css'

type BoardKind = 'arrivals' | 'departures'

/** Characters per row, split into columns below. */
const ROW_CHARS = 34
const FLIGHT_CHARS = 7
const STATUS_CHARS = 8

/** Time, flight, city and status widths; the time column depends on the clock format setting. */
function columns() {
  const time = BOARD.use24Hour ? 5 : 8
  return [time, FLIGHT_CHARS, ROW_CHARS - time - FLIGHT_CHARS - STATUS_CHARS, STATUS_CHARS]
}

/**
 * Split-flap arrivals and departures boards, side by side, each paging through
 * its flights. `ref` lets the map keep its center clear of the board.
 *
 * With the minimap in the board (its layout, or tower view), the airport and
 * clock go across the top, over the minimap too, and under them arrivals and
 * departures are stacked, with BOARD.towerRowsPerPage rows each, beside the
 * minimap (over it on a landscape screen).
 *
 * Either can be paged by hand (the arrows by the page number, shown on hover or
 * a tap on the header; the mouse wheel over a board; or a sideways swipe), which stops the paging
 * until a minute goes by untouched. A bar across the top of the footer then
 * counts down to it starting again. The lock beside the arrows stops it until
 * it's unlocked.
 */
export function Board({ board, status, ref }: { board: BoardState; status: FeedStatus; ref?: Ref<HTMLElement> }) {
  const { pos, page, resumingSince, locked, toggleLock } = usePaging()
  const lock = { locked, toggle: toggleLock }
  const tower = minimapInBoard()

  // With the minimap beside them they're stacked, so fewer rows each.
  const perPage = tower ? BOARD.towerRowsPerPage : BOARD.rowsPerPage
  const header = (
    <header className="board-top">
      <span className="board-airport">
        <b>{AIRPORT}</b>
        <small>
          {AIRPORT_PRESET.icao} / {AIRPORT_PRESET.name}
        </small>
      </span>
      <Clock />
    </header>
  )

  const main = (
    <>
      <ErrorBoundary name="ATIS">
        <AtisStrip />
      </ErrorBoundary>
      {!tower && header}

      <div className={tower ? 'board-stack' : 'board-panels'}>
        <Panel
          kind="arrivals"
          rows={board.arrivals}
          event={board.landing}
          perPage={perPage}
          page={wrap(pos.arrivals, pageCount(board.arrivals, perPage))}
          onPage={pageCount(board.arrivals, perPage) > 1 ? (by) => page('arrivals', by) : undefined}
          lock={lock}
        />
        <Panel
          kind="departures"
          rows={board.departures}
          event={board.takeoff}
          perPage={perPage}
          page={wrap(pos.departures, pageCount(board.departures, perPage))}
          onPage={pageCount(board.departures, perPage) > 1 ? (by) => page('departures', by) : undefined}
          lock={lock}
        />
      </div>

      <footer className="board-footer">
        {resumingSince !== null && (
          <i className="board-resume" key={resumingSince} style={{ animationDuration: `${RESUME_MS}ms` }} aria-hidden />
        )}
        <FeedMeter status={status} />
        <span className="board-footer-info">
          <span className={status.error ? 'is-error' : undefined}>{statusText(status)}</span>
          <span>{status.source} / adsb.im</span>
        </span>
      </footer>
    </>
  )

  return (
    <section className={`board${tower ? ' is-tower' : ''}`} ref={ref}>
      <div className="board-inner" style={boardStyle()}>
        {METAR.position === 'board' && (
          <ErrorBoundary name="Weather (METAR)">
            <MetarStrip />
          </ErrorBoundary>
        )}
        {tower ? (
          <>
            {header}
            <div className="board-tower">
              <div className="board-main">{main}</div>
              <div className={BOARD_SLOT_CLASS} />
            </div>
          </>
        ) : (
          main
        )}
      </div>
    </section>
  )
}

function pageCount(rows: BoardRow[], perPage: number) {
  return Math.max(1, Math.ceil(rows.length / perPage))
}

/** `n` wrapped into 0..m-1, also when paging back past the first page. */
function wrap(n: number, m: number) {
  return ((n % m) + m) % m
}

type PageKey = 'arrivals' | 'departures'

/** After paging by hand, the board waits this long untouched... */
const IDLE_MS = 60_000
/** ...then counts down this long, shown as a bar, before paging by itself again. */
const RESUME_MS = 10_000

/**
 * Which page each board is on (unwrapped: wrap() it by its page count). They
 * all step on every BOARD.pageMs, except after one was paged by hand: then
 * paging stops until IDLE_MS + RESUME_MS without another, or while locked.
 */
function usePaging() {
  const [pos, setPos] = useState<Record<PageKey, number>>({ arrivals: 0, departures: 0 })
  const [manualAt, setManualAt] = useState<number | null>(null)
  /** When the countdown to paging again started, while it's showing. */
  const [resumingSince, setResumingSince] = useState<number | null>(null)
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    if (locked) return
    if (manualAt === null) {
      // BOARD.pageMs is read again each time, so a changed setting applies from the next page.
      let id: ReturnType<typeof setTimeout>
      const step = () => {
        setPos((p) => ({ arrivals: p.arrivals + 1, departures: p.departures + 1 }))
        id = setTimeout(step, BOARD.pageMs)
      }
      id = setTimeout(step, BOARD.pageMs)
      return () => clearTimeout(id)
    }
    const countdown = setTimeout(() => setResumingSince(Date.now()), manualAt + IDLE_MS - Date.now())
    const resume = setTimeout(() => {
      setResumingSince(null)
      setManualAt(null)
    }, manualAt + IDLE_MS + RESUME_MS - Date.now())
    return () => {
      clearTimeout(countdown)
      clearTimeout(resume)
    }
  }, [manualAt, locked])

  const page = (key: PageKey, by: number) => {
    setPos((p) => ({ ...p, [key]: p[key] + by }))
    // Locked, it stays put anyway: no countdown to come back to.
    if (!locked) setManualAt(Date.now())
    setResumingSince(null)
  }
  // Unlocking pages on by itself again from now.
  const toggleLock = () => {
    setLocked((l) => !l)
    setManualAt(null)
    setResumingSince(null)
  }
  return { pos, page, resumingSince, locked, toggleLock }
}

/** Whether the boards have stopped paging by themselves, and the button that does it. */
type Lock = { locked: boolean; toggle: () => void }

/** A sideways swipe at least this long (CSS pixels) turns the page. */
const SWIPE_PX = 40

/** The page buttons shown by a tap hide again this long after the last one. */
const REVEAL_MS = 4000

/** Wheel events closer together than this page once (a trackpad sends a stream of them). */
const WHEEL_GAP_MS = 400

/** Characters in the header announcement, e.g. "TAKEOFF AAL1588 AUS". */
const EVENT_CHARS = 19

function Panel({
  kind,
  rows,
  event,
  perPage,
  page,
  onPage,
  lock,
}: {
  kind: BoardKind
  rows: BoardRow[]
  event: BoardEvent | null
  perPage: number
  page: number
  /** Pages by hand, forward (1) or back (-1); left out when there's nowhere to page to. */
  onPage?: (by: number) => void
  lock: Lock
}) {
  const pages = pageCount(rows, perPage)
  const visible = rows.slice(page * perPage, (page + 1) * perPage)
  const isArrivals = kind === 'arrivals'
  const shownEvent = useUntilExpired(event)
  const selected = useSelectedAircraft()
  const lastWheel = useRef(0)
  // Tapping the header shows the buttons by the page number, for screens without hover,
  // until REVEAL_MS after the last tap on any of them.
  const [revealed, setRevealed] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const reveal = (show = true) => {
    clearTimeout(hideTimer.current)
    setRevealed(show)
    if (show) hideTimer.current = setTimeout(() => setRevealed(false), REVEAL_MS)
  }
  useEffect(() => () => clearTimeout(hideTimer.current), [])
  // Each button keeps them showing a little longer when tapped while they are.
  const press = (action: () => void) => () => {
    action()
    if (revealed) reveal()
  }
  const onWheel = (e: WheelEvent) => {
    if (!onPage || e.deltaY === 0) return
    const now = performance.now()
    const quiet = now - lastWheel.current > WHEEL_GAP_MS
    lastWheel.current = now
    if (quiet) onPage(e.deltaY > 0 ? 1 : -1)
  }

  // On a touch screen, a sideways swipe across the board pages it (left for the next page).
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  const swiped = useRef(false)
  const onPointerDown = (e: PointerEvent) => {
    swipeStart.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY }
    swiped.current = false
  }
  const onPointerUp = (e: PointerEvent) => {
    const start = swipeStart.current
    swipeStart.current = null
    if (!start || !onPage) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return
    swiped.current = true
    onPage(dx < 0 ? 1 : -1)
    if (revealed) reveal()
  }
  // A swipe that ends on a row isn't a tap on it (which would follow its flight).
  const onClickCapture = (e: MouseEvent) => {
    if (!swiped.current) return
    swiped.current = false
    e.stopPropagation()
  }
  // A tap anywhere on the header, other than on a button, shows or hides the page buttons.
  const onHeaderClick = (e: MouseEvent) => {
    if (!(e.target as Element).closest('button')) reveal(!revealed)
  }

  return (
    <div
      className={`panel panel--${kind}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (swipeStart.current = null)}
      onClickCapture={onClickCapture}
    >
      <div className="panel-header" onClick={onHeaderClick}>
        <h2>{isArrivals ? 'Arrivals' : 'Departures'}</h2>
        <span>{String(rows.length).padStart(2, '0')}</span>
        {/* Flips in when a flight lands / takes off, and flips back to blank after BOARD.eventMs. */}
        <FlapText
          text={shownEvent ? `${isArrivals ? 'Landed' : 'Takeoff'} ${shownEvent.flight} ${shownEvent.iata}` : ''}
          length={EVENT_CHARS}
          delay={0}
          className="panel-event"
        />
        <span className={`panel-page${revealed ? ' is-revealed' : ''}`}>
          {onPage && (
            <button type="button" onClick={press(() => onPage(-1))} aria-label="Previous page" title="Previous page">
              ‹
            </button>
          )}
          <span className="panel-page-number">
            {page + 1}/{pages}
          </span>
          {onPage && (
            <button type="button" onClick={press(() => onPage(1))} aria-label="Next page" title="Next page">
              ›
            </button>
          )}
          <button
            type="button"
            className={`panel-lock${lock.locked ? ' is-locked' : ''}`}
            onClick={press(lock.toggle)}
            aria-pressed={lock.locked}
            aria-label="Stop paging by itself"
            title={lock.locked ? 'Unlock: page by itself again' : 'Lock: stop paging by itself'}
          >
            <svg viewBox="0 0 12 14" aria-hidden>
              <path d={lock.locked ? 'M3.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2' : 'M3.5 6.5V4.5a2.5 2.5 0 0 1 5 0'} />
              <rect x="2" y="6.5" width="8" height="6" rx="1" />
            </svg>
          </button>
        </span>
      </div>

      <div className="panel-grid panel-columns">
        <span>{isArrivals ? 'Est' : 'Dep'}</span>
        <span>Flight</span>
        <span>{isArrivals ? 'From' : 'To'}</span>
        <span>Status</span>
      </div>

      {/* Rows are keyed by position, not flight, so the same tiles flip to new content. */}
      <ol className="panel-rows">
        {Array.from({ length: perPage }, (_, i) => (
          <Row key={i} row={visible[i]} index={i} selected={!!visible[i] && visible[i].hex === selected} />
        ))}
      </ol>
    </div>
  )
}

/** A flight's row; clicking it follows the flight on the map (and again lets it go). */
function Row({ row, index, selected }: { row: BoardRow | undefined; index: number; selected: boolean }) {
  const { rowStaggerMs, charStaggerMs } = BOARD.flip
  const widths = columns()
  const texts = row
    ? [row.time === null ? '--:--' : formatTime(row.time).padStart(widths[0]), row.flight, row.city, row.status]
    : ['', '', '', '']

  // Each column picks up the cascade where the previous one left off.
  let offset = 0
  return (
    <li
      className={`panel-grid row${row?.landed ? ' is-landed' : ''}${row ? ' is-selectable' : ''}${selected ? ' is-selected' : ''}`}
      onClick={row ? () => selectAircraft(selected ? null : row.hex) : undefined}
      onKeyDown={
        row
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                selectAircraft(selected ? null : row.hex)
              }
            }
          : undefined
      }
      role={row ? 'button' : undefined}
      tabIndex={row ? 0 : undefined}
      aria-pressed={row ? selected : undefined}
      title={row ? (selected ? 'Stop following' : `Follow ${row.flight} on the map`) : undefined}
    >
      {texts.map((text, col) => {
        const delay = index * rowStaggerMs + offset * charStaggerMs
        offset += widths[col] + 1
        return <FlapText key={col} text={text} length={widths[col]} delay={delay} className={col === 3 ? 'row-status' : ''} />
      })}
    </li>
  )
}

/**
 * Returns `event` until BOARD.eventMs after it happened, then null. Times itself
 * rather than waiting for the next data refresh, so the header clears on time.
 */
function useUntilExpired(event: BoardEvent | null) {
  const [expiredAt, setExpiredAt] = useState<number | null>(null)
  useEffect(() => {
    if (!event) return
    const id = setTimeout(() => setExpiredAt(event.at), event.at + BOARD.eventMs - Date.now())
    return () => clearTimeout(id)
  }, [event])
  return event && event.at !== expiredAt ? event : null
}

/**
 * Hands the config's colors and column widths to the stylesheet. Set on
 * .board-inner, where --cell (the tile width) is defined.
 */
function boardStyle() {
  // The board matches whichever map is showing.
  const { traffic } = MAP.view === '3d' ? MAP3D : MAP
  return {
    '--arrival': traffic.arrival.color,
    '--departure': traffic.departure.color,
    '--columns': columns()
      .map((n) => `calc(${n} * var(--cell))`)
      .join(' '),
  } as CSSProperties
}

function statusText({ count, updatedAt, error }: FeedStatus) {
  if (error) return `FEED UNAVAILABLE: ${error}`
  if (!updatedAt) return 'WAITING FOR DATA'
  // The airborne count lives with the airport stats, when they're shown.
  const airborne = STATS.enabled ? '' : `${count} AIRBORNE / `
  return `${airborne}UPDATED ${formatTime(updatedAt.getTime())} ${localZoneName(updatedAt.getTime())}${MOTION.delayed ? ' / DELAYED VIEW' : ''}`
}

/** Flight and update times are the airport's local time. */
function formatTime(ms: number) {
  return formatLocalTime(ms)
}

/** A fetch taking this long fills the latency bar; past half of it counts as slow. */
const SLOW_FETCH_MS = 3000

/**
 * How the feed is doing: two hairlines (the countdown to the next fetch, a sweep
 * while one is on its way; how long the last one took to come back, with a red
 * tick where it usually lands, the recent average), signal
 * bars for how many of the last PING_HISTORY polls got through, and the values.
 */
function FeedMeter({ status }: { status: FeedStatus }) {
  const { nextPoll, fetching, latencyMs, avgLatencyMs, history, error } = status
  const ok = history.filter(Boolean).length
  const scale = (ms: number | null) => (ms === null ? null : Math.min(1, ms / SLOW_FETCH_MS))
  const latency = scale(latencyMs)
  const average = scale(avgLatencyMs)
  const strength = signalBars(ok, history.length)

  return (
    <div
      className={`feed-meter${error ? ' is-error' : ''}`}
      role="group"
      aria-label="Feed status"
      title={`Next fetch · last fetch time (red: the average) · of the last ${PING_HISTORY} polls, how many got through`}
    >
      <span className="meter-bars">
        <span className="meter-bar">
          {fetching ? (
            <i className="meter-sweep" />
          ) : (
            nextPoll && <i key={nextPoll.id} className="meter-countdown" style={{ animationDuration: `${nextPoll.delayMs}ms` }} />
          )}
        </span>
        <span className="meter-bar">
          {latency !== null && (
            <i
              className={`meter-fill${latency >= 1 ? ' is-bad' : latency >= 0.5 ? ' is-slow' : ''}`}
              style={{ transform: `scaleX(${latency})` }}
            />
          )}
          {average !== null && <b className="meter-average" style={{ left: `${average * 100}%` }} />}
        </span>
      </span>
      <span className={`meter-signal is-${strength}`} aria-label={`Signal ${strength} of 3`}>
        <i />
        <i />
        <i />
      </span>
      <span className="meter-values">
        {latencyMs === null ? '--' : formatLatency(latencyMs)} · {ok}/{history.length}
      </span>
    </div>
  )
}

/**
 * Signal strength, like a phone's, from the share of recent polls that got
 * through: 3 bars when (nearly) all did, 2 with a few failures, 1 when most
 * are failing. 0 until the first poll.
 */
function signalBars(ok: number, total: number) {
  if (total === 0) return 0
  const rate = ok / total
  return rate >= 0.9 ? 3 : rate >= 0.6 ? 2 : 1
}

/** "420ms", "1.4s". */
function formatLatency(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * The airport's local time with seconds, its time zone and the date. Ticks on its
 * own so the board doesn't re-render every second.
 */
function Clock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="board-clock" aria-label={`Local time at ${AIRPORT}`}>
      <div className="board-clock-label">Local time</div>
      <time className="board-clock-time">{formatLocalTime(now, { seconds: true })}</time>
      <div className="board-clock-label">
        {localZoneName(now)} · {formatLocalDate(now)}
      </div>
    </div>
  )
}
