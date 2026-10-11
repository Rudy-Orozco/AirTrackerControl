import type { Aircraft } from '../feed/api'
import { AIRPORT_PRESET, FEED, MOTION, trailSecondsFor } from '../config/config'
import { wasLanding, type Flight } from './flights'
import type { AirportLayout } from '../diorama/diorama'
import { RunwayAssist } from './runwayAssist'
import type { GroundTrack } from './groundTracker'

export interface LatLon {
  lat: number
  lon: number
}

export interface Track {
  info: Flight
  /** Where the current segment starts (the drawn position when the last fetch landed). */
  from: LatLon
  /** The drawn velocity when the segment started, so the curve continues smoothly from it. */
  fromVelocity: LatLon
  /** Where the plane should be when the next fetch lands, dead-reckoned from its report. */
  to: LatLon
  /** Reported velocity in degrees per millisecond; the segment ends moving at this. */
  velocity: LatLon
  segmentStart: number
  segmentMs: number
  /**
   * Flight time the curve covers, which sets how hard it bends. The same as
   * `segmentMs` when predicting; in the delayed view, the time between the two reports.
   */
  curveMs: number
  /** When the latest report's position was received (same clock as `now`). */
  reportedAt: number
  /**
   * Delayed view: the flight time (on the report clock) where the segment ends,
   * normally a report's. Later than that report's if the plane was drawn ahead of it.
   */
  toAt: number
  /** Delayed view: reports still ahead after the one the segment ends at, oldest first. */
  waypoints: Waypoint[]
  /**
   * Delayed view: how far behind live (ms) the plane is kept: as far as it was when
   * it appeared, or for a departure, as far as everything else. It plays a little
   * faster or slower until it's there.
   */
  baseDelayMs: number
  /** How fast the track is turning, in degrees per millisecond (positive = right), from the last two reports. */
  turnRate: number
  firstSeen: number
  lastSeen: number
  /** Set when the aircraft touches down; it then fades out. */
  landedAt: number | null
  /**
   * Altitude (feet) curves from `altFrom`, climbing at `altFromRate`, to `altTo`
   * over the segment, arriving at `altRate` (feet per ms), then carries on at
   * that, so the climb rate never jumps at an update.
   */
  altFrom: number | null
  altTo: number | null
  altFromRate: number
  altRate: number
  /** How fast the drawn altitude is changing (feet per ms), where the next segment's curve starts from. */
  altSpeed: number
  /** When it lifted off (carried on from the ground view), for the first minute's climb; null otherwise. */
  liftoffAt: number | null
  /** Just handed over from the ground view: the rest of its takeoff, played out (see takeoffProfile). */
  takeoff: TakeoffProfile | null

  /** Updated every frame by step(). */
  pos: LatLon
  vel: LatLon
  heading: number
  /** Smoothed altitude in feet, or null if unknown. */
  altitude: number | null
  /**
   * How fast the drawn plane is turning (degrees per ms, positive = right), eased
   * like a roll rate, so the 3D models bank into and out of turns.
   */
  turning: number
  /** How fast the drawn altitude is changing (feet per ms), eased, so the 3D models pitch smoothly. */
  climbing: number
  lastStep: number
  opacity: number
  trail: LatLon[]
  /** Altitude (feet, or null) at each trail point, for the 3D map. */
  trailAlt: (number | null)[]
  lastTrailAt: number
}

/**
 * Where an aircraft is drawn as it switches between the airborne and ground
 * trackers (takeoff or touchdown), so the other one carries on from there.
 */
export interface Handoff {
  pos: LatLon
  /** How it was moving there (degrees per ms), so the other tracker carries on at the same speed. */
  velocity: LatLon
  heading: number
  /** Feet above the field, and how fast that's changing (feet per ms; negative: descending). */
  heightFt: number
  climbRate: number
}

const TRAIL_SAMPLE_MS = 500

/** Index of the first trail sample within the last `seconds`, for views drawing a shorter trail than is kept. */
export function trailStart(t: Track, seconds: number) {
  return Math.max(0, t.trail.length - Math.floor((seconds * 1000) / TRAIL_SAMPLE_MS))
}
/** Time constant for easing the reported turn rate used to bank the 3D models (live view)... */
const TURN_SMOOTHING_MS = 2000
/** ...and the drawn curve's own turn rate (delayed view), about how long an airliner takes to roll into a turn. */
const ROLL_SMOOTHING_MS = 800
/** Time constant for easing the climb rate used to pitch the 3D models. */
const PITCH_SMOOTHING_MS = 1500
/** How much each new gap between fetches moves the running average (0 to 1). */
const GAP_SMOOTHING = 0.3
/** In the delayed view, reports closer together than this count as the same position. */
const MIN_REPORT_GAP_MS = 1000
/** A first report in the delayed view is kept through this many missed fetches while waiting for its second. */
const MAX_PENDING_MISSES = 1

/** A reported position for the delayed view to fly through. */
export interface Waypoint {
  pos: LatLon
  /** Reported velocity, degrees per ms. */
  velocity: LatLon
  /** When the position was reported (same clock as `now`). */
  at: number
  alt: number | null
  /** Feet per ms. */
  altRate: number
  /** Degrees per ms, from this report and the one before. */
  turnRate: number
}

/** An aircraft's first reports in the delayed view, waiting until there are enough to draw it. */
interface PendingReports {
  reports: { info: Flight; reportedAt: number }[]
  /** Fetches in a row it's been missing from; one miss is forgiven. */
  missed: number
}

/** How many reports the delayed view waits for (MOTION.delayedReports: 2 or 3). */
function reportsNeeded() {
  return MOTION.delayedReports === 3 ? 3 : 2
}

/**
 * Turns periodic position snapshots into continuous motion.
 *
 * Each fetch starts a new segment that curves from wherever the plane is drawn
 * to where its reported speed and track say it will be when the next fetch
 * lands. A turning plane (its track changed since the last report) is predicted
 * to keep turning at the same rate, so turns follow arcs rather than being
 * corrected back at every fetch. The curve (a cubic Hermite spline) starts at the plane's current
 * velocity and ends at its reported velocity, so position and direction never
 * jump: turns come out as smooth arcs instead of corners. Planes move from the
 * moment they appear and keep gliding along their heading if a fetch fails.
 *
 * In the delayed view (MOTION.delayed) nothing is predicted: an aircraft appears
 * once it has reported two or three times (MOTION.delayedReports), and flies
 * through its reports in turn at real speed, each segment curving from one to
 * the next. The map runs one or two fetches behind live, but follows the real
 * path; with three, one missed fetch still leaves a report to fly to.
 *
 * Only airborne aircraft are shown: one that lands rolls out and fades away, and
 * one that takes off fades in as it appears.
 */
export class Tracker {
  readonly tracks = new Map<string, Track>()
  private lastIngest: number | null = null
  private segmentMs = FEED.pollMs
  /** Running average of the time between updates, however long (for how long to keep missing aircraft). */
  private gapMs = FEED.pollMs
  private pending = new Map<string, PendingReports>()
  /** Lines arrivals and departures up with the runways near the ground, once the airport's layout is known. */
  private assist: RunwayAssist | null = null
  private delayed = MOTION.delayed
  private reportsNeeded = reportsNeeded()

  /**
   * `handoff` gives where a just-departed aircraft was drawn on the ground, so
   * it lifts off from there instead of appearing from nowhere.
   */
  ingest(flights: Flight[], now: number, handoff: (hex: string) => Handoff | null = () => null) {
    // Bring every plane up to now first: each new segment starts from where it's drawn
    // now, not where it was last frame, or it would stall for a frame at each update.
    this.step(now)
    // Match the segment length to the gap between fetches (pollMs plus however
    // long the request takes) so planes arrive just as the next update lands.
    // Averaging keeps one slow request from stretching or squashing the next segment.
    if (this.lastIngest !== null) {
      const gap = clamp(now - this.lastIngest, FEED.pollMs, FEED.pollMs * 2)
      this.segmentMs += (gap - this.segmentMs) * GAP_SMOOTHING
      this.gapMs += (now - this.lastIngest - this.gapMs) * GAP_SMOOTHING
    }
    this.lastIngest = now
    const segmentMs = this.segmentMs

    // Switching between live and delayed would send every plane back in time
    // (or jump it ahead), so start over and let them fade back in.
    if (MOTION.delayed !== this.delayed || reportsNeeded() !== this.reportsNeeded) {
      this.delayed = MOTION.delayed
      this.reportsNeeded = reportsNeeded()
      this.tracks.clear()
      this.pending.clear()
    }
    if (this.delayed) this.ingestDelayed(flights, now, segmentMs, handoff)
    else this.ingestLive(flights, now, segmentMs, handoff)
  }

  private ingestLive(flights: Flight[], now: number, segmentMs: number, handoff: (hex: string) => Handoff | null) {
    const reported = new Set(flights.map((f) => f.hex))
    for (const t of this.tracks.values()) {
      // Low aircraft usually drop out of coverage at touchdown, before reporting "ground".
      if (!reported.has(t.info.hex) && t.landedAt === null && wasLanding(t.info)) t.landedAt = now
    }

    for (const a of flights) {
      const existing = this.tracks.get(a.hex)
      if (a.onGround) {
        if (existing && existing.landedAt === null) existing.landedAt = now
        continue
      }

      const ageMs = a.positionAge * 1000
      const reportedAt = now - ageMs
      const turnRate = existing ? turnRateOf(existing, a, reportedAt) : 0
      // Reported positions are already `positionAge` seconds old; aim for where
      // the plane will be at the end of this segment. If it's drawn further along
      // than that (it was predicted on past a turn, or it's slowing), aim ahead of
      // it anyway so it eases off rather than turning back.
      const lead = existing ? leadOf(existing.pos, a) : null
      const target = predict(a, turnRate, Math.max(ageMs + segmentMs, (lead ?? -Infinity) + segmentMs * MIN_AHEAD))
      // Altitude is extrapolated along the vertical rate the same way. When it isn't sent,
      // estimate it from the climb or descent since the last report.
      const altRate = a.verticalRate !== null ? a.verticalRate / 60_000 : estimatedAltRate(existing, a, reportedAt)
      const altNow = a.altitude === null ? null : a.altitude + altRate * ageMs
      const altTo = altNow === null ? null : altNow + altRate * segmentMs

      if (!existing) {
        const takeoff = handoff(a.hex)
        const pos = takeoff?.pos ?? predict(a, turnRate, ageMs).pos
        // Its takeoff played out (see playTakeoff), its altitudes are just its reports': that
        // makes up the climb from the runway to them itself. Otherwise they climb from the runway.
        const played = takeoff !== null && MOTION.runwayAssist
        const altFrom = takeoff && !played ? AIRPORT_PRESET.elevationFt + takeoff.heightFt : altNow
        this.tracks.set(a.hex, {
          info: a,
          from: pos,
          fromVelocity: takeoff?.velocity ?? target.velocity,
          to: target.pos,
          velocity: target.velocity,
          segmentStart: now,
          segmentMs,
          curveMs: segmentMs,
          toAt: reportedAt,
          waypoints: [],
          baseDelayMs: 0,
          reportedAt,
          turnRate,
          // Already on screen on the ground, so no fade-in.
          firstSeen: takeoff ? now - MOTION.fadeInMs : now,
          lastSeen: now,
          landedAt: null,
          altFrom,
          altTo: takeoff && !played ? climbingAway(altTo, now, now + segmentMs) : altTo,
          // Lifting off, the climb builds up from level, like a rotation, toward a typical
          // initial climb if no climb rate is sent (there's no earlier altitude to tell it from).
          altFromRate: takeoff && !played ? 0 : altRate,
          altRate: takeoff && a.verticalRate === null ? LIFTOFF_CLIMB_FPM / 60_000 : altRate,
          altSpeed: takeoff && !played ? 0 : altRate,
          liftoffAt: takeoff ? now : null,
          takeoff: played ? takeoffProfile(a, takeoff.pos, now, this.assist?.liftoffPoint(takeoff.pos, takeoff.heading)) : null,
          pos,
          vel: target.velocity,
          heading: takeoff?.heading ?? a.track ?? 0,
          altitude: takeoff ? AIRPORT_PRESET.elevationFt + takeoff.heightFt : altNow,
          turning: 0,
          climbing: altRate,
          lastStep: now,
          opacity: 0,
          trail: [],
          trailAlt: [],
          lastTrailAt: now,
        })
        continue
      }

      existing.info = a
      existing.from = existing.pos
      existing.fromVelocity = existing.vel
      existing.to = target.pos
      existing.velocity = target.velocity
      existing.reportedAt = reportedAt
      existing.turnRate = turnRate
      existing.segmentStart = now
      existing.segmentMs = segmentMs
      existing.curveMs = segmentMs
      existing.altFrom = existing.takeoff?.reportedAlt ?? existing.altitude ?? altNow
      existing.altFromRate = existing.takeoff ? existing.takeoff.reportedRate : existing.altSpeed
      existing.altTo = existing.liftoffAt === null || existing.takeoff ? altTo : climbingAway(altTo, existing.liftoffAt, now + segmentMs)
      existing.altRate = altRate
      existing.lastSeen = now
      // Touchdown reports can flicker; an airborne report means it's still flying.
      existing.landedAt = null
    }
  }

  private ingestDelayed(flights: Flight[], now: number, segmentMs: number, handoff: (hex: string) => Handoff | null) {
    const reported = new Set(flights.map((f) => f.hex))
    for (const t of this.tracks.values()) {
      if (!reported.has(t.info.hex) && t.landedAt === null && wasLanding(t.info)) t.landedAt = now
    }
    for (const [hex, p] of this.pending) {
      if (reported.has(hex)) p.missed = 0
      else if (++p.missed > MAX_PENDING_MISSES) this.pending.delete(hex)
    }

    for (const a of flights) {
      const existing = this.tracks.get(a.hex)
      if (a.onGround) {
        if (existing && existing.landedAt === null) existing.landedAt = now
        this.pending.delete(a.hex)
        continue
      }

      const reportedAt = now - a.positionAge * 1000

      if (!existing) {
        const takeoff = handoff(a.hex)
        if (takeoff) {
          // Lifting off: carry on from where the ground view drew it to this first report.
          this.pending.delete(a.hex)
          const wp = waypointOf(a, reportedAt, 0)
          // Its takeoff played out (see playTakeoff), its altitudes are just its reports' (back
          // along their climb to the start of the segment): that makes up the climb from the
          // runway to them itself. Otherwise they climb from the runway.
          const altFrom = !MOTION.runwayAssist ? AIRPORT_PRESET.elevationFt + takeoff.heightFt : wp.alt === null ? null : wp.alt - wp.altRate * segmentMs
          const t = newTrack(a, reportedAt, now, takeoff.pos, wp.velocity, reportedAt - segmentMs, altFrom, takeoff.heading)
          t.liftoffAt = now
          if (MOTION.runwayAssist) t.takeoff = takeoffProfile(a, takeoff.pos, now, this.assist?.liftoffPoint(takeoff.pos, takeoff.heading))
          // Drawn where the ground view left it until its takeoff plays out.
          t.altitude = AIRPORT_PRESET.elevationFt + takeoff.heightFt
          t.firstSeen = now - MOTION.fadeInMs
          // The ground view runs about one fetch behind, but everything else in the air runs
          // a fetch behind for each report it waited for after its first. Ease back to match,
          // and the reports ahead build up to the same number as theirs.
          // (Theirs also includes how old their first report already was, so this does too.)
          t.baseDelayMs = (this.reportsNeeded - 1) * segmentMs + (now - reportedAt)
          startSegment(t, now, takeoff.pos, takeoff.velocity, reportedAt - segmentMs, altFrom, [wp])
          this.tracks.set(a.hex, t)
          continue
        }
        const pending = this.pending.get(a.hex) ?? { reports: [], missed: 0 }
        const last = pending.reports.at(-1)
        if (!last || reportedAt - last.reportedAt >= MIN_REPORT_GAP_MS) pending.reports.push({ info: a, reportedAt })
        if (pending.reports.length < this.reportsNeeded) {
          // Not a path yet: wait for more reports.
          this.pending.set(a.hex, pending)
          continue
        }
        this.pending.delete(a.hex)
        // Start at the first report and fly through the rest; the view runs that far behind.
        const [first, ...rest] = pending.reports
        const waypoints: Waypoint[] = []
        let prev = { info: first.info, reportedAt: first.reportedAt, turnRate: 0 }
        for (const r of rest) {
          const turnRate = turnRateOf(prev, r.info, r.reportedAt)
          waypoints.push(waypointOf(r.info, r.reportedAt, turnRate))
          prev = { ...r, turnRate }
        }
        const start = waypointOf(first.info, first.reportedAt, 0)
        const t = newTrack(a, reportedAt, now, start.pos, start.velocity, start.at, start.alt, first.info.track ?? 0)
        startSegment(t, now, start.pos, start.velocity, start.at, start.alt, waypoints)
        this.tracks.set(a.hex, t)
        continue
      }

      existing.lastSeen = now
      existing.landedAt = null
      // No fresh position since the last fetch: carry on through the reports already queued.
      if (reportedAt - existing.reportedAt < MIN_REPORT_GAP_MS) {
        existing.info = a
        continue
      }
      const latestTurn = existing.waypoints.at(-1)?.turnRate ?? existing.turnRate
      const wp = waypointOf(a, reportedAt, turnRateOf({ ...existing, turnRate: latestTurn }, a, reportedAt))
      existing.info = a
      existing.reportedAt = reportedAt
      if (now - existing.segmentStart < existing.segmentMs) {
        // Still on its way to an earlier report: this one waits its turn.
        existing.waypoints.push(wp)
      } else {
        // It ran out of reports and has been carrying on along its last arc: curve from
        // wherever that got it to this report.
        startSegment(existing, now, existing.pos, existing.vel, drawnFlightTime(existing, now), existing.altitude, [wp])
      }
    }
  }

  /** The landing or takeoff path the runway assist is guiding `t` along, if any (for drawing). */
  assistPath(t: Track) {
    return this.assist?.path(t) ?? null
  }

  /** The runways in use now or within the last `holdMs`, by name (see RunwayAssist.runwaysInUse); none without the runway assist. */
  runwaysInUse(now: number, holdMs: number) {
    return this.assist && MOTION.runwayAssist ? this.assist.runwaysInUse(now, holdMs) : { landing: [], departing: [] }
  }

  /** What the runway assist guides aircraft along on the runways in use (see RunwayAssist.guides), for drawing. */
  runwayGuides(now: number) {
    return this.assist?.guides(now) ?? []
  }

  /**
   * The takeoff path of an aircraft still on the ground (the ground view's), if
   * it's lined up on a runway or rolling down one; not for arrivals rolling out.
   */
  groundAssistPath(g: GroundTrack) {
    if (g.info.kind === 'arrival' || !MOTION.runwayAssist) return null
    return this.assist?.groundPath(g.pos, g.heading) ?? null
  }

  /** The airport's layout, so approaches and climb-outs can follow its runways (see runwayAssist.ts). */
  setLayout(layout: AirportLayout) {
    this.assist = new RunwayAssist(layout)
  }

  /** Advance every track to `now`. Call once per animation frame. */
  step(now: number) {
    this.assist?.prune((t) => this.tracks.get(t.info.hex) === t)
    for (const [hex, t] of this.tracks) {
      const overdue = overdueFor(now, t.lastSeen, this.lastIngest, this.gapMs, MOTION.staleMs)
      const landedFor = t.landedAt === null ? 0 : now - t.landedAt
      if (overdue > MOTION.fadeOutMs || landedFor > MOTION.landingFadeMs) {
        this.tracks.delete(hex)
        continue
      }

      // Delayed view: reached the end of this segment, so curve on to the next report queued.
      while (now - t.segmentStart >= t.segmentMs && t.waypoints.length > 0) {
        startSegment(t, t.segmentStart + t.segmentMs, t.to, t.velocity, t.toAt, t.altTo, t.waypoints)
      }

      const elapsed = now - t.segmentStart
      // How fast the drawn path is turning (degrees per ms), for banking.
      let curveTurn = t.turnRate
      if (elapsed < t.segmentMs) {
        // Played back over `segmentMs`, but shaped by the flight time it covers (`curveMs`),
        // so `vel` stays the plane's real velocity along it.
        const u = elapsed / t.segmentMs
        t.pos = {
          lat: hermite(t.from.lat, t.fromVelocity.lat, t.to.lat, t.velocity.lat, t.curveMs, u),
          lon: hermite(t.from.lon, t.fromVelocity.lon, t.to.lon, t.velocity.lon, t.curveMs, u),
        }
        t.vel = {
          lat: hermiteSlope(t.from.lat, t.fromVelocity.lat, t.to.lat, t.velocity.lat, t.curveMs, u),
          lon: hermiteSlope(t.from.lon, t.fromVelocity.lon, t.to.lon, t.velocity.lon, t.curveMs, u),
        }
        const accel = {
          lat: hermiteCurve(t.from.lat, t.fromVelocity.lat, t.to.lat, t.velocity.lat, t.curveMs, u),
          lon: hermiteCurve(t.from.lon, t.fromVelocity.lon, t.to.lon, t.velocity.lon, t.curveMs, u),
        }
        curveTurn = turnRateAlong(t.vel, accel, t.pos.lat) ?? t.turnRate
      } else {
        // The next fetch is late: keep flying at the last known speed, still turning at the last known rate.
        const next = carryOn(t, elapsed - t.segmentMs)
        t.pos = next.pos
        t.vel = next.velocity
      }
      if (t.altTo === null || t.altFrom === null) {
        t.altitude = t.altTo
        t.altSpeed = 0
      } else if (elapsed < t.segmentMs) {
        const u = elapsed / t.segmentMs
        // Climb rates kept to what the altitudes do, so it never bumps up or down between them.
        const [fromRate, toRate] = monotoneRates(t.altFrom, t.altFromRate, t.altTo, t.altRate, t.segmentMs)
        t.altitude = hermite(t.altFrom, fromRate, t.altTo, toRate, t.segmentMs, u)
        t.altSpeed = hermiteSlope(t.altFrom, fromRate, t.altTo, toRate, t.segmentMs, u)
      } else {
        // Carrying on at the rate the curve ended on.
        const [, toRate] = monotoneRates(t.altFrom, t.altFromRate, t.altTo, t.altRate, t.segmentMs)
        t.altitude = t.altTo + toRate * (elapsed - t.segmentMs)
        t.altSpeed = toRate
      }
      // Taking off: rolling until the liftoff point, then climbing away, easing into the reports.
      // (Part of the runway assist: turned off, it carries on as reported.)
      if (t.takeoff && !MOTION.runwayAssist) t.takeoff = null
      if (t.takeoff) playTakeoff(t, now)
      // Just lifted off, never back down onto the runway (a curve can dip before it climbs).
      if (t.liftoffAt !== null && t.altitude !== null) t.altitude = Math.max(t.altitude, AIRPORT_PRESET.elevationFt)
      if (t.liftoffAt !== null && now - t.liftoffAt > LIFTOFF_MS) t.liftoffAt = null

      // Point the arrow along the curve; keep the last heading if the speed is unknown.
      t.heading = headingOf(t.vel, t.pos.lat) ?? t.info.track ?? t.heading
      // Live, the curve gets corrected at every fetch and its turning wobbles at the joins,
      // so bank to the reported turn rate, eased so it rolls in and out. Delayed, the curve
      // follows the real path, so bank to how it actually turns, eased like a roll.
      const dt = now - t.lastStep
      if (dt > 0) {
        const [turnTarget, turnMs] = MOTION.delayed ? [curveTurn, ROLL_SMOOTHING_MS] : [t.turnRate, TURN_SMOOTHING_MS]
        t.turning += (turnTarget - t.turning) * (1 - Math.exp(-dt / turnMs))
        // Pitch follows the drawn climb, eased.
        t.climbing += (t.altSpeed - t.climbing) * (1 - Math.exp(-dt / PITCH_SMOOTHING_MS))
      }
      t.lastStep = now
      // Near the runways, onto the approach or climb-out it's flying (before the trail records it).
      this.assist?.apply(t, Math.max(dt, 0), MOTION.runwayAssist)

      const fadeIn = Math.min((now - t.firstSeen) / MOTION.fadeInMs, 1)
      const fadeOut = 1 - clamp(overdue / MOTION.fadeOutMs, 0, 1)
      const landingFade = 1 - landedFor / MOTION.landingFadeMs
      t.opacity = Math.min(fadeIn, fadeOut, landingFade)

      if (now - t.lastTrailAt >= TRAIL_SAMPLE_MS) {
        t.trail.push(t.pos)
        t.trailAlt.push(t.altitude)
        while (t.trail.length > (trailSecondsFor(t.info.kind) * 1000) / TRAIL_SAMPLE_MS) {
          t.trail.shift()
          t.trailAlt.shift()
        }
        t.lastTrailAt = now
      }
    }
  }

  /** Where a just-landed aircraft was drawn, for the ground tracker to carry on from. */
  handoff(hex: string): Handoff | null {
    const t = this.tracks.get(hex)
    if (!t) return null
    const heightFt = t.altitude === null ? 0 : Math.max(t.altitude - AIRPORT_PRESET.elevationFt, 0)
    return { pos: t.pos, velocity: t.vel, heading: t.heading, heightFt, climbRate: t.altSpeed }
  }
}

/**
 * How long (ms) past being hidden an aircraft last seen at `lastSeen` is: negative
 * while it should still be shown, then it fades out. One missing from the latest
 * update (`lastIngest`) is hidden `keepFor` after it was last seen, or longer if
 * updates are coming slowly (`gapMs` apart on average), so one slow or missed
 * update doesn't hide it. One still in the latest update is only hidden if the
 * feed goes quiet for MOTION.feedDownMs, however slow the next update is.
 */
export function overdueFor(now: number, lastSeen: number, lastIngest: number | null, gapMs: number, keepFor: number): number {
  const inLatest = lastIngest !== null && lastSeen >= lastIngest
  if (inLatest) return now - lastSeen - Math.max(MOTION.feedDownMs, keepFor)
  return now - lastSeen - Math.max(keepFor, MOTION.staleUpdates * gapMs)
}

/**
 * The rest of `t`'s current segment as of its last step: points (with altitudes)
 * along the curve from where it's drawn to where the segment ends, then in the
 * delayed view on through the reports still queued. `marks` are those segment
 * ends: the reports ahead (with `markAlts`). Empty once the segment is over (the next fetch is late).
 */
export function predictedPath(
  t: Track,
  steps = 16,
): { points: LatLon[]; alts: (number | null)[]; marks: LatLon[]; markAlts: (number | null)[] } {
  const start = (t.lastStep - t.segmentStart) / t.segmentMs
  if (!(start < 1)) return { points: [], alts: [], marks: [], markAlts: [] }
  const points: LatLon[] = []
  const alts: (number | null)[] = []
  for (let i = 0; i <= steps; i++) {
    const u = start + ((1 - start) * i) / steps
    points.push({
      lat: hermite(t.from.lat, t.fromVelocity.lat, t.to.lat, t.velocity.lat, t.curveMs, u),
      lon: hermite(t.from.lon, t.fromVelocity.lon, t.to.lon, t.velocity.lon, t.curveMs, u),
    })
    alts.push(t.altFrom === null || t.altTo === null ? t.altTo : t.altFrom + (t.altTo - t.altFrom) * u)
  }
  const marks = [t.to]
  const markAlts = [t.altTo]
  let prev = { pos: t.to, velocity: t.velocity, at: t.toAt, alt: t.altTo }
  for (const wp of t.waypoints) {
    const ms = Math.max(wp.at - prev.at, MIN_REPORT_GAP_MS)
    for (let i = 1; i <= steps; i++) {
      const u = i / steps
      points.push({
        lat: hermite(prev.pos.lat, prev.velocity.lat, wp.pos.lat, wp.velocity.lat, ms, u),
        lon: hermite(prev.pos.lon, prev.velocity.lon, wp.pos.lon, wp.velocity.lon, ms, u),
      })
      alts.push(prev.alt === null || wp.alt === null ? wp.alt : prev.alt + (wp.alt - prev.alt) * u)
    }
    marks.push(wp.pos)
    markAlts.push(wp.alt)
    prev = wp
  }
  return { points, alts, marks, markAlts }
}

/**
 * In the delayed view, where `t` has probably got to since its latest report
 * (as of its last step), carrying on at its reported speed and turn rate:
 * `steps + 1` points from the latest report to that estimate. Empty when live,
 * where the plane is already drawn there.
 */
export function estimatedPath(t: Track, steps = 16): { points: LatLon[]; alts: (number | null)[] } {
  // From the latest report: the last one queued, or the one this segment ends at.
  const latest = t.waypoints.at(-1) ?? { pos: t.to, velocity: t.velocity, at: t.toAt, alt: t.altTo, altRate: t.altRate, turnRate: t.turnRate }
  const sinceReport = t.lastStep - latest.at
  if (!MOTION.delayed || !(sinceReport > 0)) return { points: [], alts: [] }
  const points: LatLon[] = []
  const alts: (number | null)[] = []
  // The same arc the plane itself flies if it runs out of reports, so the two line up.
  for (let i = 0; i <= steps; i++) {
    const ms = (sinceReport * i) / steps
    points.push(flyOn(latest.pos, latest.velocity, latest.turnRate, ms).pos)
    alts.push(latest.alt === null ? null : latest.alt + latest.altRate * ms)
  }
  return { points, alts }
}

const NM_PER_DEG_LAT = 60
const MS_PER_HOUR = 3_600_000
/** Twice a standard-rate turn (3°/s); anything faster is treated as a bad track report. */
const MAX_TURN_RATE = 6 / 1000
/**
 * Each segment ends at least this fraction of its length ahead of where the plane
 * is drawn. Any closer and the curve, which starts at full speed, would overshoot
 * the end and come back to it.
 */
const MIN_AHEAD = 0.5
/** Delayed view: a plane that's behind or ahead of where it should be plays up to this much faster or slower (0.15 = 15%) until it's there. */
const MAX_CATCH_UP = 0.15
/** Reports closer together than this give too noisy a turn rate. */
const MIN_TURN_SAMPLE_MS = 2000

/**
 * Degrees per millisecond the track turned between the track's previous report
 * and `a`. Keeps the previous rate if no fresh position arrived in between.
 */
function turnRateOf(t: Pick<Track, 'info' | 'reportedAt' | 'turnRate'>, a: Aircraft, reportedAt: number): number {
  const elapsed = reportedAt - t.reportedAt
  if (elapsed < MIN_TURN_SAMPLE_MS) return t.turnRate
  if (a.track === null || t.info.track === null) return 0
  const turned = ((a.track - t.info.track + 540) % 360) - 180
  const rate = turned / elapsed
  return Math.abs(rate) > MAX_TURN_RATE ? 0 : rate
}

/**
 * Where `a` will be `ms` after its report, and its velocity there, if it keeps
 * its ground speed and turns at `turnRate` (degrees per millisecond).
 */
function predict(a: Aircraft, turnRate: number, ms: number): { pos: LatLon; velocity: LatLon } {
  const pos = { lat: a.lat, lon: a.lon }
  if (a.groundSpeed === null || a.track === null) return { pos, velocity: { lat: 0, lon: 0 } }
  return fly(pos, a.groundSpeed / MS_PER_HOUR, a.track, turnRate, ms)
}

/** Where `t` is `ms` after reaching the end of its segment, carrying on at its end velocity and turn rate. */
function carryOn(t: Track, ms: number): { pos: LatLon; velocity: LatLon } {
  return flyOn(t.to, t.velocity, t.turnRate, ms)
}

/** Where a plane at `p` moving at `velocity` (degrees per ms) and turning at `turnRate` will be after `ms`. */
function flyOn(p: LatLon, velocity: LatLon, turnRate: number, ms: number): { pos: LatLon; velocity: LatLon } {
  const track = headingOf(velocity, p.lat)
  if (track === null) return { pos: p, velocity }
  const nmPerMs = Math.hypot(velocity.lat, velocity.lon * Math.cos((p.lat * Math.PI) / 180)) * NM_PER_DEG_LAT
  return fly(p, nmPerMs, track, turnRate, ms)
}

/**
 * Where a plane at `p`, moving at `nmPerMs` along `track` (degrees) and turning
 * at `turnRate` (degrees per ms), will be after `ms`, and its velocity there.
 */
function fly(p: LatLon, nmPerMs: number, track: number, turnRate: number, ms: number): { pos: LatLon; velocity: LatLon } {
  const start = (track * Math.PI) / 180
  const end = ((track + turnRate * ms) * Math.PI) / 180
  const turnedRad = end - start
  // Distance covered north and east: along an arc, or straight if barely turning.
  const [north, east] =
    Math.abs(turnedRad) < 1e-6
      ? [nmPerMs * ms * Math.cos(start), nmPerMs * ms * Math.sin(start)]
      : [
          ((nmPerMs * ms) / turnedRad) * (Math.sin(end) - Math.sin(start)),
          ((nmPerMs * ms) / turnedRad) * (Math.cos(start) - Math.cos(end)),
        ]
  const lonScale = NM_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180)
  return {
    pos: { lat: p.lat + north / NM_PER_DEG_LAT, lon: p.lon + east / lonScale },
    velocity: { lat: (nmPerMs * Math.cos(end)) / NM_PER_DEG_LAT, lon: (nmPerMs * Math.sin(end)) / lonScale },
  }
}

/**
 * The flight time (on the report clock) of where `t` is drawn at `now`: partway
 * along its curve to its last report, or past that report if the fetch is late.
 */
function drawnFlightTime(t: Track, now: number): number {
  const elapsed = now - t.segmentStart
  if (elapsed >= t.segmentMs) return t.toAt + (elapsed - t.segmentMs)
  return t.toAt - (1 - elapsed / t.segmentMs) * t.curveMs
}

/**
 * How far (in flight time, ms) `pos` is ahead of `a`'s reported position along
 * its reported track; negative if behind. Null if it isn't moving or has no track.
 */
function leadOf(pos: LatLon, a: Aircraft): number | null {
  if (a.groundSpeed === null || a.track === null) return null
  return leadPast(pos, { lat: a.lat, lon: a.lon }, predict(a, 0, 0).velocity)
}

/** The same for a point `at` moving at `velocity` (degrees per ms). Null if it's barely moving. */
function leadPast(pos: LatLon, at: LatLon, velocity: LatLon): number | null {
  const cos = Math.cos((at.lat * Math.PI) / 180)
  const [vn, ve] = [velocity.lat, velocity.lon * cos]
  const speed2 = vn * vn + ve * ve
  // Below about 30 knots the direction of travel means little.
  if (speed2 < (30 / MS_PER_HOUR / NM_PER_DEG_LAT) ** 2) return null
  return ((pos.lat - at.lat) * vn + (pos.lon - at.lon) * cos * ve) / speed2
}

/** A report as a waypoint for the delayed view. */
function waypointOf(a: Aircraft, reportedAt: number, turnRate: number): Waypoint {
  const { pos, velocity } = predict(a, 0, 0)
  return { pos, velocity, at: reportedAt, alt: a.altitude, altRate: (a.verticalRate ?? 0) / 60_000, turnRate }
}

/**
 * Delayed view: starts `t`'s next segment at `now`, from a plane at `from`
 * (moving at `fromVelocity`, at flight time `fromAt`, altitude `fromAlt`) to the
 * first of `queue`, which it takes from the queue; the rest stay queued. Flown at
 * real speed, so the view stays the same time behind. Reports the plane is
 * already level with or past are skipped, and if that leaves none, it aims a
 * little past the last one, so it never turns back.
 */
function startSegment(t: Track, now: number, from: LatLon, fromVelocity: LatLon, fromAt: number, fromAlt: number | null, queue: Waypoint[]) {
  let wp = queue.shift()!
  let curveMs = segmentTime(from, fromVelocity, fromAt, wp)
  let lead = leadPast(from, wp.pos, wp.velocity)
  while (lead !== null && -lead < curveMs * MIN_AHEAD && queue.length > 0) {
    wp = queue.shift()!
    curveMs = segmentTime(from, fromVelocity, fromAt, wp)
    lead = leadPast(from, wp.pos, wp.velocity)
  }
  const offsetMs = lead !== null && -lead < curveMs * MIN_AHEAD ? lead + curveMs : 0
  const end = offsetMs > 0 ? flyOn(wp.pos, wp.velocity, wp.turnRate, offsetMs) : wp
  t.waypoints = queue
  t.from = from
  t.fromVelocity = fromVelocity
  t.to = end.pos
  t.velocity = end.velocity
  t.toAt = wp.at + offsetMs
  t.turnRate = wp.turnRate
  t.curveMs = curveMs
  t.segmentStart = now
  // Further behind than it should be (a segment had to be stretched, or reports ran
  // out)? Play this one a little faster, unnoticeably, to catch up. Not far enough
  // behind (a departure, just handed over from the ground view)? A little slower.
  const behindMs = now - fromAt - t.baseDelayMs
  t.segmentMs = curveMs / (1 + clamp(behindMs / curveMs, -MAX_CATCH_UP, MAX_CATCH_UP))
  t.altFrom = fromAlt ?? wp.alt
  t.altFromRate = t.takeoff ? t.takeoff.reportedRate : t.altSpeed
  const altTo = wp.alt === null ? null : wp.alt + wp.altRate * offsetMs
  t.altTo = t.liftoffAt === null || t.takeoff ? altTo : climbingAway(altTo, t.liftoffAt, now + t.segmentMs)
  t.altRate = wp.altRate
}

/**
 * The rest of a takeoff, from the moment the ground view hands an aircraft over
 * (at its first airborne report): it keeps rolling down the runway to its
 * liftoff point, two-thirds of the way down (whatever height the reports
 * already give), then climbs away following its reports, but as far below
 * them as they were above the runway when it lifted off: a gap that closes
 * gently, then more quickly, the further it flies, until a few kilometers on
 * it's on them. The reports are often well above where it's drawn (the ground
 * view runs behind, or it's handed over early, already high), so it doesn't
 * leap up to meet them. Off a runway the layout
 * doesn't show, the liftoff point is worked back from the first report along
 * its track at its climb gradient.
 */
export interface TakeoffProfile {
  /** Where it leaves the runway, and the direction it rolls and climbs (unit, meters east and north). */
  liftoff: LatLon
  east: number
  north: number
  /**
   * Climbing: how far (feet) its reports were above the runway when it lifted
   * off, and how far (meters, whichever way) it's flown since, as of `lastPos`,
   * where it was drawn last frame.
   */
  gap: number
  flown: number
  lastPos: LatLon
  /** When the handover happened, and when it left the runway (null while still rolling). */
  start: number
  liftedAt: number | null
  /**
   * The altitude (feet) and climb rate (feet per ms) the reports put it at,
   * before blending with the takeoff: each update's curve carries on from these,
   * so an update can't disturb the blend.
   */
  reportedAlt: number | null
  reportedRate: number
}

function takeoffProfile(a: Aircraft, from: LatLon, now: number, runwayLiftoff: LatLon | null = null): TakeoffProfile {
  const rad = ((a.track ?? 0) * Math.PI) / 180
  const [east, north] = [Math.sin(rad), Math.cos(rad)]
  const height = a.altitude === null ? 0 : Math.max(a.altitude - AIRPORT_PRESET.elevationFt, 0)
  // Back along its track from where it was reported, to where it was at the runway.
  const backM = height / climbGradientOf(a)
  let liftoff = runwayLiftoff ?? offset({ lat: a.lat, lon: a.lon }, east * -backM, north * -backM)
  // Already drawn past that (it was running behind): lift off now.
  if (alongMeters(from, liftoff, east, north) < 0) liftoff = from
  return {
    liftoff,
    east,
    north,
    gap: 0,
    flown: 0,
    lastPos: from,
    start: now,
    liftedAt: null,
    reportedAlt: a.altitude,
    reportedRate: (a.verticalRate ?? 0) / 60_000,
  }
}

/**
 * Holds a taking-off aircraft on the runway until its liftoff point, then
 * climbs it away below its reports by the height they were already at, closing
 * that gap the further it flies, then hands it back to them.
 */
function playTakeoff(t: Track, now: number) {
  const p = t.takeoff!
  const field = AIRPORT_PRESET.elevationFt
  const reported = t.altitude
  const reportedRate = t.altSpeed
  p.reportedAlt = reported
  p.reportedRate = reportedRate
  if (p.liftedAt === null) {
    if (alongMeters(p.liftoff, t.pos, p.east, p.north) < 0 && now - p.start < MAX_ROLL_MS) {
      // Still rolling: on the runway, level.
      t.altitude = field
      t.altSpeed = 0
      p.lastPos = t.pos
      return
    }
    p.liftedAt = now
    // The first minute's climb (see climbingAway) counts from here, where it really left the runway.
    t.liftoffAt = now
    p.lastPos = t.pos
    p.gap = reported === null ? 0 : Math.max(reported - field, 0)
  }
  // However far it's flown, whichever way: turning straight after takeoff, it keeps closing the gap.
  p.flown += metersBetween(p.lastPos, t.pos)
  p.lastPos = t.pos
  const u = Math.min(p.flown / DRAG_M, 1)
  if (u >= 1 || reported === null) {
    // On its reports: they take over from here (without climbingAway's floor, which
    // could lift it back off them).
    if (u >= 1) {
      t.takeoff = null
      t.liftoffAt = null
    }
    return
  }
  // Below its reports by the gap still left: gently closing at first, then more quickly.
  const speed = Math.hypot(t.vel.lon * M_PER_DEG * Math.cos((t.pos.lat * Math.PI) / 180), t.vel.lat * M_PER_DEG)
  const left = 1 - u * u * (3 - 2 * u)
  const closing = (6 * u * (1 - u) * speed) / DRAG_M
  t.altitude = Math.max(reported - p.gap * left, field)
  t.altSpeed = reportedRate + p.gap * closing
}

/** Its climb gradient (feet per meter flown) from its reported climb and speed; else a typical airliner's. */
function climbGradientOf(a: Aircraft) {
  const mPerMin = (a.groundSpeed ?? 0) * M_PER_MIN_PER_KT
  const gradient = a.verticalRate !== null && a.verticalRate > 200 && mPerMin > 1500 ? a.verticalRate / mPerMin : TYPICAL_CLIMB_GRADIENT / M_PER_FT
  return Math.min(gradient, STEEPEST_FT_PER_M)
}

/** Meters from `a` to `b` along the direction (`east`, `north`). */
function alongMeters(a: LatLon, b: LatLon, east: number, north: number) {
  return (b.lon - a.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180) * east + (b.lat - a.lat) * M_PER_DEG * north
}

function metersBetween(a: LatLon, b: LatLon) {
  return Math.hypot((b.lon - a.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * M_PER_DEG)
}

function offset(p: LatLon, eastM: number, northM: number): LatLon {
  return { lat: p.lat + northM / M_PER_DEG, lon: p.lon + eastM / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) }
}

const M_PER_DEG = 111_320
const M_PER_FT = 0.3048
const M_PER_MIN_PER_KT = 1852 / 60
/** About 7°: a typical airliner's initial climb, when no climb rate is sent. */
const TYPICAL_CLIMB_GRADIENT = 0.12
/** Climbing out, never steeper than about 15° (feet per meter). */
const STEEPEST_FT_PER_M = Math.tan((15 * Math.PI) / 180) / M_PER_FT
/** How far (meters) after liftoff it's caught up with its reports. */
const DRAG_M = 5000
/** Lifts off by this long (ms) after the handover even if it hasn't reached its liftoff point (a poor estimate). */
const MAX_ROLL_MS = 25_000

/** Feet per ms from the altitude change between `t`'s last report and `a`, or 0 if that's unknown. */
function estimatedAltRate(t: Track | undefined, a: Aircraft, reportedAt: number) {
  if (!t || t.info.altitude === null || a.altitude === null || reportedAt - t.reportedAt < MIN_RATE_GAP_MS) return 0
  return (a.altitude - t.info.altitude) / (reportedAt - t.reportedAt)
}

/** Reports closer together than this (ms) are too close to tell a climb rate from. */
const MIN_RATE_GAP_MS = 2000

/**
 * Just lifted off, an altitude target no lower than a steady climb away from
 * the runway would be by `at` (from liftoff at `liftoffAt`), for the first
 * minute or so: reported altitudes near the ground can read at or below the
 * runway (pressure altitude, a stale altimeter setting), which would leave it
 * sitting on the ground until the next update. Not while a takeoff is being
 * played out (see playTakeoff): that keeps it climbing, and the floor lifting
 * after a minute would bring it back down to its reports.
 */
function climbingAway(altTo: number | null, liftoffAt: number, at: number) {
  if (altTo === null) return null
  const climbed = Math.min(((at - liftoffAt) * LIFTOFF_CLIMB_FPM) / 60_000, LIFTOFF_CLIMB_MAX_FT)
  return Math.max(altTo, AIRPORT_PRESET.elevationFt + climbed)
}

/** The climb assumed after liftoff when reports say less, and how high it's kept to. */
const LIFTOFF_CLIMB_FPM = 1500
/** How long after liftoff (ms) that's looked after. */
const LIFTOFF_MS = 60_000
const LIFTOFF_CLIMB_MAX_FT = 1000

/**
 * How long (ms) the delayed view takes to fly from `from` (at flight time
 * `fromAt`) to `wp`: the time between them, but never less than flying the
 * distance at the faster of the two speeds takes. Report times don't always
 * match how far a plane moved (slow, circling traffic especially), and a
 * segment that's too short makes it dart across.
 */
function segmentTime(from: LatLon, fromVelocity: LatLon, fromAt: number, wp: Waypoint): number {
  const cos = Math.cos((from.lat * Math.PI) / 180)
  const distance = Math.hypot(wp.pos.lat - from.lat, (wp.pos.lon - from.lon) * cos)
  const speed = Math.max(Math.hypot(fromVelocity.lat, fromVelocity.lon * cos), Math.hypot(wp.velocity.lat, wp.velocity.lon * cos))
  const flyingMs = speed > 0 ? distance / speed : 0
  return Math.max(wp.at - fromAt, flyingMs, MIN_REPORT_GAP_MS)
}

/** A delayed-view track drawn at `pos`, before its first segment is started. */
function newTrack(info: Flight, reportedAt: number, now: number, pos: LatLon, vel: LatLon, at: number, alt: number | null, heading: number): Track {
  return {
    info,
    from: pos,
    fromVelocity: vel,
    to: pos,
    velocity: vel,
    segmentStart: now,
    segmentMs: 0,
    curveMs: 0,
    toAt: at,
    waypoints: [],
    baseDelayMs: now - at,
    reportedAt,
    turnRate: 0,
    firstSeen: now,
    lastSeen: now,
    landedAt: null,
    altFrom: alt,
    altTo: alt,
    altFromRate: 0,
    altRate: 0,
    altSpeed: 0,
    liftoffAt: null,
    takeoff: null,
    pos,
    vel,
    heading,
    altitude: alt,
    turning: 0,
    climbing: 0,
    lastStep: now,
    opacity: 0,
    trail: [],
    trailAlt: [],
    lastTrailAt: now,
  }
}

/** Compass heading of a velocity, or null if it's not moving. */
function headingOf(v: LatLon, lat: number): number | null {
  const east = v.lon * Math.cos((lat * Math.PI) / 180)
  const north = v.lat
  if (east === 0 && north === 0) return null
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
}

/**
 * Cubic Hermite interpolation from p0 (moving at v0) to p1 (moving at v1) over
 * `duration` ms, evaluated at fraction u in [0, 1].
 */
export function hermite(p0: number, v0: number, p1: number, v1: number, duration: number, u: number) {
  const u2 = u * u
  const u3 = u2 * u
  return (
    (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * duration * v0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * duration * v1
  )
}

/**
 * Climb rates (per ms) for a hermite() from `p0` to `p1` over `duration`,
 * limited so the curve never overshoots either end (Fritsch–Carlson): reported
 * vertical rates are noisy and lag, and one that disagrees with the reported
 * altitudes would make the curve rise and fall back between level reports, or
 * dip before a climb. The same sign as the change, at most three times its
 * average rate; level between equal altitudes.
 */
function monotoneRates(p0: number, v0: number, p1: number, v1: number, duration: number): [number, number] {
  const average = (p1 - p0) / duration
  if (average === 0) return [0, 0]
  const limit = (v: number) => (v / average <= 0 ? 0 : Math.sign(v) * Math.min(Math.abs(v), 3 * Math.abs(average)))
  return [limit(v0), limit(v1)]
}

/** Rate of change of hermite() per millisecond, i.e. the velocity along the curve. */
export function hermiteSlope(p0: number, v0: number, p1: number, v1: number, duration: number, u: number) {
  const u2 = u * u
  return (
    ((6 * u2 - 6 * u) * p0 + (3 * u2 - 4 * u + 1) * duration * v0 + (-6 * u2 + 6 * u) * p1 + (3 * u2 - 2 * u) * duration * v1) /
    duration
  )
}

/** Second derivative of hermite() per millisecond squared, i.e. the acceleration along the curve. */
function hermiteCurve(p0: number, v0: number, p1: number, v1: number, duration: number, u: number) {
  return (
    ((12 * u - 6) * p0 + (6 * u - 4) * duration * v0 + (-12 * u + 6) * p1 + (6 * u - 2) * duration * v1) /
    (duration * duration)
  )
}

/** Degrees per ms a path moving at `vel` with acceleration `accel` is turning (positive = right), or null if it's not moving. */
function turnRateAlong(vel: LatLon, accel: LatLon, lat: number): number | null {
  const cos = Math.cos((lat * Math.PI) / 180)
  const [north, east, northAcc, eastAcc] = [vel.lat, vel.lon * cos, accel.lat, accel.lon * cos]
  const speed2 = north * north + east * east
  if (speed2 === 0) return null
  return (((north * eastAcc - east * northAcc) / speed2) * 180) / Math.PI
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max)
}
