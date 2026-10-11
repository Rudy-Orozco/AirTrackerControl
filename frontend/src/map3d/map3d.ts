import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Raycaster,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { modelGeometry } from '../aircraft/aircraftModels'
import { aircraftSize } from '../aircraft/aircraftShapes'
import { AIRPORT_PRESET, CENTER, FETCH_RADIUS_NM, MAP, MAP3D, type Map3DTrafficStyle } from '../config/config'
import { bankOf, pitchOf } from '../diorama/diorama'
import type { MapLayers } from '../map/mapLayers'
import { elevationAt, type Terrain } from '../map/terrain'
import { createProjection, drawTrackLabels, labelFont, renderBackground, type Point } from '../map/renderer'
import { clearAnchor, orbitAnchor, type OrbitAnchor } from './orbitAnchor'
import { estimatedPath, predictedPath, trailStart, type LatLon, type Track } from '../tracking/tracker'

const FT_PER_NM = 6076.12
const LON_SCALE = Math.cos((CENTER.lat * Math.PI) / 180)
const BACKGROUND = 0x03050a
const CAMERA_KEY = 'map3dCamera'

/** Nautical miles east (x) and north (y) of the airport. */
function local(p: LatLon) {
  return { x: (p.lon - CENTER.lon) * 60 * LON_SCALE, y: (p.lat - CENTER.lat) * 60 }
}

/** Drawn height in nautical miles: above the field, exaggerated per MAP3D.altitudeScale. */
function heightOf(altitudeFt: number | null) {
  if (altitudeFt === null) return 0
  return (Math.max(altitudeFt - AIRPORT_PRESET.elevationFt, 0) / FT_PER_NM) * MAP3D.altitudeScale
}

/** One aircraft's scene objects. */
interface Craft {
  mesh: Mesh
  material: MeshPhongMaterial
  trail: Line
  curtain: Mesh
  route: Line
  /** The rest of the current segment, when MAP.showPredictions is on. */
  prediction: Line
  /** Delayed view: from the latest report on to where the plane probably is now. */
  estimate: Line
  /** Points in the trail buffers, how many they can hold, and the trail sample they were built from. */
  count: number
  capacity: number
  builtAt: number
  routeEnd: Vector3 | null
}

/**
 * The tilted 3D map: the 2D map's background as the ground, aircraft as 3D
 * models at (exaggerated) altitude, trails as 3D lines with a faint curtain to
 * the ground, and optional lines toward each flight's origin or destination.
 * Labels go on a 2D canvas laid over it.
 */
export class Map3D {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(40, 1, 0.05, 2000)
  /** When the last frame was drawn, for a steady orbit speed whatever the frame rate. */
  private lastFrame = performance.now()
  private readonly controls: OrbitControls
  private readonly ground: Mesh<PlaneGeometry, MeshBasicMaterial>
  /** Set while terrain is on and loaded: the ground is raised to match it. */
  private terrain: Terrain | null = null
  private readonly drops = new LineSegments(
    new BufferGeometry(),
    new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
  )
  /** A dot on the ground under each aircraft, a few pixels across at any distance. */
  private readonly dots = new Points(
    new BufferGeometry(),
    new PointsMaterial({
      size: DOT_PX,
      sizeAttenuation: false,
      map: roundDot(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    }),
  )
  /** Debug: a dot at each report ahead of the arrivals and departures (MAP.showPredictions). */
  private readonly waypoints = new Points(
    new BufferGeometry(),
    new PointsMaterial({
      size: WAYPOINT_PX,
      sizeAttenuation: false,
      map: roundDot(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    }),
  )
  /** The orbit axis (see orbitAnchor.ts), while placing it: a vertical line fading upward from a ring on the ground. */
  private readonly axis = new Line(axisGeometry(), new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }))
  private readonly axisRing = new LineLoop(ringGeometry(), new LineBasicMaterial({ color: AXIS_COLOR, transparent: true, opacity: 0.8, depthWrite: false }))
  /** The orbit point itself, while its height is being picked and as it's placed. */
  private readonly ball = new Mesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ color: AXIS_COLOR, transparent: true, depthWrite: false }))
  /** The cursor over the map, for the axis preview. */
  private pointer: { x: number; y: number } | null = null
  /** The ball's height while picking it, held when the cursor can't place it. */
  private lastBallZ: number | null = null
  /** The point the camera last moved to orbit around, so a new one is noticed. */
  private followed: OrbitAnchor['anchor'] = null
  /** Moving the camera over to orbit around a newly placed axis. */
  private glide: { from: Vector3; to: Vector3; start: number } | null = null
  private readonly crafts = new Map<Track, Craft>()
  private readonly labels: CanvasRenderingContext2D
  private width = 1
  private height = 1
  private shift = { x: 0, y: 0 }

  constructor(canvas: HTMLCanvasElement, labelCanvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true })
    this.renderer.setClearColor(BACKGROUND)
    this.labels = labelCanvas.getContext('2d')!

    const R = FETCH_RADIUS_NM
    // Range is set each frame from the camera's distance (see render).
    this.scene.fog = new Fog(BACKGROUND, R, R * 3)
    this.scene.add(new AmbientLight(0xffffff, 1.1))
    const sun = new DirectionalLight(0xffffff, 2.2)
    sun.position.set(-0.4, -0.6, 1)
    this.scene.add(sun)

    // Faded out toward its edges, so the map has no hard square border.
    this.ground = new Mesh(
      new PlaneGeometry(R * 2, R * 2),
      new MeshBasicMaterial({ color: BACKGROUND, alphaMap: edgeFade(), transparent: true }),
    )
    // Draw the ground before everything else that's see-through (trails, curtains, aircraft).
    this.ground.renderOrder = -1
    this.scene.add(this.ground)
    this.drops.frustumCulled = false
    this.scene.add(this.drops)
    this.dots.frustumCulled = false
    this.scene.add(this.dots)
    this.waypoints.frustumCulled = false
    this.scene.add(this.waypoints)
    for (const o of [this.axis, this.axisRing, this.ball]) {
      o.frustumCulled = false
      o.visible = false
      this.scene.add(o)
    }

    // North-up map with z as height.
    this.camera.up.set(0, 0, 1)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04
    this.controls.minDistance = 2
    this.controls.maxDistance = R * 4
    this.controls.addEventListener('end', () => this.saveCamera())
    this.restoreCamera()
  }

  /**
   * Bakes the 2D map's background (basemap, radar, hill shading, range rings)
   * into the ground texture, and raises the ground to the terrain when it's on.
   */
  setBackground({ basemap, radar, terrain }: MapLayers) {
    const size = Math.min(4096, this.renderer.capabilities.maxTextureSize)
    const R = FETCH_RADIUS_NM
    // Drawn at half size and 2× pixel ratio, so lines and lettering come out twice as
    // big as on the flat map and stay readable when seen at an angle from afar.
    const half = size / 2
    const view = { cx: half / 2, cy: half / 2, pxPerNm: half / (2 * R) }
    const canvas = renderBackground(half, half, 2, view, createProjection(view, CENTER), basemap, radar, terrain)
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    this.ground.material.map?.dispose()
    this.ground.material.map = texture
    this.ground.material.color.set(0xffffff)
    this.ground.material.needsUpdate = true

    this.terrain = MAP.terrain ? terrain : null
    this.buildGround()
  }

  /** Flat, or a grid of heights following the terrain (with the aircraft's height exaggeration). */
  private buildGround() {
    const R = FETCH_RADIUS_NM
    const segments = this.terrain ? GROUND_SEGMENTS : 1
    const geometry = new PlaneGeometry(R * 2, R * 2, segments, segments)
    if (this.terrain) {
      const pos = geometry.getAttribute('position') as BufferAttribute
      for (let i = 0; i < pos.count; i++) pos.setZ(i, this.groundZ(pos.getX(i), pos.getY(i)))
      geometry.computeVertexNormals()
    }
    this.ground.geometry.dispose()
    this.ground.geometry = geometry
    // Trails hang their curtains down to the ground, so rebuild them too.
    for (const craft of this.crafts.values()) craft.builtAt = -1
  }

  /** Height of the ground at a point (nautical miles east/north), drawn like aircraft heights; 0 without terrain. */
  private groundZ(x: number, y: number) {
    if (!this.terrain) return 0
    const meters = elevationAt(this.terrain, CENTER.lat + y / 60, CENTER.lon + x / (60 * LON_SCALE))
    return ((meters * FT_PER_M - AIRPORT_PRESET.elevationFt) / FT_PER_NM) * MAP3D.altitudeScale
  }

  /**
   * `visible` is the part of the screen the board leaves uncovered; the view
   * centers itself there, like the flat map.
   */
  resize(width: number, height: number, dpr: number, visible: { width: number; height: number }) {
    this.width = Math.max(width, 1)
    this.height = Math.max(height, 1)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(this.width, this.height, false)
    const canvas = this.labels.canvas
    canvas.width = this.width * dpr
    canvas.height = this.height * dpr
    this.labels.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.camera.aspect = this.width / this.height
    // Move the vanishing point to the middle of the uncovered area.
    this.shift = { x: visible.width / this.width - 1, y: 1 - visible.height / this.height }
    this.updateProjection()
  }

  resetCamera() {
    // The camera leaves the axis, so drop it rather than glide straight back.
    clearAnchor()
    this.followed = null
    this.glide = null
    this.controls.target.set(0, 0, 0)
    this.camera.position.copy(DEFAULT_CAMERA)
    this.controls.update()
    this.saveCamera()
  }

  /** Draws one frame. Call after the tracker has stepped. */
  render(tracks: Iterable<Track>) {
    // Orbit (MAP3D.orbit): OrbitControls circles the target, holding tilt and distance.
    // A positive speed moves the camera clockwise seen from above.
    const now = performance.now()
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1)
    this.lastFrame = now
    if (this.controls.autoRotate && !MAP3D.orbit) this.saveCamera()
    // Holds still while the orbit point is being placed, so it's easier to aim.
    this.controls.autoRotate = MAP3D.orbit && !orbitAnchor().picking
    this.controls.autoRotateSpeed = ((MAP3D.orbitDirection === 'counterclockwise' ? -1 : 1) * MAP3D.orbitSpeed) / 6
    this.followAnchor(now)
    this.controls.update(dt)
    // Fog only the far side of the map, however far out the camera is zoomed;
    // fixed distances would darken the whole map when zoomed out.
    const fog = this.scene.fog as Fog
    const distance = this.camera.position.distanceTo(this.controls.target)
    fog.near = distance + FETCH_RADIUS_NM * 0.6
    fog.far = distance + FETCH_RADIUS_NM * 2.2
    const seen = new Set<Track>()
    const shown: Track[] = []
    const screen: Point[] = []
    const routeLabels: { at: Vector3; text: string; color: string; opacity: number }[] = []
    const drops: number[] = []
    const dropColors: number[] = []
    const dots: number[] = []
    const dotColors: number[] = []
    const marks: number[] = []
    const markColors: number[] = []
    const color = new Color()

    for (const t of tracks) {
      const style = MAP3D.traffic[t.info.kind]
      if (t.opacity <= 0 || !style.show) continue
      seen.add(t)
      const craft = this.crafts.get(t) ?? this.addCraft(t)
      const { x, y } = local(t.pos)
      const z = heightOf(t.altitude)
      const opacity = t.opacity * style.opacity
      color.set(style.color)

      const size = aircraftSize(t.info.aircraftType, t.info.emitterCategory)
      const geometry = modelGeometry(size.kind, size.lengthM, size.spanM, t.info.aircraftType)
      if (craft.mesh.geometry !== geometry) craft.mesh.geometry = geometry
      craft.mesh.position.set(x, y, z)
      craft.mesh.scale.setScalar((this.modelLength(craft.mesh.position, size.lengthM) * style.scale) / size.lengthM)
      craft.mesh.rotation.set(rad(pitchOf(t, MAP3D.altitudeScale)), rad(bankOf(t)), -rad(t.heading), 'ZXY')
      craft.material.color.copy(color)
      craft.material.opacity = opacity

      this.updateTrail(craft, t, style, color, opacity)
      craft.trail.visible = style.trail
      craft.curtain.visible = style.curtain
      this.updateRoute(craft, t, style, x, y, z, color, opacity)
      this.updatePrediction(craft, t, x, y, z, color, opacity)
      if (MAP.showPredictions && t.info.kind !== 'other') {
        const path = predictedPath(t)
        path.marks.forEach((m, i) => {
          const l = local(m)
          marks.push(l.x, l.y, heightOf(path.markAlts[i]))
          markColors.push(color.r, color.g, color.b, 0.9 * opacity)
        })
      }
      if (craft.routeEnd && t.info.counterpart) {
        routeLabels.push({ at: craft.routeEnd, text: t.info.counterpart.city, color: style.color, opacity })
      }

      // Drop line from the aircraft to the ground.
      const groundZ = this.groundZ(x, y)
      if (style.dropLine) {
        drops.push(x, y, z, x, y, groundZ)
        dropColors.push(color.r, color.g, color.b, 0.35 * opacity, color.r, color.g, color.b, 0)
      }
      if (style.groundDot) {
        // Lifted a hair so it isn't hidden in the ground.
        dots.push(x, y, groundZ + 0.05)
        dotColors.push(color.r, color.g, color.b, 0.8 * opacity)
      }

      const p = craft.mesh.position.clone().project(this.camera)
      if (p.z < 1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2) {
        shown.push(t)
        screen.push({ x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height })
      }
    }
    for (const [t, craft] of this.crafts) if (!seen.has(t)) this.removeCraft(t, craft)

    this.drops.geometry.setAttribute('position', new BufferAttribute(new Float32Array(drops), 3))
    this.drops.geometry.setAttribute('color', new BufferAttribute(new Float32Array(dropColors), 4))
    this.dots.geometry.setAttribute('position', new BufferAttribute(new Float32Array(dots), 3))
    this.dots.geometry.setAttribute('color', new BufferAttribute(new Float32Array(dotColors), 4))
    this.waypoints.geometry.setAttribute('position', new BufferAttribute(new Float32Array(marks), 3))
    this.waypoints.geometry.setAttribute('color', new BufferAttribute(new Float32Array(markColors), 4))
    this.renderer.render(this.scene, this.camera)

    const ctx = this.labels
    ctx.clearRect(0, 0, this.width, this.height)
    if (MAP.showLabels) drawTrackLabels(ctx, shown, MAP3D.traffic, screen)
    this.drawRouteLabels(routeLabels)
    if (MAP3D.showHud) this.drawHud()
  }

  /**
   * The ground point under a screen position (client pixels), for placing the
   * orbit axis; null if it's off the ground.
   */
  pickGround(clientX: number, clientY: number): Vector3 | null {
    const raycaster = new Raycaster()
    raycaster.ray.copy(this.rayAt(clientX, clientY))
    return raycaster.intersectObject(this.ground)[0]?.point ?? null
  }

  dispose() {
    if (this.controls.autoRotate) this.saveCamera()
    for (const [t, craft] of this.crafts) this.removeCraft(t, craft)
    this.controls.dispose()
    this.ground.material.map?.dispose()
    this.ground.material.alphaMap?.dispose()
    this.renderer.dispose()
  }

  // ---- Aircraft ---------------------------------------------------------------------

  private addCraft(t: Track): Craft {
    // One pass: three.js otherwise draws a transparent double-sided material twice a frame, re-checking its shader each time.
    const material = new MeshPhongMaterial({ flatShading: true, shininess: 40, transparent: true, side: DoubleSide, forceSinglePass: true })
    const mesh = new Mesh(new BufferGeometry(), material)
    mesh.frustumCulled = false
    const trail = new Line(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }))
    const curtain = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({ vertexColors: true, transparent: true, side: DoubleSide, depthWrite: false, forceSinglePass: true }),
    )
    const route = new Line(
      new BufferGeometry(),
      new LineDashedMaterial({ vertexColors: true, transparent: true, depthWrite: false, dashSize: 1.2, gapSize: 0.8 }),
    )
    const prediction = new Line(
      new BufferGeometry(),
      new LineDashedMaterial({ transparent: true, depthWrite: false, dashSize: 0.4, gapSize: 0.4 }),
    )
    const estimate = new Line(
      new BufferGeometry(),
      new LineDashedMaterial({ transparent: true, depthWrite: false, dashSize: 0.1, gapSize: 0.3 }),
    )
    for (const o of [trail, curtain, route, prediction, estimate]) o.frustumCulled = false
    this.scene.add(mesh, trail, curtain, route, prediction, estimate)
    const craft: Craft = { mesh, material, trail, curtain, route, prediction, estimate, count: 0, capacity: 0, builtAt: -1, routeEnd: null }
    this.crafts.set(t, craft)
    return craft
  }

  private removeCraft(t: Track, craft: Craft) {
    this.scene.remove(craft.mesh, craft.trail, craft.curtain, craft.route, craft.prediction, craft.estimate)
    craft.material.dispose()
    for (const o of [craft.trail, craft.curtain, craft.route, craft.prediction, craft.estimate]) {
      o.geometry.dispose()
      ;(o.material as LineBasicMaterial).dispose()
    }
    this.crafts.delete(t)
  }

  /**
   * Rebuilds the trail line and curtain when a new trail point arrives (twice a
   * second), and otherwise just moves their head to the aircraft each frame.
   */
  private updateTrail(craft: Craft, t: Track, style: Map3DTrafficStyle, color: Color, opacity: number) {
    const start = trailStart(t, style.trailSeconds)
    const n = t.trail.length - start + 1
    if (t.lastTrailAt !== craft.builtAt || n !== craft.count) {
      craft.builtAt = t.lastTrailAt
      if (n > craft.capacity) this.allocateTrail(craft, n + 64)
      craft.count = n
      const trail = t.trail.slice(start).map((p, i) => ({ ...local(p), z: heightOf(t.trailAlt[start + i] ?? null) }))
      const points = smooth([...trail, { ...local(t.pos), z: heightOf(t.altitude) }], style.trailSmoothing)
      const line = craft.trail.geometry
      const wall = craft.curtain.geometry
      const linePos = line.getAttribute('position') as BufferAttribute
      const lineCol = line.getAttribute('color') as BufferAttribute
      const wallPos = wall.getAttribute('position') as BufferAttribute
      const wallCol = wall.getAttribute('color') as BufferAttribute
      const curtain = style.curtainOpacity
      points.forEach((p, i) => {
        // Fades in from the tail to the aircraft.
        const fade = n > 1 ? i / (n - 1) : 1
        linePos.setXYZ(i, p.x, p.y, p.z)
        lineCol.setXYZW(i, color.r, color.g, color.b, fade * style.trailOpacity * opacity)
        wallPos.setXYZ(2 * i, p.x, p.y, p.z)
        wallPos.setXYZ(2 * i + 1, p.x, p.y, this.groundZ(p.x, p.y))
        wallCol.setXYZW(2 * i, color.r, color.g, color.b, fade * curtain * opacity)
        wallCol.setXYZW(2 * i + 1, color.r, color.g, color.b, 0)
      })
      for (const a of [linePos, lineCol, wallPos, wallCol]) {
        a.clearUpdateRanges()
        a.needsUpdate = true
      }
      line.setDrawRange(0, n)
      wall.setDrawRange(0, Math.max(n - 1, 0) * 6)
      return
    }
    // Same trail: just keep its head on the aircraft.
    const i = n - 1
    const { x, y } = local(t.pos)
    const z = heightOf(t.altitude)
    const linePos = craft.trail.geometry.getAttribute('position') as BufferAttribute
    const wallPos = craft.curtain.geometry.getAttribute('position') as BufferAttribute
    linePos.setXYZ(i, x, y, z)
    wallPos.setXYZ(2 * i, x, y, z)
    wallPos.setXYZ(2 * i + 1, x, y, this.groundZ(x, y))
    linePos.clearUpdateRanges()
    linePos.addUpdateRange(i * 3, 3)
    linePos.needsUpdate = true
    wallPos.clearUpdateRanges()
    wallPos.addUpdateRange(i * 6, 6)
    wallPos.needsUpdate = true
  }

  private allocateTrail(craft: Craft, capacity: number) {
    craft.capacity = capacity
    const line = new BufferGeometry()
    line.setAttribute('position', new BufferAttribute(new Float32Array(capacity * 3), 3))
    line.setAttribute('color', new BufferAttribute(new Float32Array(capacity * 4), 4))
    const wall = new BufferGeometry()
    wall.setAttribute('position', new BufferAttribute(new Float32Array(capacity * 6), 3))
    wall.setAttribute('color', new BufferAttribute(new Float32Array(capacity * 8), 4))
    // Two triangles between each pair of trail points: top and bottom of the curtain.
    const index = new Uint32Array((capacity - 1) * 6)
    for (let i = 0; i < capacity - 1; i++) {
      const [a, b, c, d] = [2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3]
      index.set([a, b, c, b, d, c], i * 6)
    }
    wall.setIndex(new BufferAttribute(index, 1))
    craft.trail.geometry.dispose()
    craft.curtain.geometry.dispose()
    craft.trail.geometry = line
    craft.curtain.geometry = wall
  }

  /**
   * A dashed line from the aircraft along the great circle toward its origin
   * (arrivals) or destination (departures), rising toward cruise height as it
   * goes. Rebuilt with the trail; hidden when off or the airport isn't known.
   */
  private updateRoute(craft: Craft, t: Track, style: Map3DTrafficStyle, x: number, y: number, z: number, color: Color, opacity: number) {
    const target = t.info.counterpart
    const on = style.route && t.info.kind !== 'other' && target?.lat != null && target.lon != null
    craft.route.visible = on
    if (!on) {
      craft.routeEnd = null
      return
    }
    if (craft.route.userData.builtAt === craft.builtAt) {
      // Keep the start on the aircraft between rebuilds.
      const pos = craft.route.geometry.getAttribute('position') as BufferAttribute
      pos.setXYZ(0, x, y, z)
      pos.needsUpdate = true
      return
    }
    craft.route.userData.builtAt = craft.builtAt
    const points = greatCircle(t.pos, { lat: target!.lat!, lon: target!.lon! }, style.routeLengthNm, ROUTE_SEGMENTS)
    const cruise = heightOf(AIRPORT_PRESET.elevationFt + CRUISE_FT)
    const positions = new Float32Array(points.length * 3)
    const colors = new Float32Array(points.length * 4)
    points.forEach((p, i) => {
      const f = i / (points.length - 1)
      const l = local(p)
      positions.set([l.x, l.y, z + (Math.max(cruise, z) - z) * f * f], i * 3)
      colors.set([color.r, color.g, color.b, 0.7 * opacity * (1 - f * 0.85)], i * 4)
    })
    craft.route.geometry.dispose()
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 4))
    craft.route.geometry = geometry
    craft.route.computeLineDistances()
    const last = points.length - 1
    craft.routeEnd = new Vector3(positions[last * 3], positions[last * 3 + 1], positions[last * 3 + 2])
  }

  /**
   * Debug: the rest of the current segment as a dashed line at altitude, like the
   * 2D map's, and in the delayed view a dotted one on to where the plane probably is now.
   */
  private updatePrediction(craft: Craft, t: Track, x: number, y: number, z: number, color: Color, opacity: number) {
    const on = MAP.showPredictions && t.info.kind !== 'other'
    // The curve starts exactly on the aircraft.
    setPathLine(craft.prediction, on ? predictedPath(t) : null, { x, y, z }, color, 0.8 * opacity)
    setPathLine(craft.estimate, on ? estimatedPath(t) : null, null, color, 0.6 * opacity)
  }

  private drawRouteLabels(items: { at: Vector3; text: string; color: string; opacity: number }[]) {
    const ctx = this.labels
    ctx.font = `${MAP.labelSize - 1}px ${MAP.fontFamily}`
    ctx.letterSpacing = '2px'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const { at, text, color, opacity } of items) {
      const p = at.clone().project(this.camera)
      if (p.z >= 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue
      ctx.globalAlpha = 0.6 * opacity
      ctx.fillStyle = color
      ctx.fillText(text.toUpperCase(), ((p.x + 1) / 2) * this.width, ((1 - p.y) / 2) * this.height - 4)
    }
    ctx.globalAlpha = 1
    ctx.letterSpacing = '0px'
    ctx.font = labelFont()
  }

  // ---- Camera -----------------------------------------------------------------------

  /**
   * A minimal heading tape along the top of the visible map, like an aircraft
   * HUD's: ticks every 5°, labels every 30°, the camera's heading over a caret
   * in the middle, and its altitude (true scale, above sea level) beside it.
   * Drops below the airport logo when there's no room between it and the toolbar.
   */
  private drawHud() {
    const ctx = this.labels
    const offset = new Vector3().subVectors(this.controls.target, this.camera.position)
    const heading = ((Math.atan2(offset.x, offset.y) * 180) / Math.PI + 360) % 360
    const feet = (this.camera.position.z * FT_PER_NM) / MAP3D.altitudeScale + AIRPORT_PRESET.elevationFt

    const half = HUD_WIDTH / 2
    const cx = (this.width * (1 + this.shift.x)) / 2
    const roomy = cx - half > Math.min(336, this.width * 0.4 + 16) + 8 && cx + half + HUD_ALT_WIDTH < this.width - 310
    const top = roomy ? 14 : 96
    const tickTop = top + 24

    ctx.save()
    ctx.strokeStyle = ctx.fillStyle = HUD_COLOR
    ctx.lineWidth = 1
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.letterSpacing = '1px'

    // The tape, fading out toward its ends.
    ctx.font = `10px ${MAP.fontFamily}`
    for (let deg = Math.ceil((heading - half / HUD_PX_PER_DEG) / 5) * 5; deg <= heading + half / HUD_PX_PER_DEG; deg += 5) {
      const x = cx + (deg - heading) * HUD_PX_PER_DEG
      ctx.globalAlpha = HUD_OPACITY * (1 - ((x - cx) / half) ** 2)
      const major = deg % 10 === 0
      ctx.beginPath()
      ctx.moveTo(x, tickTop)
      ctx.lineTo(x, tickTop + (major ? 7 : 4))
      ctx.stroke()
      if (deg % 30 === 0) {
        const d = ((deg % 360) + 360) % 360
        ctx.fillText(COMPASS[d] ?? String(d / 10).padStart(2, '0'), x, tickTop + 17)
      }
    }

    // Heading over a caret pointing at the tape.
    ctx.globalAlpha = HUD_OPACITY * 1.4
    ctx.font = `12px ${MAP.fontFamily}`
    ctx.fillText(String(Math.round(heading) % 360).padStart(3, '0'), cx, top + 8)
    ctx.beginPath()
    ctx.moveTo(cx - 3.5, tickTop - 6)
    ctx.lineTo(cx + 3.5, tickTop - 6)
    ctx.lineTo(cx, tickTop - 1.5)
    ctx.closePath()
    ctx.fill()

    // Altitude: flight level, with feet under it.
    const ax = cx + half + 16
    ctx.textAlign = 'left'
    ctx.fillText(`FL${String(Math.max(0, Math.round(feet / 100))).padStart(3, '0')}`, ax, top + 8)
    ctx.globalAlpha = HUD_OPACITY
    ctx.font = `10px ${MAP.fontFamily}`
    ctx.fillText(`${Math.max(0, Math.round(feet / 10) * 10).toLocaleString('en-US')} FT`, ax, tickTop + 4)
    ctx.restore()
  }

  /**
   * While orbiting around a point: glides the camera over when a new one is
   * placed (keeping its angle and distance) and keeps panning off so it stays
   * in the middle. Draws the axis while one is being placed, and flashes it
   * once placed before fading it out.
   */
  private followAnchor(now: number) {
    const { anchor, picking, foot } = orbitAnchor()
    const target = MAP3D.orbit ? anchor : null
    if (target !== this.followed) {
      this.followed = target
      this.glide = target
        ? { from: this.controls.target.clone(), to: new Vector3(target.x, target.y, target.z), start: now }
        : null
    }
    this.controls.enablePan = target === null
    if (this.glide) {
      const t = Math.min((now - this.glide.start) / AXIS_GLIDE_MS, 1)
      const eased = 1 - (1 - t) ** 3
      const delta = this.glide.from.clone().lerp(this.glide.to, eased).sub(this.controls.target)
      this.controls.target.add(delta)
      this.camera.position.add(delta)
      if (t === 1) {
        this.glide = null
        this.saveCamera()
      }
    }

    // What to draw: the axis under the cursor, the planted one with the ball at
    // the cursor's height, or the chosen point flashing then fading away.
    let shown: { x: number; y: number; groundZ: number; ballZ: number | null; opacity: number; pulse: number } | null = null
    if (picking === 'axis' && this.pointer) {
      const p = this.pickGround(this.pointer.x, this.pointer.y)
      if (p) shown = { x: p.x, y: p.y, groundZ: p.z, ballZ: null, opacity: 0.55, pulse: 0 }
    } else if (picking === 'height' && foot) {
      const z = this.pointer ? this.pickHeight(this.pointer.x, this.pointer.y, foot) : null
      shown = { x: foot.x, y: foot.y, groundZ: foot.z, ballZ: z ?? this.lastBallZ ?? foot.z, opacity: 0.9, pulse: 0 }
      this.lastBallZ = shown.ballZ
    } else if (target && this.glide) {
      // Placed: a quick pulse to show the choice, then it fades out as the camera arrives.
      const t = (now - this.glide.start) / AXIS_GLIDE_MS
      const pulse = Math.sin(Math.min(t / 0.35, 1) * Math.PI)
      const opacity = t < 0.35 ? 1 : Math.max(0, 1 - (t - 0.35) / 0.65)
      shown = { x: target.x, y: target.y, groundZ: target.groundZ, ballZ: target.z, opacity, pulse }
    }
    if (picking !== 'height') this.lastBallZ = null

    this.axis.visible = this.axisRing.visible = shown !== null
    this.ball.visible = shown?.ballZ != null
    if (!shown) return
    // Sized by the camera's distance, so it looks the same however far out it's zoomed.
    const distance = this.camera.position.distanceTo(this.controls.target)
    const above = (shown.ballZ ?? shown.groundZ) - shown.groundZ
    this.axis.position.set(shown.x, shown.y, shown.groundZ)
    this.axis.scale.set(1, 1, Math.max(distance * 0.45, above + distance * 0.15))
    this.axisRing.position.set(shown.x, shown.y, shown.groundZ + 0.02)
    this.axisRing.scale.setScalar(distance * 0.025 * (1 + shown.pulse * 0.8))
    ;(this.axis.material as LineBasicMaterial).opacity = shown.opacity
    this.axisRing.material.opacity = 0.8 * shown.opacity
    if (shown.ballZ != null) {
      this.ball.position.set(shown.x, shown.y, shown.ballZ)
      this.ball.scale.setScalar(distance * 0.004 * (1 + shown.pulse))
      this.ball.material.opacity = shown.opacity
    }
  }

  /** Turns dragging, pinching and scrolling the camera on or off (off while a finger aims the orbit point). */
  setControlsEnabled(enabled: boolean) {
    this.controls.enabled = enabled
  }

  /**
   * Where the cursor is (client pixels), so the axis preview can follow it;
   * null when it leaves the map.
   */
  setPointer(pointer: { x: number; y: number } | null) {
    this.pointer = pointer
  }

  /**
   * How high up the vertical axis standing at `foot` the cursor points: the
   * point on the axis nearest the ray under it, kept between the ground and a
   * little above the camera's distance. Null when looking straight down it.
   */
  pickHeight(clientX: number, clientY: number, foot: { x: number; y: number; z: number }): number | null {
    const { origin, direction: d } = this.rayAt(clientX, clientY)
    const denom = 1 - d.z * d.z
    if (denom < 1e-4) return null
    // Closest points between the ray and the line (foot.x, foot.y, t).
    const w = origin.clone().sub(new Vector3(foot.x, foot.y, 0))
    const z = (w.z - d.z * d.dot(w)) / denom
    const top = foot.z + this.camera.position.distanceTo(this.controls.target)
    return Math.min(Math.max(z, foot.z), top)
  }

  private rayAt(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2)
    const raycaster = new Raycaster()
    raycaster.setFromCamera(ndc, this.camera)
    return raycaster.ray
  }

  /** World units per screen pixel at `distance` from the camera, for sizing things in pixels. */
  private worldPerPixel(distance: number) {
    return (2 * distance * Math.tan(rad(this.camera.fov) / 2)) / this.height
  }

  /**
   * How long (in nautical miles) to draw an aircraft whose real length is
   * `lengthM`. Normally a fixed size in the world, so it grows as you zoom in,
   * sized to look like MAP3D.planeSize from the default camera distance; never
   * smaller than a few pixels when zoomed far out. With MAP3D.fixedScreenSize,
   * the same number of pixels at any distance instead.
   */
  private modelLength(at: Vector3, lengthM: number) {
    const px = MAP3D.planeSize * 2.6 * Math.sqrt(lengthM / 38)
    const here = this.worldPerPixel(this.camera.position.distanceTo(at))
    if (MAP3D.fixedScreenSize) return px * here
    return Math.max(px * this.worldPerPixel(DEFAULT_DISTANCE), MIN_MODEL_PX * here)
  }


  private updateProjection() {
    this.camera.updateProjectionMatrix()
    // Shear the projection so its center sits in the uncovered area (see resize).
    this.camera.projectionMatrix.elements[8] -= this.shift.x
    this.camera.projectionMatrix.elements[9] -= this.shift.y
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert()
  }

  /** Remembers the camera in this browser (also before a setup is saved). */
  saveCamera() {
    try {
      const { position: p } = this.camera
      const { target: t } = this.controls
      localStorage.setItem(CAMERA_KEY, JSON.stringify({ position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] }))
    } catch {
      // Storage unavailable: the view just won't be remembered.
    }
  }

  private restoreCamera() {
    try {
      const saved = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? 'null') as { position: number[]; target: number[] } | null
      if (saved?.position?.length === 3 && saved.target?.length === 3) {
        this.camera.position.set(saved.position[0], saved.position[1], saved.position[2])
        this.controls.target.set(saved.target[0], saved.target[1], saved.target[2])
        this.controls.update()
        return
      }
    } catch {
      // Fall through to the default view.
    }
    this.resetCamera()
  }
}

/**
 * An alpha map that's solid in the middle and fades to clear at the ground's
 * edges (and fully clear in its corners), drawn as a radial gradient.
 */
function edgeFade() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(size / 2, size / 2, size * EDGE_FADE_START, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, '#fff')
  gradient.addColorStop(1, '#000')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

/** Ground dots' size in pixels, and a soft round sprite for them (points are square otherwise). */
const DOT_PX = 5
/** Size of the report-ahead dots (MAP.showPredictions), in pixels. */
const WAYPOINT_PX = 8

function roundDot() {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, '#fff')
  gradient.addColorStop(0.6, '#fff')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

/** Where the fade begins, as a fraction of the ground's width from its middle. */
const EDGE_FADE_START = 0.3

/** Where the camera starts, and its distance from the map's middle, which sets the aircraft's world size. */
const DEFAULT_CAMERA = new Vector3(0, -FETCH_RADIUS_NM * 1.25, FETCH_RADIUS_NM * 0.85)
const DEFAULT_DISTANCE = DEFAULT_CAMERA.length()
/** Aircraft never get smaller than this on screen, however far out you zoom. */
const MIN_MODEL_PX = 6

const ROUTE_SEGMENTS = 40
/** Ground grid resolution with terrain on: ~0.5 nm per cell over the area. */
const GROUND_SEGMENTS = 255
const FT_PER_M = 3.28084
/** Route lines rise toward this altitude (feet) away from the airport. */
const CRUISE_FT = 30_000

/** Points a dashed line along `path` (at altitude), or hides it when null or empty. `start` overrides the first point. */
function setPathLine(
  line: Line,
  path: { points: LatLon[]; alts: (number | null)[] } | null,
  start: { x: number; y: number; z: number } | null,
  color: Color,
  opacity: number,
) {
  line.visible = !!path && path.points.length > 0
  if (!path || !line.visible) return
  const positions = new Float32Array(path.points.length * 3)
  path.points.forEach((p, i) => {
    const l = local(p)
    positions.set(i === 0 && start ? [start.x, start.y, start.z] : [l.x, l.y, heightOf(path.alts[i])], i * 3)
  })
  const geometry = line.geometry
  const attr = geometry.getAttribute('position') as BufferAttribute | undefined
  if (attr?.count === path.points.length) {
    attr.copyArray(positions)
    attr.needsUpdate = true
  } else {
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
  }
  line.computeLineDistances()
  const material = line.material as LineDashedMaterial
  material.color.copy(color)
  material.opacity = opacity
}

const HUD_COLOR = '#e8eef8'
const HUD_OPACITY = 0.5
/** Width of the heading tape and the room the altitude beside it needs, in pixels. */
const HUD_WIDTH = 260
const HUD_ALT_WIDTH = 90
const HUD_PX_PER_DEG = 3
const COMPASS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }

const AXIS_COLOR = 0xe8eef8
const AXIS_GLIDE_MS = 1200

/** A unit-tall vertical line, solid at the ground and fading out at the top. */
function axisGeometry() {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 1]), 3))
  const c = new Color(AXIS_COLOR)
  geometry.setAttribute('color', new BufferAttribute(new Float32Array([c.r, c.g, c.b, 0.9, c.r, c.g, c.b, 0]), 4))
  return geometry
}

/** A flat unit circle, for the ring around the axis's foot. */
function ringGeometry() {
  const segments = 48
  const positions = new Float32Array(segments * 3)
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    positions.set([Math.cos(a), Math.sin(a), 0], i * 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  return geometry
}

function rad(deg: number) {
  return (deg * Math.PI) / 180
}

/**
 * Points along the great circle from `from` toward `to`, stopping after
 * `maxNm` nautical miles (or at `to`, if closer).
 */
function greatCircle(from: LatLon, to: LatLon, maxNm: number, segments: number): LatLon[] {
  const toVec = ({ lat, lon }: LatLon) => {
    const [φ, λ] = [rad(lat), rad(lon)]
    return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)]
  }
  const a = toVec(from)
  const b = toVec(to)
  const angle = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
  if (angle < 1e-9) return [from, to]
  // Central angle covered: maxNm of arc, or the whole way.
  const reach = Math.min(angle, rad(maxNm / 60))
  const points: LatLon[] = []
  for (let i = 0; i <= segments; i++) {
    const f = (reach * i) / segments
    const [wa, wb] = [Math.sin(angle - f) / Math.sin(angle), Math.sin(f) / Math.sin(angle)]
    const [x, y, z] = [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]]
    points.push({ lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI })
  }
  return points
}

/** Moving average over up to `radius` neighbours, narrowing at the ends so they stay put. */
function smooth<T extends { x: number; y: number; z: number }>(points: T[], radius: number): T[] {
  if (radius <= 0 || points.length < 3) return points
  const last = points.length - 1
  return points.map((p, i) => {
    const r = Math.min(radius, i, last - i)
    if (r === 0) return p
    let [x, y, z] = [0, 0, 0]
    for (let j = i - r; j <= i + r; j++) {
      x += points[j].x
      y += points[j].y
      z += points[j].z
    }
    const n = 2 * r + 1
    return { ...p, x: x / n, y: y / n, z: z / n }
  })
}
