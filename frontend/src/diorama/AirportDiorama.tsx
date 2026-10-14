import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref, type WheelEvent as ReactWheelEvent } from 'react'
import { AircraftModels } from '../aircraft/aircraftModels'
import { AIRPORT, AIRPORT_PRESET, DIORAMA, MAP } from '../config/config'
import {
  createDioramaView,
  drawDioramaAircraft,
  drawDioramaCaption,
  boxSilhouette,
  drawDioramaFront,
  fetchAirportLayout,
  renderDioramaBackground,
  type AirportLayout,
  type DioramaWind,
  type DioramaView,
  type ViewAngle,
} from './diorama'
import type { GroundTracker } from '../tracking/groundTracker'
import { LockIcon } from '../ui/icons'
import { isDoubleTap, TAP_SLOP_PX, type Tap } from '../lib/touch'
import { drawFocusBrackets, type Point } from '../map/renderer'
import { selectAircraft, selectedAircraft } from '../tracking/selection'
import {
  buttonsStyle,
  clamp,
  maxPanelSize,
  toFractions,
  usePointerOverWhileLocked,
  useWindowSize,
  validPlacement,
  type Placement,
  type SavedPlacement,
} from '../lib/panel'
import { LOCK_SETTING, RESET_DIORAMA_EVENT, setSetting, settingsVersion } from '../config/settings'
import type { Tracker } from '../tracking/tracker'
import { useMetar, type Metar } from '../weather/metar'
import './AirportDiorama.css'

interface Saved {
  placement: SavedPlacement | null
  angle: ViewAngle
}

const STORAGE_KEY = 'airportDiorama'
const DEFAULT_ANGLE: ViewAngle = {
  rotation: DIORAMA.rotationDeg,
  elevation: DIORAMA.elevationDeg,
}
const MIN_SIZE = 160
const MIN_ELEVATION = 10
const MAX_ELEVATION = 90
/** Dragging across the whole panel turns the view this many degrees, whatever its size. */
const DRAG_DEG_PER_PANEL = 160
/** After a flick, the spin slows to a stop with this time constant (ms). */
const SPIN_FRICTION_MS = 350
/** Each wheel notch grows or shrinks the panel by this factor. */
const WHEEL_ZOOM = 1.08
/** How long a touch shows the move and resize handles. */
const TOUCH_REVEAL_MS = 4000
/** How close (pixels) a click has to be to an aircraft to pick it. */
const PICK_RADIUS_PX = 14

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
/** Each edge, between the corners, moves the panel. */
const EDGES = ['top', 'right', 'bottom', 'left'] as const

/**
 * A small tilted 3D view of the airport in the top-right corner: runways,
 * taxiways and terminals, with aircraft taxiing, parked at gates, and flying
 * low overhead. Like the main map, it draws outside React every frame.
 *
 * Drag inside to rotate and tilt (double-click resets the angle), drag the
 * caption strip to move it, and drag the corner handle to resize it. Click an
 * aircraft to follow it, like on the maps (locked, that's all a click does).
 * Drags and scrolls in the empty space around the box, or anywhere but an
 * aircraft while locked, go through to the map underneath.
 * The layout is remembered in this browser.
 */
export function AirportDiorama({ tracker, ground }: { tracker: Tracker; ground: GroundTracker }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const modelsRef = useRef<HTMLCanvasElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const [saved] = useState(loadSaved)
  const [placement, setPlacement] = useState<SavedPlacement | null>(saved.placement)
  const [rotating, setRotating] = useState(false)
  const windowSize = useWindowSize()
  const pointerOver = usePointerOverWhileLocked(containerRef, DIORAMA.locked)
  // Read by the animation loop, which rebuilds the scene when it changes.
  const angleRef = useRef<ViewAngle>(saved.angle)
  // The latest wind, for the vane under the caption.
  const metar = useMetar(AIRPORT_PRESET.icao)
  const windRef = useRef<Omit<DioramaWind, 'since'> | null>(null)
  windRef.current = DIORAMA.showWind && metar ? windOf(metar) : null
  // Where each aircraft was drawn last frame, for clicking on one.
  const hitsRef = useRef<{ hex: string; at: Point }[]>([])
  // The box's outline on the canvas: presses outside it go through to the map.
  const outlineRef = useRef<Point[]>([])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const models = new AircraftModels(modelsRef.current!)
    let width = 0
    let height = 0
    let dpr = 1
    let layout: AirportLayout | null = null
    let view: DioramaView | null = null
    let background: HTMLCanvasElement | null = null
    let builtAngle: ViewAngle | null = null
    let builtSettings = settingsVersion()
    let backdropMask = ''
    // The wind shown, and when it came in (for the vane to swing round to it).
    let wind: DioramaWind | null = null

    const rebuild = () => {
      if (!layout || !width || !height) return
      builtAngle = angleRef.current
      builtSettings = settingsVersion()
      view = createDioramaView(layout, width, height, builtAngle)
      background = renderDioramaBackground(layout, view, width, height, dpr)
      outlineRef.current = boxSilhouette(view)
      backdropMask = silhouetteMask(outlineRef.current, width, height)
    }

    const resize = () => {
      dpr = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      models.resize(width, height, dpr)
      rebuild()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const controller = new AbortController()
    fetchAirportLayout(AIRPORT, controller.signal)
      .then((l) => {
        layout = l
        rebuild()
      })
      .catch((err) => {
        if (!controller.signal.aborted) console.warn('Airport layout unavailable:', err)
      })

    // Labels use the bundled web font; redraw once it arrives.
    document.fonts.load(`10px ${MAP.fontFamily}`).then(rebuild, () => {})

    let frame = requestAnimationFrame(function loop(now) {
      if (angleRef.current !== builtAngle || settingsVersion() !== builtSettings) rebuild()
      // The backdrop can appear after the scene was built (when its setting is turned on).
      const backdrop = backdropRef.current
      if (backdrop && backdrop.dataset.mask !== backdropMask) {
        backdrop.dataset.mask = backdropMask
        backdrop.style.maskImage = backdropMask
      }
      ground.step(now)
      ctx.clearRect(0, 0, width, height)
      if (view && background) {
        ctx.drawImage(background, 0, 0, width, height)
        // Shadows and drop lines stay in 2D; the aircraft go to the WebGL layer above when it's on.
        const use3d = DIORAMA.models3d && models.available
        const poses = drawDioramaAircraft(ctx, view, ground.tracks.values(), tracker.tracks.values(), !use3d)
        drawDioramaFront(ctx, view)
        const latest = windRef.current
        if (!latest) wind = null
        else if (latest.label !== wind?.label) wind = { ...latest, since: now }
        drawDioramaCaption(ctx, view, caption(ground), wind, now, DIORAMA.showCompass)
        models.render(view, use3d ? poses : [])
        const hits = poses.map((p) => ({ hex: p.info.hex, at: view!.toScreen(p.at) }))
        hitsRef.current = hits
        const hex = selectedAircraft()
        const focus = hex ? hits.find((h) => h.hex === hex) : null
        if (focus) drawFocusBrackets(ctx, focus.at.x, focus.at.y)
      } else hitsRef.current = []
      frame = requestAnimationFrame(loop)
    })

    return () => {
      controller.abort()
      cancelAnimationFrame(frame)
      observer.disconnect()
      models.dispose()
    }
  }, [tracker, ground])

  const save = (next: Partial<Saved>) => storeSaved({ placement, angle: angleRef.current, ...next })

  /** Runs `onMove` with the pointer's offset from where the drag started, until it's released. */
  const drag = (e: ReactPointerEvent, onMove: (dx: number, dy: number) => void, onEnd: (ev: PointerEvent) => void) => {
    e.preventDefault()
    e.stopPropagation()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const [startX, startY] = [e.clientX, e.clientY]
    const move = (ev: PointerEvent) => onMove(ev.clientX - startX, ev.clientY - startY)
    const up = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      onEnd(ev)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  /** The panel's current placement in pixels, measured from the page. */
  const currentPlacement = (): Placement => {
    const rect = containerRef.current!.getBoundingClientRect()
    return { left: rect.left, top: rect.top, size: rect.width }
  }

  /** The aircraft drawn nearest a point (client pixels), if close enough to count as clicked. */
  const aircraftAt = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    let best: string | null = null
    let bestDistance = PICK_RADIUS_PX
    for (const { hex, at } of hitsRef.current) {
      const d = Math.hypot(at.x - (clientX - rect.left), at.y - (clientY - rect.top))
      if (d < bestDistance) {
        best = hex
        bestDistance = d
      }
    }
    return best
  }

  /**
   * Whether a press at this point is the panel's: on an aircraft, or (unlocked)
   * inside the box. Anywhere else, the empty space around the box or all but
   * the aircraft while locked, belongs to the map underneath.
   */
  const ownsPoint = (clientX: number, clientY: number) => {
    if (aircraftAt(clientX, clientY) !== null) return true
    if (DIORAMA.locked) return false
    const rect = canvasRef.current!.getBoundingClientRect()
    return insidePolygon(outlineRef.current, clientX - rect.left, clientY - rect.top)
  }

  /** Hands an event to whatever is under the panel at its point (the map), as if the panel weren't there. */
  const passThrough = (e: PointerEvent | WheelEvent) => {
    const container = containerRef.current!
    container.style.visibility = 'hidden'
    const under = document.elementFromPoint(e.clientX, e.clientY)
    container.style.visibility = ''
    if (!under) return
    // The original event's own fields (pointer id, buttons, deltas...) carry over.
    const copy = e instanceof WheelEvent ? new WheelEvent(e.type, e) : new PointerEvent(e.type, e)
    under.dispatchEvent(copy)
    // (React's wheel listener is passive, so only a press can be prevented.)
    if (copy.defaultPrevented && e instanceof PointerEvent) e.preventDefault()
  }

  /** Picks the aircraft under a click or tap that didn't move, if there is one. */
  const pickAt = (ev: PointerEvent, dx: number, dy: number) => {
    if (ev.type !== 'pointerup' || Math.hypot(dx, dy) >= TAP_SLOP_PX) return
    const hex = aircraftAt(ev.clientX, ev.clientY)
    if (hex) selectAircraft(hex)
  }

  /**
   * Drag on the cube: rotate and tilt (right-drag or Shift+drag moves it instead);
   * a click that doesn't move picks the aircraft under it. By touch: one finger
   * rotates, two pinch to resize and drag to move, and a double tap resets the
   * angle. Locked, it only picks aircraft.
   */
  const onCanvasPointerDown = (e: ReactPointerEvent) => {
    // Shift+drag still moves the panel from anywhere on it.
    if (!e.shiftKey && !ownsPoint(e.clientX, e.clientY)) {
      passThrough(e.nativeEvent)
      return
    }
    stopSpin()
    if (DIORAMA.locked) {
      if (e.button !== 0 || !e.isPrimary) return
      let [lastX, lastY] = [0, 0]
      drag(
        e,
        (dx, dy) => ([lastX, lastY] = [dx, dy]),
        (ev) => pickAt(ev, lastX, lastY),
      )
      return
    }
    if (e.pointerType !== 'mouse') {
      const fingers = touchesRef.current
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const lift = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return
        fingers.delete(e.pointerId)
        window.removeEventListener('pointerup', lift)
        window.removeEventListener('pointercancel', lift)
      }
      window.addEventListener('pointerup', lift)
      window.addEventListener('pointercancel', lift)
      if (fingers.size === 2) return startPinch()
      if (fingers.size > 2) return
      if (isDoubleTap(lastTapRef.current, e) && aircraftAt(e.clientX, e.clientY) === null) {
        lastTapRef.current = null
        resetAngle()
        e.preventDefault()
        return
      }
      lastTapRef.current = { t: e.timeStamp, x: e.clientX, y: e.clientY }
    }
    if (e.button === 2 || e.button === 1 || e.shiftKey) startMove(e)
    else if (e.button === 0) startRotate(e)
  }

  // Touch: fingers on the cube, the last tap (for double taps), and whether a pinch
  // has taken over from the one-finger rotation.
  const touchesRef = useRef(new Map<number, { x: number; y: number }>())
  const lastTapRef = useRef<Tap | null>(null)
  const pinchingRef = useRef(false)

  /** Two fingers: their spread resizes the panel and their midpoint moves it. */
  const startPinch = () => {
    const fingers = touchesRef.current
    const [a, b] = [...fingers.values()]
    const start = currentPlacement()
    const startDist = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1)
    const startMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const ids = [...fingers.keys()]
    const maxSize = maxPanelSize()
    let latest = toFractions(start)
    pinchingRef.current = true
    lastTapRef.current = null
    const move = (ev: PointerEvent) => {
      if (!ids.includes(ev.pointerId) || !fingers.has(ev.pointerId)) return
      fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
      const [p, q] = ids.map((id) => fingers.get(id)!)
      if (!p || !q) return
      const size = clamp((start.size * Math.hypot(q.x - p.x, q.y - p.y)) / startDist, MIN_SIZE, maxSize)
      const scale = size / start.size
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
      latest = toFractions({ left: mid.x - (startMid.x - start.left) * scale, top: mid.y - (startMid.y - start.top) * scale, size })
      setPlacement(latest)
    }
    const end = (ev: PointerEvent) => {
      if (!ids.includes(ev.pointerId)) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      pinchingRef.current = false
      save({ placement: latest })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  /** By touch there's no hover to show the move and resize handles, so a touch shows them for a while. */
  const [touched, setTouched] = useState(false)
  const touchedTimer = useRef(0)
  const revealControls = () => {
    setTouched(true)
    clearTimeout(touchedTimer.current)
    touchedTimer.current = window.setTimeout(() => setTouched(false), TOUCH_REVEAL_MS)
  }
  useEffect(() => () => clearTimeout(touchedTimer.current), [])

  const startRotate = (e: ReactPointerEvent) => {
    const start = angleRef.current
    const degPerPx = DRAG_DEG_PER_PANEL / currentPlacement().size
    // Recent pointer samples, to carry on spinning at the release speed.
    const samples: { t: number; dx: number; dy: number }[] = []
    let pinched = false
    let [lastX, lastY] = [0, 0]
    setRotating(true)
    drag(
      e,
      (dx, dy) => {
        // A second finger turned this into a pinch: leave the angle be.
        if (pinchingRef.current || pinched) {
          pinched = true
          return
        }
        ;[lastX, lastY] = [dx, dy]
        angleRef.current = turned(start, dx * degPerPx, dy * degPerPx)
        samples.push({ t: performance.now(), dx, dy })
        if (samples.length > 6) samples.shift()
      },
      (ev) => {
        setRotating(false)
        if (pinched) return
        // Barely moved: a click, not a turn.
        if (Math.hypot(lastX, lastY) < TAP_SLOP_PX) {
          angleRef.current = start
          pickAt(ev, lastX, lastY)
          return
        }
        const [a, b] = [samples[0], samples[samples.length - 1]]
        const dt = b && a ? b.t - a.t : 0
        // Only a flick spins on: a release after holding still stops dead.
        if (dt > 0 && performance.now() - b.t < 80) spin(((b.dx - a.dx) / dt) * degPerPx, ((b.dy - a.dy) / dt) * degPerPx)
        else save({})
      },
    )
  }

  /** Keeps turning at `vr`/`ve` degrees per ms, slowing to a stop. */
  const spinRef = useRef(0)
  const stopSpin = () => cancelAnimationFrame(spinRef.current)
  const spin = (vr: number, ve: number) => {
    let last: number | null = null
    const step = (now: number) => {
      const dt = last === null ? 16 : now - last
      last = now
      const decay = Math.exp(-dt / SPIN_FRICTION_MS)
      vr *= decay
      ve *= decay
      angleRef.current = turned(angleRef.current, vr * dt, ve * dt)
      if (Math.hypot(vr, ve) > 0.002) spinRef.current = requestAnimationFrame(step)
      else save({})
    }
    spinRef.current = requestAnimationFrame(step)
  }
  useEffect(() => stopSpin, [])

  const startMove = (e: ReactPointerEvent) => {
    const start = currentPlacement()
    let latest = toFractions(start)
    drag(
      e,
      (dx, dy) => {
        // Free to go past the screen's edges; the toolbar's reset button brings it back.
        latest = toFractions({ ...start, left: start.left + dx, top: start.top + dy })
        setPlacement(latest)
      },
      () => save({ placement: latest }),
    )
  }

  /** Resizes from a corner, keeping the opposite corner where it is. */
  const startResize = (corner: Corner) => (e: ReactPointerEvent) => {
    const start = currentPlacement()
    const [east, south] = [corner.endsWith('e'), corner.startsWith('s')]
    const right = start.left + start.size
    const bottom = start.top + start.size
    const maxSize = maxPanelSize()
    let latest = toFractions(start)
    drag(
      e,
      (dx, dy) => {
        const size = clamp(start.size + ((east ? dx : -dx) + (south ? dy : -dy)) / 2, MIN_SIZE, maxSize)
        latest = toFractions({ left: east ? start.left : right - size, top: south ? start.top : bottom - size, size })
        setPlacement(latest)
      },
      () => save({ placement: latest }),
    )
  }

  /** Scroll over the cube to grow or shrink it around its middle. Ctrl+scroll is left for page zoom. */
  const onWheel = (e: ReactWheelEvent) => {
    if (e.ctrlKey) return
    // Locked, or outside the box: the map's to zoom.
    if (!ownsPoint(e.clientX, e.clientY)) return passThrough(e.nativeEvent)
    if (e.deltaY === 0) return
    const start = currentPlacement()
    const size = clamp(start.size * (e.deltaY < 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM), MIN_SIZE, maxPanelSize())
    const grow = (size - start.size) / 2
    const next = toFractions({ left: start.left - grow, top: start.top - grow, size })
    setPlacement(next)
    save({ placement: next })
  }

  // The settings panel can put it back in its corner at the starting angle.
  useEffect(() => {
    const reset = (e: Event) => {
      // The toolbar button only brings it back into place; settings also reset the angle.
      const keepAngle = (e as CustomEvent<{ keepAngle?: boolean }>).detail?.keepAngle === true
      if (!keepAngle) angleRef.current = DEFAULT_ANGLE
      setPlacement(null)
      storeSaved({ placement: null, angle: angleRef.current })
    }
    window.addEventListener(RESET_DIORAMA_EVENT, reset)
    return () => window.removeEventListener(RESET_DIORAMA_EVENT, reset)
  }, [])

  const resetAngle = () => {
    stopSpin()
    angleRef.current = DEFAULT_ANGLE
    save({})
  }

  // Viewport units keep it in proportion when the window changes size.
  const style: CSSProperties | undefined = placement
    ? { left: `${placement.left * 100}vw`, top: `${placement.top * 100}vh`, width: `${placement.size * 100}vw`, right: 'auto' }
    : undefined

  return (
    <>
      <Backdrop style={style} ref={backdropRef} />
      <div
        ref={containerRef}
        className={`diorama${rotating ? ' is-rotating' : ''}${DIORAMA.locked ? ' is-locked' : ''}${pointerOver ? ' is-pointer-over' : ''}${touched ? ' is-touched' : ''}`}
        style={style}
        onPointerDownCapture={(e) => e.pointerType !== 'mouse' && revealControls()}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onCanvasPointerDown}
          onDoubleClick={(e) => !DIORAMA.locked && aircraftAt(e.clientX, e.clientY) === null && ownsPoint(e.clientX, e.clientY) && resetAngle()}
          onWheel={onWheel}
          onPointerMove={(e) => {
            if (e.pointerType !== 'mouse' || e.buttons !== 0) return
            e.currentTarget.classList.toggle('is-over-aircraft', aircraftAt(e.clientX, e.clientY) !== null)
            // Outside the box, the map's cursor: a drag there moves the map.
            e.currentTarget.classList.toggle('is-outside', !ownsPoint(e.clientX, e.clientY))
          }}
          onContextMenu={(e) => e.preventDefault()}
          title={
            DIORAMA.locked
              ? 'Click an aircraft to follow it'
              : 'Drag to rotate · right-drag or Shift+drag to move · scroll or pinch to resize · double-click or double-tap to reset · click an aircraft to follow it'
          }
        />
        <canvas ref={modelsRef} className="diorama-models" />
        {EDGES.map((edge) => (
          <div key={edge} className={`diorama-move is-${edge}`} onPointerDown={startMove} title="Drag to move">
            {edge === 'top' && <span className="diorama-grip" />}
          </div>
        ))}
        {CORNERS.map((corner) => (
          <div key={corner} className={`diorama-resize is-${corner}`} onPointerDown={startResize(corner)} title="Drag to resize" />
        ))}
        <div className="diorama-buttons" style={buttonsStyle(placement, windowSize)}>
          <button type="button" className="diorama-reset" onClick={resetAngle} title="Reset the view angle" aria-label="Reset the view angle">
            ↺
          </button>
          {/* Still reachable while locked (the rest of the panel then lets clicks through to the map). */}
          <button
          type="button"
          className="diorama-lock"
          aria-pressed={DIORAMA.locked}
          aria-label={DIORAMA.locked ? 'Unlock the airport view' : 'Lock the airport view'}
          title={DIORAMA.locked ? 'Unlock: allow moving, resizing and rotating' : 'Lock in place'}
          onClick={() => setSetting(LOCK_SETTING, !DIORAMA.locked)}
        >
          <LockIcon locked={DIORAMA.locked} />
          </button>
        </div>
      </div>
    </>
  )
}

/** Whether (x, y) is inside the polygon `points` (even-odd rule). */
function insidePolygon(points: Point[], x: number, y: number) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [a, b] = [points[i], points[j]]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** "KDFW SURFACE  3 TAXIING · 41 PARKED" */
function caption(ground: GroundTracker) {
  let taxiing = 0
  let parked = 0
  for (const t of ground.tracks.values()) {
    if (t.opacity <= 0) continue
    if (t.parked) parked++
    else taxiing++
  }
  return `${AIRPORT_PRESET.icao} SURFACE  ${taxiing} TAXIING · ${parked} PARKED`
}

/** The METAR's wind for the vane, or null if it doesn't report one. */
function windOf({ wdir, wspd, wgst }: Metar): Omit<DioramaWind, 'since'> | null {
  if (wspd === null) return null
  if (wspd === 0) return { dir: null, speed: 0, gusting: false, label: 'WIND CALM' }
  const dir = typeof wdir === 'number' ? wdir : null
  const from = dir === null ? 'VRB' : `${String(dir).padStart(3, '0')}°`
  return { dir, speed: wspd, gusting: !!wgst, label: `WIND ${from} ${wspd}${wgst ? `G${wgst}` : ''} KT` }
}

/**
 * Blurs and/or darkens the map behind the airport so it reads clearly. Masked
 * to the box's outline on screen (set by the animation loop as the view
 * turns), with softened edges.
 *
 * It's a sibling placed exactly under the panel rather than inside it: the
 * panel sits above the board, but this stays below it, so it only ever blurs
 * the map and never the board, METAR or ATIS.
 */
function Backdrop({ style, ref }: { style: CSSProperties | undefined; ref: Ref<HTMLDivElement> }) {
  const blur = DIORAMA.backdropBlur
  const darkness = DIORAMA.backdropDarkness
  if (blur <= 0 && darkness <= 0) return null
  return (
    <div
      ref={ref}
      className="diorama-backdrop"
      style={{
        ...style,
        backdropFilter: blur > 0 ? `blur(${blur}px)` : undefined,
        background: darkness > 0 ? `rgb(3 5 10 / ${darkness})` : undefined,
      }}
    />
  )
}

/**
 * A CSS mask image of `outline` as an SVG polygon whose edge fades out over
 * about DIORAMA.backdropFeather pixels. The polygon is shrunk before it's
 * blurred, so the fade happens mostly inside the outline rather than spilling
 * past it (and being cut off at the panel's edge).
 */
function silhouetteMask(outline: { x: number; y: number }[], width: number, height: number) {
  const points = outline.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const feather = Math.max(DIORAMA.backdropFeather, 0)
  const filter =
    feather > 0
      ? `<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">` +
        `<feMorphology operator="erode" radius="${feather * 0.6}"/>` +
        `<feGaussianBlur stdDeviation="${feather * 0.45}"/></filter>`
      : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `${filter}<polygon points="${points}" fill="#000"${feather > 0 ? ' filter="url(#f)"' : ''}/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

function loadSaved(): Saved {
  const fallback: Saved = { placement: null, angle: DEFAULT_ANGLE }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Saved | null
    if (!saved) return fallback
    return { placement: validPlacement(saved.placement), angle: saved.angle ?? DEFAULT_ANGLE }
  } catch {
    return fallback
  }
}

/** Kept in localStorage, so it lasts across sessions in this browser. */
function storeSaved(saved: Saved) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    // Storage can be unavailable (private windows); the panel just won't remember.
  }
}

/** `angle` turned by `rotation` degrees and tilted by `elevation` degrees (kept in range). */
function turned(angle: ViewAngle, rotation: number, elevation: number): ViewAngle {
  return {
    rotation: (((angle.rotation + rotation) % 360) + 360) % 360,
    elevation: clamp(angle.elevation + elevation, MIN_ELEVATION, MAX_ELEVATION),
  }
}



