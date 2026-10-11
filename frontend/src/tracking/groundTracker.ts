import { DIORAMA, FEED, MOTION } from '../config/config'
import type { Flight } from './flights'
import { hermite, hermiteSlope, overdueFor, type Handoff, type LatLon } from './tracker'
import type { AirportLayout } from '../diorama/diorama'
import { TaxiNetwork } from './taxiNetwork'

export interface GroundTrack {
  info: Flight
  /**
   * The drawn position curves from `from` to the latest reported position over
   * one fetch, starting at the velocity it was drawn moving at and ending at the
   * one reported there (degrees per ms), so speed and direction never jump.
   */
  from: LatLon
  to: LatLon
  fromVelocity: LatLon
  toVelocity: LatLon
  /** The last reported ground speed (knots) and when, to tell how fast it's speeding up or slowing down. */
  lastSpeed: { gs: number; at: number } | null
  fromHeading: number
  toHeading: number
  segmentStart: number
  segmentMs: number
  firstSeen: number
  lastSeen: number
  /** Height above the field (feet), gliding from `fromHeightFt` to 0 over the segment: just touched down. */
  fromHeightFt: number
  /** Whether the current target was predicted ahead (takeoff or landing roll). */
  predicted: boolean
  /** When it last stopped moving, or null while it's moving. */
  stoppedSince: number | null
  parked: boolean

  /** Which way the nose points, as last reported (null if it isn't sent); a pushback moves the other way. */
  nose: number | null
  /** How far (degrees lat/lon) the drawn position sits from the glide between reports, easing onto the centerline it's on. */
  snapOffset: LatLon
  /** When step() last ran for it, so easing keeps time however often it's called. */
  steppedAt: number | null

  /** Updated every frame by step(). */
  pos: LatLon
  /** Degrees per ms. */
  vel: LatLon
  heading: number
  heightFt: number
  opacity: number
}

/**
 * Aircraft on the ground at the airport, for the 3D airport view.
 *
 * Taxi routes turn sharply at every intersection, so rather than predict ahead
 * (which cuts corners) each taxiing aircraft curves between its last two
 * reported positions, running one fetch behind. Takeoff and landing rolls are
 * fast and straight, so those are predicted ahead instead, allowing for how
 * fast it's speeding up or slowing down. Either way the curve carries on at
 * the speed it was drawn moving, so nothing lurches at each update. Aircraft that sit still count as parked
 * and stay on screen for hours after they vanish from the feed, because most
 * switch their transponders off at the gate.
 *
 * An aircraft that just landed carries on from where the airborne tracker drew
 * it, still in the air, and settles onto the runway over its first segment.
 *
 * Once the airport's layout is known (setLayout), moving aircraft are kept on
 * the taxiway and runway centerlines, and point the way they're moving along
 * them: nose first, or tail first while pushing back.
 */
export class GroundTracker {
  readonly tracks = new Map<string, GroundTrack>()
  private lastIngest: number | null = null
  /** Running average of the time between updates (for how long to keep missing aircraft). */
  private gapMs = FEED.pollMs
  private network: TaxiNetwork | null = null

  /** The airport's layout, for keeping moving aircraft on its taxiway and runway centerlines. */
  setLayout(layout: AirportLayout) {
    this.network = new TaxiNetwork(layout)
  }

  /** `handoff` gives where a just-landed aircraft was drawn in the air. */
  ingest(flights: Flight[], now: number, handoff: (hex: string) => Handoff | null = () => null) {
    // Bring every aircraft up to now first, so each new curve starts where it's drawn now.
    this.step(now)
    const segmentMs = this.lastIngest === null ? 0 : Math.min(now - this.lastIngest, FEED.pollMs * 2)
    if (this.lastIngest !== null) this.gapMs += (now - this.lastIngest - this.gapMs) * GAP_SMOOTHING
    this.lastIngest = now

    for (const f of flights) {
      const existing = this.tracks.get(f.hex)
      if (f.isVehicle) continue
      if (!f.onGround || f.distanceNm > DIORAMA.radiusNm) {
        // Took off or left the airport: the main map takes over.
        if (existing) this.tracks.delete(f.hex)
        continue
      }

      // Fast means a takeoff or landing roll: runways are straight, so predict ahead
      // like the airborne tracker does, and the two line up at liftoff and touchdown.
      // Easing from predicting a whole fetch ahead (runway speed) down to none
      // (taxi speed) keeps a slowing plane from lurching back as it turns off.
      // The delayed view never predicts ahead, so liftoff hands over a position behind the first airborne report.
      const gs = f.groundSpeed ?? 0
      const lead = MOTION.delayed ? 0 : clamp((gs - TAXI_SPEED_KT) / (RUNWAY_SPEED_KT - TAXI_SPEED_KT), 0, 1)
      const predicted = lead > 0 && f.track !== null
      // Speeding up (takeoff) or slowing down (landing), from the last two speeds reported;
      // just touched down, with only one, braking as landings usually do.
      const landing = existing ? null : handoff(f.hex)
      const reportedAt = now - f.positionAge * 1000
      const last = existing?.lastSpeed
      const accel =
        last && reportedAt - last.at > 2000
          ? clamp((gs - last.gs) / (reportedAt - last.at), -MAX_ACCEL, MAX_ACCEL)
          : landing && predicted
            ? -LANDING_DECEL
            : 0
      const aheadMs = f.positionAge * 1000 + lead * (segmentMs || FEED.pollMs)
      // A takeoff roll stops speeding up much once it rotates, around here.
      const topKt = Math.max(gs, ROTATE_KT)
      const reported = predicted ? ahead(f, aheadMs, accel, topKt) : { lat: f.lat, lon: f.lon }
      const stopped = gs < DIORAMA.parkedSpeedKt
      // How it'll be moving there: at the speed it'll have reached, predicting ahead.
      const toVelocity = stopped || f.track === null ? ZERO : velocityOf(predicted ? clamp(gs + accel * aheadMs, 0, topKt) : gs, f.track, f.lat)
      if (!existing) {
        const heading = f.trueHeading ?? f.track ?? landing?.heading ?? 0
        this.tracks.set(f.hex, {
          info: f,
          from: landing?.pos ?? reported,
          to: reported,
          fromVelocity: landing?.velocity ?? toVelocity,
          toVelocity,
          lastSpeed: { gs, at: reportedAt },
          fromHeading: landing?.heading ?? heading,
          toHeading: heading,
          segmentStart: now,
          // A landing glides down to its first ground report; anything else just appears there.
          segmentMs: landing ? segmentMs || FEED.pollMs : 0,
          fromHeightFt: landing?.heightFt ?? 0,
          predicted,
          // Already on screen in the air, so no fade-in.
          firstSeen: landing ? now - MOTION.fadeInMs : now,
          lastSeen: now,
          // Already sitting still when first seen: most likely parked.
          stoppedSince: stopped && !landing ? now - DIORAMA.parkedAfterMs : null,
          parked: stopped && !landing,
          nose: f.trueHeading,
          snapOffset: { lat: 0, lon: 0 },
          steppedAt: null,
          pos: landing?.pos ?? reported,
          vel: landing?.velocity ?? toVelocity,
          heading: landing?.heading ?? heading,
          heightFt: landing?.heightFt ?? 0,
          opacity: 0,
        })
        continue
      }

      existing.info = f
      // Carries on from exactly where (and how fast) it's drawn: that's already on the
      // centerline, so the easing onto it starts over.
      existing.from = existing.pos
      existing.fromVelocity = existing.vel
      existing.snapOffset = { lat: 0, lon: 0 }
      existing.lastSpeed = { gs, at: reportedAt }
      // Don't go backwards after a predicted-ahead target overshot: carry on more slowly
      // until the reports catch up. (Only then: pushbacks really do move backwards.)
      const overshot = existing.predicted && isBehind(existing.pos, reported, existing.heading)
      const slowed = { lat: toVelocity.lat * OVERSHOT_SPEED, lon: toVelocity.lon * OVERSHOT_SPEED }
      const span = segmentMs || FEED.pollMs
      existing.to = overshot ? { lat: existing.pos.lat + slowed.lat * span, lon: existing.pos.lon + slowed.lon * span } : reported
      existing.toVelocity = overshot ? slowed : toVelocity
      existing.predicted = predicted
      existing.fromHeading = existing.heading
      // Stopped aircraft often report no track (or a meaningless one); keep the last heading,
      // unless they say which way the nose points.
      existing.nose = f.trueHeading
      existing.toHeading = f.trueHeading ?? (stopped || f.track === null ? existing.heading : f.track)
      existing.segmentStart = now
      existing.segmentMs = segmentMs
      existing.fromHeightFt = existing.heightFt
      existing.lastSeen = now
      existing.stoppedSince = stopped ? (existing.stoppedSince ?? now) : null
      existing.parked = existing.stoppedSince !== null && now - existing.stoppedSince >= DIORAMA.parkedAfterMs
    }
  }

  /** Advance every track to `now`. Call once per animation frame. */
  step(now: number) {
    for (const [hex, t] of this.tracks) {
      const keepFor = t.parked ? DIORAMA.keepParkedMs : DIORAMA.staleMs
      const overdue = overdueFor(now, t.lastSeen, this.lastIngest, this.gapMs, keepFor)
      if (overdue > MOTION.fadeOutMs) {
        this.tracks.delete(hex)
        continue
      }

      const elapsed = now - t.segmentStart
      const u = t.segmentMs > 0 ? Math.min(elapsed / t.segmentMs, 1) : 1
      let glide: LatLon
      if (u < 1) {
        glide = {
          lat: hermite(t.from.lat, t.fromVelocity.lat, t.to.lat, t.toVelocity.lat, t.segmentMs, u),
          lon: hermite(t.from.lon, t.fromVelocity.lon, t.to.lon, t.toVelocity.lon, t.segmentMs, u),
        }
        t.vel = {
          lat: hermiteSlope(t.from.lat, t.fromVelocity.lat, t.to.lat, t.toVelocity.lat, t.segmentMs, u),
          lon: hermiteSlope(t.from.lon, t.fromVelocity.lon, t.to.lon, t.toVelocity.lon, t.segmentMs, u),
        }
      } else {
        // The next report is late: roll on at the speed it arrived with, easing to a stop.
        const over = Math.max(elapsed - t.segmentMs, 0)
        const carried = COAST_MS * (1 - Math.exp(-over / COAST_MS))
        glide = { lat: t.to.lat + t.toVelocity.lat * carried, lon: t.to.lon + t.toVelocity.lon * carried }
        const left = Math.exp(-over / COAST_MS)
        t.vel = { lat: t.toVelocity.lat * left, lon: t.toVelocity.lon * left }
      }
      let heading = t.fromHeading + (((t.toHeading - t.fromHeading + 540) % 360) - 180) * u
      t.heightFt = t.fromHeightFt * (1 - u)

      // Moving: onto the centerline it's on (if any), facing along it the way it's going.
      let offset = { lat: 0, lon: 0 }
      const moved = metersBetween(t.from, t.to)
      const speed = metersPerMs(t.vel, glide.lat)
      if (!t.parked && t.stoppedSince === null && (moved > MIN_MOVE_M || speed > MIN_SPEED)) {
        // Which way it's going: its drawn velocity, or the way between reports when barely moving.
        const motion = speed > MIN_SPEED ? bearingOf(t.vel, glide.lat) : bearing(t.from, t.to)
        // Moving away from where the nose points: a pushback. Without a reported nose, only at
        // pushback speed, so a tight turn between reports can't leave it facing backwards.
        const slow = (t.info.groundSpeed ?? 0) < PUSHBACK_MAX_KT
        const reversing = (t.nose !== null || slow) && angleBetween(motion, t.nose ?? t.heading) > 120
        let along = motion
        const snapped = MOTION.taxiwaySnap ? this.network?.snap(glide) : null
        if (snapped) {
          offset = { lat: snapped.pos.lat - glide.lat, lon: snapped.pos.lon - glide.lon }
          along = angleBetween(snapped.bearing, motion) <= 90 ? snapped.bearing : snapped.bearing + 180
        }
        heading = reversing ? along + 180 : along
      }
      // Eased, so stepping on or off a line (or onto another) never jumps.
      const dt = t.steppedAt === null ? Infinity : Math.max(now - t.steppedAt, 0)
      t.steppedAt = now
      const kPos = 1 - Math.exp(-dt / SNAP_EASE_MS)
      const kTurn = 1 - Math.exp(-dt / TURN_EASE_MS)
      t.snapOffset = {
        lat: t.snapOffset.lat + (offset.lat - t.snapOffset.lat) * kPos,
        lon: t.snapOffset.lon + (offset.lon - t.snapOffset.lon) * kPos,
      }
      t.pos = { lat: glide.lat + t.snapOffset.lat, lon: glide.lon + t.snapOffset.lon }
      t.heading = (((t.heading + ((((heading - t.heading) % 360) + 540) % 360 - 180) * kTurn) % 360) + 360) % 360

      const fadeIn = Math.min((now - t.firstSeen) / MOTION.fadeInMs, 1)
      const fadeOut = 1 - Math.min(Math.max(overdue / MOTION.fadeOutMs, 0), 1)
      t.opacity = Math.min(fadeIn, fadeOut)
    }
  }

  /** Where a departing aircraft was drawn on the ground, for the airborne tracker to lift off from. */
  handoff(hex: string): Handoff | null {
    const t = this.tracks.get(hex)
    return t ? { pos: t.pos, velocity: t.vel, heading: t.heading, heightFt: t.heightFt } : null
  }
}

/** Tugs push back slower than this (knots); anything faster going "backwards" is really a tight turn. */
const PUSHBACK_MAX_KT = 8
/** Moving less than this between reports (meters) counts as standing still, for which way it faces. */
const MIN_MOVE_M = 1.5
/** How quickly (ms) the drawn position eases onto a centerline, and the nose round to its new direction. */
const SNAP_EASE_MS = 400
const TURN_EASE_MS = 450

function metersBetween(a: LatLon, b: LatLon) {
  const north = (b.lat - a.lat) * M_PER_DEG_LAT
  const east = (b.lon - a.lon) * M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(north, east)
}

/** Degrees from north, from `a` toward `b`. */
function bearing(a: LatLon, b: LatLon) {
  const north = b.lat - a.lat
  const east = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180)
  return (Math.atan2(east, north) * 180) / Math.PI
}

/** The angle between two directions (0 to 180 degrees). */
function angleBetween(a: number, b: number) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180)
}

/** How much each new gap between updates moves the running average (0 to 1). */
const GAP_SMOOTHING = 0.3
/** Ground speed (knots) of a takeoff or landing roll, predicted a whole fetch ahead... */
const RUNWAY_SPEED_KT = 40
/** ...down to taxiing, which runs a fetch behind instead. */
const TAXI_SPEED_KT = 15
const M_PER_DEG_LAT = 111_320
const MS_PER_KT = 0.514444 / 1000

/** Fastest speeding up or slowing down believed (knots per ms): about an airliner's braking. */
const MAX_ACCEL = 6 / 1000
/** How a just-landed aircraft is assumed to brake (knots per ms) until its reports show how it really is. */
const LANDING_DECEL = 3 / 1000
/** Ahead of its reports (a predicted roll that overshot), it carries on at this fraction of their speed until they catch up. */
const OVERSHOT_SPEED = 0.6
/** Moving slower than this (meters per ms, about 1 kt) counts as stopped, for which way it faces. */
const MIN_SPEED = 0.0005
/** A late report: how long (ms) the aircraft takes to coast to a stop. */
const COAST_MS = 1500
const ZERO: LatLon = { lat: 0, lon: 0 }

/** A velocity (degrees per ms) from a speed (knots) and track (degrees from north) at latitude `lat`. */
function velocityOf(knots: number, track: number, lat: number): LatLon {
  const perMs = knots * MS_PER_KT
  const rad = (track * Math.PI) / 180
  return { lat: (perMs * Math.cos(rad)) / M_PER_DEG_LAT, lon: (perMs * Math.sin(rad)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)) }
}

function metersPerMs(v: LatLon, lat: number) {
  return Math.hypot(v.lat * M_PER_DEG_LAT, v.lon * M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
}

/** Degrees from north of a velocity. */
function bearingOf(v: LatLon, lat: number) {
  return (Math.atan2(v.lon * Math.cos((lat * Math.PI) / 180), v.lat) * 180) / Math.PI
}

/** About where airliners rotate (knots): a takeoff roll isn't predicted to speed up past it. */
const ROTATE_KT = 160

/**
 * Where `f` will be `ms` after its report, carrying on straight at its ground
 * speed, changing by `accel` (knots per ms) until it'd stop, or reach `topKt`.
 */
function ahead(f: Flight, ms: number, accel = 0, topKt = Infinity): LatLon {
  const gs = f.groundSpeed ?? 0
  // How long the speed keeps changing (until it stops or tops out), then carries on.
  const changing = accel < 0 ? Math.min(ms, gs / -accel) : accel > 0 ? Math.min(ms, Math.max(topKt - gs, 0) / accel) : 0
  const after = accel < 0 ? 0 : ms - changing
  const meters = (gs * changing + 0.5 * accel * changing * changing + (gs + accel * changing) * after) * MS_PER_KT
  const rad = ((f.track ?? 0) * Math.PI) / 180
  return {
    lat: f.lat + (meters * Math.cos(rad)) / M_PER_DEG_LAT,
    lon: f.lon + (meters * Math.sin(rad)) / (M_PER_DEG_LAT * Math.cos((f.lat * Math.PI) / 180)),
  }
}

/** Whether `target` lies behind a plane at `pos` pointing along `heading`. */
function isBehind(pos: LatLon, target: LatLon, heading: number) {
  const north = target.lat - pos.lat
  const east = (target.lon - pos.lon) * Math.cos((pos.lat * Math.PI) / 180)
  const rad = (heading * Math.PI) / 180
  return north * Math.cos(rad) + east * Math.sin(rad) < 0
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max)
}
