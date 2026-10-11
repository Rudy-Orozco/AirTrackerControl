import { useEffect, useState, type CSSProperties, type Ref } from 'react'
import { AIRPORT, AIRPORT_PRESET, BOARD, MAP, MAP3D, MOTION } from '../config/config'
import { FlapText } from './FlapText'
import type { BoardEvent, BoardRow, BoardState } from './flightBoard'
import { AtisStrip } from '../weather/AtisStrip'
import { MetarStrip } from '../weather/MetarStrip'
import { formatLocalDate, formatLocalTime, localZoneName } from './localTime'
import { useTick } from '../lib/useTick'
import { selectAircraft, useSelectedAircraft } from '../tracking/selection'
import type { FeedStatus } from '../feed/useAircraftFeed'
import { ErrorBoundary } from '../ui/ErrorBoundary'
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
 */
export function Board({ board, status, ref }: { board: BoardState; status: FeedStatus; ref?: Ref<HTMLElement> }) {
  const tick = useTick(() => BOARD.pageMs)

  return (
    <section className="board" ref={ref}>
      <div className="board-inner" style={boardStyle()}>
        <ErrorBoundary name="Weather (METAR)">
          <MetarStrip />
        </ErrorBoundary>
        <ErrorBoundary name="ATIS">
          <AtisStrip />
        </ErrorBoundary>
        <header className="board-top">
          <span className="board-airport">
            <b>{AIRPORT}</b>
            <small>
              {AIRPORT_PRESET.icao} / {AIRPORT_PRESET.name}
            </small>
          </span>
          <Clock />
        </header>

        <div className="board-panels">
          <Panel kind="arrivals" rows={board.arrivals} event={board.landing} tick={tick} />
          <Panel kind="departures" rows={board.departures} event={board.takeoff} tick={tick} />
        </div>

        <footer className="board-footer">
          <span className={`board-status${status.error ? ' is-error' : ''}`}>
            <PollTimer nextPoll={status.nextPoll} fetching={status.fetching} />
            {statusText(status)}
          </span>
          <span>{status.source} / adsb.im</span>
        </footer>
      </div>
    </section>
  )
}

/** Characters in the header announcement, e.g. "TAKEOFF AAL1588 AUS". */
const EVENT_CHARS = 19

function Panel({
  kind,
  rows,
  event,
  tick,
}: {
  kind: BoardKind
  rows: BoardRow[]
  event: BoardEvent | null
  tick: number
}) {
  const perPage = BOARD.rowsPerPage
  const pages = Math.max(1, Math.ceil(rows.length / perPage))
  const page = tick % pages
  const visible = rows.slice(page * perPage, (page + 1) * perPage)
  const isArrivals = kind === 'arrivals'
  const shownEvent = useUntilExpired(event)
  const selected = useSelectedAircraft()

  return (
    <div className={`panel panel--${kind}`}>
      <div className="panel-header">
        <h2>{isArrivals ? 'Arrivals' : 'Departures'}</h2>
        <span>{String(rows.length).padStart(2, '0')}</span>
        {/* Flips in when a flight lands / takes off, and flips back to blank after BOARD.eventMs. */}
        <FlapText
          text={shownEvent ? `${isArrivals ? 'Landed' : 'Takeoff'} ${shownEvent.flight} ${shownEvent.iata}` : ''}
          length={EVENT_CHARS}
          delay={0}
          className="panel-event"
        />
        <span className="panel-page">
          {page + 1}/{pages}
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
  return `${count} AIRBORNE / UPDATED ${formatTime(updatedAt.getTime())} ${localZoneName(updatedAt.getTime())}${MOTION.delayed ? ' / DELAYED VIEW' : ''}`
}

/** Flight and update times are the airport's local time. */
function formatTime(ms: number) {
  return formatLocalTime(ms)
}

/**
 * A ring that empties as the next data fetch approaches. Restarts (via its key)
 * each time a fetch is scheduled, including longer waits after errors. While a
 * request is on its way, it spins instead.
 */
function PollTimer({ nextPoll, fetching }: { nextPoll: FeedStatus['nextPoll']; fetching: boolean }) {
  if (fetching) {
    return (
      <svg className="poll-timer is-fetching" viewBox="0 0 20 20" aria-label="Fetching">
        <circle className="poll-timer-track" cx="10" cy="10" r="8" />
        <circle className="poll-timer-spin" cx="10" cy="10" r="8" pathLength={1} />
      </svg>
    )
  }
  if (nextPoll === null) return null
  return (
    <svg className="poll-timer" viewBox="0 0 20 20" key={nextPoll.id} aria-hidden>
      <circle className="poll-timer-track" cx="10" cy="10" r="8" />
      <circle
        className="poll-timer-ring"
        cx="10"
        cy="10"
        r="8"
        pathLength={1}
        style={{ animationDuration: `${nextPoll.delayMs}ms` }}
      />
    </svg>
  )
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
