import { PROCEDURES } from '../../config/config'
import { proceduresToShow, type ProcedureMatch } from '../../domain/procedures/matcher'
import { pieceRole, procedurePieces, shownWaypoints, type Procedure, type ProcedureKind } from '../../domain/procedures/procedures'
import { focusRoute, type FocusRoute, type RouteLine } from '../../domain/procedures/route'
import type { LatLon } from '../../domain/tracking/tracker'
import { mapStyle } from './mapStyle'
import type { Point, Projection } from './renderer'

/**
 * STARs, SIDs and approaches under the aircraft (see proceduresToShow): those
 * picked in the panel, each a thin line with a soft glow, chevrons along it
 * pointing the way it's flown (an approach's missed approach dashed), and its
 * waypoints as four-pointed stars (as on the charts), named; and the followed
 * flight's (`focus`) STAR or SID, and approach, as it flies them
 * (drawFocusRoute). Each kind has its own color (PROCEDURES.starColor,
 * sidColor, approachColor), apart from the aircraft's.
 */
export function drawProcedures(ctx: CanvasRenderingContext2D, project: Projection, focus: { hex: string; pos: LatLon } | null) {
  if (!PROCEDURES.show2d) return
  const { shown, focus: match, approach } = proceduresToShow(focus?.hex ?? null)
  const routes = focus
    ? ([match, approach].filter(Boolean) as ProcedureMatch[]).flatMap((m) => {
        const route = focusRoute(m, focus.pos)
        return route ? [{ route, match: m }] : []
      })
    : []
  const lone = shownWaypoints()
  if (shown.length === 0 && routes.length === 0 && lone.length === 0) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const labelled = new Set<string>()
  for (const [procedure, kind] of shown) drawLines(ctx, project, procedure, procedureColor(kind))
  // The followed flight's on top, its waypoints labelled first (with their altitudes).
  for (const { route, match: m } of routes) drawFocusRoute(ctx, project, route, m, labelled)
  for (const [procedure, kind] of shown) drawWaypoints(ctx, project, procedure, procedureColor(kind), labelled)
  // Waypoints on their own (the Waypoints tab), as set there: named, with their charted altitude.
  if (lone.length > 0) {
    const { labelSize, fontFamily } = mapStyle()
    const font = `${Math.max(labelSize - 3, 8)}px ${fontFamily}`
    const { width, height } = ctx.canvas.getBoundingClientRect()
    for (const w of lone) {
      if (labelled.has(w.name)) continue
      const q = project(w.at)
      // Off screen: nothing to draw.
      if (q.x < -50 || q.y < -20 || q.x > width + 50 || q.y > height + 20) continue
      const label = PROCEDURES.waypointLabels ? (w.alt ? `${w.name} ${w.alt}` : w.name) : null
      drawWaypoint(ctx, q.x, q.y, PROCEDURES.waypointColor, PROCEDURES.waypointOpacity, PROCEDURES.waypointSize, label, font)
    }
  }
  ctx.restore()
}

/**
 * The followed flight's procedure as it flies it: the way it's come, fainter,
 * through the waypoints it's passed; the way ahead, bright, with chevrons and
 * the altitude to cross each waypoint at; and dashed, the branches it may yet
 * take (a STAR's runway transitions, a SID's exits), each named at its end.
 */
function drawFocusRoute(ctx: CanvasRenderingContext2D, project: Projection, route: FocusRoute, match: ProcedureMatch, labelled: Set<string>) {
  const color = procedureColor(match.kind)
  const { labelSize, fontFamily } = mapStyle()
  const font = `${Math.max(labelSize - 3, 8)}px ${fontFamily}`
  const bright = Math.min(1, PROCEDURES.opacity * 2)
  ctx.strokeStyle = color

  // Branches, under the rest.
  ctx.setLineDash([5, 5])
  for (const branch of route.branches) {
    trace(ctx, branch.points.map(project))
    ctx.globalAlpha = PROCEDURES.opacity
    ctx.lineWidth = 1.2
    ctx.stroke()
  }
  ctx.setLineDash([])

  // The way it's come.
  trace(ctx, route.flown.points.map(project))
  ctx.globalAlpha = PROCEDURES.opacity * 0.6
  ctx.lineWidth = 1.5
  ctx.stroke()

  // The way ahead: dashed while it's only predicted (from where it's coming from or going).
  const ahead = route.ahead.points.map(project)
  ctx.setLineDash(match.predicted ? [8, 6] : [])
  trace(ctx, ahead)
  ctx.globalAlpha = bright * 0.2
  ctx.lineWidth = 7
  ctx.stroke()
  ctx.globalAlpha = bright
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.setLineDash([])
  drawChevrons(ctx, ahead, bright)

  const mark = (line: RouteLine, opacity: number, size: number, withAlt: boolean) =>
    line.points.forEach((p, i) => {
      const name = line.names[i]
      if (labelled.has(name)) return
      labelled.add(name)
      const q = project(p)
      const alt = withAlt ? legAltitude(match.procedure, name) : null
      drawWaypoint(ctx, q.x, q.y, color, opacity, size, alt ? `${name} ${alt}` : name, font)
    })
  mark({ ...route.ahead, points: route.ahead.points.slice(1), names: route.ahead.names.slice(1) }, 1, 5, true)
  mark(route.flown, 0.55, 3.5, false)
  for (const branch of route.branches) mark(branch, PROCEDURES.opacity * 1.4, 3.5, true)

  // Each branch named at its end, and the procedure by the next waypoint.
  ctx.font = `600 ${Math.max(labelSize - 3, 8)}px ${fontFamily}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = color
  for (const branch of route.branches) {
    if (!branch.label) continue
    const q = project(branch.points[branch.points.length - 1])
    ctx.globalAlpha = PROCEDURES.opacity * 1.4
    withHalo(ctx, () => ctx.fillText(branch.label!, q.x + 8, q.y + 6))
  }
  const next = route.ahead.points[1] ?? route.ahead.points[0]
  if (next) {
    const q = project(next)
    ctx.globalAlpha = 1
    ctx.font = `600 ${Math.max(labelSize - 1, 9)}px ${fontFamily}`
    ctx.textBaseline = 'bottom'
    const name = `${match.procedure.name}${match.transition ? ` · ${match.transition}` : ''}${match.predicted ? ' · predicted' : ''}`
    withHalo(ctx, () => ctx.fillText(name, q.x + 8, q.y - 8))
  }
}

export function procedureColor(kind: ProcedureKind) {
  return kind === 'star' ? PROCEDURES.starColor : kind === 'sid' ? PROCEDURES.sidColor : PROCEDURES.approachColor
}

/** Pixels between the chevrons along a line. */
const CHEVRON_SPACING = 70
const CHEVRON_SIZE = 3.5

function drawLines(ctx: CanvasRenderingContext2D, project: Projection, procedure: Procedure, color: string) {
  const opacity = PROCEDURES.opacity
  ctx.strokeStyle = color
  for (const piece of procedurePieces(procedure)) {
    const points = piece.points.map(project)
    // An approach's missed approach, dashed: flown only by those going around.
    ctx.setLineDash(pieceRole(piece) === 'missed' ? [5, 5] : [])
    trace(ctx, points)
    // A soft glow under a thin line.
    ctx.globalAlpha = opacity * 0.18
    ctx.lineWidth = 4
    ctx.stroke()
    ctx.globalAlpha = opacity
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
    drawChevrons(ctx, points, opacity)
  }
}

function trace(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath()
  points.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)))
}

/** Small open chevrons along the line, pointing the way it's flown. */
function drawChevrons(ctx: CanvasRenderingContext2D, points: Point[], alpha: number) {
  ctx.globalAlpha = alpha
  ctx.lineWidth = 1
  let carried = CHEVRON_SPACING / 2
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) continue
    const ux = (b.x - a.x) / length
    const uy = (b.y - a.y) / length
    let along = carried
    for (; along < length; along += CHEVRON_SPACING) {
      const x = a.x + ux * along
      const y = a.y + uy * along
      ctx.beginPath()
      ctx.moveTo(x - ux * CHEVRON_SIZE - uy * CHEVRON_SIZE, y - uy * CHEVRON_SIZE + ux * CHEVRON_SIZE)
      ctx.lineTo(x, y)
      ctx.lineTo(x - ux * CHEVRON_SIZE + uy * CHEVRON_SIZE, y - uy * CHEVRON_SIZE - ux * CHEVRON_SIZE)
      ctx.stroke()
    }
    carried = along - length
  }
}

function drawWaypoints(ctx: CanvasRenderingContext2D, project: Projection, procedure: Procedure, color: string, labelled: Set<string>) {
  const opacity = Math.min(1, PROCEDURES.opacity * 1.4)
  const { labelSize, fontFamily } = mapStyle()
  const font = `${Math.max(labelSize - 3, 8)}px ${fontFamily}`
  for (const piece of procedurePieces(procedure)) {
    piece.points.forEach((p, i) => {
      const name = piece.names[i]
      if (labelled.has(name)) return
      labelled.add(name)
      const q = project(p)
      drawWaypoint(ctx, q.x, q.y, color, opacity, 4, PROCEDURES.labels ? name : null, font)
    })
  }
}

/**
 * A waypoint as on the charts: a four-pointed star, outlined dark so it stands
 * out over the map, with its name (if `label`) beside it, letter-spaced, with a
 * dark halo. Shared with the 3D map's labels.
 */
export function drawWaypoint(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, opacity: number, size: number, label: string | null, font: string) {
  ctx.globalAlpha = opacity
  const waist = size * 0.32
  ctx.beginPath()
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? size : waist
    const angle = (i * Math.PI) / 4 - Math.PI / 2
    const px = x + Math.cos(angle) * r
    const py = y + Math.sin(angle) * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(3, 5, 10, 0.85)'
  ctx.stroke()
  ctx.fillStyle = color
  ctx.fill()
  if (!label) return
  ctx.font = font
  ctx.letterSpacing = '1px'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.globalAlpha = opacity * 0.9
  withHalo(ctx, () => ctx.fillText(label, x + size + 3, y))
  ctx.letterSpacing = '0px'
}

/** Draws text with a soft dark halo, so it reads over terrain and radar. */
function withHalo(ctx: CanvasRenderingContext2D, draw: () => void) {
  ctx.shadowColor = 'rgba(3, 5, 10, 0.9)'
  ctx.shadowBlur = 3
  draw()
  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'
}

/** The altitude a procedure has its aircraft cross `fix` at, as charted. */
export function legAltitude(procedure: Procedure, fix: string): string | null {
  for (const legs of [procedure.route, ...Object.values(procedure.transitions ?? {}), ...Object.values(procedure.runwayTransitions ?? {}), procedure.missedApproach ?? []]) {
    for (const leg of legs) if (typeof leg !== 'string' && leg.fix === fix && leg.alt) return leg.alt
  }
  return null
}
