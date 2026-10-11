import { useEffect, useRef, type RefObject } from 'react'
import { uncoveredArea } from '../lib/layout'
import { Map3D } from './map3d'
import { cancelPicking, orbitAnchor, plantAxis, setAnchorHeight, subscribeOrbitAnchor } from './orbitAnchor'
import { watchMapLayers, type MapLayers } from '../map/mapLayers'
import { labelFont } from '../map/renderer'
import { RESET_CAMERA_EVENT, settingsVersion } from '../config/settings'
import { STORE_CAMERA_EVENT } from '../config/profiles'
import type { Tracker } from '../tracking/tracker'
import './AirTraffic3D.css'

/**
 * The 3D map: a full-screen WebGL scene (see map3d.ts) with a 2D canvas over it
 * for labels. Drag to orbit, right-drag to pan, scroll or pinch to zoom; the
 * camera is remembered. While orbiting, the axis button lets two clicks pick
 * the point the camera circles: an axis on the ground, then a height up it. Like the flat map, it draws outside
 * React every frame and centers itself in the area the board (`overlay`) leaves
 * uncovered.
 */
export function AirTraffic3D({ tracker, overlay }: { tracker: Tracker; overlay: RefObject<HTMLElement | null> }) {
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

    const reset = () => map.resetCamera()
    window.addEventListener(RESET_CAMERA_EVENT, reset)
    const storeCamera = () => map.saveCamera()
    window.addEventListener(STORE_CAMERA_EVENT, storeCamera)

    // Placing the orbit point: a click (not a drag, which still turns the view) on the
    // ground plants the axis, then another picks how high up it the point sits.
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      down = orbitAnchor().picking && e.button === 0 ? { x: e.clientX, y: e.clientY } : null
    }
    const onUp = (e: PointerEvent) => {
      if (!down || !orbitAnchor().picking) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved > CLICK_SLOP_PX) return
      const { picking, foot } = orbitAnchor()
      if (picking === 'axis') {
        const point = map.pickGround(e.clientX, e.clientY)
        if (point) plantAxis({ x: point.x, y: point.y, z: point.z })
      } else if (picking === 'height' && foot) {
        const z = map.pickHeight(e.clientX, e.clientY, foot)
        if (z !== null) setAnchorHeight(z)
      }
    }
    const onMove = (e: PointerEvent) => map.setPointer({ x: e.clientX, y: e.clientY })
    const onLeave = () => map.setPointer(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && orbitAnchor().picking) cancelPicking()
    }
    const showPicking = () => canvas.classList.toggle('is-picking', orbitAnchor().picking !== false)
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
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
      map.render(tracker.tracks.values())
      frame = requestAnimationFrame(loop)
    })

    return () => {
      stopLayers()
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener(RESET_CAMERA_EVENT, reset)
      window.removeEventListener(STORE_CAMERA_EVENT, storeCamera)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('keydown', onKey)
      stopAnchor()
      cancelPicking()
      map.dispose()
    }
  }, [tracker, overlay])

  return (
    <>
      <canvas ref={canvasRef} className="radar map3d" />
      <canvas ref={labelsRef} className="radar map3d-labels" />
    </>
  )
}

/** A press that moves less than this before release counts as a click. */
const CLICK_SLOP_PX = 5
