import { useEffect, useRef, type RefObject } from 'react'
import { CENTER, MAP, VIEW_RADIUS_NM } from '../config/config'
import { watchMapLayers, type MapLayers } from './mapLayers'
import { createProjection, createView, drawAssistPaths, drawFocusBrackets, drawFocusRoute, drawTracks, labelFont, renderBackground, type Point } from './renderer'
import { settingsVersion } from '../config/settings'
import type { GroundTracker } from '../tracking/groundTracker'
import { locateAircraft, routeOf, selectAircraft, selectedAircraft } from '../tracking/selection'
import type { Tracker } from '../tracking/tracker'
import { uncoveredArea } from '../lib/layout'
import { isDoubleTap, TAP_SLOP_PX, type Tap } from '../lib/touch'
import './AirTrafficCanvas.css'

/**
 * Full-screen map canvas driven by requestAnimationFrame. All per-frame work
 * happens outside React so the 60 fps loop never triggers a re-render.
 *
 * `overlay` is the board drawn on top of the map; the map centers itself in the
 * area the board leaves uncovered.
 *
 * Drag to pan the map; double-click to put the airport back in the middle.
 * Click an aircraft (or pick one on the board) to follow it in the middle of the
 * map until it's let go, when the map slides back to where it was.
 */
export function AirTrafficCanvas({
  tracker,
  ground,
  overlay,
}: {
  tracker: Tracker
  ground: GroundTracker
  overlay: RefObject<HTMLElement | null>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d', { alpha: false })!

    let width = 0
    let height = 0
    let dpr = 1
    let layers: MapLayers = { basemap: null, radar: null, terrain: null }
    let view = createView(1, 1, VIEW_RADIUS_NM)
    let project = createProjection(view, CENTER)
    let background = renderBackground(1, 1, 1, view, project, null)
    // How far the map has been dragged (pixels), and the drag in progress.
    let pan = { x: 0, y: 0 }
    let dragging: { startX: number; startY: number; dx: number; dy: number } | null = null
    // The centered view for the current size, before panning.
    let baseView = view
    // The part of the map the board leaves uncovered, from the top-left corner.
    let visible = { width: 1, height: 1 }
    // The pan the background was last drawn at; drawn shifted while the map slides along after an aircraft.
    let bakedPan = pan
    let bakedAt = 0
    // Where the map was panned before following an aircraft, to slide back to after.
    let home: { x: number; y: number } | null = null
    let lastFrame = performance.now()
    // Where each aircraft was drawn last frame, for clicking on one.
    let hits: { hex: string; at: Point }[] = []

    /** Rebuilds the view and projection from the size and the pan. */
    const placeView = () => {
      view = { ...baseView, cx: baseView.cx + pan.x, cy: baseView.cy + pan.y }
      project = createProjection(view, CENTER)
    }

    const redrawBackground = () => {
      bakedPan = pan
      bakedAt = performance.now()
      background = renderBackground(width, height, dpr, view, project, layers.basemap, layers.radar, layers.terrain)
    }

    const resize = () => {
      dpr = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      visible = uncoveredArea(width, height, overlay.current)
      baseView = createView(visible.width, visible.height, VIEW_RADIUS_NM)
      placeView()
      redrawBackground()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    if (overlay.current) observer.observe(overlay.current)
    resize()

    // Radar is baked into the background too, so it costs nothing per frame;
    // the background is redrawn whenever a new scan arrives.
    const stopLayers = watchMapLayers((loaded) => {
      layers = loaded
      redrawBackground()
    })

    // Labels baked into the background need redrawing once the web font arrives.
    document.fonts.load(labelFont()).then(redrawBackground, () => {})

    // Panning. While dragging, the cached background just slides along (redrawing it
    // every move would be slow with big basemaps); it's redrawn in place on release.
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      canvas.setPointerCapture(e.pointerId)
      dragging = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 }
      canvas.classList.add('is-dragging')
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      dragging.dx = e.clientX - dragging.startX
      dragging.dy = e.clientY - dragging.startY
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return
      const tapped = Math.hypot(dragging.dx, dragging.dy) < TAP_SLOP_PX
      // While following, the aircraft holds the map in place.
      if (!home) pan = { x: pan.x + dragging.dx, y: pan.y + dragging.dy }
      dragging = null
      canvas.classList.remove('is-dragging')
      placeView()
      redrawBackground()
      if (tapped && e.type === 'pointerup') {
        const hex = aircraftAt(e.clientX, e.clientY)
        if (hex) {
          selectAircraft(hex)
          return
        }
      }
      // Touchscreens don't reliably send dblclick: two quick taps re-center too.
      if (e.type === 'pointerup' && e.pointerType !== 'mouse' && tapped) {
        if (isDoubleTap(lastTap, e)) {
          lastTap = null
          onDoubleClick()
        } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY }
      }
    }
    let lastTap: Tap | null = null
    const onDoubleClick = () => {
      if (home) return
      pan = { x: 0, y: 0 }
      placeView()
      redrawBackground()
    }
    /** The aircraft drawn nearest a point (client pixels), if close enough to count as clicked. */
    const aircraftAt = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      let best: string | null = null
      let bestDistance = PICK_RADIUS_PX
      for (const { hex, at } of hits) {
        const d = Math.hypot(at.x - (clientX - rect.left), at.y - (clientY - rect.top))
        if (d < bestDistance) {
          best = hex
          bestDistance = d
        }
      }
      return best
    }
    const onHover = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && !dragging) canvas.classList.toggle('is-over-aircraft', aircraftAt(e.clientX, e.clientY) !== null)
    }

    /**
     * Slides the map so the followed aircraft stays in the middle, easing over to
     * it at first; once it's let go, slides back to where the map was.
     */
    const follow = (now: number) => {
      const dt = Math.min(now - lastFrame, 100)
      lastFrame = now
      const hex = selectedAircraft()
      const focus = hex ? locateAircraft(hex, tracker, ground) : null
      let goal: { x: number; y: number } | null = null
      if (focus) {
        home ??= pan
        const at = createProjection(baseView, CENTER)(focus.pos)
        goal = { x: baseView.cx - at.x, y: baseView.cy - at.y }
      } else if (home) {
        goal = home
      }
      if (!goal) return null
      const ease = 1 - Math.exp(-dt / FOLLOW_EASE_MS)
      pan = { x: pan.x + (goal.x - pan.x) * ease, y: pan.y + (goal.y - pan.y) * ease }
      if (!focus && Math.hypot(goal.x - pan.x, goal.y - pan.y) < 0.5) {
        pan = goal
        home = null
        placeView()
        redrawBackground()
        return null
      }
      placeView()
      // Redraw the background now and then as it slides along, rather than every frame.
      const drift = Math.hypot(pan.x - bakedPan.x, pan.y - bakedPan.y)
      if (drift > Math.min(width, height) * 0.2 || (drift > 0.5 && now - bakedAt > REBAKE_MS)) redrawBackground()
      return focus
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onHover)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('dblclick', onDoubleClick)

    // Ring spacing, radar opacity and label size are baked into the background.
    let builtSettings = settingsVersion()
    let frame = requestAnimationFrame(function loop(now) {
      if (settingsVersion() !== builtSettings) {
        builtSettings = settingsVersion()
        redrawBackground()
      }
      tracker.step(now)
      ground.step(now)
      const focus = follow(now)
      // How far the map has moved since the background was drawn: by a drag, or following an aircraft.
      const drag = dragging && !home ? { x: dragging.dx, y: dragging.dy } : { x: 0, y: 0 }
      const dx = pan.x + drag.x - bakedPan.x
      const dy = pan.y + drag.y - bakedPan.y
      let drawn = project
      if (dx || dy) {
        // Slide the cached background; what it doesn't cover yet is plain backdrop.
        ctx.fillStyle = BACKDROP
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(background, dx, dy, width, height)
        drawn = createProjection({ ...view, cx: view.cx + drag.x, cy: view.cy + drag.y }, CENTER)
      } else {
        ctx.drawImage(background, 0, 0, width, height)
      }
      // The landing and takeoff paths aircraft are being guided along, under them.
      if (MAP.showAssistPaths) {
        const paths = []
        for (const t of tracker.tracks.values()) {
          const path = t.opacity > 0 ? tracker.assistPath(t) : null
          if (path) paths.push({ ...path, opacity: t.opacity })
        }
        // Departures still on the ground: lined up, or rolling.
        for (const g of ground.tracks.values()) {
          const path = g.opacity > 0 ? tracker.groundAssistPath(g) : null
          if (path) paths.push({ ...path, opacity: g.opacity })
        }
        drawAssistPaths(ctx, paths, drawn)
      }
      // The followed flight's route to its destination or from its origin, under the aircraft.
      const route = focus && routeOf(focus)
      if (route) drawFocusRoute(ctx, route, drawn, MAP.traffic[route.kind].color, visible.width, visible.height)
      drawTracks(ctx, tracker.tracks.values(), drawn)
      hits = []
      for (const t of tracker.tracks.values()) {
        if (t.opacity > 0 && MAP.traffic[t.info.kind].show) hits.push({ hex: t.info.hex, at: drawn(t.pos) })
      }
      if (focus) {
        const at = drawn(focus.pos)
        drawFocusBrackets(ctx, at.x, at.y)
      }
      frame = requestAnimationFrame(loop)
    })

    return () => {
      stopLayers()
      cancelAnimationFrame(frame)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onHover)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('dblclick', onDoubleClick)
    }
  }, [tracker, ground, overlay])

  return <canvas ref={canvasRef} className="radar map2d" title="Drag to move the map · double-click to recenter · click an aircraft to follow it" />
}

/** How close (pixels) a click has to be to an aircraft to pick it. */
const PICK_RADIUS_PX = 20
/** Time constant (ms) of the map's slide toward a followed aircraft, and back. */
const FOLLOW_EASE_MS = 180
/** While following, the background is redrawn at least this often (ms) as the map slides. */
const REBAKE_MS = 1500

/** The map's backdrop color at its edges, for uncovered areas while dragging. */
const BACKDROP = '#03050a'
