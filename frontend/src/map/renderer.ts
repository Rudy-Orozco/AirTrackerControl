import type { Basemap, Line } from './basemap'
import { type MapTrafficStyle, type TrafficStyle } from '../config/config'
import { mapStyle } from './mapStyle'
import type { FlightKind } from '../tracking/flights'
import type { Radar } from './radar'
import type { Terrain } from './terrain'
import { leaderLine, newLabelState, updateLabels, type LabelItem, type LabelState } from './labels'
import { estimatedPath, predictedPath, trailStart, type LatLon, type Track } from '../tracking/tracker'
import type { RunwayGuide } from '../tracking/runwayAssist'

export interface Point {
  x: number
  y: number
}

export type Projection = (p: LatLon) => Point

/** Where the map center sits on screen and how many pixels make a nautical mile. */
export interface View {
  cx: number
  cy: number
  pxPerNm: number
}

const NM_PER_DEG_LAT = 60
/** Read on every use so a changed label size applies at once. */
export function labelFont() {
  return `${mapStyle().labelSize}px ${mapStyle().fontFamily}`
}

/**
 * Centers the map in the part of the screen the board doesn't cover, with
 * `radiusNm` reaching the nearer edge of that area.
 */
export function createView(visibleWidth: number, visibleHeight: number, radiusNm: number): View {
  return {
    cx: visibleWidth / 2,
    cy: visibleHeight / 2,
    pxPerNm: Math.min(visibleWidth, visibleHeight) / 2 / radiusNm,
  }
}

/**
 * Flat projection centered on `center`. Accurate enough for a ~100 nm view and
 * much cheaper than Web Mercator.
 */
export function createProjection(view: View, center: LatLon): Projection {
  const lonScale = Math.cos((center.lat * Math.PI) / 180)
  return ({ lat, lon }) => ({
    x: view.cx + (lon - center.lon) * NM_PER_DEG_LAT * lonScale * view.pxPerNm,
    y: view.cy - (lat - center.lat) * NM_PER_DEG_LAT * view.pxPerNm,
  })
}

/** Where the map credits and radar time start in the top-left corner, clear of the airport logo (AirportLogo.tsx). */
const CORNER_TEXT_TOP = 96

/**
 * Draws everything that never moves (backdrop, map, range rings) to an offscreen
 * canvas once, so each frame just blits it instead of redrawing.
 */
export function renderBackground(
  width: number,
  height: number,
  dpr: number,
  view: View,
  project: Projection,
  basemap: Basemap | null,
  radar: Radar | null = null,
  terrain: Terrain | null = null,
  /** The map credits and radar time in the top-left corner (off for small maps). */
  cornerText = true,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width * dpr
  canvas.height = height * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)

  const { cx, cy, pxPerNm } = view
  // Far enough to reach every corner of the screen, wherever the center sits.
  const maxRadius = Math.max(Math.hypot(cx, cy), Math.hypot(width - cx, cy), Math.hypot(cx, height - cy), Math.hypot(width - cx, height - cy))
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxRadius)
  gradient.addColorStop(0, '#0b1424')
  gradient.addColorStop(1, '#03050a')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  if (terrain && mapStyle().terrain) drawTerrain(ctx, terrain, project)
  if (basemap) drawBasemap(ctx, basemap, project, cornerText)
  if (radar) drawRadar(ctx, radar, project, cornerText)

  const maxRingNm = maxRadius / pxPerNm
  ctx.strokeStyle = 'rgba(120, 160, 220, 0.12)'
  ctx.fillStyle = 'rgba(120, 160, 220, 0.35)'
  ctx.lineWidth = 1
  ctx.font = labelFont()
  ctx.textAlign = 'center'
  for (let nm = mapStyle().ringSpacingNm; nm <= maxRingNm; nm += mapStyle().ringSpacingNm) {
    const r = nm * pxPerNm
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillText(`${nm}`, cx, cy - r - 4)
  }

  return canvas
}

/** Hill shading stretched over the area it covers, under everything else. */
function drawTerrain(ctx: CanvasRenderingContext2D, terrain: Terrain, project: Projection) {
  const { west, south, east, north } = terrain.bounds
  const topLeft = project({ lat: north, lon: west })
  const bottomRight = project({ lat: south, lon: east })
  ctx.save()
  ctx.globalAlpha = Math.min(mapStyle().terrainShading, 1)
  ctx.imageSmoothingQuality = 'high'
  // Stronger than 1: draw it again on top.
  const passes = mapStyle().terrainShading > 1 ? 2 : 1
  for (let i = 0; i < passes; i++) {
    if (i === 1) ctx.globalAlpha = mapStyle().terrainShading - 1
    ctx.drawImage(terrain.shade, topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
  }
  ctx.restore()
}

/** Faint water and freeways for orientation, with runways as the brightest detail. */
function drawBasemap(ctx: CanvasRenderingContext2D, map: Basemap, project: Projection, cornerText: boolean) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  ctx.beginPath()
  for (const ring of map.water) tracePath(ctx, ring, project, true)
  ctx.fillStyle = 'rgba(50, 100, 170, 0.22)'
  ctx.fill()

  strokeLines(ctx, map.coastlines ?? [], project, 'rgba(70, 120, 190, 0.45)', 1.25)
  strokeLines(ctx, map.rivers, project, 'rgba(50, 100, 170, 0.18)', 0.75)
  strokeLines(ctx, map.highways, project, 'rgba(140, 160, 200, 0.10)', 1)
  strokeLines(ctx, map.runways, project, 'rgba(190, 205, 230, 0.45)', 2.5)

  ctx.font = `${mapStyle().labelSize - 1}px ${mapStyle().fontFamily}`
  ctx.letterSpacing = '3px'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(160, 180, 215, 0.28)'
  for (const city of map.cities) {
    const p = project(city)
    ctx.fillText(city.name.toUpperCase(), p.x, p.y)
  }

  ctx.letterSpacing = '0px'
  if (!cornerText) return
  ctx.font = labelFont()
  ctx.fillStyle = 'rgba(160, 180, 215, 0.25)'
  // Top corner, under the local clock: the board covers the bottom (or right) of the map.
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.fillText(map.attribution, 16, CORNER_TEXT_TOP)
  ctx.textBaseline = 'alphabetic'
}

/**
 * The radar image is in plain lat/lon, which our projection maps linearly, so
 * it stretches exactly onto its corners. Scan time goes in the top corner.
 */
function drawRadar(ctx: CanvasRenderingContext2D, radar: Radar, project: Projection, cornerText: boolean) {
  const { west, south, east, north } = radar.bounds
  const topLeft = project({ lat: north, lon: west })
  const bottomRight = project({ lat: south, lon: east })
  ctx.save()
  ctx.globalAlpha = mapStyle().radar.opacity
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(radar.image, topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
  ctx.restore()

  if (cornerText && radar.validTime) {
    const time = radar.validTime.toISOString().slice(11, 16).replace(':', '')
    ctx.font = labelFont()
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(160, 180, 215, 0.4)'
    ctx.fillText(`RADAR ${time}Z`, 16, CORNER_TEXT_TOP + 18)
    ctx.textBaseline = 'alphabetic'
  }
}

/** Strokes every line as one path, which is far cheaper than stroking each separately. */
function strokeLines(ctx: CanvasRenderingContext2D, lines: Line[], project: Projection, color: string, width: number) {
  ctx.beginPath()
  for (const line of lines) tracePath(ctx, line, project, false)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
}

function tracePath(ctx: CanvasRenderingContext2D, line: Line, project: Projection, close: boolean) {
  line.forEach(([lon, lat], i) => {
    const p = project({ lat, lon })
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  if (close) ctx.closePath()
}

export function drawTracks(ctx: CanvasRenderingContext2D, tracks: Iterable<Track>, project: Projection) {
  ctx.font = labelFont()
  ctx.textAlign = 'left'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Draw background traffic first so arrivals and departures sit on top.
  const visible = [...tracks]
    .filter((t) => t.opacity > 0 && mapStyle().traffic[t.info.kind].show)
    .sort((a, b) => DRAW_ORDER[a.info.kind] - DRAW_ORDER[b.info.kind])
  const positions = visible.map((t) => project(t.pos))

  visible.forEach((t, i) => {
    const style = mapStyle().traffic[t.info.kind]
    const { color, opacity, scale } = style
    if (style.trail) drawTrail(ctx, t, positions[i], project, style, t.opacity * opacity)
    ctx.globalAlpha = t.opacity * opacity
    ctx.fillStyle = color
    drawPlane(ctx, positions[i], t.heading, mapStyle().planeSize * scale)
    if (mapStyle().showPredictions && t.info.kind !== 'other') drawPrediction(ctx, t, positions[i], project, color)
  })

  if (mapStyle().showLabels) drawLabels(ctx, visible, mapStyle().traffic, positions)
  ctx.globalAlpha = 1
}

/**
 * Debug overlay: the rest of the plane's current curve, dashed, ending in a ring
 * where it'll be at the next fetch. In the delayed view the curve carries on
 * through every report still ahead (a ring at each), then a dotted line on to a
 * dot where it probably is now.
 */
function drawPrediction(ctx: CanvasRenderingContext2D, t: Track, pos: Point, project: Projection, color: string) {
  const estimate = estimatedPath(t).points
  if (estimate.length > 0) {
    const now = project(estimate[estimate.length - 1])
    ctx.save()
    ctx.globalAlpha = t.opacity * 0.8
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1
    ctx.setLineDash([1, 3])
    ctx.beginPath()
    estimate.forEach((p, i) => {
      const q = project(p)
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    })
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(now.x, now.y, 2.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  const { points, marks } = predictedPath(t)
  if (points.length === 0) return
  ctx.save()
  ctx.globalAlpha = t.opacity
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(pos.x, pos.y)
  for (const p of points.slice(1)) {
    const q = project(p)
    ctx.lineTo(q.x, q.y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  // A ring with a dot in it at each report ahead, outlined dark so it stands out over the map.
  for (const m of marks) {
    const q = project(m)
    ctx.beginPath()
    ctx.arc(q.x, q.y, 5, 0, Math.PI * 2)
    ctx.lineWidth = 3.5
    ctx.strokeStyle = 'rgba(3, 5, 10, 0.8)'
    ctx.stroke()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = color
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(q.x, q.y, 1.5, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
  }
  ctx.restore()
}

const LABEL_OPACITY = 0.8

/** Each aircraft's label placement in each map's style, kept between frames so labels glide rather than jump. */
const labelStates = new WeakMap<object, WeakMap<Track, LabelState>>()
const textWidths = new Map<string, number>()
// Widths measured with a fallback font are wrong once the web font arrives.
document.fonts.addEventListener('loadingdone', () => textWidths.clear())

/**
 * Labels go on top of every aircraft, each in a free spot around its aircraft,
 * with a leader line when it had to sit farther out.
 */
/** Labels for aircraft already placed on screen by another view (the 3D map), in its styles. */
export function drawTrackLabels(ctx: CanvasRenderingContext2D, tracks: Track[], styles: TrafficStyles, positions: Point[]) {
  ctx.font = labelFont()
  ctx.textAlign = 'left'
  ctx.lineCap = 'round'
  drawLabels(ctx, tracks, styles, positions)
  ctx.globalAlpha = 1
}

/** Labels the aircraft whose kind has labels on; the others still keep labels off their icons. */
function drawLabels(ctx: CanvasRenderingContext2D, all: Track[], styles: TrafficStyles, allPositions: Point[]) {
  const tracks: Track[] = []
  const positions: Point[] = []
  all.forEach((t, i) => {
    if (!styles[t.info.kind].labels) return
    tracks.push(t)
    positions.push(allPositions[i])
  })
  const texts = tracks.map(label)
  let states = labelStates.get(mapStyle())
  if (!states) {
    states = new WeakMap()
    labelStates.set(mapStyle(), states)
  }
  const items: LabelItem[] = tracks.map((t, i) => {
    const width = measure(ctx, texts[i])
    let state = states.get(t)
    if (!state) {
      state = newLabelState(width)
      states.set(t, state)
    }
    const isBackground = t.info.kind === 'other'
    return {
      anchor: positions[i],
      width,
      height: mapStyle().labelSize + 2,
      priority: isBackground ? 1 : 0,
      optional: isBackground && mapStyle().hideCrowdedLabels,
      state,
    }
  })
  updateLabels(items, allPositions, { width: ctx.canvas.clientWidth, height: ctx.canvas.clientHeight }, performance.now())

  ctx.textBaseline = 'middle'
  ctx.lineWidth = 1
  items.forEach((item, i) => {
    const { color, opacity } = styles[tracks[i].info.kind]
    ctx.globalAlpha = tracks[i].opacity * opacity * LABEL_OPACITY * item.state.alpha
    if (ctx.globalAlpha < 0.01) return
    const line = leaderLine(item)
    if (line) {
      ctx.strokeStyle = color
      ctx.globalAlpha *= 0.6
      ctx.beginPath()
      ctx.moveTo(line.from.x, line.from.y)
      ctx.lineTo(line.to.x, line.to.y)
      ctx.stroke()
      ctx.globalAlpha /= 0.6
    }
    ctx.fillStyle = color
    const { offset } = item.state
    ctx.fillText(texts[i], item.anchor.x + offset.x - item.width / 2, item.anchor.y + offset.y)
  })
  ctx.textBaseline = 'alphabetic'
}

function measure(ctx: CanvasRenderingContext2D, text: string) {
  // Keyed by font too, since the label size can change.
  const key = `${ctx.font}|${text}`
  let width = textWidths.get(key)
  if (width === undefined) {
    // Labels change as altitudes do; don't let the cache grow forever.
    if (textWidths.size > 2000) textWidths.clear()
    width = ctx.measureText(text).width
    textWidths.set(key, width)
  }
  return width
}

type TrafficStyles = Record<FlightKind, TrafficStyle & { labels: boolean }>

const DRAW_ORDER: Record<FlightKind, number> = { other: 0, departure: 1, arrival: 1 }

function drawTrail(ctx: CanvasRenderingContext2D, t: Track, pos: Point, project: Projection, style: MapTrafficStyle, opacity: number) {
  const trail = t.trail.slice(trailStart(t, style.trailSeconds))
  if (trail.length < 2) return
  const { color } = style
  const start = project(trail[0])

  // One path per plane with a tail-to-head gradient: looks like a fading trail
  // at a fraction of the cost of stroking every segment separately.
  const gradient = ctx.createLinearGradient(start.x, start.y, pos.x, pos.y)
  gradient.addColorStop(0, withAlpha(color, 0))
  gradient.addColorStop(1, withAlpha(color, style.trailOpacity * opacity))

  const points = smoothPath([...trail.map(project), pos], style.trailSmoothing)
  // Curve through the midpoints between samples, using each sample as the control point.
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    const next = points[i + 1]
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2)
  }
  ctx.lineTo(pos.x, pos.y)
  ctx.strokeStyle = gradient
  ctx.lineWidth = style.trailWidth
  ctx.stroke()
}

/**
 * Moving average over up to `radius` neighbours on each side. The window
 * narrows towards the ends so the first and last points stay put (the trail
 * still meets the plane).
 */
function smoothPath(points: Point[], radius: number): Point[] {
  if (radius <= 0) return points
  // Prefix sums make each average O(1).
  const sumX = [0]
  const sumY = [0]
  for (const p of points) {
    sumX.push(sumX[sumX.length - 1] + p.x)
    sumY.push(sumY[sumY.length - 1] + p.y)
  }
  const last = points.length - 1
  return points.map((_, i) => {
    const r = Math.min(radius, i, last - i)
    const n = 2 * r + 1
    return { x: (sumX[i + r + 1] - sumX[i - r]) / n, y: (sumY[i + r + 1] - sumY[i - r]) / n }
  })
}

/** "#rrggbb" plus an alpha, as a CSS color. */
function withAlpha(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`
}

/** An arrowhead pointing along `heading` (degrees clockwise from north). */
function drawPlane(ctx: CanvasRenderingContext2D, pos: Point, heading: number, size: number) {
  ctx.save()
  ctx.translate(pos.x, pos.y)
  ctx.rotate((heading * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0, -size)
  ctx.lineTo(size * 0.65, size * 0.7)
  ctx.lineTo(0, size * 0.3)
  ctx.lineTo(-size * 0.65, size * 0.7)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function label(t: Track) {
  const { callsign, altitude } = t.info
  if (altitude === null) return callsign
  return `${callsign} ${Math.round(altitude / 100).toString().padStart(3, '0')}`
}


/**
 * The landing and takeoff paths aircraft are being guided along near the
 * runways (see runwayAssist.ts): dashed, in the arrival color for landings and
 * the departure color for takeoffs, as bold as the guidance is strong.
 */
export function drawAssistPaths(ctx: CanvasRenderingContext2D, paths: { landing: boolean; points: LatLon[]; strength: number; opacity: number }[], project: Projection) {
  ctx.save()
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  for (const { landing, points, strength, opacity } of paths) {
    ctx.strokeStyle = landing ? mapStyle().traffic.arrival.color : mapStyle().traffic.departure.color
    ctx.globalAlpha = 0.8 * strength * opacity
    ctx.beginPath()
    points.forEach((p, i) => {
      const q = project(p)
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    })
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * What the runway assist guides aircraft along on the runways in use (see
 * RunwayAssist.guides), seen from above: the extended centerline dashed, the
 * edges of the area either side that still counts, and on final a bar every
 * nautical mile from touchdown, a wider one at the gate where arrivals are
 * held to the glide path, and a short one at the touchdown aiming point. In the
 * arrival or departure color, as bold as it's in use.
 */
export function drawRunwayGuides(ctx: CanvasRenderingContext2D, guides: RunwayGuide[], project: Projection) {
  const line = (points: LatLon[]) => {
    ctx.beginPath()
    points.forEach((p, i) => {
      const q = project(p)
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    })
    ctx.stroke()
  }
  ctx.save()
  ctx.lineWidth = 1
  for (const g of guides) {
    ctx.strokeStyle = g.landing ? mapStyle().traffic.arrival.color : mapStyle().traffic.departure.color
    ctx.setLineDash([8, 6])
    ctx.globalAlpha = 0.5 * g.strength
    line(g.centerline)
    ctx.setLineDash([])
    ctx.globalAlpha = 0.18 * g.strength
    for (const edge of g.edges) line(edge)
    for (const bar of g.bars) {
      ctx.globalAlpha = (bar.kind === 'mile' ? 0.35 : 0.6) * g.strength
      line([bar.from, bar.to])
    }
  }
  ctx.restore()
}

/** Corner brackets around the followed aircraft (see selection.ts), on the flat map and over the 3D one. */
export function drawFocusBrackets(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = FOCUS_BRACKET_PX
  const arm = r * 0.45
  ctx.save()
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = '#f1f3f6'
  ctx.lineWidth = 1.5
  ctx.lineCap = 'square'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
  ctx.shadowBlur = 4
  ctx.beginPath()
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    ctx.moveTo(x + sx * r, y + sy * (r - arm))
    ctx.lineTo(x + sx * r, y + sy * r)
    ctx.lineTo(x + sx * (r - arm), y + sy * r)
  }
  ctx.stroke()
  ctx.restore()
}

const FOCUS_BRACKET_PX = 16

/**
 * The followed flight's route on the flat map (see selection.ts): a dashed line
 * from the aircraft to its origin or destination, labelled where it reaches the
 * airport or, if that's off screen, where it leaves the map. `width` and
 * `height` are the area to keep the label in (the part the board leaves uncovered).
 */
export function drawFocusRoute(
  ctx: CanvasRenderingContext2D,
  route: { points: LatLon[]; label: string },
  project: Projection,
  color: string,
  width: number,
  height: number,
) {
  const points = route.points.map(project)
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.globalAlpha = 0.85
  ctx.setLineDash([6, 5])
  ctx.beginPath()
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.stroke()
  ctx.setLineDash([])

  const at = lastOnScreen(points, width, height, ROUTE_LABEL_MARGIN_PX)
  if (at) {
    const end = at === points[points.length - 1]
    ctx.fillStyle = color
    if (end) {
      ctx.beginPath()
      ctx.arc(at.x, at.y, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.font = labelFont()
    ctx.letterSpacing = '1.5px'
    ctx.textAlign = at.x > width / 2 ? 'right' : 'left'
    ctx.textBaseline = 'bottom'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)'
    ctx.shadowBlur = 4
    ctx.globalAlpha = 1
    ctx.fillText(route.label, at.x + (at.x > width / 2 ? -6 : 6), at.y - 6)
  }
  ctx.restore()
}

/** The farthest point along `points` before the line first leaves the screen (less `margin`), or null if it starts off screen. */
export function lastOnScreen<T extends Point>(points: T[], width: number, height: number, margin: number): T | null {
  let last: T | null = null
  for (const p of points) {
    if (p.x < margin || p.y < margin || p.x > width - margin || p.y > height - margin) break
    last = p
  }
  return last
}

/**
 * A minimal compass marking north, east, south and west around (`x`, `y`): a
 * thin ring of `radius` pixels with a tick at each, north's a small pointer.
 * `dirOf` gives the screen direction (pixels per pixel of ring) of a compass
 * bearing: straight up for north on a north-up map, or squashed and turned for
 * one lying on a tilted floor. The letters always stand upright.
 */
export function drawCompass(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  dirOf: (deg: number) => Point = (deg) => ({ x: Math.sin((deg * Math.PI) / 180), y: -Math.cos((deg * Math.PI) / 180) }),
) {
  const at = (deg: number, r: number) => {
    const d = dirOf(deg)
    return { x: x + d.x * r, y: y + d.y * r }
  }
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 1
  ctx.strokeStyle = COMPASS_RING
  ctx.beginPath()
  for (let deg = 0; deg <= 360; deg += 10) {
    const p = at(deg, radius)
    if (deg === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
  // Ticks in from the ring at east, south and west...
  ctx.strokeStyle = COMPASS_TICK
  ctx.beginPath()
  for (const deg of [90, 180, 270]) {
    const [a, b] = [at(deg, radius), at(deg, radius * 0.72)]
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
  }
  ctx.stroke()
  // ...and a slim pointer for north.
  const [tip, left, right] = [at(0, radius), at(-14, radius * 0.5), at(14, radius * 0.5)]
  ctx.fillStyle = COMPASS_NORTH
  ctx.beginPath()
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(left.x, left.y)
  ctx.lineTo(right.x, right.y)
  ctx.closePath()
  ctx.fill()

  // The letters just outside the ring, a fixed gap out from it whatever the tilt.
  const size = Math.max(Math.round(radius * 0.5), 8)
  ctx.font = `${size}px ${mapStyle().fontFamily}`
  ctx.letterSpacing = '0px'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const [deg, letter] of [
    [0, 'N'],
    [90, 'E'],
    [180, 'S'],
    [270, 'W'],
  ] as const) {
    const d = dirOf(deg)
    const length = Math.hypot(d.x, d.y) || 1
    const gap = size * 0.85
    const p = at(deg, radius)
    ctx.fillStyle = deg === 0 ? COMPASS_NORTH : COMPASS_LETTER
    ctx.fillText(letter, p.x + (d.x / length) * gap, p.y + (d.y / length) * gap)
  }
  ctx.restore()
}

const COMPASS_RING = 'rgba(170, 195, 230, 0.28)'
const COMPASS_TICK = 'rgba(170, 195, 230, 0.5)'
const COMPASS_LETTER = 'rgba(190, 205, 230, 0.55)'
const COMPASS_NORTH = 'rgba(241, 243, 246, 0.95)'

/** How far in from the screen's edge a route's label stays. */
const ROUTE_LABEL_MARGIN_PX = 40
