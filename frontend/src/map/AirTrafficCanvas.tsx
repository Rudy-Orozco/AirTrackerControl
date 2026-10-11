import { useEffect, useRef, type RefObject } from 'react'
import { CENTER, VIEW_RADIUS_NM } from '../config/config'
import { watchMapLayers, type MapLayers } from './mapLayers'
import { createProjection, createView, drawTracks, labelFont, renderBackground } from './renderer'
import { settingsVersion } from '../config/settings'
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
 */
export function AirTrafficCanvas({ tracker, overlay }: { tracker: Tracker; overlay: RefObject<HTMLElement | null> }) {
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

    /** Rebuilds the view and projection from the size and the pan. */
    const placeView = () => {
      view = { ...baseView, cx: baseView.cx + pan.x, cy: baseView.cy + pan.y }
      project = createProjection(view, CENTER)
    }

    const redrawBackground = () => {
      background = renderBackground(width, height, dpr, view, project, layers.basemap, layers.radar, layers.terrain)
    }

    const resize = () => {
      dpr = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const visible = uncoveredArea(width, height, overlay.current)
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
      pan = { x: pan.x + dragging.dx, y: pan.y + dragging.dy }
      dragging = null
      canvas.classList.remove('is-dragging')
      placeView()
      redrawBackground()
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
      pan = { x: 0, y: 0 }
      placeView()
      redrawBackground()
    }
    canvas.addEventListener('pointerdown', onPointerDown)
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
      if (dragging && (dragging.dx || dragging.dy)) {
        // Slide the cached background; what it doesn't cover yet is plain backdrop.
        ctx.fillStyle = BACKDROP
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(background, dragging.dx, dragging.dy, width, height)
        const moved = { ...view, cx: view.cx + dragging.dx, cy: view.cy + dragging.dy }
        drawTracks(ctx, tracker.tracks.values(), createProjection(moved, CENTER))
      } else {
        ctx.drawImage(background, 0, 0, width, height)
        drawTracks(ctx, tracker.tracks.values(), project)
      }
      frame = requestAnimationFrame(loop)
    })

    return () => {
      stopLayers()
      cancelAnimationFrame(frame)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('dblclick', onDoubleClick)
    }
  }, [tracker, overlay])

  return <canvas ref={canvasRef} className="radar map2d" title="Drag to move the map · double-click to recenter" />
}

/** The map's backdrop color at its edges, for uncovered areas while dragging. */
const BACKDROP = '#03050a'
