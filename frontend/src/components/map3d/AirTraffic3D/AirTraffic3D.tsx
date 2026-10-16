import { useEffect, useRef, type RefObject } from 'react'
import { isDoubleTap, TAP_SLOP_PX, type Tap } from '../../../utils/touch'
import { uncoveredArea } from '../../../utils/layout'
import { AIRPORT, MAP3D } from '../../../config/config'
import { fetchAirportLayout } from '../../../services/api/basemap'
import { Map3D } from '../../../rendering/map3d/map3d'
import { cancelPicking, orbitAnchor, plantAxis, setAnchorHeight, subscribeOrbitAnchor } from '../../../state/orbitAnchor'
import { leaveStreetView, setStreetAvailable, standAt, streetView, subscribeStreetView } from '../../../state/streetView'
import { inTowerView, TOWER_SPOT } from '../../../rendering/map3d/tower'
import { watchMapLayers, type MapLayers } from '../../../rendering/map/mapLayers'
import { labelFont } from '../../../rendering/map/renderer'
import { RESET_CAMERA_EVENT, setSetting, settingsVersion, TOWER_SETTING } from '../../../state/settings'
import { STORE_CAMERA_EVENT } from '../../../state/profiles'
import type { GroundTracker } from '../../../domain/tracking/groundTracker'
import { locateAircraft, rideView, routeOf, selectAircraft, selectedAircraft } from '../../../state/selection'
import type { Tracker } from '../../../domain/tracking/tracker'
import './AirTraffic3D.css'

/**
 * The 3D map: a full-screen WebGL scene (see map3d.ts) with a 2D canvas over it
 * for labels. Drag to orbit, right-drag to pan, scroll or pinch to zoom; the
 * camera is remembered. While orbiting, the axis button lets two clicks pick
 * the point the camera circles: an axis on the ground, then a height up it. Clicking an aircraft
 * (or picking one on the board) follows it until it's let go; riding along with it, dragging looks
 * around and scrolling zooms. Like the flat map, it draws outside
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
    let layers: MapLayers = { basemap: null, radar: null, terrain: null, clouds: null, echoTops: null }
    const redrawGround = () => map.setBackground(layers)
    map.setAssistPaths(
      (t) => tracker.assistPath(t),
      (g) => tracker.groundAssistPath(g),
    )
    map.setRunwayGuides((now) => tracker.runwayGuides(now))
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
      // The clouds are sheets of their own, not part of the ground.
      if (loaded.clouds && loaded.clouds !== layers.clouds) map.setClouds(loaded.clouds)
      if (loaded.echoTops !== layers.echoTops) map.setEchoTops(loaded.echoTops)
      const groundChanged = loaded.basemap !== layers.basemap || loaded.radar !== layers.radar || loaded.terrain !== layers.terrain
      layers = loaded
      if (groundChanged) redrawGround()
    })
    document.fonts.load(labelFont()).then(redrawGround, () => {})

    // The airport itself, laid on the map at true size.
    const layoutRequest = new AbortController()
    fetchAirportLayout(AIRPORT, layoutRequest.signal)
      .then((layout) => {
        map.setAirport(layout)
      })
      .catch((err) => {
        if (!layoutRequest.signal.aborted) console.warn('Airport layout unavailable:', err)
      })

    const reset = () => {
      selectAircraft(null)
      leaveStreetView()
      if (MAP3D.tower) setSetting(TOWER_SETTING, false)
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
      else if (streetView().state === 'placing') {
        // Street view: a click on the ground picks where to stand.
        const point = map.pickGround(e.clientX, e.clientY)
        if (point) standAt({ x: point.x, y: point.y })
      }
      // Riding along, a click belongs to looking around (a double-click recenters), not picking.
      else if (!map.isRiding()) {
        const hex = map.pickAircraft(e.clientX, e.clientY)
        if (hex) {
          selectAircraft(hex)
          // In the street, turn to it and keep it in view.
          map.trackFromStreet()
        }
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
        canvas.classList.toggle('is-over-aircraft', !map.isRiding() && map.pickAircraft(e.clientX, e.clientY) !== null)
      }
    }
    const onLeave = () => {
      if (!touchAim) map.setPointer(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (orbitAnchor().picking) cancelPicking()
      // Escape lets go of a selected aircraft first (the info panel), then steps out of the street or down from the tower.
      else if (streetView().state === 'placing' || (streetView().state === 'standing' && !selectedAircraft())) leaveStreetView()
      else if (inTowerView() && !selectedAircraft()) setSetting(TOWER_SETTING, false)
    }

    // Riding along with an aircraft or standing in the street (the camera controls are
    // off): dragging looks around, scrolling or pinching zooms, and a double-click or
    // double-tap looks straight ahead again. Riding along, other aircraft are picked
    // from the board; in the street, clicking one turns to it.
    const looking = new Map<number, { x: number; y: number }>()
    let pinch: number | null = null
    let lastTap: Tap | null = null
    const spread = () => {
      const [a, b] = [...looking.values()]
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const onLookDown = (e: PointerEvent) => {
      if (!map.isLooking() || orbitAnchor().picking || (e.pointerType === 'mouse' && e.button !== 0)) return
      canvas.setPointerCapture(e.pointerId)
      looking.set(e.pointerId, { x: e.clientX, y: e.clientY })
      pinch = looking.size === 2 ? spread() : null
    }
    const onLookMove = (e: PointerEvent) => {
      const last = looking.get(e.pointerId)
      if (!last) return
      looking.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (looking.size === 1) map.lookAround(e.clientX - last.x, e.clientY - last.y)
      else if (looking.size === 2 && pinch) {
        const now = spread()
        map.zoomBy(now / pinch)
        pinch = now
      }
    }
    const onLookUp = (e: PointerEvent) => {
      if (!looking.delete(e.pointerId)) return
      pinch = null
      // Touchscreens don't reliably send dblclick: two quick taps recenter too.
      if (e.type === 'pointerup' && e.pointerType !== 'mouse') {
        if (isDoubleTap(lastTap, e)) {
          lastTap = null
          map.recenterLook()
        } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY }
      }
    }
    const onWheel = (e: WheelEvent) => {
      if (!map.isLooking()) return
      e.preventDefault()
      // Lines (Firefox) scroll in bigger steps than pixels.
      const pixels = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      map.zoomBy(Math.exp(-pixels * WHEEL_ZOOM))
    }
    const onDoubleClick = () => {
      if (map.isLooking()) map.recenterLook()
    }
    canvas.addEventListener('pointerdown', onLookDown)
    canvas.addEventListener('pointermove', onLookMove)
    canvas.addEventListener('pointerup', onLookUp)
    canvas.addEventListener('pointercancel', onLookUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDoubleClick)

    // Crosshair while waiting for a click to place the orbit point or where to stand.
    const showPicking = () => {
      canvas.classList.toggle('is-picking', orbitAnchor().picking !== false || streetView().state === 'placing')
      map.setStreetPlacing(streetView().state === 'placing')
    }
    // Capture, so a touch aim turns the camera controls off before they see the touch.
    canvas.addEventListener('pointerdown', onDown, { capture: true })
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    window.addEventListener('keydown', onKey)
    const stopAnchor = subscribeOrbitAnchor(showPicking)
    const stopStreet = subscribeStreetView(showPicking)
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
        hex && focus
          ? {
              hex,
              pos: focus.pos,
              altitude: focus.altitude,
              route: routeOf(focus),
              heading: focus.heading,
              onGround: focus.onGround,
              groundSpeed: focus.info.groundSpeed,
              verticalRate: focus.info.verticalRate,
              distanceNm: focus.info.distanceNm,
              info: focus.info,
              ride: rideView(),
            }
          : null,
        ground.tracks.values(),
        // The tower takes over from the street.
        inTowerView() ? TOWER_SPOT : streetView().state === 'standing' ? streetView().spot : null,
      )
      setStreetAvailable(map.isNearAirport())
      frame = requestAnimationFrame(loop)
    })

    return () => {
      stopLayers()
      layoutRequest.abort()
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener(RESET_CAMERA_EVENT, reset)
      window.removeEventListener(STORE_CAMERA_EVENT, storeCamera)
      canvas.removeEventListener('pointerdown', onDown, { capture: true })
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onLookDown)
      canvas.removeEventListener('pointermove', onLookMove)
      canvas.removeEventListener('pointerup', onLookUp)
      canvas.removeEventListener('pointercancel', onLookUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDoubleClick)
      window.removeEventListener('keydown', onKey)
      stopAnchor()
      stopStreet()
      cancelPicking()
      leaveStreetView()
      setStreetAvailable(false)
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
/** Riding along, how much each pixel scrolled zooms in or out. */
const WHEEL_ZOOM = 0.0025
