import { useEffect, useState } from 'react'
import { aircraftSource, fetchAircraft } from './api'
import { FlightBoard, type BoardState } from '../board/flightBoard'
import { FEED, MOTION } from '../config/config'
import { AirportStats, type AirportStatsState } from '../tracking/airportStats'
import { FlightClassifier } from '../tracking/flights'
import { RouteCache } from './routes'
import type { GroundTracker } from '../tracking/groundTracker'
import type { Tracker } from '../tracking/tracker'

export interface FeedStatus {
  /** Airborne aircraft in range. */
  count: number
  updatedAt: Date | null
  error: string | null
  /** The next scheduled fetch: a unique id and how long until it runs, including any backoff after errors. */
  nextPoll: { id: number; delayMs: number } | null
  /** A request is on its way. */
  fetching: boolean
  /** Which network the aircraft came from (adsb.lol, or adsb.fi while adsb.lol is rate-limiting). */
  source: string
}

/** One step of getting the first aircraft on screen, for the startup screen. */
export interface BootStep {
  label: string
  /** How long it's expected to take, in ms (revised as it goes, e.g. after a failed fetch). */
  expectedMs: number
  /** performance.now() when it started and finished, or null if it hasn't. */
  startedAt: number | null
  finishedAt: number | null
}

export interface BootState {
  steps: BootStep[]
  /** Aircraft are on screen: the startup screen can go. */
  done: boolean
  /** The last fetch failed while starting up; it'll be retried. */
  error: string | null
}

export interface Feed {
  status: FeedStatus
  board: BoardState
  stats: AirportStatsState | null
  boot: BootState
}

/** First guesses at how long a fetch and the route lookup take, before either has been timed. */
const EXPECTED_FETCH_MS = 2500
const EXPECTED_ROUTES_MS = 1500

/**
 * Polls /api/aircraft every FEED.pollMs, looks up each flight's route, and feeds the
 * classified flights to the tracker (map) and the arrivals/departures board.
 */
export function useAircraftFeed(tracker: Tracker, ground: GroundTracker): Feed {
  const [feed, setFeed] = useState<Feed>({
    status: { count: 0, updatedAt: null, error: null, nextPoll: null, fetching: false, source: aircraftSource() },
    board: { arrivals: [], departures: [], landing: null, takeoff: null },
    stats: null,
    boot: { steps: [], done: false, error: null },
  })

  useEffect(() => {
    const controller = new AbortController()
    const routes = new RouteCache()
    const classifier = new FlightClassifier()
    const stats = new AirportStats()
    const board = new FlightBoard(stats)
    let timer: ReturnType<typeof setTimeout>
    let polls = 0

    // Startup: the first fetch and route lookup, then in the delayed view a second
    // fetch, since aircraft only appear once they've reported twice.
    const steps: BootStep[] = [
      { label: 'Fetching aircraft positions', expectedMs: EXPECTED_FETCH_MS, startedAt: null, finishedAt: null },
      { label: 'Looking up flight routes', expectedMs: EXPECTED_ROUTES_MS, startedAt: null, finishedAt: null },
    ]
    const reportsNeeded = MOTION.delayed ? (MOTION.delayedReports === 3 ? 3 : 2) : 1
    for (let n = 2; n <= reportsNeeded; n++) {
      steps.push({
        label: `Waiting for report ${n} of ${reportsNeeded} (delayed view)`,
        expectedMs: FEED.pollMs + EXPECTED_FETCH_MS + EXPECTED_ROUTES_MS,
        startedAt: null,
        finishedAt: null,
      })
    }
    /** Steps finished so far. */
    let booted = 0
    const bootState = (error: string | null): BootState => ({
      steps: steps.map((s) => ({ ...s })),
      done: booted >= steps.length,
      error,
    })
    const start = (i: number) => {
      if (i < steps.length && steps[i].startedAt === null) steps[i].startedAt = performance.now()
    }
    const finish = (i: number) => {
      start(i)
      steps[i].finishedAt = performance.now()
      booted = i + 1
      start(booted)
    }
    const showBoot = () => setFeed((f) => ({ ...f, boot: bootState(f.boot.error) }))

    // The wait starts once the poll has finished (or failed), so slow responses
    // never bunch requests together.
    const scheduleNext = () => {
      const delay = FEED.pollMs
      timer = setTimeout(poll, delay)
      return { id: ++polls, delayMs: delay }
    }

    const poll = async () => {
      // Until one poll has got all the way through (a retry after a failed one counts too).
      const firstPoll = booted < 2
      const pollStart = performance.now()
      setFeed((f) => ({ ...f, status: { ...f.status, fetching: true } }))
      try {
        if (firstPoll) {
          start(booted)
          showBoot()
        }
        const aircraft = await fetchAircraft(controller.signal)
        if (booted === 0) {
          finish(0)
          showBoot()
        }
        const routeMap = await routes.lookup(aircraft, controller.signal)
        const flights = classifier.classify(aircraft, routeMap)
        const now = performance.now()
        if (firstPoll) {
          // In the delayed view each further report lands one poll later, after another fetch and lookup like this one.
          for (const s of steps.slice(2)) s.expectedMs = FEED.pollMs + (now - pollStart)
          finish(1)
        } else if (booted < steps.length) {
          finish(booted)
        }
        // Each hands aircraft over to the other at takeoff and touchdown, so they carry on from where they were drawn.
        // Lifting off carries on from where the ground view draws it now (not last frame).
        ground.step(now)
        tracker.ingest(flights, now, (hex) => ground.handoff(hex))
        ground.ingest(flights, now, (hex) => tracker.handoff(hex))
        const count = flights.filter((f) => !f.onGround).length
        const nextPoll = scheduleNext()
        setFeed({
          status: { count, updatedAt: new Date(), error: null, nextPoll, fetching: false, source: aircraftSource() },
          board: board.update(flights, Date.now()),
          stats: stats.update(flights, Date.now()),
          boot: bootState(null),
        })
      } catch (err) {
        if (controller.signal.aborted) return
        // Keep the last snapshot on screen; the tracker keeps planes gliding meanwhile.
        const error = err instanceof Error ? err.message : String(err)
        const nextPoll = scheduleNext()
        // Still starting up: the step in progress now waits for the retry as well.
        const current = steps[booted]
        if (current) current.expectedMs += nextPoll.delayMs
        setFeed((f) => ({ ...f, status: { ...f.status, error, nextPoll, fetching: false }, boot: bootState(error) }))
      }
    }
    poll()

    return () => {
      controller.abort()
      clearTimeout(timer)
      stats.dispose()
    }
  }, [tracker, ground])

  return feed
}
