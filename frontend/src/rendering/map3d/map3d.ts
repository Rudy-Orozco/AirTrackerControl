import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Euler,
  Fog,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  MeshPhongMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
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
import { aircraftSize } from '../../domain/aircraft/aircraftShapes'
import type { Flight } from '../../domain/tracking/flights'
import type { GroundTrack } from '../../domain/tracking/groundTracker'
import type { AssistPath, RunwayGuide } from '../../domain/tracking/runwayAssist'
import type { AirportLayout } from '../../types/airport'
import { buildAirportModel, buildMapRunways } from './airportModel'
import { CloudLayers, type CloudLabel } from './clouds'
import { PrecipShafts } from './precip'
import type { Radar } from '../map/radar'
import { echoTopAround, type EchoTops } from '../../services/api/echoTops'
import type { CloudField } from '../map/clouds'
import { AIRPORT_PRESET, CENTER, FETCH_RADIUS_NM, MAP, MAP3D, PROCEDURES, type Map3DTrafficStyle } from '../../config/config'
import { proceduresToShow, type ProcedureMatch } from '../../domain/procedures/matcher'
import { focusRoute } from '../../domain/procedures/route'
import { drawWaypoint, legAltitude, procedureColor } from '../map/procedureLayer'
import { pieceRole, procedurePieces, proceduresVersion, shownWaypoints } from '../../domain/procedures/procedures'
import { bankOf, pitchOf } from '../diorama/diorama'
import type { Line as MapLine } from '../../types/airport'
import type { MapLayers } from '../map/mapLayers'
import { elevationAt, type Terrain } from '../map/terrain'
import { createProjection, drawFocusBrackets, drawTrackLabels, labelFont, lastOnScreen, renderBackground, type Point } from '../map/renderer'
import { clearAnchor, orbitAnchor, type OrbitAnchor } from '../../state/orbitAnchor'
import { estimatedPath, predictedPath, trailStart, type LatLon, type Track } from '../../domain/tracking/tracker'
import { greatCircle, distanceNm } from '../../domain/geo/greatCircle'
import type { FocusRoute } from '../../state/selection'
import { localStore } from '../../services/storage'

const FT_PER_NM = 6076.12
const LON_SCALE = Math.cos((CENTER.lat * Math.PI) / 180)
const BACKGROUND = 0x03050a
const CAMERA_KEY = 'map3dCamera'

/**
 * Where to stand in the street: nautical miles east (x) and north (y) of the
 * airport, with the eye `eyeFt` above the ground (a person's if not given) and
 * first facing compass `heading` (the way the camera faced if not given).
 */
export interface StreetSpot {
  x: number
  y: number
  eyeFt?: number
  heading?: number
}

/** Nautical miles east (x) and north (y) of the airport. */
export function local(p: LatLon) {
  return { x: (p.lon - CENTER.lon) * 60 * LON_SCALE, y: (p.lat - CENTER.lat) * 60 }
}

/** Drawn height in nautical miles: above the field, exaggerated per MAP3D.altitudeScale. */
function heightOf(altitudeFt: number | null) {
  if (altitudeFt === null) return 0
  return (Math.max(altitudeFt - AIRPORT_PRESET.elevationFt, 0) / FT_PER_NM) * MAP3D.altitudeScale
}

/** The aircraft the camera follows (see selection.ts): its hex code and where it's drawn. */
export interface Focus {
  hex: string
  pos: LatLon
  altitude: number | null
  /** Its route to its destination (departures) or from its origin (arrivals), if known. */
  route: FocusRoute | null
  heading: number
  onGround: boolean
  groundSpeed: number | null
  /** Feet per minute, positive climbing. */
  verticalRate: number | null
  /** Nautical miles to the airport. */
  distanceNm: number
  /** Its details, for drawing it when it's on the ground (the map only draws airborne traffic). */
  info: Flight
  /** Riding along in its cockpit or behind its tail, rather than circling it. */
  ride: 'cockpit' | 'tail' | null
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
  /** The landing or takeoff path it's being guided along (MAP.showAssistPaths). */
  assist: Line
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
  /**
   * The scenery: the ground and everything drawn at height but the aircraft
   * themselves (trails, curtains, lines, markers). Squashed down (`vScale`)
   * while riding along, so heights come out true rather than exaggerated; the
   * aircraft stay outside it, placed at the squashed heights, so their models
   * keep their shape.
   */
  private readonly world = new Group()
  /** How much of the drawn heights to keep: 1 normally, down to true height (1 / MAP3D.altitudeScale) riding along. */
  private vScale = 1
  /** The airport itself, at true size (see airportModel.ts), once its layout has loaded. */
  private airport: ReturnType<typeof buildAirportModel> | null = null
  /**
   * The airport's runways as the map draws them (pale, widened bars), taken out
   * of the ground picture so they can make way for the airport model up close.
   */
  private mapRunways: Mesh | null = null
  /** With terrain on, the ground is flat out to this far from the airport (nm), so the airport lies on it. */
  private flatRadius = 0
  private readonly camera = new PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, 2000)
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
  /** Where the camera was before it started following an aircraft, to go back to once it's let go. */
  private home: { position: Vector3; target: Vector3 } | null = null
  /** Following an aircraft: which, and the glide over to it. */
  private following: { hex: string; start: number; from: Vector3; fromDistance: number } | null = null
  /** Gliding back home after letting an aircraft go. */
  private returning: { start: number; target: Vector3; offset: Vector3 } | null = null
  /**
   * The followed flight's route, over the whole way to the other airport: out
   * past the edge of the map, so not fogged.
   */
  private readonly focusRoute = new Line(
    new BufferGeometry(),
    new LineDashedMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, dashSize: 0.6, gapSize: 0.45 }),
  )
  /**
   * Riding along with the followed aircraft, or moving into or out of it:
   * `blend` runs from 0 (following from outside, at `offset` from it) to 1
   * (riding along), and `view` from 0 (in the cockpit) to 1 (behind the tail).
   * `attitude` and `chase` are the aircraft's smoothed orientation for the
   * cockpit and tail cameras, and `body` its own. `look` turns the view away
   * from straight ahead (degrees: yaw to the left, pitch up), and `zoom`
   * magnifies it (`zoomShown` eases after it).
   */
  private riding: {
    blend: number
    view: number
    mode: 'cockpit' | 'tail' | null
    look: { yaw: number; pitch: number }
    zoom: number
    zoomShown: number
    offset: Vector3
    attitude: Quaternion | null
    chase: Quaternion | null
    body: Quaternion
    at: Vector3
    /** For the head-up display: flight path angle and angle of attack (degrees), and load factor (G). */
    readout: { fpa: number; aoa: number; load: number }
  } | null = null
  /** The followed aircraft when it's on the ground, which the map doesn't otherwise draw. */
  private readonly focusMesh = new Mesh(
    new BufferGeometry(),
    new MeshPhongMaterial({ flatShading: true, shininess: 40, transparent: true, side: DoubleSide, forceSinglePass: true }),
  )
  /**
   * Standing in the street (see streetView.ts), or moving into or out of it:
   * `blend` runs from 0 (where the camera was, `from`) to 1 (standing at
   * `spot`, eye height above the ground). The view faces compass `heading` and
   * `pitch` degrees up; `zoom` magnifies it (`zoomShown` eases after it). While
   * `tracking`, it turns to keep the selected aircraft (`trackedHex`) in view.
   */
  private street: {
    blend: number
    spot: Vector2
    heading: number
    pitch: number
    zoom: number
    zoomShown: number
    tracking: boolean
    trackedHex: string | null
    /** Eye height above the ground: a person's, or a tower cab's. */
    eyeNm: number
    from: { position: Vector3; quaternion: Quaternion; target: Vector3 }
  } | null = null
  /** Picking where to stand in the street: a pin on the ground under the cursor shows where it'd be. */
  private streetPlacing = false
  private readonly streetPin = streetPinMarker()
  /** Whether the camera was near the airport last frame (MAP3D.airportRangeNm), when street view is offered. */
  private nearAirport = false
  /** Aircraft on the ground at the airport, drawn while the camera is near it (MAP3D.showGroundTraffic). */
  private readonly groundCrafts = new Map<GroundTrack, Mesh<BufferGeometry, MeshPhongMaterial>>()
  private assistPaths: ((t: Track) => AssistPath | null) | null = null
  private groundAssistPaths: ((g: GroundTrack) => AssistPath | null) | null = null
  /** Takeoff paths of departures still on the ground (MAP.showAssistPaths). */
  private readonly groundPathLines = new Map<GroundTrack, Line>()
  private runwayGuides: ((now: number) => RunwayGuide[]) | null = null
  /** The localizers, glide paths and climb-outs of the runways in use (MAP.showRunwayGuides), by RunwayGuide.id. */
  private readonly guideLines = new Map<string, GuideLines>()
  /** STARs, SIDs and approaches in the air at their altitudes (see updateProcedures), rebuilt when what's shown changes. */
  private readonly procedureLines = new Group()
  private procedureKey = ''
  private procedureLabels: { at: Vector3; text: string; color: string; opacity: number; focused: boolean; size?: number; named?: boolean }[] = []
  /** The clouds (MAP3D.clouds), and the tops over the airport, labeled. */
  private readonly clouds = new CloudLayers()
  private cloudLabels: CloudLabel[] = []
  /** Rain and snow falling from the clouds (MAP3D.precipitation), from the radar the ground was last drawn with. */
  private readonly precip = new PrecipShafts()
  private precipRadar: Radar | null = null
  /** How high the precipitation cores reach, for the rain's height in storms. */
  private echoTops: EchoTops | null = null
  /** Where each aircraft was drawn on screen last frame, for clicking on one. */
  private hits: { hex: string; x: number; y: number }[] = []
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
    this.scene.add(this.world)
    this.world.add(this.ground)
    this.world.add(this.procedureLines)
    this.world.add(this.clouds.group)
    this.world.add(this.precip.mesh)
    this.drops.frustumCulled = false
    this.world.add(this.drops)
    this.dots.frustumCulled = false
    this.world.add(this.dots)
    this.waypoints.frustumCulled = false
    this.world.add(this.waypoints)
    this.streetPin.visible = false
    this.world.add(this.streetPin)
    for (const o of [this.axis, this.axisRing, this.ball, this.focusRoute, this.focusMesh]) {
      o.frustumCulled = false
      o.visible = false
      if (o === this.focusMesh) this.scene.add(o)
      else this.world.add(o)
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
    // The airport's own runways are drawn separately (see mapRunways); other airports' stay in the picture.
    const ours = (line: MapLine) => line.every(([lon, lat]) => Math.hypot(local({ lat, lon }).x, local({ lat, lon }).y) < AIRPORT_RUNWAYS_NM)
    const ground = basemap && { ...basemap, runways: basemap.runways.filter((line) => !ours(line)) }
    const canvas = renderBackground(half, half, 2, view, createProjection(view, CENTER), ground, radar, terrain)
    if (this.mapRunways) {
      this.world.remove(this.mapRunways)
      disposeTree(this.mapRunways)
      this.mapRunways = null
    }
    if (basemap) {
      // As wide as the flat map's 2.5 px bars, at the ground picture's scale.
      this.mapRunways = buildMapRunways(basemap.runways.filter(ours), ([lon, lat]) => {
        const { x, y } = local({ lat, lon })
        return new Vector2(x, y)
      }, MAP_RUNWAY_PX / view.pxPerNm)
      this.world.add(this.mapRunways)
    }
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    this.ground.material.map?.dispose()
    this.ground.material.map = texture
    this.ground.material.color.set(0xffffff)
    this.ground.material.needsUpdate = true

    this.terrain = MAP.terrain ? terrain : null
    this.buildGround()
    this.precipRadar = radar
    this.buildPrecip()
  }

  /** Lets the rain's cores reach as high as `tops` say (none: just from the cloud bases). */
  setEchoTops(tops: EchoTops | null) {
    this.echoTops = tops
    this.buildPrecip()
  }

  /** Lets the rain fall from the clouds' bases to the ground as they now are. */
  private buildPrecip() {
    this.precip.build(this.precipRadar, {
      radiusNm: FETCH_RADIUS_NM,
      // The clouds' bases whether or not they're shown, so the rain keeps its height either way.
      baseAt: (x, y) => this.clouds.baseAt(x, y),
      coreTopAt: (x, y) => {
        const tops = this.echoTops
        return tops && echoTopAround(tops, CENTER.lat + y / 60, CENTER.lon + x / (60 * LON_SCALE))
      },
      defaultBaseFt: AIRPORT_PRESET.elevationFt + PRECIP_DEFAULT_BASE_FT,
      heightOf,
      groundZ: (x, y) => this.groundZ(x, y),
    })
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

  /**
   * Height of the ground at a point (nautical miles east/north), drawn like
   * aircraft heights; 0 without terrain. Level with the field under the
   * airport, easing into the terrain around it.
   */
  private groundZ(x: number, y: number) {
    if (!this.terrain) return 0
    const meters = elevationAt(this.terrain, CENTER.lat + y / 60, CENTER.lon + x / (60 * LON_SCALE))
    const z = ((meters * FT_PER_M - AIRPORT_PRESET.elevationFt) / FT_PER_NM) * MAP3D.altitudeScale
    if (!this.flatRadius) return z
    return z * smoothstep(Math.min(Math.max((Math.hypot(x, y) - this.flatRadius) / FLAT_BLEND_NM, 0), 1))
  }

  /** Lays the airport (runways, taxiways, aprons and buildings) on the map, and flattens the terrain under it. */
  setAirport(layout: AirportLayout) {
    if (this.airport) {
      this.world.remove(this.airport.group)
      disposeTree(this.airport.group)
    }
    this.airport = buildAirportModel(layout, ([lon, lat]) => {
      const { x, y } = local({ lat, lon })
      return new Vector2(x, y)
    })
    this.world.add(this.airport.group)
    this.flatRadius = this.airport.extentNm + FLAT_MARGIN_NM
    if (this.terrain) this.buildGround()
  }

  /** Shows the clouds (see map/clouds.ts), labeling the tops over the airport. */
  setClouds(field: CloudField) {
    this.cloudLabels = this.clouds.set(field, heightOf)
    this.buildPrecip()
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
    this.home = null
    this.following = null
    this.returning = null
    this.stepOut()
    this.leaveStreet()
    this.controls.target.set(0, 0, 0)
    this.camera.position.copy(DEFAULT_CAMERA)
    this.controls.update()
    this.saveCamera()
  }

  /**
   * Draws one frame, following `focus` if given, with `ground` (aircraft on the
   * ground at the airport) when the camera's near it, and standing at
   * `street` (see streetView.ts) if given. Call after the trackers have stepped.
   */
  render(tracks: Iterable<Track>, focus: Focus | null = null, ground: Iterable<GroundTrack> = [], street: StreetSpot | null = null) {
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
    this.showStreetPin(now)
    // Riding along or standing in the street, heights come down to true scale (as the
    // camera goes in, so it isn't a jump), and aircraft to true size.
    const altitudeScale = MAP3D.altitudeScale
    const realism = smoothstep(Math.max(this.riding?.blend ?? 0, this.street?.blend ?? 0))
    this.vScale = 1 + (1 / altitudeScale - 1) * realism
    this.world.scale.z = this.vScale
    // Buildings are built at true height; stretched like everything else's.
    if (this.airport) this.airport.buildings.scale.z = altitudeScale
    // The followed aircraft in the scenery's own heights, and where it's drawn (squashed with it).
    const focusLocal = focus ? new Vector3(local(focus.pos).x, local(focus.pos).y, heightOf(focus.altitude)) : null
    const focusAt = focusLocal ? focusLocal.clone().setZ(focusLocal.z * this.vScale) : null
    const list = [...tracks]
    // Picked another aircraft while riding along: straight out, then over to it from there.
    if (this.riding && this.following?.hex !== focus?.hex) this.stepOut()
    // Riding along takes over from the street: straight back to where the camera was first.
    if (focus?.ride && this.street) this.leaveStreet()
    if (focus && focusAt && (focus.ride || this.riding)) {
      this.rideAlong(now, dt, focus, focusAt, list)
    } else if (street || this.street) {
      if (this.riding) this.stepOut()
      this.standInStreet(dt, street, focus?.hex ?? null, focusAt)
    } else {
      // Let go while in the cockpit: back out to where the camera was following from first.
      if (this.riding) this.stepOut()
      this.followFocus(now, focus?.hex ?? null, focusAt)
      this.controls.update(dt)
    }
    // Labels are placed by projecting through the camera before it's rendered (which would
    // update its view): without this, they'd be a frame behind it, swimming and shaking off
    // their aircraft wherever the camera moves fast (riding along, turning, the buffet).
    this.camera.updateMatrixWorld()
    // Riding along, the followed aircraft isn't marked; from the cockpit, it isn't drawn at all.
    const ridingWith = (this.riding?.blend ?? 0) > 0.5 ? focus?.hex : null
    const inside = ridingWith && (this.riding?.view ?? 0) < 0.5 ? ridingWith : null
    // Riding along or in the street, everything shrinks to its true size, as a person would see it.
    const trueScale = smoothstep(Math.max(this.riding?.blend ?? 0, this.street?.blend ?? 0))
    // Close to the airport, its model (and the aircraft on its ground) are drawn; further
    // out they'd be specks, so it's left to the map's own simple runways and isn't drawn at all.
    const cameraDistance = this.camera.position.length()
    const nearAirport = cameraDistance < MAP3D.airportRangeNm
    this.nearAirport = nearAirport || this.street !== null
    // Closer still (MAP3D.trueSizeRangeNm), aircraft close to the airport (departing, or on
    // final) are drawn at true size too, next to its runways; eased in and out so none pops.
    const range = MAP3D.trueSizeRangeNm
    const closeIn = (distance: number) => 1 - smoothstep(Math.min(Math.max((distance - range) / (range * TRUE_SIZE_EASE), 0), 1))
    const closeCamera = MAP3D.trueSizeNearAirport ? closeIn(cameraDistance) : 0
    if (this.airport) this.airport.group.visible = MAP3D.showAirport && nearAirport
    // The map's simple runways, wherever the airport model isn't.
    if (this.mapRunways) this.mapRunways.visible = !this.airport?.group.visible
    this.clouds.group.visible = MAP3D.clouds.enabled
    this.clouds.setOpacity(MAP3D.clouds.opacity)
    this.clouds.setMinDensity(MAP3D.clouds.minDensity)
    this.precip.update(MAP3D.precipitation.opacity, MAP3D.precipitation.enabled)
    this.world.updateMatrixWorld()
    // Fog only the far side of the map, however far out the camera is zoomed;
    // fixed distances would darken the whole map when zoomed out.
    const fog = this.scene.fog as Fog
    const distance = this.camera.position.distanceTo(this.controls.target) * (1 - trueScale)
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

    // Once landed, an aircraft carries on in the ground traffic (when shown), from where it touched down.
    const allGround = [...ground]
    const groundList = MAP3D.showGroundTraffic && nearAirport ? allGround : []
    const onTheGround = new Set(groundList.filter((g) => g.opacity > 0).map((g) => g.info.hex))
    for (const t of list) {
      const style = MAP3D.traffic[t.info.kind]
      if (t.opacity <= 0 || !style.show) continue
      if (t.landedAt !== null && onTheGround.has(t.info.hex)) continue
      seen.add(t)
      const craft = this.crafts.get(t) ?? this.addCraft(t)
      const { x, y } = local(t.pos)
      const z = heightOf(t.altitude)
      const opacity = t.opacity * style.opacity
      color.set(style.color)

      const size = aircraftSize(t.info.aircraftType, t.info.emitterCategory)
      const geometry = modelGeometry(size.kind, size.lengthM, size.spanM, t.info.aircraftType)
      if (craft.mesh.geometry !== geometry) craft.mesh.geometry = geometry
      craft.mesh.position.set(x, y, z * this.vScale)
      const drawnNm = this.modelLength(craft.mesh.position, size.lengthM) * style.scale
      const trueNm = size.lengthM / M_PER_NM
      let lengthNm = drawnNm + (trueNm - drawnNm) * trueScale
      // Near the airport with the camera: true size, but never smaller than a few pixels.
      const close = closeCamera && closeCamera * closeIn(Math.hypot(x, y))
      if (close) {
        const smallest = MIN_MODEL_PX * this.worldPerPixel(this.camera.position.distanceTo(craft.mesh.position))
        lengthNm += (Math.max(trueNm, smallest) - lengthNm) * close
      }
      craft.mesh.scale.setScalar(lengthNm / size.lengthM)
      // Pitched to match how steeply its path is drawn: at true heights, riding along.
      craft.mesh.rotation.set(rad(pitchOf(t, altitudeScale * this.vScale)), rad(bankOf(t)), -rad(t.heading), 'ZXY')
      // Riding along: the true attitude the camera rides with, so the tail view lines up with the aircraft.
      if (this.riding && t.info.hex === focus?.hex) craft.mesh.quaternion.copy(this.riding.body)
      craft.material.color.copy(color)
      craft.material.opacity = opacity
      craft.mesh.visible = t.info.hex !== inside

      this.updateTrail(craft, t, style, color, opacity)
      craft.trail.visible = style.trail
      craft.curtain.visible = style.curtain
      this.updateRoute(craft, t, style, x, y, z, color, opacity)
      // The followed flight's whole route is drawn on its own instead (see updateFocusRoute).
      if (focus?.route && t.info.hex === focus.hex) {
        craft.route.visible = false
        craft.routeEnd = null
      }
      this.updatePrediction(craft, t, x, y, z, color, opacity)
      this.updateAssistPath(craft, t)
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
      if (t.info.hex === ridingWith) continue
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
    this.hits = shown.map((t, i) => ({ hex: t.info.hex, ...screen[i] }))
    // Those still flying (not just landed) are drawn by the airborne tracker above.
    const flying = new Set([...seen].filter((t) => t.landedAt === null).map((t) => t.info.hex))
    const onGround = this.updateGroundTraffic(groundList, flying, inside)
    this.updateGroundAssistPaths(allGround)
    this.updateRunwayGuides()
    this.updateProcedures(focus ? { hex: focus.hex, pos: focus.pos } : null)
    const focusDrawn = !!focus && (flying.has(focus.hex) || onGround.has(focus.hex))
    this.updateFocusMesh(focus, focusAt, focusDrawn, trueScale, inside !== null)
    this.updateFocusRoute(focus, focusLocal)

    this.drops.geometry.setAttribute('position', new BufferAttribute(new Float32Array(drops), 3))
    this.drops.geometry.setAttribute('color', new BufferAttribute(new Float32Array(dropColors), 4))
    this.dots.geometry.setAttribute('position', new BufferAttribute(new Float32Array(dots), 3))
    this.dots.geometry.setAttribute('color', new BufferAttribute(new Float32Array(dotColors), 4))
    this.waypoints.geometry.setAttribute('position', new BufferAttribute(new Float32Array(marks), 3))
    this.waypoints.geometry.setAttribute('color', new BufferAttribute(new Float32Array(markColors), 4))
    this.renderer.render(this.scene, this.camera)

    const ctx = this.labels
    ctx.clearRect(0, 0, this.width, this.height)
    this.drawProcedureLabels()
    if (MAP3D.clouds.enabled && MAP3D.clouds.labels) this.drawCloudLabels()
    if (MAP.showLabels) drawTrackLabels(ctx, shown, MAP3D.traffic, screen)
    this.drawRouteLabels(routeLabels)
    if (focus?.route && this.focusRoute.visible) this.drawFocusRouteLabel(focus.route)
    if (focusAt && !ridingWith) this.drawFocus(focusAt)
    // In the cockpit, its own head-up display replaces the heading tape.
    // It's projected ahead of the pilot, so it fades as they look away from it or zoom in.
    let hud = 0
    if (this.riding) {
      const { blend, view, look, zoomShown } = this.riding
      const away = Math.max(Math.abs(look.yaw), Math.abs(look.pitch))
      hud = ((blend - 0.8) / 0.2) * (1 - smoothstep(Math.min(view / 0.3, 1)))
      hud *= 1 - smoothstep(Math.min(Math.max(away - 5, 0) / 15, 1))
      hud *= 1 - smoothstep(Math.min((zoomShown - 1) / 0.5, 1))
    }
    if (hud > 0) this.drawCockpitHud(focus, hud)
    else if (MAP3D.showHud) this.drawHud()
    if (this.riding && this.riding.blend > 0.8) {
      const { zoomShown, look } = this.riding
      this.drawLookHint(zoomShown, Math.abs(look.yaw) > 1 || Math.abs(look.pitch) > 1, false)
    } else if (this.street && this.street.blend > 0.8) {
      this.drawLookHint(this.street.zoomShown, Math.abs(this.street.pitch) > 1, true)
    }
  }

  /** The aircraft drawn nearest a screen position (client pixels), if one is close enough to count as clicked. */
  pickAircraft(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    let best: string | null = null
    let bestDistance = PICK_RADIUS_PX
    for (const hit of this.hits) {
      const d = Math.hypot(hit.x - x, hit.y - y)
      if (d < bestDistance) {
        best = hit.hex
        bestDistance = d
      }
    }
    return best
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
    for (const mesh of this.groundCrafts.values()) mesh.material.dispose()
    for (const line of this.groundPathLines.values()) {
      line.geometry.dispose()
      ;(line.material as LineDashedMaterial).dispose()
    }
    for (const lines of this.guideLines.values()) disposeTree(lines.group)
    disposeTree(this.procedureLines)
    this.clouds.dispose()
    this.precip.dispose()
    this.controls.dispose()
    this.ground.material.map?.dispose()
    this.ground.material.alphaMap?.dispose()
    if (this.airport) disposeTree(this.airport.group)
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
    const assist = new Line(
      new BufferGeometry(),
      new LineDashedMaterial({ transparent: true, depthWrite: false, dashSize: 0.12, gapSize: 0.09 }),
    )
    for (const o of [trail, curtain, route, prediction, estimate, assist]) o.frustumCulled = false
    this.scene.add(mesh)
    this.world.add(trail, curtain, route, prediction, estimate, assist)
    const craft: Craft = { mesh, material, trail, curtain, route, prediction, estimate, assist, count: 0, capacity: 0, builtAt: -1, routeEnd: null }
    this.crafts.set(t, craft)
    return craft
  }

  private removeCraft(t: Track, craft: Craft) {
    this.scene.remove(craft.mesh)
    this.world.remove(craft.trail, craft.curtain, craft.route, craft.prediction, craft.estimate, craft.assist)
    craft.material.dispose()
    for (const o of [craft.trail, craft.curtain, craft.route, craft.prediction, craft.estimate, craft.assist]) {
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

  /**
   * The landing or takeoff path the aircraft's being guided along near the
   * runways (MAP.showAssistPaths), dashed, in the board's arrival or departure
   * color, as bold as the guidance is strong.
   */
  private updateAssistPath(craft: Craft, t: Track) {
    const path = MAP.showAssistPaths && this.assistPaths ? this.assistPaths(t) : null
    craft.assist.visible = path !== null
    if (!path) return
    const color = new Color((path.landing ? MAP3D.traffic.arrival : MAP3D.traffic.departure).color)
    setPathLine(craft.assist, { points: path.points, alts: path.alts }, null, color, 0.85 * path.strength * t.opacity)
  }

  /** Where the landing and takeoff paths come from (the tracker's runway assist), for MAP.showAssistPaths. */
  setAssistPaths(paths: (t: Track) => AssistPath | null, groundPaths: (g: GroundTrack) => AssistPath | null) {
    this.assistPaths = paths
    this.groundAssistPaths = groundPaths
  }

  /** The takeoff paths of departures still on the ground, lined up or rolling (MAP.showAssistPaths). */
  private updateGroundAssistPaths(ground: GroundTrack[]) {
    const seen = new Set<GroundTrack>()
    if (MAP.showAssistPaths && this.groundAssistPaths) {
      const color = new Color(MAP3D.traffic.departure.color)
      for (const g of ground) {
        const path = g.opacity > 0 ? this.groundAssistPaths(g) : null
        if (!path) continue
        seen.add(g)
        let line = this.groundPathLines.get(g)
        if (!line) {
          line = new Line(new BufferGeometry(), new LineDashedMaterial({ transparent: true, depthWrite: false, dashSize: 0.12, gapSize: 0.09 }))
          line.frustumCulled = false
          this.world.add(line)
          this.groundPathLines.set(g, line)
        }
        setPathLine(line, { points: path.points, alts: path.alts }, null, color, 0.85 * g.opacity)
      }
    }
    for (const [g, line] of this.groundPathLines) {
      if (seen.has(g)) continue
      this.world.remove(line)
      line.geometry.dispose()
      ;(line.material as LineDashedMaterial).dispose()
      this.groundPathLines.delete(g)
    }
  }

  /** Where the runway guides come from (the tracker's runway assist), for MAP.showRunwayGuides. */
  setRunwayGuides(guides: (now: number) => RunwayGuide[]) {
    this.runwayGuides = guides
  }

  /**
   * What the runway assist guides aircraft along on the runways in use
   * (MAP.showRunwayGuides): on final, the localizer dashed along the ground with
   * the edges of the area either side that still counts, the glide path in the
   * air with a bar across it every nautical mile from touchdown, a wider one at
   * the gate where arrivals are held to it (on a post down to the ground), and
   * one at the touchdown aiming point; taking off, the climb-out along the
   * ground. In the arrival or departure color, as bold as it's in use.
   */
  private updateRunwayGuides() {
    const guides = MAP.showRunwayGuides && this.runwayGuides ? this.runwayGuides(performance.now()) : []
    const seen = new Set<string>()
    for (const g of guides) {
      seen.add(g.id)
      let lines = this.guideLines.get(g.id)
      if (!lines) {
        lines = guideLines()
        this.world.add(lines.group)
        this.guideLines.set(g.id, lines)
      }
      const color = new Color((g.landing ? MAP3D.traffic.arrival : MAP3D.traffic.departure).color)
      const field = AIRPORT_PRESET.elevationFt
      setPathLine(lines.centerline, { points: g.centerline, alts: g.centerline.map(() => field) }, null, color, 0.55 * g.strength)
      setPathLine(lines.glide, g.glide, null, color, 0.45 * g.strength)
      const at = (p: LatLon, alt: number) => {
        const l = local(p)
        return [l.x, l.y, heightOf(alt)]
      }
      const edges = g.edges.flatMap((edge) => edge.slice(1).flatMap((p, i) => [...at(edge[i], field), ...at(p, field)]))
      setSegments(lines.edges, edges, color, 0.2 * g.strength)
      const bars = g.bars.flatMap((b) => {
        // The touchdown aiming point is on the runway; the rest across the glide path, the gate on a post.
        const alt = b.kind === 'touchdown' ? field : b.alt
        const bar = [...at(b.from, alt), ...at(b.to, alt)]
        if (b.kind !== 'gate') return bar
        const mid = { lat: (b.from.lat + b.to.lat) / 2, lon: (b.from.lon + b.to.lon) / 2 }
        return [...bar, ...at(mid, field), ...at(mid, alt)]
      })
      setSegments(lines.bars, bars, color, 0.5 * g.strength)
    }
    for (const [id, lines] of this.guideLines) {
      if (seen.has(id)) continue
      this.world.remove(lines.group)
      disposeTree(lines.group)
      this.guideLines.delete(id)
    }
  }

  /**
   * STARs, SIDs and approaches (see proceduresToShow) as lines through their waypoints,
   * each at the altitude the procedure has aircraft cross it at (filled in
   * between, or estimated), so arrivals are seen to come down them: those
   * picked in the panel, and the followed flight's as it flies it (see focusRoute).
   */
  private updateProcedures(followed: { hex: string; pos: LatLon } | null) {
    const { shown, focus, approach } = PROCEDURES.show3d ? proceduresToShow(followed?.hex ?? null) : { shown: [], focus: null, approach: null }
    // The followed flight's STAR or SID, and its approach, as it flies them.
    const routes = followed
      ? ([focus, approach].filter(Boolean) as ProcedureMatch[]).flatMap((m) => {
          const route = focusRoute(m, followed.pos)
          return route ? [{ route, match: m }] : []
        })
      : []
    const key = [
      proceduresVersion(),
      PROCEDURES.opacity,
      PROCEDURES.labels,
      PROCEDURES.predict,
      // Waypoints on their own (the Waypoints tab).
      PROCEDURES.enabled && PROCEDURES.showWaypoints,
      PROCEDURES.waypointColor,
      PROCEDURES.waypointOpacity,
      PROCEDURES.waypointSize,
      PROCEDURES.waypointLabels,
      PROCEDURES.waypointAltitude,
      PROCEDURES.waypointFixedFt,
      PROCEDURES.waypointDropLine,
      PROCEDURES.waypointGroundDot,
      MAP3D.altitudeScale,
      // The ground under them (terrain, and the airport flattened into it).
      this.terrain !== null,
      this.flatRadius,
      procedureColor('star'),
      procedureColor('sid'),
      ...routes.map(({ route, match: m }) => `${m.procedure.name}.${m.transition}.${m.runway}.${m.predicted}.${route.passed}.${route.branches.length}`),
      ...shown.map(([p]) => p.name),
    ].join('|')
    if (key === this.procedureKey) return
    this.procedureKey = key
    disposeTree(this.procedureLines)
    this.procedureLines.clear()
    this.procedureLabels = []
    const labelled = new Set<string>()
    const polyline = (positions: number[], color: string, opacity: number, dashed: boolean) => {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
      const material = dashed
        ? new LineDashedMaterial({ color, transparent: true, depthWrite: false, opacity, dashSize: 0.4, gapSize: 0.4 })
        : new LineBasicMaterial({ color, transparent: true, depthWrite: false, opacity })
      const drawn = new Line(geometry, material)
      if (dashed) drawn.computeLineDistances()
      drawn.frustumCulled = false
      this.procedureLines.add(drawn)
    }
    /**
     * A line through `points`: in the air at its altitudes where they're charted;
     * where they're only estimated, traced on the ground, with a faint curtain up
     * to the estimate (and a fainter dashed line along its top).
     */
    const line = (route: { points: LatLon[]; alts: number[]; estimated: boolean[] }, color: string, opacity: number, dashed = false) => {
      const { points, alts, estimated } = route
      for (let i = 0; i < points.length - 1; ) {
        // A run of legs all charted, or all estimated (a leg with either end estimated is).
        const guess = estimated[i] || estimated[i + 1]
        let j = i + 1
        while (j < points.length - 1 && (estimated[j] || estimated[j + 1]) === guess) j++
        const samples = this.pathSamples(points.slice(i, j + 1), alts.slice(i, j + 1))
        if (!guess) polyline(samples.flatMap((p) => [p.x, p.y, p.air]), color, opacity, dashed)
        else {
          polyline(samples.flatMap((p) => [p.x, p.y, p.ground]), color, opacity, dashed)
          polyline(samples.flatMap((p) => [p.x, p.y, p.air]), color, opacity * ESTIMATE_TOP_OPACITY, true)
          this.procedureLines.add(curtainMesh(samples, color, opacity * ESTIMATE_CURTAIN_OPACITY))
        }
        i = j
      }
    }
    const mark = (
      route: { points: LatLon[]; alts: number[]; estimated: boolean[]; names: string[] },
      color: string,
      opacity: number,
      focused: boolean,
      altOf?: (name: string) => string | null,
    ) =>
      route.points.forEach((p, i) => {
        const name = route.names[i]
        if (labelled.has(name)) return
        labelled.add(name)
        const l = local(p)
        const alt = altOf?.(name) ?? null
        // On the ground under an estimated altitude, with the line traced there.
        const z = route.estimated[i] ? this.onGround(l.x, l.y) : this.aboveGround(l.x, l.y, heightOf(route.alts[i]))
        this.procedureLabels.push({ at: new Vector3(l.x, l.y, z), text: alt ? `${name} ${alt}` : name, color, opacity, focused })
      })
    const after = <T extends { points: LatLon[]; alts: number[]; estimated: boolean[]; names: string[] }>(r: T) => ({
      points: r.points.slice(1),
      alts: r.alts.slice(1),
      estimated: r.estimated.slice(1),
      names: r.names.slice(1),
    })

    // The followed flight's, as on the 2D map: the way it's come, fainter; ahead, bright; branches, dashed.
    for (const { route, match: focus } of routes) {
      const color = procedureColor(focus.kind)
      const bright = Math.min(1, PROCEDURES.opacity * 2)
      const altOf = (name: string) => legAltitude(focus.procedure, name)
      line(route.flown, color, PROCEDURES.opacity * 0.6)
      // Dashed while it's only predicted.
      line(route.ahead, color, bright, focus.predicted)
      for (const b of route.branches) line(b, color, PROCEDURES.opacity, true)
      mark(after(route.ahead), color, 1, true, altOf)
      mark(route.flown, color, 0.55, false)
      for (const b of route.branches) mark(b, color, PROCEDURES.opacity * 1.4, false, altOf)
    }
    // Those picked in the panel.
    for (const [procedure, kind] of shown) {
      const color = procedureColor(kind)
      for (const piece of procedurePieces(procedure)) {
        // An approach's missed approach, dashed.
        line(piece, color, PROCEDURES.opacity, pieceRole(piece) === 'missed')
        mark(piece, color, PROCEDURES.opacity, false)
      }
    }
    // Waypoints on their own (the Waypoints tab): at the altitude picked there, with a line down to a dot on the ground.
    const drops: number[] = []
    const dots: number[] = []
    for (const w of PROCEDURES.show3d ? shownWaypoints() : []) {
      if (labelled.has(w.name)) continue
      const l = local(w.at)
      const ground = this.onGround(l.x, l.y)
      const feet = PROCEDURES.waypointAltitude === 'fixed' ? PROCEDURES.waypointFixedFt : PROCEDURES.waypointAltitude === 'charted' ? w.altFt : null
      const z = feet === null ? ground : this.aboveGround(l.x, l.y, heightOf(feet))
      if (z > ground) {
        if (PROCEDURES.waypointDropLine) drops.push(l.x, l.y, ground, l.x, l.y, z)
        if (PROCEDURES.waypointGroundDot) dots.push(l.x, l.y, ground)
      }
      this.procedureLabels.push({
        at: new Vector3(l.x, l.y, z),
        text: w.alt ? `${w.name} ${w.alt}` : w.name,
        color: PROCEDURES.waypointColor,
        opacity: PROCEDURES.waypointOpacity,
        focused: false,
        size: PROCEDURES.waypointSize,
        named: PROCEDURES.waypointLabels,
      })
    }
    if (drops.length > 0) {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(drops), 3))
      const lines = new LineSegments(geometry, new LineBasicMaterial({ color: PROCEDURES.waypointColor, transparent: true, depthWrite: false, opacity: PROCEDURES.waypointOpacity * 0.5 }))
      lines.frustumCulled = false
      this.procedureLines.add(lines)
    }
    if (dots.length > 0) {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(dots), 3))
      const points = new Points(
        geometry,
        new PointsMaterial({ color: PROCEDURES.waypointColor, size: WAYPOINT_DOT_PX, sizeAttenuation: false, transparent: true, depthWrite: false, opacity: PROCEDURES.waypointOpacity }),
      )
      points.frustumCulled = false
      this.procedureLines.add(points)
    }
  }

  /**
   * A line through `points` at altitudes `alts` (feet), sampled for drawing:
   * each leg split into steps of about a nautical mile, with its altitude eased
   * along it and kept clear of the ground under it (`air`, see aboveGround, so a
   * long leg doesn't cut through hills between its waypoints), and the ground
   * itself just under it (`ground`).
   */
  private pathSamples(points: LatLon[], alts: number[]): { x: number; y: number; air: number; ground: number }[] {
    const out: { x: number; y: number; air: number; ground: number }[] = []
    const sample = (x: number, y: number, alt: number) => out.push({ x, y, air: this.aboveGround(x, y, heightOf(alt)), ground: this.onGround(x, y) })
    points.forEach((p, i) => {
      const b = local(p)
      if (i === 0) return sample(b.x, b.y, alts[0])
      const a = local(points[i - 1])
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / PROCEDURE_STEP_NM))
      for (let k = 1; k <= steps; k++) {
        const t = k / steps
        sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, alts[i - 1] + (alts[i] - alts[i - 1]) * t)
      }
    })
    return out
  }

  /** Just above the ground at `x`, `y` (drawing units), for a line traced on it. */
  private onGround(x: number, y: number) {
    return this.groundZ(x, y) + (PROCEDURE_GROUND_FT / FT_PER_NM) * MAP3D.altitudeScale
  }

  /** Height `z` (drawing units), or PROCEDURE_CLEARANCE_FT above the ground at `x`, `y` if that's higher. */
  private aboveGround(x: number, y: number, z: number) {
    return Math.max(z, this.groundZ(x, y) + (PROCEDURE_CLEARANCE_FT / FT_PER_NM) * MAP3D.altitudeScale)
  }

  /** The waypoints (see updateProcedures) as on the 2D map: four-pointed stars, named. */
  private drawProcedureLabels() {
    if (this.procedureLabels.length === 0) return
    const ctx = this.labels
    const font = `${Math.max(MAP.labelSize - 3, 8)}px ${MAP.fontFamily}`
    for (const { at, text, color, opacity, focused, size, named } of this.procedureLabels) {
      const p = at.clone().setZ(at.z * this.vScale).project(this.camera)
      if (p.z >= 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue
      const showName = named ?? (PROCEDURES.labels || focused)
      drawWaypoint(ctx, ((p.x + 1) / 2) * this.width, ((1 - p.y) / 2) * this.height, color, opacity, size ?? (focused ? 5 : 4), showName ? text : null, font)
    }
    ctx.globalAlpha = 1
    ctx.font = labelFont()
  }

  /** The cloud tops over the airport (feet above sea level), beside it at their height. */
  private drawCloudLabels() {
    if (this.cloudLabels.length === 0) return
    const ctx = this.labels
    ctx.font = `${Math.max(MAP.labelSize - 2, 8)}px ${MAP.fontFamily}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = CLOUD_LABEL_COLOR
    ctx.globalAlpha = CLOUD_LABEL_OPACITY
    for (const { at, text } of this.cloudLabels) {
      const p = at.clone().setZ(at.z * this.vScale).project(this.camera)
      if (p.z >= 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue
      const x = ((p.x + 1) / 2) * this.width
      const y = ((1 - p.y) / 2) * this.height
      ctx.fillRect(x - 6, y - 0.5, 4, 1)
      ctx.fillText(`${text} FT`, x, y)
    }
    ctx.globalAlpha = 1
    ctx.font = labelFont()
  }

  private drawRouteLabels(items: { at: Vector3; text: string; color: string; opacity: number }[]) {
    const ctx = this.labels
    ctx.font = `${MAP.labelSize - 1}px ${MAP.fontFamily}`
    ctx.letterSpacing = '2px'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const { at, text, color, opacity } of items) {
      const p = at.clone().setZ(at.z * this.vScale).project(this.camera)
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
    const offset = new Vector3()
    this.camera.getWorldDirection(offset)
    const heading = ((Math.atan2(offset.x, offset.y) * 180) / Math.PI + 360) % 360
    const feet = (this.camera.position.z * FT_PER_NM) / (MAP3D.altitudeScale * this.vScale) + AIRPORT_PRESET.elevationFt

    const half = HUD_WIDTH / 2
    const cx = (this.width * (1 + this.shift.x)) / 2
    const roomy = cx - half > Math.min(336, this.width * 0.4 + 16) + 8 && cx + half + HUD_ALT_WIDTH < this.width - 310
    // Riding along, the hint on how to look around takes the top.
    const top = roomy && !this.riding && !this.street ? 14 : 96
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

  /**
   * Following an aircraft: remembers where the camera was, glides over to the
   * aircraft (moving in closer if it's far out) and then keeps it in the middle,
   * still turning around it with the orbit or a drag. Once it's let go, glides
   * back to where it was.
   */
  private followFocus(now: number, hex: string | null, at: Vector3 | null) {
    const offset = new Vector3().subVectors(this.camera.position, this.controls.target)
    if (hex && at) {
      if (this.following?.hex !== hex) {
        // Switching aircraft keeps the first one's starting point as home.
        this.home ??= { position: this.camera.position.clone(), target: this.controls.target.clone() }
        this.following = { hex, start: now, from: this.controls.target.clone(), fromDistance: offset.length() }
        this.returning = null
      }
      const { start, from, fromDistance } = this.following
      const eased = 1 - (1 - Math.min((now - start) / FOLLOW_GLIDE_MS, 1)) ** 3
      if (eased < 1) {
        const distance = fromDistance + (Math.min(fromDistance, FOLLOW_DISTANCE) - fromDistance) * eased
        offset.setLength(distance)
        this.controls.target.lerpVectors(from, at, eased)
      } else {
        this.controls.target.copy(at)
      }
      this.camera.position.copy(this.controls.target).add(offset)
      this.controls.enablePan = false
      return
    }

    this.following = null
    if (!this.home) return
    this.returning ??= { start: now, target: this.controls.target.clone(), offset }
    const { start, target, offset: from } = this.returning
    const homeOffset = new Vector3().subVectors(this.home.position, this.home.target)
    const eased = 1 - (1 - Math.min((now - start) / FOLLOW_GLIDE_MS, 1)) ** 3
    // Distance and direction blend separately, so the camera swings around rather than cutting through.
    const length = from.length() + (homeOffset.length() - from.length()) * eased
    const blended = from.clone().lerp(homeOffset, eased)
    if (blended.lengthSq() < 1e-9) blended.copy(homeOffset)
    this.controls.target.lerpVectors(target, this.home.target, eased)
    this.camera.position.copy(this.controls.target).add(blended.setLength(length))
    if (eased === 1) {
      this.home = null
      this.returning = null
      this.saveCamera()
    }
  }

  /**
   * Points the followed flight's route line from the aircraft to the other
   * airport: up to cruise height and level, then down to the ground there.
   */
  private updateFocusRoute(focus: Focus | null, at: Vector3 | null) {
    const route = focus?.route
    // From the cockpit it would just be a pole out of the aircraft; behind the tail it leads the way.
    const riding = this.riding ? smoothstep(this.riding.blend) * (1 - smoothstep(this.riding.view)) : 0
    this.focusRoute.visible = !!route && !!at && riding < 0.5
    if (!route || !at) return
    const { points } = route
    const total = distanceNm(points[0], points[points.length - 1])
    const cruise = Math.max(heightOf(AIRPORT_PRESET.elevationFt + CRUISE_FT), at.z)
    const color = new Color(MAP3D.traffic[route.kind].color)
    const positions = new Float32Array(points.length * 3)
    const colors = new Float32Array(points.length * 4)
    points.forEach((p, i) => {
      const along = (total * i) / (points.length - 1)
      const climb = Math.min(along / CRUISE_RAMP_NM, 1)
      const z = Math.min(at.z + (cruise - at.z) * climb * (2 - climb), (cruise * (total - along)) / CRUISE_RAMP_NM)
      const l = local(p)
      positions.set(i === 0 ? [at.x, at.y, at.z] : [l.x, l.y, Math.max(z, 0)], i * 3)
      colors.set([color.r, color.g, color.b, 0.9 - 0.4 * (i / (points.length - 1))], i * 4)
    })
    const geometry = this.focusRoute.geometry
    const attr = geometry.getAttribute('position') as BufferAttribute | undefined
    if (attr?.count === points.length) {
      attr.copyArray(positions)
      attr.needsUpdate = true
      const colorAttr = geometry.getAttribute('color') as BufferAttribute
      colorAttr.copyArray(colors)
      colorAttr.needsUpdate = true
    } else {
      geometry.setAttribute('position', new BufferAttribute(positions, 3))
      geometry.setAttribute('color', new BufferAttribute(colors, 4))
    }
    this.focusRoute.computeLineDistances()
  }

  /** Labels the followed flight's route at the other airport, or where the line leaves the screen. */
  private drawFocusRouteLabel(route: FocusRoute) {
    const pos = this.focusRoute.geometry.getAttribute('position') as BufferAttribute
    const screen: Point[] = []
    for (let i = 0; i < pos.count; i++) {
      const p = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i) * this.vScale).project(this.camera)
      if (p.z >= 1) break
      screen.push({ x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height })
    }
    // Kept clear of the board, in the part of the screen it leaves uncovered (see resize).
    const at = lastOnScreen(screen, this.width * (1 + this.shift.x), this.height * (1 - this.shift.y), 40)
    if (!at) return
    // Where the line leaves the screen right by the aircraft (behind the tail, an arrival's runs back
    // past the camera), the label would sit on it, jumping about as the camera moves: fade it out there.
    const clear = Math.hypot(at.x - screen[0].x, at.y - screen[0].y)
    const fade = Math.min(Math.max((clear - ROUTE_LABEL_CLEAR_PX) / ROUTE_LABEL_CLEAR_PX, 0), 1)
    if (fade <= 0) return
    const ctx = this.labels
    const color = MAP3D.traffic[route.kind].color
    const right = at.x > (this.width * (1 + this.shift.x)) / 2
    ctx.save()
    ctx.globalAlpha = fade
    ctx.fillStyle = color
    if (at === screen[pos.count - 1]) {
      ctx.beginPath()
      ctx.arc(at.x, at.y, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.font = labelFont()
    ctx.letterSpacing = '1.5px'
    ctx.textAlign = right ? 'right' : 'left'
    ctx.textBaseline = 'bottom'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)'
    ctx.shadowBlur = 4
    ctx.fillText(route.label, at.x + (right ? -6 : 6), at.y - 6)
    ctx.restore()
  }

  /**
   * Riding along with the followed aircraft, from its cockpit or behind its
   * tail. In the cockpit the camera turns with its heading, pitch and bank,
   * lagging a little like a pilot's head, with a light buffet that's rougher low
   * down and a rumble on the ground. Behind the tail it's a chase camera: it
   * swings round after the aircraft more slowly, rolls only part way with it
   * and looks down at it a little. Going in or out, or between the two, the
   * camera glides; the field of view opens up to about what a person takes in.
   */
  private rideAlong(now: number, dt: number, focus: Focus, at: Vector3, tracks: Track[]) {
    if (!this.riding) {
      // Coming straight in (e.g. from the flat map): still remember where to go back to.
      this.home ??= { position: this.camera.position.clone(), target: this.controls.target.clone() }
      const offset = new Vector3().subVectors(this.camera.position, this.controls.target)
      if (this.following?.hex !== focus.hex || offset.length() > FOLLOW_DISTANCE) offset.setLength(FOLLOW_DISTANCE)
      this.following = { hex: focus.hex, start: now - FOLLOW_GLIDE_MS, from: at.clone(), fromDistance: offset.length() }
      this.returning = null
      this.riding = {
        blend: 0,
        view: focus.ride === 'tail' ? 1 : 0,
        mode: focus.ride,
        look: { yaw: 0, pitch: 0 },
        zoom: 1,
        zoomShown: 1,
        offset,
        attitude: null,
        chase: null,
        body: new Quaternion(),
        at: at.clone(),
        readout: { fpa: 0, aoa: 0, load: 1 },
      }
      this.controls.enabled = false
    }
    const riding = this.riding
    riding.at.copy(at)
    riding.blend = Math.min(Math.max(riding.blend + ((focus.ride ? 1 : -1) * dt) / COCKPIT_BLEND_S, 0), 1)
    if (focus.ride) riding.view = Math.min(Math.max(riding.view + ((focus.ride === 'tail' ? 1 : -1) * dt) / RIDE_SWITCH_S, 0), 1)
    // Switching between the cockpit and the tail starts looking straight ahead again.
    if (focus.ride && focus.ride !== riding.mode) {
      riding.mode = focus.ride
      this.recenterLook()
    }
    riding.zoomShown += (riding.zoom - riding.zoomShown) * (1 - Math.exp((-dt * 1000) / ZOOM_EASE_MS))
    if (riding.blend === 0 && !focus.ride) {
      this.stepOut()
      this.controls.update(dt)
      return
    }

    // The aircraft's attitude, plus a little buffet. The nose sits the angle of attack
    // above the flight path: true heights here, not exaggerated like the models' (a 3°
    // approach would look like a dive), and higher when slow or pulling G in a turn.
    const t = tracks.find((t) => t.info.hex === focus.hex && t.landedAt === null)
    const airborne = !!t && !focus.onGround
    const speed = focus.groundSpeed ?? 0
    const fpa = t && airborne && speed > 0 ? deg(Math.atan2(t.climbing * 1000 * M_PER_FT, speed * KT_TO_MS)) : 0
    const bank = t && airborne ? bankOf(t) : 0
    const load = 1 / Math.cos(rad(bank))
    const aoa = airborne ? angleOfAttack(speed, load) : 0
    const pitch = fpa + aoa
    riding.readout = { fpa, aoa, load }
    riding.body.setFromEuler(new Euler(rad(pitch), rad(bank), -rad(focus.heading), 'ZXY'))
    const s = now / 1000
    const rough = focus.onGround
      ? 0.06 * Math.min((focus.groundSpeed ?? 0) / 40, 1)
      : TURBULENCE_DEG * ((focus.altitude ?? 0) < LOW_ALTITUDE_FT ? 1.6 : 1)
    const bump = (a: number, b: number, c: number) => Math.sin(s * a + c) * 0.6 + Math.sin(s * b + c * 2.3) * 0.4
    const shaken = new Quaternion().setFromEuler(
      new Euler(rad(pitch + rough * bump(1.7, 4.3, 0.2)), rad(bank + rough * 1.4 * bump(1.3, 3.7, 1.1)), -rad(focus.heading + rough * 0.5 * bump(0.8, 2.1, 2.4)), 'ZXY'),
    )

    // Looking around (dragging): turned left or right about the aircraft's up, then up or down.
    const look = new Quaternion().setFromEuler(new Euler(rad(riding.look.pitch), 0, rad(riding.look.yaw), 'ZXY'))

    // In the cockpit: just above the aircraft's middle, looking out along its nose.
    riding.attitude ??= shaken.clone()
    riding.attitude.slerp(shaken, 1 - Math.exp((-dt * 1000) / COCKPIT_LAG_MS))
    const cockpitAttitude = riding.attitude.clone().multiply(look).multiply(CAMERA_IN_BODY)
    const cockpitEye = at.clone().add(new Vector3(0, 0, COCKPIT_EYE_NM).applyQuaternion(shaken))

    // Behind the tail: a few lengths back and up, swinging round after it.
    const chaseAim = new Quaternion().setFromEuler(new Euler(rad(pitch), rad(bank * TAIL_ROLL), -rad(focus.heading), 'ZXY'))
    riding.chase ??= chaseAim.clone()
    riding.chase.slerp(chaseAim, 1 - Math.exp((-dt * 1000) / TAIL_LAG_MS))
    const length = aircraftSize(focus.info.aircraftType, focus.info.emitterCategory).lengthM / M_PER_NM
    // Looking around swings the camera round the aircraft, never below the ground.
    const orbit = riding.chase.clone().multiply(look)
    const tailEye = at.clone().add(new Vector3(0, -length * TAIL_BACK, length * TAIL_UP).applyQuaternion(orbit))
    tailEye.z = Math.max(tailEye.z, this.groundZ(tailEye.x, tailEye.y) * this.vScale + COCKPIT_EYE_NM)
    const tailAttitude = orbit.multiply(LOOK_DOWN_AT_TAIL).multiply(CAMERA_IN_BODY)

    const v = smoothstep(riding.view)
    const eye = cockpitEye.lerp(tailEye, v)
    const attitude = cockpitAttitude.slerp(tailAttitude, v)

    // Following from outside, as the camera was before going in.
    const outside = at.clone().add(riding.offset)
    this.camera.position.copy(outside)
    this.camera.lookAt(at)
    const outsideAttitude = this.camera.quaternion.clone()
    this.controls.target.copy(at)

    const k = smoothstep(riding.blend)
    this.camera.position.lerpVectors(outside, eye, k)
    this.camera.quaternion.slerpQuaternions(outsideAttitude, attitude, k)
    const wide = this.verticalFov(COCKPIT_HORIZONTAL_FOV + (TAIL_HORIZONTAL_FOV - COCKPIT_HORIZONTAL_FOV) * v)
    // Zooming narrows it like binoculars, the same in every direction.
    const rideFov = deg(2 * Math.atan(Math.tan(rad(wide) / 2) / riding.zoomShown))
    this.camera.fov = CAMERA_FOV + (rideFov - CAMERA_FOV) * k
    this.camera.near = k > 0.5 ? COCKPIT_NEAR : CAMERA_NEAR
    this.updateProjection()
  }

  /** Whether the camera is riding along (or moving into or out of it), when clicks look around rather than pick aircraft. */
  isRiding() {
    return this.riding !== null
  }

  /** Whether dragging and scrolling look around and zoom (riding along, or standing in the street) rather than move the camera. */
  isLooking() {
    return this.riding !== null || this.street !== null
  }

  /** Whether the camera is near enough the airport to offer street view (or already in it). */
  isNearAirport() {
    return this.nearAirport
  }

  /** Whether the next click picks where to stand in the street (a pin follows the cursor until then). */
  setStreetPlacing(placing: boolean) {
    this.streetPlacing = placing
  }

  /**
   * While picking where to stand: the pin on the ground under the cursor,
   * gently pulsing, sized by the camera's distance so it reads at any zoom.
   */
  private showStreetPin(now: number) {
    const at = this.streetPlacing && this.pointer ? this.pickGround(this.pointer.x, this.pointer.y) : null
    this.streetPin.visible = at !== null
    if (!at) return
    this.streetPin.position.set(at.x, at.y, at.z / this.vScale)
    this.streetPin.scale.setScalar(this.camera.position.distanceTo(at) * STREET_PIN_SIZE)
    const ring = this.streetPin.children[0]
    ring.scale.setScalar(1 + 0.25 * Math.sin(now / 250))
  }

  /** In the street, turns to the selected aircraft and keeps it in view (until the view's dragged). */
  trackFromStreet() {
    if (this.street) this.street.tracking = true
  }

  /**
   * Riding along or in the street, a drag of `dx`, `dy` pixels turns the view:
   * about as far as the picture moves under the pointer, less when zoomed in.
   * In the cockpit it turns the pilot's head; behind the tail it swings the
   * camera round the aircraft; in the street it turns your head (and stops
   * tracking an aircraft).
   */
  lookAround(dx: number, dy: number) {
    const perPixel = this.camera.fov / this.height
    if (this.street) {
      const street = this.street
      street.tracking = false
      street.heading = (((street.heading + dx * perPixel) % 360) + 360) % 360
      street.pitch = Math.min(Math.max(street.pitch - dy * perPixel, -STREET_LOOK_PITCH), STREET_LOOK_PITCH)
      return
    }
    if (!this.riding) return
    const look = this.riding.look
    look.yaw = ((look.yaw - dx * perPixel + 540) % 360) - 180
    const [min, max] = this.riding.mode === 'tail' ? TAIL_LOOK_PITCH : COCKPIT_LOOK_PITCH
    look.pitch = Math.min(Math.max(look.pitch - dy * perPixel, min), max)
  }

  /** Riding along or in the street, magnifies the view by `factor` (above 1 zooms in), within limits. */
  zoomBy(factor: number) {
    const view = this.riding ?? this.street
    if (view) view.zoom = Math.min(Math.max(view.zoom * factor, 1), MAX_ZOOM)
  }

  /** Riding along, looks straight ahead again, unzoomed; in the street, back to level and unzoomed. */
  recenterLook() {
    if (this.street) {
      this.street.zoom = 1
      if (!this.street.tracking) this.street.pitch = 0
      return
    }
    if (!this.riding) return
    this.riding.look = { yaw: 0, pitch: 0 }
    this.riding.zoom = 1
  }

  /**
   * Standing in the street at `spot` (null to step back out): eye height above
   * the ground (a person's, or the spot's own, as in the tower), true heights and sizes all round, a person's field of view.
   * Glides in from where the camera was, and back out to it. While tracking,
   * turns smoothly to keep the selected aircraft (`hex`, drawn at `at`) in view.
   */
  private standInStreet(dt: number, spot: StreetSpot | null, hex: string | null, at: Vector3 | null) {
    if (spot && !this.street) {
      const facing = new Vector3()
      this.camera.getWorldDirection(facing)
      this.street = {
        blend: 0,
        spot: new Vector2(spot.x, spot.y),
        heading: spot.heading ?? ((deg(Math.atan2(facing.x, facing.y)) % 360) + 360) % 360,
        pitch: 0,
        zoom: 1,
        zoomShown: 1,
        tracking: hex !== null,
        trackedHex: hex,
        eyeNm: STREET_EYE_NM,
        from: { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), target: this.controls.target.clone() },
      }
      this.controls.enabled = false
    }
    const street = this.street!
    if (spot) {
      street.spot.set(spot.x, spot.y)
      street.eyeNm = spot.eyeFt === undefined ? STREET_EYE_NM : (spot.eyeFt * 0.3048) / 1852
    }
    street.blend = Math.min(Math.max(street.blend + ((spot ? 1 : -1) * dt) / STREET_BLEND_S, 0), 1)
    if (street.blend === 0 && !spot) {
      this.leaveStreet()
      this.controls.update(dt)
      return
    }
    // Picking an aircraft (on the map or the board) turns to it.
    if (hex !== street.trackedHex) {
      street.trackedHex = hex
      street.tracking = hex !== null
    }
    street.zoomShown += (street.zoom - street.zoomShown) * (1 - Math.exp((-dt * 1000) / ZOOM_EASE_MS))
    // Orbiting, standing still (in the tower or the street) turns the view around instead,
    // the same way and speed, unless it's turning to keep an aircraft in view.
    if (MAP3D.orbit && !street.tracking && street.blend > 0) {
      const turn = (MAP3D.orbitDirection === 'counterclockwise' ? -1 : 1) * MAP3D.orbitSpeed * dt
      street.heading = (((street.heading + turn) % 360) + 360) % 360
    }

    const eye = new Vector3(street.spot.x, street.spot.y, this.groundZ(street.spot.x, street.spot.y) * this.vScale + street.eyeNm)
    if (street.tracking && at) {
      const to = at.clone().sub(eye)
      const k = 1 - Math.exp((-dt * 1000) / STREET_TRACK_LAG_MS)
      const heading = deg(Math.atan2(to.x, to.y))
      const pitch = deg(Math.atan2(to.z, Math.hypot(to.x, to.y)))
      street.heading = (((street.heading + ((((heading - street.heading) % 360) + 540) % 360 - 180) * k) % 360) + 360) % 360
      street.pitch += (Math.min(Math.max(pitch, -STREET_LOOK_PITCH), STREET_LOOK_PITCH) - street.pitch) * k
    }

    // Where the camera stands and looks, then glided to from where it was.
    const [h, p] = [rad(street.heading), rad(street.pitch)]
    this.camera.position.copy(eye)
    this.camera.lookAt(eye.clone().add(new Vector3(Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p))))
    const standing = this.camera.quaternion.clone()
    const k = smoothstep(street.blend)
    this.camera.position.lerpVectors(street.from.position, eye, k)
    this.camera.quaternion.slerpQuaternions(street.from.quaternion, standing, k)
    const fov = deg(2 * Math.atan(Math.tan(rad(this.verticalFov(STREET_HORIZONTAL_FOV)) / 2) / street.zoomShown))
    this.camera.fov = CAMERA_FOV + (fov - CAMERA_FOV) * k
    // As far out as the eye height allows (the nearest thing in view is the ground below),
    // so high up in the tower, the depth buffer keeps its precision out to the horizon
    // and the ground doesn't flicker where the runways and taxiways lie on it.
    this.camera.near = k > 0.5 ? Math.max(STREET_NEAR, street.eyeNm * STREET_NEAR_OF_EYE) : CAMERA_NEAR
    this.updateProjection()
  }

  /** Straight back from the street to where the camera was before, and the camera controls back on. */
  private leaveStreet() {
    if (!this.street) return
    const { from } = this.street
    this.street = null
    this.controls.target.copy(from.target)
    this.camera.position.copy(from.position)
    this.camera.fov = CAMERA_FOV
    this.camera.near = CAMERA_NEAR
    this.updateProjection()
    this.controls.enabled = true
  }

  /**
   * The vertical field of view (what the camera takes) that spans `horizontal`
   * degrees across the part of the screen the board leaves uncovered.
   */
  private verticalFov(horizontal: number) {
    const aspect = (this.width * (1 + this.shift.x)) / (this.height * (1 - this.shift.y))
    const vertical = deg(2 * Math.atan(Math.tan(rad(horizontal) / 2) / aspect))
    return Math.min(Math.max(vertical, RIDE_FOV_MIN), RIDE_FOV_MAX)
  }

  /**
   * Draws the aircraft on the ground at the airport: true size, like the
   * airport they stand on (never smaller than a few pixels), facing their
   * heading, fainter once parked. Skips those still flying, and the one whose
   * cockpit the camera is in. Returns which were drawn; they can be clicked too.
   */
  private updateGroundTraffic(tracks: Iterable<GroundTrack>, flying: Set<string>, inside: string | null) {
    const drawn = new Set<string>()
    const seen = new Set<GroundTrack>()
    for (const g of tracks) {
      const style = MAP3D.traffic[g.info.kind]
      if (g.opacity <= 0 || !style.show || flying.has(g.info.hex) || g.info.hex === inside) continue
      seen.add(g)
      drawn.add(g.info.hex)
      let mesh = this.groundCrafts.get(g)
      if (!mesh) {
        mesh = new Mesh(
          new BufferGeometry(),
          new MeshPhongMaterial({ flatShading: true, shininess: 40, transparent: true, side: DoubleSide, forceSinglePass: true }),
        )
        mesh.frustumCulled = false
        this.scene.add(mesh)
        this.groundCrafts.set(g, mesh)
      }
      const size = aircraftSize(g.info.aircraftType, g.info.emitterCategory)
      const geometry = modelGeometry(size.kind, size.lengthM, size.spanM, g.info.aircraftType)
      if (mesh.geometry !== geometry) mesh.geometry = geometry
      const { x, y } = local(g.pos)
      // On the ground, or still settling onto the runway just after touchdown.
      const z = Math.max(heightOf(AIRPORT_PRESET.elevationFt + g.heightFt), this.groundZ(x, y)) * this.vScale
      mesh.position.set(x, y, z)
      const lengthNm = Math.max(size.lengthM / M_PER_NM, MIN_MODEL_PX * this.worldPerPixel(this.camera.position.distanceTo(mesh.position)))
      mesh.scale.setScalar(lengthNm / size.lengthM)
      // Lifted by its own height above its middle, so its wheels are on the ground.
      mesh.position.z += lengthNm * GROUND_LIFT
      mesh.rotation.set(0, 0, -rad(g.heading), 'ZXY')
      mesh.material.color.set(style.color)
      mesh.material.opacity = g.opacity * style.opacity * (g.parked ? PARKED_OPACITY : 1)

      const p = mesh.position.clone().project(this.camera)
      if (p.z < 1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2) {
        this.hits.push({ hex: g.info.hex, x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height })
      }
    }
    for (const [g, mesh] of this.groundCrafts) {
      if (seen.has(g)) continue
      this.scene.remove(mesh)
      mesh.material.dispose()
      this.groundCrafts.delete(g)
    }
    return drawn
  }

  /**
   * Draws the followed aircraft when the map doesn't (it's on the ground, where
   * only the airport view shows traffic), so there's something to follow and to
   * ride behind. Sized like the others; hidden from the cockpit.
   */
  private updateFocusMesh(focus: Focus | null, at: Vector3 | null, drawn: boolean, trueScale: number, inside: boolean) {
    this.focusMesh.visible = !!focus && !!at && !drawn && !inside
    if (!focus || !at || !this.focusMesh.visible) return
    const size = aircraftSize(focus.info.aircraftType, focus.info.emitterCategory)
    const geometry = modelGeometry(size.kind, size.lengthM, size.spanM, focus.info.aircraftType)
    if (this.focusMesh.geometry !== geometry) this.focusMesh.geometry = geometry
    // Lifted a hair so it sits on the ground rather than in it.
    this.focusMesh.position.set(at.x, at.y, Math.max(at.z, this.groundZ(at.x, at.y) * this.vScale) + 0.002)
    const style = MAP3D.traffic[focus.info.kind]
    const drawnNm = this.modelLength(this.focusMesh.position, size.lengthM) * style.scale
    this.focusMesh.scale.setScalar((drawnNm + (size.lengthM / M_PER_NM - drawnNm) * trueScale) / size.lengthM)
    if (this.riding) this.focusMesh.quaternion.copy(this.riding.body)
    else this.focusMesh.rotation.set(0, 0, -rad(focus.heading), 'ZXY')
    this.focusMesh.material.color.set(style.color)
    this.focusMesh.material.opacity = style.opacity
  }

  /** Straight back out to following from outside, and the camera controls back on. */
  private stepOut() {
    if (!this.riding) return
    const { at, offset } = this.riding
    this.riding = null
    this.controls.target.copy(at)
    this.camera.position.copy(at).add(offset)
    this.camera.fov = CAMERA_FOV
    this.camera.near = CAMERA_NEAR
    this.updateProjection()
    this.controls.enabled = true
  }

  /**
   * A flight sim's head-up display in the cockpit. Fixed to the nose: the
   * aircraft symbol, a speed tape (left), altitude tape with vertical speed
   * (right), a heading tape (bottom) and a bank scale (top), with angle of
   * attack, G, radio altitude and distance to the field beside them. Fixed to
   * the world: the horizon and pitch ladder, and the flight path marker where
   * the aircraft is actually going (the angle of attack below the nose).
   */
  private drawCockpitHud(focus: Focus | null, fade: number) {
    if (!focus || !this.riding) return
    const ctx = this.labels
    const { aoa, load, fpa } = this.riding.readout
    // Attitude as the camera shows it (smoothed, with the buffet), so the numbers match the view.
    const euler = new Euler().setFromQuaternion(this.camera.quaternion.clone().multiply(BODY_IN_CAMERA), 'ZXY')
    const bank = deg(euler.y)
    const heading = (((-deg(euler.z)) % 360) + 360) % 360
    const cam = this.camera.position
    const toScreen = (dir: Vector3) => {
      const p = cam.clone().addScaledVector(dir, HUD_RANGE_NM).project(this.camera)
      return p.z < 1 ? { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height } : null
    }
    /** A world direction at `headingDeg` and `elevationDeg` above the horizon. */
    const direction = (headingDeg: number, elevationDeg: number) => {
      const [h, e] = [rad(headingDeg), rad(elevationDeg)]
      return new Vector3(Math.sin(h) * Math.cos(e), Math.cos(h) * Math.cos(e), Math.sin(e))
    }

    // Laid out in the part of the screen the board leaves uncovered.
    const visibleWidth = this.width * (1 + this.shift.x)
    const visibleHeight = this.height * (1 - this.shift.y)
    const cx = visibleWidth / 2
    const cy = visibleHeight / 2
    const halfW = Math.min(visibleWidth * 0.42, 300)
    const halfH = Math.min(visibleHeight * 0.36, 230)

    ctx.save()
    ctx.strokeStyle = ctx.fillStyle = COCKPIT_HUD_COLOR
    ctx.lineWidth = 1.5
    ctx.textBaseline = 'middle'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
    ctx.shadowBlur = 3
    ctx.globalAlpha = fade * 0.9
    const font = (px: number) => (ctx.font = `${px}px ${MAP.fontFamily}`)
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
    }
    const text = (s: string, x: number, y: number, align: CanvasTextAlign, px = 11) => {
      font(px)
      ctx.textAlign = align
      ctx.fillText(s, x, y)
    }
    /** A boxed readout of a tape's current value. */
    const box = (s: string, x: number, y: number, w: number, align: 'left' | 'right') => {
      const left = align === 'left' ? x : x - w
      ctx.save()
      ctx.shadowBlur = 0
      ctx.globalAlpha = fade * 0.75
      ctx.fillStyle = 'rgba(0, 12, 4, 0.75)'
      ctx.fillRect(left, y - 11, w, 22)
      ctx.restore()
      ctx.strokeRect(left, y - 11, w, 22)
      text(s, left + w / 2, y + 1, 'center', 14)
    }

    // Horizon and pitch ladder, clipped to the middle between the tapes.
    const nose = new Vector3()
    this.camera.getWorldDirection(nose)
    const noseHeading = deg(Math.atan2(nose.x, nose.y))
    ctx.save()
    ctx.beginPath()
    ctx.rect(cx - halfW + 60, cy - halfH + 30, (halfW - 60) * 2, (halfH - 30) * 2 - 20)
    ctx.clip()
    for (let pitchDeg = -30; pitchDeg <= 30; pitchDeg += 5) {
      const spread = pitchDeg === 0 ? 40 : 3.5
      const a = toScreen(direction(noseHeading - spread, pitchDeg))
      const b = toScreen(direction(noseHeading + spread, pitchDeg))
      if (!a || !b) continue
      ctx.globalAlpha = fade * (pitchDeg === 0 ? 0.85 : 0.6)
      ctx.setLineDash(pitchDeg < 0 ? [6, 4] : [])
      if (pitchDeg === 0) line(a.x, a.y, b.x, b.y)
      else {
        // Each rung has a gap in the middle and tips pointing toward the horizon.
        const gap = 0.3
        const tip = pitchDeg > 0 ? 6 : -6
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const ux = (b.x - a.x) / Math.hypot(b.x - a.x, b.y - a.y)
        const uy = (b.y - a.y) / Math.hypot(b.x - a.x, b.y - a.y)
        const len = Math.hypot(b.x - a.x, b.y - a.y) / 2
        for (const side of [-1, 1]) {
          const inner = { x: mx + side * ux * len * gap, y: my + side * uy * len * gap }
          const outer = { x: mx + side * ux * len, y: my + side * uy * len }
          ctx.beginPath()
          ctx.moveTo(inner.x, inner.y)
          ctx.lineTo(outer.x, outer.y)
          ctx.lineTo(outer.x - uy * tip, outer.y + ux * tip)
          ctx.stroke()
          ctx.setLineDash([])
          text(String(Math.abs(pitchDeg)), outer.x + side * ux * 14, outer.y + side * uy * 14, 'center', 10)
          ctx.setLineDash(pitchDeg < 0 ? [6, 4] : [])
        }
      }
    }
    ctx.setLineDash([])
    // Flight path marker: where the aircraft is going, its track and flight path angle.
    const fpm = toScreen(direction(focus.heading, fpa))
    if (fpm) {
      ctx.globalAlpha = fade * 0.95
      ctx.beginPath()
      ctx.arc(fpm.x, fpm.y, 6, 0, Math.PI * 2)
      ctx.stroke()
      line(fpm.x - 18, fpm.y, fpm.x - 6, fpm.y)
      line(fpm.x + 6, fpm.y, fpm.x + 18, fpm.y)
      line(fpm.x, fpm.y - 6, fpm.x, fpm.y - 13)
    }
    ctx.restore()

    // The aircraft symbol (the nose): fixed in the middle.
    ctx.globalAlpha = fade * 0.9
    ctx.beginPath()
    ctx.moveTo(cx - 40, cy)
    ctx.lineTo(cx - 14, cy)
    ctx.lineTo(cx - 7, cy + 8)
    ctx.lineTo(cx, cy)
    ctx.lineTo(cx + 7, cy + 8)
    ctx.lineTo(cx + 14, cy)
    ctx.lineTo(cx + 40, cy)
    ctx.stroke()

    // Bank scale: ticks along an arc above the middle, and a pointer that stays toward the sky.
    const arc = halfH - 8
    for (const tick of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const a = rad(tick)
      const len = Math.abs(tick) % 30 === 0 ? 12 : 7
      line(cx + Math.sin(a) * arc, cy - Math.cos(a) * arc, cx + Math.sin(a) * (arc + len), cy - Math.cos(a) * (arc + len))
    }
    ctx.beginPath()
    ctx.moveTo(cx, cy - arc - 2)
    ctx.lineTo(cx - 6, cy - arc - 12)
    ctx.lineTo(cx + 6, cy - arc - 12)
    ctx.closePath()
    ctx.stroke()
    {
      const a = rad(-bank)
      const r = arc - 3
      const [px, py] = [cx + Math.sin(a) * r, cy - Math.cos(a) * r]
      const [tx, ty] = [Math.sin(a), -Math.cos(a)]
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(px - tx * 10 + ty * 6, py - ty * 10 - tx * 6)
      ctx.lineTo(px - tx * 10 - ty * 6, py - ty * 10 + tx * 6)
      ctx.closePath()
      ctx.fill()
      if (Math.abs(bank) >= 5) text(`${Math.round(Math.abs(bank))}°`, px - tx * 22, py - ty * 22, 'center', 10)
    }

    // Speed tape (left): ground speed, ±60 kt shown.
    const tapeH = halfH * 1.3
    const speed = focus.groundSpeed ?? 0
    const sx = cx - halfW
    const ktPx = tapeH / 120
    ctx.save()
    ctx.beginPath()
    ctx.rect(sx - 60, cy - tapeH / 2, 80, tapeH)
    ctx.clip()
    line(sx, cy - tapeH / 2, sx, cy + tapeH / 2)
    for (let v = Math.floor((speed - 60) / 10) * 10; v <= speed + 60; v += 10) {
      if (v < 0) continue
      const y = cy - (v - speed) * ktPx
      line(sx, y, sx + (v % 20 === 0 ? 10 : 6), y)
      if (v % 20 === 0) text(String(v), sx - 8, y, 'right', 11)
    }
    ctx.restore()
    box(String(Math.round(speed)), sx - 2, cy, 54, 'right')
    text('GS', sx - 2, cy - tapeH / 2 - 14, 'right', 11)
    text(`AOA ${aoa.toFixed(1)}`, sx - 2, cy + tapeH / 2 + 16, 'right', 11)
    text(`G ${load.toFixed(2)}`, sx - 2, cy + tapeH / 2 + 32, 'right', 11)

    // Altitude tape (right): ±500 ft shown, vertical speed above, radio altitude below.
    const altitude = focus.altitude ?? 0
    const ax = cx + halfW
    const ftPx = tapeH / 1000
    ctx.save()
    ctx.beginPath()
    ctx.rect(ax - 20, cy - tapeH / 2, 90, tapeH)
    ctx.clip()
    line(ax, cy - tapeH / 2, ax, cy + tapeH / 2)
    for (let v = Math.floor((altitude - 500) / 100) * 100; v <= altitude + 500; v += 100) {
      const y = cy - (v - altitude) * ftPx
      line(ax, y, ax - (v % 500 === 0 ? 10 : 6), y)
      if (v % 200 === 0) text(v.toLocaleString('en-US'), ax + 8, y, 'left', 11)
    }
    ctx.restore()
    box((Math.round(altitude / 20) * 20).toLocaleString('en-US'), ax + 2, cy, 66, 'left')
    const vs = focus.onGround ? 0 : (focus.verticalRate ?? 0)
    text(`VS ${vs > 0 ? '+' : vs < 0 ? '−' : ''}${Math.abs(Math.round(vs / 50) * 50).toLocaleString('en-US')}`, ax + 2, cy - tapeH / 2 - 14, 'left', 11)
    // A vertical speed needle beside the tape: up to ±4,000 fpm.
    const needle = Math.max(-1, Math.min(1, vs / 4000)) * (tapeH / 2 - 10)
    ctx.lineWidth = 3
    line(ax + 76, cy, ax + 76, cy - needle)
    ctx.lineWidth = 1.5
    const above = altitude - AIRPORT_PRESET.elevationFt
    if (focus.onGround || above < RADIO_ALTITUDE_FT) {
      text(`RA ${focus.onGround ? 0 : Math.max(0, Math.round(above / 10) * 10).toLocaleString('en-US')}`, ax + 2, cy + tapeH / 2 + 16, 'left', 11)
    }
    text(`${AIRPORT_PRESET.icao} ${focus.distanceNm.toFixed(1)} NM`, ax + 2, cy + tapeH / 2 + 32, 'left', 11)

    // Heading tape (bottom): ±30° shown, labels every 10° in tens.
    const hy = cy + halfH + 6
    const degPx = (halfW * 1.2) / 60
    ctx.save()
    ctx.beginPath()
    ctx.rect(cx - halfW * 0.6, hy - 4, halfW * 1.2, 40)
    ctx.clip()
    line(cx - halfW * 0.6, hy, cx + halfW * 0.6, hy)
    for (let d = Math.ceil((heading - 30) / 5) * 5; d <= heading + 30; d += 5) {
      const x = cx + (d - heading) * degPx
      const major = d % 10 === 0
      line(x, hy, x, hy + (major ? 9 : 5))
      if (major) {
        const h = ((d % 360) + 360) % 360
        text(COMPASS[h] ?? String(h / 10).padStart(2, '0'), x, hy + 20, 'center', 10)
      }
    }
    ctx.restore()
    box(String(Math.round(heading) % 360).padStart(3, '0'), cx + 24, hy - 18, 48, 'right')
    ctx.restore()
  }

  /**
   * Riding along or in the street: how to look around, along the top of the view
   * (clear of the info panel), and how far it's zoomed in.
   */
  private drawLookHint(zoomShown: number, turned: boolean, street: boolean) {
    const ctx = this.labels
    const cx = (this.width * (1 + this.shift.x)) / 2
    const y = 22
    ctx.save()
    ctx.font = `10px ${MAP.fontFamily}`
    ctx.letterSpacing = '1.5px'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = HUD_COLOR
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowBlur = 3
    ctx.globalAlpha = 0.55
    const parts = ['DRAG TO LOOK', 'SCROLL TO ZOOM']
    if (street) parts.push('CLICK AN AIRCRAFT TO TRACK IT')
    if (zoomShown > 1.05 || turned) parts.push(street ? 'DOUBLE-CLICK TO LEVEL' : 'DOUBLE-CLICK TO RECENTER')
    ctx.fillText(parts.join(' · '), cx, y)
    if (zoomShown > 1.05) {
      ctx.globalAlpha = 0.9
      ctx.font = `13px ${MAP.fontFamily}`
      ctx.fillText(`${zoomShown < 10 ? zoomShown.toFixed(1) : Math.round(zoomShown)}×`, cx, y + 18)
    }
    ctx.restore()
  }

  /** Brackets around the followed aircraft, so it's easy to spot. */
  private drawFocus(at: Vector3) {
    const p = at.clone().project(this.camera)
    if (p.z >= 1) return
    const x = ((p.x + 1) / 2) * this.width
    const y = ((1 - p.y) / 2) * this.height
    drawFocusBrackets(this.labels, x, y)
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

  /** Remembers the camera in this browser (also before a setup is saved); while following, where it'll go back to. */
  saveCamera() {
    // If storage is unavailable, the view just won't be remembered.
    const p = this.home?.position ?? this.street?.from.position ?? this.camera.position
    const t = this.home?.target ?? this.street?.from.target ?? this.controls.target
    localStore.setJson(CAMERA_KEY, { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] })
  }

  private restoreCamera() {
    try {
      const saved = localStore.getJson(CAMERA_KEY) as { position: number[]; target: number[] } | null
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

/** Frees an object's (and its children's) geometries and materials. */
function disposeTree(root: Object3D) {
  root.traverse((o) => {
    const { geometry, material } = o as Mesh
    geometry?.dispose()
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}

/** Procedures' lines are drawn in steps this long (nm), each kept PROCEDURE_CLEARANCE_FT clear of the ground under it... */
const PROCEDURE_STEP_NM = 1
const PROCEDURE_CLEARANCE_FT = 500
/** ...or, where traced on the ground (altitude only estimated), this far above it. */
const PROCEDURE_GROUND_FT = 40
/** Under an estimated altitude: the curtain up to it, and the dashed line along its top, this opaque (times the line's). */
const ESTIMATE_CURTAIN_OPACITY = 0.14
/** The dot on the ground under a waypoint in the air (pixels). */
const WAYPOINT_DOT_PX = 3
const ESTIMATE_TOP_OPACITY = 0.45

/** A see-through wall standing between the ground and the air along `samples` (see Map3D.pathSamples). */
function curtainMesh(samples: { x: number; y: number; air: number; ground: number }[], color: string, opacity: number) {
  const positions: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    positions.push(a.x, a.y, a.ground, b.x, b.y, b.ground, b.x, b.y, b.air, a.x, a.y, a.ground, b.x, b.y, b.air, a.x, a.y, a.air)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ color, transparent: true, opacity, side: DoubleSide, depthWrite: false }))
  mesh.frustumCulled = false
  return mesh
}

/** Runways all within this far (nm) of the airport are its own, drawn apart from the ground picture (see mapRunways). */
const AIRPORT_RUNWAYS_NM = 3
/** The flat map's runway width, in its pixels. */
const MAP_RUNWAY_PX = 2.5

/** With terrain on, the ground is level this far (nm) beyond the airport's furthest pavement or building, then eases into the terrain over the next stretch. */
const FLAT_MARGIN_NM = 0.8
const FLAT_BLEND_NM = 2

/** Where the fade begins, as a fraction of the ground's width from its middle. */
const EDGE_FADE_START = 0.3

/** Where the camera starts, and its distance from the map's middle, which sets the aircraft's world size. */
const DEFAULT_CAMERA = new Vector3(0, -FETCH_RADIUS_NM * 1.25, FETCH_RADIUS_NM * 0.85)
const DEFAULT_DISTANCE = DEFAULT_CAMERA.length()
/** Aircraft never get smaller than this on screen, however far out you zoom. */
const MIN_MODEL_PX = 6
/** True size near the airport eases out over this fraction of MAP3D.trueSizeRangeNm beyond it. */
const TRUE_SIZE_EASE = 0.2
/** Aircraft on the ground are raised this fraction of their length, so they stand on it rather than sink into it. */
const GROUND_LIFT = 0.08
/** Parked aircraft on the ground are drawn this much fainter. */
const PARKED_OPACITY = 0.55

const ROUTE_SEGMENTS = 40
/** Ground grid resolution with terrain on: ~0.5 nm per cell over the area. */
const GROUND_SEGMENTS = 255
const FT_PER_M = 3.28084
/** Route lines rise toward this altitude (feet) away from the airport. */
const CRUISE_FT = 30_000
/** The followed flight's route climbs to cruise over this many nautical miles, and comes down over as many at the far end. */
const CRUISE_RAMP_NM = 120

/** Points a dashed line along `path` (at altitude), or hides it when null or empty. `start` overrides the first point. */
/** One runway guide's lines in the 3D map (see Map3D.updateRunwayGuides). */
interface GuideLines {
  group: Group
  centerline: Line
  glide: Line
  edges: LineSegments
  bars: LineSegments
}

function guideLines(): GuideLines {
  const material = () => new LineBasicMaterial({ transparent: true, depthWrite: false })
  const centerline = new Line(new BufferGeometry(), new LineDashedMaterial({ transparent: true, depthWrite: false, dashSize: 0.25, gapSize: 0.18 }))
  const glide = new Line(new BufferGeometry(), material())
  const edges = new LineSegments(new BufferGeometry(), material())
  const bars = new LineSegments(new BufferGeometry(), material())
  const group = new Group()
  for (const line of [centerline, glide, edges, bars]) {
    line.frustumCulled = false
    group.add(line)
  }
  return { group, centerline, glide, edges, bars }
}

/** Sets a LineSegments' points (x, y, z for each end of each segment), color and opacity. */
function setSegments(lines: LineSegments, positions: number[], color: Color, opacity: number) {
  lines.visible = positions.length > 0
  if (!lines.visible) return
  const attr = lines.geometry.getAttribute('position') as BufferAttribute | undefined
  if (attr?.count === positions.length / 3) {
    attr.copyArray(positions)
    attr.needsUpdate = true
  } else {
    lines.geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  }
  const material = lines.material as LineBasicMaterial
  material.color.copy(color)
  material.opacity = opacity
}

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

/** How close (pixels) a click has to be to an aircraft to pick it. */
const PICK_RADIUS_PX = 24
/** How long the camera takes to glide to a picked aircraft and back, and how close it moves in. */
const FOLLOW_GLIDE_MS = 1200
const FOLLOW_DISTANCE = DEFAULT_DISTANCE * 0.3

/** The camera's usual field of view (degrees) and near clipping distance (nm)... */
const CAMERA_FOV = 40
const CAMERA_NEAR = 0.05
/**
 * ...and riding along: set across the width of the view, as people judge it,
 * then turned into the camera's vertical one for the screen's shape. Wide in the
 * cockpit, near what both eyes take in without turning (a flight sim's "natural"
 * setting); a little narrower behind the tail, like a chase camera.
 */
const COCKPIT_HORIZONTAL_FOV = 100
const TAIL_HORIZONTAL_FOV = 80
/** Never narrower or wider than this vertically, however tall or wide the view (a portrait screen would get a fisheye). */
const RIDE_FOV_MIN = 45
const RIDE_FOV_MAX = 85
/** Riding along, close enough to see aircraft just ahead. */
const COCKPIT_NEAR = 0.004
/** How long going into or out of riding along takes, and switching between the cockpit and the tail (seconds). */
const COCKPIT_BLEND_S = 1.4
const RIDE_SWITCH_S = 1
/** Behind the tail: how far back and up, in the aircraft's lengths, and how far it looks down at it (degrees). */
const TAIL_BACK = 2.8
const TAIL_UP = 0.55
const TAIL_LOOK_DOWN_DEG = 6
/** The tail camera swings round after the aircraft more slowly than a pilot's head (ms), and rolls only part way with it. */
const TAIL_LAG_MS = 600
const TAIL_ROLL = 0.4
/**
 * In the street: eye height (6 ft, in nm), a person's field of view, how close
 * the camera can see (nm), how long stepping in or out takes (seconds), how
 * far up or down you can look (degrees), and how far turning to follow an
 * aircraft lags behind it (ms).
 */
const STREET_EYE_NM = (6 * 0.3048) / 1852
const STREET_HORIZONTAL_FOV = 100
const STREET_NEAR = 0.0008
/** ...or this fraction of the eye height above the ground, if farther (in the tower). */
const STREET_NEAR_OF_EYE = 0.5
const STREET_BLEND_S = 1.6
const STREET_LOOK_PITCH = 88
const STREET_TRACK_LAG_MS = 180
/** How far up and down (degrees) the view can turn: a pilot's head, or the tail camera swinging under and over. */
const COCKPIT_LOOK_PITCH: [number, number] = [-70, 80]
const TAIL_LOOK_PITCH: [number, number] = [-70, 45]
/** Riding along, the most the view magnifies, and how quickly the zoom eases (ms). */
const MAX_ZOOM = 100
const ZOOM_EASE_MS = 120
/** How far the camera's turning lags the aircraft's (ms), like a pilot's head settling. */
const COCKPIT_LAG_MS = 220
/** Eye height above the aircraft's middle (nm, about 50 ft). */
const COCKPIT_EYE_NM = 0.008
/** Size of the buffet in the air (degrees), more at low altitude. */
const TURBULENCE_DEG = 0.25
const LOW_ALTITUDE_FT = 10_000
/** How far out the head-up display's horizon and pitch ladder are placed (nm, inside the far clipping plane). */
const HUD_RANGE_NM = 400
const COCKPIT_HUD_COLOR = '#7dffa6'
/** A camera looks down its -z with +y up; turned a quarter about x, it looks along a model's nose (+y) with +z up. */
const CAMERA_IN_BODY = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2)
const BODY_IN_CAMERA = CAMERA_IN_BODY.clone().invert()
/** Tipped down about the aircraft's wings, so the tail camera looks down at it. */
const LOOK_DOWN_AT_TAIL = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -rad(TAIL_LOOK_DOWN_DEG))
/** The head-up display shows height above the field (radio altitude) below this many feet. */
const RADIO_ALTITUDE_FT = 2500
const M_PER_NM = 1852
const M_PER_FT = 0.3048
const KT_TO_MS = 0.514444

/**
 * A rough angle of attack (degrees) for an airliner at `speedKt` pulling `load`
 * G: about 5° on approach, 2–3° climbing out, under 2° cruising fast.
 */
function angleOfAttack(speedKt: number, load: number) {
  return Math.min(1.5 + 3.5 * load * (140 / Math.max(speedKt, 100)) ** 2, 14)
}

function deg(r: number) {
  return (r * 180) / Math.PI
}

function smoothstep(x: number) {
  return x * x * (3 - 2 * x)
}

const AXIS_COLOR = 0xe8eef8
const AXIS_GLIDE_MS = 1200

/** The street view pin, as a fraction of the camera's distance. */
const STREET_PIN_SIZE = 0.035
const STREET_PIN_COLOR = 0x7dffa6

/**
 * Where you'd stand in the street: a ring on the ground (its first child, so it
 * can pulse) with a short post up from its middle and a ball on top, a person
 * on a map pin. Unit-sized; scaled to the camera's distance.
 */
function streetPinMarker() {
  const pin = new Group()
  const ring = new LineLoop(ringGeometry(), new LineBasicMaterial({ color: STREET_PIN_COLOR, transparent: true, opacity: 0.9, depthTest: false }))
  ring.scale.setScalar(0.5)
  const post = new Line(
    new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 1]), 3)),
    new LineBasicMaterial({ color: STREET_PIN_COLOR, transparent: true, opacity: 0.9, depthTest: false }),
  )
  const head = new Mesh(new SphereGeometry(0.12, 12, 8), new MeshBasicMaterial({ color: STREET_PIN_COLOR, transparent: true, opacity: 0.95, depthTest: false }))
  head.position.z = 1.1
  const ringHolder = new Group()
  ringHolder.add(ring)
  pin.add(ringHolder, post, head)
  pin.traverse((o) => {
    o.frustumCulled = false
    // Drawn over everything, so buildings and aircraft never hide it.
    o.renderOrder = 10
  })
  return pin
}

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

/** The followed flight's route label fades out within this many pixels (twice this, fully shown) of the aircraft on screen. */
const ROUTE_LABEL_CLEAR_PX = 40
const CLOUD_LABEL_COLOR = '#dfe6ee'
/** Without a cloud overhead, rain and snow fall from this high above the field, feet. */
const PRECIP_DEFAULT_BASE_FT = 4000
const CLOUD_LABEL_OPACITY = 0.7
