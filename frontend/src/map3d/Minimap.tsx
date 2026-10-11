import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { CENTER, MINIMAP } from '../config/config'
import { MINIMAP_LOCK_SETTING, MINIMAP_TOWER_LOCK_SETTING, RESET_MINIMAP_EVENT, setSetting, settingsVersion } from '../config/settings'
import { watchMapLayers, type MapLayers } from '../map/mapLayers'
import { withMapStyle } from '../map/mapStyle'
import { createProjection, createView, drawAssistPaths, drawFocusBrackets, drawRunwayGuides, drawTracks, labelFont, renderBackground, type Point } from '../map/renderer'
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
import { TAP_SLOP_PX } from '../lib/touch'
import type { GroundTracker } from '../tracking/groundTracker'
import { locateAircraft, selectAircraft, selectedAircraft } from '../tracking/selection'
import type { Tracker } from '../tracking/tracker'
import { LockIcon } from '../ui/icons'
import { minimapInBoard } from './tower'
import './Minimap.css'

const STORAGE_KEY = 'minimap'
const MIN_SIZE = 100
/** Each wheel notch grows or shrinks the panel by this factor. */
const WHEEL_ZOOM = 1.08
/** How long a touch shows the move and resize handles. */
const TOUCH_REVEAL_MS = 4000
/** How close (pixels) a click has to be to an aircraft to pick it. */
const PICK_RADIUS_PX = 14

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

/**
 * A small flat map in a corner of the 3D map: north up and centered on the
 * airport, drawn like the 2D map in its own settings (MINIMAP). Like the 3D
 * airport view, drag it to move it, drag a corner, scroll or pinch to resize
 * it, and lock it in place; click an aircraft on it to follow it. Where it
 * sits is remembered in this browser.
 *
 * In the board (its layout, or tower view) it has a place of its own: docked
 * in the board's slot for it (BOARD_SLOT_CLASS), locked, until it's unlocked
 * and moved.
 *
 * The 3D map steps the trackers each frame; this only draws them.
 */
export function Minimap({ tracker, ground }: { tracker: Tracker; ground: GroundTracker }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const docked = minimapInBoard()
  const [placements, setPlacements] = useState(loadPlacements)
  const placement = docked ? placements.tower : placements.free
  const setPlacement = (next: SavedPlacement | null) => setPlacements((p) => (docked ? { ...p, tower: next } : { ...p, free: next }))
  const locked = docked ? MINIMAP.towerLocked : MINIMAP.locked
  const windowSize = useWindowSize()
  const pointerOver = usePointerOverWhileLocked(containerRef, locked)
  const slot = useBoardSlot(docked && !placement)
  // Where each aircraft was drawn last frame, for clicking on one.
  const hitsRef = useRef<{ hex: string; at: Point }[]>([])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d', { alpha: false })!
    let width = 0
    let height = 0
    let dpr = 1
    let layers: MapLayers = { basemap: null, radar: null, terrain: null }
    let project = createProjection(createView(1, 1, MINIMAP.radiusNm), CENTER)
    let background: HTMLCanvasElement | null = null

    const rebuild = () => {
      if (!width || !height) return
      project = createProjection(createView(width, height, MINIMAP.radiusNm), CENTER)
      background = withMapStyle(MINIMAP, () =>
        renderBackground(width, height, dpr, createView(width, height, MINIMAP.radiusNm), project, layers.basemap, layers.radar, layers.terrain, false),
      )
    }

    const resize = () => {
      dpr = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      rebuild()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const stopLayers = watchMapLayers((loaded) => {
      layers = loaded
      rebuild()
    })
    // Labels baked into the background need redrawing once the web font arrives.
    document.fonts.load(withMapStyle(MINIMAP, labelFont)).then(rebuild, () => {})

    // Range, ring spacing, terrain and radar opacity are baked into the background.
    let builtSettings = settingsVersion()
    let frame = requestAnimationFrame(function loop() {
      if (settingsVersion() !== builtSettings) {
        builtSettings = settingsVersion()
        rebuild()
      }
      if (background) ctx.drawImage(background, 0, 0, width, height)
      withMapStyle(MINIMAP, () => {
        if (MINIMAP.showRunwayGuides) drawRunwayGuides(ctx, tracker.runwayGuides(performance.now()), project)
        if (MINIMAP.showAssistPaths) {
          const paths = []
          for (const t of tracker.tracks.values()) {
            const path = t.opacity > 0 ? tracker.assistPath(t) : null
            if (path) paths.push({ ...path, opacity: t.opacity })
          }
          for (const g of ground.tracks.values()) {
            const path = g.opacity > 0 ? tracker.groundAssistPath(g) : null
            if (path) paths.push({ ...path, opacity: g.opacity })
          }
          drawAssistPaths(ctx, paths, project)
        }
        drawTracks(ctx, tracker.tracks.values(), project)
      })
      const hits: { hex: string; at: Point }[] = []
      for (const t of tracker.tracks.values()) {
        if (t.opacity > 0 && MINIMAP.traffic[t.info.kind].show) hits.push({ hex: t.info.hex, at: project(t.pos) })
      }
      hitsRef.current = hits
      const hex = selectedAircraft()
      const focus = hex ? locateAircraft(hex, tracker, ground) : null
      if (focus) {
        const at = project(focus.pos)
        drawFocusBrackets(ctx, at.x, at.y)
      }
      frame = requestAnimationFrame(loop)
    })

    return () => {
      stopLayers()
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [tracker, ground])

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

  /** Runs `onMove` with the pointer's offset from where the drag started, until it's released. */
  const drag = (e: ReactPointerEvent, onMove: (dx: number, dy: number) => void, onEnd: (dx: number, dy: number, ev: PointerEvent) => void) => {
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
      onEnd(ev.clientX - startX, ev.clientY - startY, ev)
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

  const place = (next: SavedPlacement | null, save: boolean) => {
    const all = docked ? { ...placements, tower: next } : { ...placements, free: next }
    setPlacements(all)
    if (save) storePlacements(all)
  }

  // Touch: fingers on the map, and whether a pinch has taken over from moving it.
  const touchesRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchingRef = useRef(false)

  /**
   * Drag on the map to move it; a click or tap that doesn't move picks the
   * aircraft under it. By touch, two fingers pinch to resize and drag to move.
   * Locked, it only picks aircraft.
   */
  const onCanvasPointerDown = (e: ReactPointerEvent) => {
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
      if (fingers.size === 2) return locked ? undefined : startPinch()
      if (fingers.size > 2) return
    }
    if (e.button === 0) startMove(e, true)
  }

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
      place(latest, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  /** Moves the panel with the pointer; from inside the map, a press that doesn't move is a click on it. */
  const startMove = (e: ReactPointerEvent, mayPick = false) => {
    const start = currentPlacement()
    let latest = toFractions(start)
    let moved = false
    let pinched = false
    drag(
      e,
      (dx, dy) => {
        // A second finger turned this into a pinch: it moves the panel instead.
        if (pinchingRef.current || pinched) {
          pinched = true
          return
        }
        if (!moved && Math.hypot(dx, dy) < TAP_SLOP_PX) return
        moved = true
        // Locked: a drag is just not a click.
        if (locked) return
        // Free to go past the screen's edges; the toolbar's button brings it back.
        latest = toFractions({ ...start, left: start.left + dx, top: start.top + dy })
        setPlacement(latest)
      },
      (_dx, _dy, ev) => {
        if (pinched) return
        if (moved) {
          if (!locked) place(latest, true)
        }
        else if (mayPick && ev.type === 'pointerup') {
          const hex = aircraftAt(ev.clientX, ev.clientY)
          if (hex) selectAircraft(hex)
        }
      },
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
      () => place(latest, true),
    )
  }

  /** Scroll over the map to grow or shrink it around its middle. Ctrl+scroll is left for page zoom. */
  const onWheel = (e: ReactWheelEvent) => {
    if (locked || e.ctrlKey || e.deltaY === 0) return
    const start = currentPlacement()
    const size = clamp(start.size * (e.deltaY < 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM), MIN_SIZE, maxPanelSize())
    const grow = (size - start.size) / 2
    place(toFractions({ left: start.left - grow, top: start.top - grow, size }), true)
  }

  /** By touch there's no hover to show the resize handles, so a touch shows them for a while. */
  const [touched, setTouched] = useState(false)
  const touchedTimer = useRef(0)
  const revealControls = () => {
    setTouched(true)
    clearTimeout(touchedTimer.current)
    touchedTimer.current = window.setTimeout(() => setTouched(false), TOUCH_REVEAL_MS)
  }
  useEffect(() => () => clearTimeout(touchedTimer.current), [])

  // The settings panel and the toolbar can put it back in its corner (or, in tower view, in the board).
  useEffect(() => {
    const reset = () => {
      // What's stored is up to date (every move saves it).
      const all = { ...loadPlacements(), [minimapInBoard() ? 'tower' : 'free']: null }
      setPlacements(all)
      storePlacements(all)
    }
    window.addEventListener(RESET_MINIMAP_EVENT, reset)
    return () => window.removeEventListener(RESET_MINIMAP_EVENT, reset)
  }, [])

  // Viewport units keep it in proportion when the window changes size; docked, it fills the board's slot.
  const style: CSSProperties = {
    opacity: MINIMAP.opacity,
    ...(placement
      ? { left: `${placement.left * 100}vw`, top: `${placement.top * 100}vh`, bottom: 'auto', width: `${placement.size * 100}vw` }
      : slot && { left: slot.left, top: slot.top, bottom: 'auto', width: slot.width, height: slot.height, aspectRatio: 'auto' }),
  }

  return (
    <div
      ref={containerRef}
      className={`minimap${slot ? ' is-docked' : ''}${locked ? ' is-locked' : ''}${pointerOver ? ' is-pointer-over' : ''}${touched ? ' is-touched' : ''}`}
      style={style}
      onPointerDownCapture={(e) => e.pointerType !== 'mouse' && revealControls()}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={onCanvasPointerDown}
        onWheel={onWheel}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' && e.buttons === 0) e.currentTarget.classList.toggle('is-over-aircraft', aircraftAt(e.clientX, e.clientY) !== null)
        }}
        onContextMenu={(e) => e.preventDefault()}
        title={locked ? 'Click an aircraft to follow it' : 'Drag to move · scroll, pinch or drag a corner to resize · click an aircraft to follow it'}
      />
      {CORNERS.map((corner) => (
        <div key={corner} className={`minimap-resize is-${corner}`} onPointerDown={startResize(corner)} title="Drag to resize" />
      ))}
      <div className="minimap-buttons" style={buttonsStyle(placement, windowSize)}>
        {/* Still reachable while locked (the rest of the panel then lets clicks through to the map). */}
        <button
          type="button"
          className="minimap-lock"
          aria-pressed={locked}
          aria-label={locked ? 'Unlock the minimap' : 'Lock the minimap'}
          title={locked ? 'Unlock: allow moving and resizing' : 'Lock in place'}
          onClick={() => setSetting(docked ? MINIMAP_TOWER_LOCK_SETTING : MINIMAP_LOCK_SETTING, !locked)}
        >
          <LockIcon locked={locked} />
        </button>
      </div>
    </div>
  )
}

/** Where it sits on its own and in tower view; null until moved there, while CSS (or the board's slot) places it. */
interface Placements {
  free: SavedPlacement | null
  tower: SavedPlacement | null
}

function loadPlacements(): Placements {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    return { free: validPlacement(saved?.placement), tower: validPlacement(saved?.towerPlacement) }
  } catch {
    return { free: null, tower: null }
  }
}

/** Kept in localStorage, so it lasts across sessions in this browser. */
function storePlacements({ free, tower }: Placements) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ placement: free, towerPlacement: tower }))
  } catch {
    // Storage can be unavailable (private windows); the minimap just won't remember.
  }
}

/** The board's spot for the minimap in tower view (see Board.tsx). */
export const BOARD_SLOT_CLASS = 'board-minimap-slot'

/** Where the minimap goes in the board, in pixels; not always square. */
interface SlotRect {
  left: number
  top: number
  width: number
  height: number
}

/** Where the minimap goes for the board's slot, kept up to date while `active`; null when there's none. */
function useBoardSlot(active: boolean): SlotRect | null {
  const [slot, setSlot] = useState<SlotRect | null>(null)
  useEffect(() => {
    if (!active) return
    const el = document.querySelector(`.${BOARD_SLOT_CLASS}`)
    if (!el) return
    // From the slot's top-left to the board's bottom-right corner (the screen's), filling it.
    const measure = () => {
      const rect = el.getBoundingClientRect()
      const board = el.closest('.board')?.getBoundingClientRect() ?? rect
      const right = Math.min(board.right, document.documentElement.clientWidth)
      const bottom = Math.min(board.bottom, document.documentElement.clientHeight)
      const next = { left: rect.left, top: rect.top, width: Math.max(right - rect.left, 0), height: Math.max(bottom - rect.top, 0) }
      setSlot((was) =>
        was && was.left === next.left && was.top === next.top && was.width === next.width && was.height === next.height ? was : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    // The board can shift without the slot resizing (the window, or the board's other contents).
    observer.observe(document.body)
    if (el.parentElement) observer.observe(el.parentElement)
    window.addEventListener('resize', measure)
    el.closest('.board')?.addEventListener('scroll', measure)
    // And now and then, for anything that moves it unobserved.
    const timer = setInterval(measure, 1000)
    return () => {
      clearInterval(timer)
      observer.disconnect()
      window.removeEventListener('resize', measure)
      el.closest('.board')?.removeEventListener('scroll', measure)
    }
  }, [active])
  return active ? slot : null
}
