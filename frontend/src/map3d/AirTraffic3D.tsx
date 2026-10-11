import { useEffect, useRef, type RefObject } from 'react'
import { TAP_SLOP_PX } from '../lib/touch'
import { uncoveredArea } from '../lib/layout'
import { Map3D } from './map3d'
import { cancelPicking, orbitAnchor, plantAxis, setAnchorHeight, subscribeOrbitAnchor } from './orbitAnchor'
import { watchMapLayers, type MapLayers } from '../map/mapLayers'
import { labelFont } from '../map/renderer'
import { RESET_CAMERA_EVENT, settingsVersion } from '../config/settings'
import { STORE_CAMERA_EVENT } from '../config/profiles'
import type { GroundTracker } from '../tracking/groundTracker'
import { locateAircraft, routeOf, selectAircraft, selectedAircraft } from '../tracking/selection'
import type { Tracker } from '../tracking/tracker'
import './AirTraffic3D.css'

/**
 * The 3D map: a full-screen WebGL scene (see map3d.ts) with a 2D canvas over it
 * for labels. Drag to orbit, right-drag to pan, scroll or pinch to zoom; the
 * camera is remembered. While orbiting, the axis button lets two clicks pick
 * the point the camera circles: an axis on the ground, then a height up it. Clicking an aircraft
 * (or picking one on the board) follows it until it's let go. Like the flat map, it draws outside
 * React every frame and centers itself in the area the board (`overlay`) leaves
 * uncovered.
 */
export function AirTraffic3D({
  tracker,
  ground,
  overlay,
}: {
  tracker: Tracker
  ground: GroundTracker
  overlay: RefObject<HTMLElement | null>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    let map: Map3D
    try {
      map = new Map3D(canvas, labelsRef.current!)
    } catch (err) {
      console.warn('3D map unavailable (no WebGL?):', err)
      return
    }
    let layers: MapLayers = { basemap: null, radar: null, terrain: null }
    const redrawGround = () => map.setBackground(layers)
    redrawGround()

    const resize = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      map.resize(width, height, window.devicePixelRatio || 1, uncoveredArea(width, height, overlay.current))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    if (overlay.current) observer.observe(overlay.current)
    resize()

    const stopLayers = watchMapLayers((loaded) => {
      layers = loaded
      redrawGround()
    })
    document.fonts.load(labelFont()).then(redrawGround, () => {})

    const reset = () => {
      selectAircraft(null)
      map.resetCamera()
    }
    window.addEventListener(RESET_CAMERA_EVENT, reset)
    const storeCamera = () => map.saveCamera()
    window.addEventListener(STORE_CAMERA_EVENT, storeCamera)

    // Placing the orbit point: a click (not a drag, which still turns the view) on the
    // ground plants the axis, then another picks how high up it the point sits. By
    // touch there's no hover to aim with, so the finger aims instead (the view holds
    // still under it) and lifting it places the point.
    // Otherwise a click or tap (not a drag) on an aircraft picks it to follow.
    let down: { x: number; y: number } | null = null
    let touchAim = false
    const onDown = (e: PointerEvent) => {
      down = null
      if (!orbitAnchor().picking) {
        if (e.isPrimary && e.button === 0) down = { x: e.clientX, y: e.clientY }
        return
      }
      if (e.pointerType === 'mouse') {
        if (e.button === 0) down = { x: e.clientX, y: e.clientY }
        return
      }
      touchAim = true
      map.setControlsEnabled(false)
      map.setPointer({ x: e.clientX, y: e.clientY })
    }
    const place = (x: number, y: number) => {
      const { picking, foot } = orbitAnchor()
      if (picking === 'axis') {
        const point = map.pickGround(x, y)
        if (point) plantAxis({ x: point.x, y: point.y, z: point.z })
      } else if (picking === 'height' && foot) {
        const z = map.pickHeight(x, y, foot)
        if (z !== null) setAnchorHeight(z)
      }
    }
    const onUp = (e: PointerEvent) => {
      if (touchAim) {
        touchAim = false
        map.setControlsEnabled(true)
        map.setPointer(null)
        if (orbitAnchor().picking) place(e.clientX, e.clientY)
        return
      }
      if (!down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved > (e.pointerType === 'mouse' ? CLICK_SLOP_PX : TAP_SLOP_PX)) return
      if (orbitAnchor().picking) place(e.clientX, e.clientY)
      else {
        const hex = map.pickAircraft(e.clientX, e.clientY)
        if (hex) selectAircraft(hex)
      }
    }
    const onCancel = () => {
      if (!touchAim) return
      touchAim = false
      map.setControlsEnabled(true)
      map.setPointer(null)
    }
    const onMove = (e: PointerEvent) => {
      map.setPointer({ x: e.clientX, y: e.clientY })
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        canvas.classList.toggle('is-over-aircraft', map.pickAircraft(e.clientX, e.clientY) !== null)
      }
    }
    const onLeave = () => {
      if (!touchAim) map.setPointer(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && orbitAnchor().picking) cancelPicking()
    }
    const showPicking = () => canvas.classList.toggle('is-picking', orbitAnchor().picking !== false)
    // Capture, so a touch aim turns the camera controls off before they see the touch.
    canvas.addEventListener('pointerdown', onDown, { capture: true })
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    window.addEventListener('keydown', onKey)
    const stopAnchor = subscribeOrbitAnchor(showPicking)
    showPicking()

    // Ring spacing, radar opacity and label size are baked into the ground.
    let builtSettings = settingsVersion()
    let frame = requestAnimationFrame(function loop(now) {
      if (settingsVersion() !== builtSettings) {
        builtSettings = settingsVersion()
        redrawGround()
      }
      tracker.step(now)
      ground.step(now)
      const hex = selectedAircraft()
      const focus = hex ? locateAircraft(hex, tracker, ground) : null
      map.render(
        tracker.tracks.values(),
        hex && focus ? { hex, pos: focus.pos, altitude: focus.altitude, route: routeOf(focus) } : null,
      )
      frame = requestAnimationFrame(loop)
    })

    return () => {
      stopLayers()
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener(RESET_CAMERA_EVENT, reset)
      window.removeEventListener(STORE_CAMERA_EVENT, storeCamera)
      canvas.removeEventListener('pointerdown', onDown, { capture: true })
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('keydown', onKey)
      stopAnchor()
      cancelPicking()
      map.dispose()
    }
  }, [tracker, ground, overlay])

  return (
    <>
      <canvas ref={canvasRef} className="radar map3d" />
      <canvas ref={labelsRef} className="radar map3d-labels" />
    </>
  )
}

/** A press that moves less than this before release counts as a click. */
const CLICK_SLOP_PX = 5
