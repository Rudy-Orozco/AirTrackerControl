import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Camera,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshPhongMaterial,
  Scene,
  Shape,
  Vector2,
  WebGLRenderer,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { aircraftSize, type ShapeKind } from '../../domain/aircraft/aircraftShapes'
import { dioramaPlaneScale, type AircraftPose, type DioramaView } from '../diorama/diorama'

/**
 * Low-poly 3D aircraft for the airport view, drawn with WebGL on a canvas
 * stacked over the 2D scene. The models are built in code from each type's
 * real length and wingspan (no model files), and the camera reproduces the 2D
 * view's projection exactly, so they sit where the flat shapes would.
 */
export class AircraftModels {
  private renderer: WebGLRenderer | null = null
  private readonly scene = new Scene()
  private readonly camera = new Camera()
  private readonly meshes = new Map<string, { mesh: Mesh; material: MeshPhongMaterial }>()
  private width = 1
  private height = 1

  constructor(canvas: HTMLCanvasElement) {
    try {
      this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true })
      this.renderer.setClearColor(0x000000, 0)
    } catch (err) {
      // No WebGL (e.g. disabled or unsupported): the 2D shapes are drawn instead.
      console.warn('3D aircraft unavailable:', err)
    }
    this.scene.add(new AmbientLight(0xffffff, 1.1))
    const sun = new DirectionalLight(0xffffff, 2.2)
    // From the southwest and high up; the camera has no transform, so this is in box meters.
    sun.position.set(-0.4, -0.6, 1)
    this.scene.add(sun)
  }

  get available() {
    return this.renderer !== null
  }

  resize(width: number, height: number, dpr: number) {
    this.width = Math.max(width, 1)
    this.height = Math.max(height, 1)
    this.renderer?.setPixelRatio(dpr)
    this.renderer?.setSize(this.width, this.height, false)
  }

  /** Draws `poses`, adding and removing models as aircraft come and go. */
  render(view: DioramaView, poses: AircraftPose[]) {
    if (!this.renderer) return
    const seen = new Set<string>()
    for (const pose of poses) {
      seen.add(pose.id)
      let entry = this.meshes.get(pose.id)
      const size = aircraftSize(pose.info.aircraftType, pose.info.emitterCategory)
      const geometry = modelGeometry(size.kind, size.lengthM, size.spanM, pose.info.aircraftType)
      if (!entry) {
        // One pass: three.js otherwise draws a transparent double-sided material twice a frame, re-checking its shader each time.
        const material = new MeshPhongMaterial({ flatShading: true, shininess: 40, transparent: true, side: DoubleSide, forceSinglePass: true })
        const mesh = new Mesh(geometry, material)
        mesh.frustumCulled = false
        this.scene.add(mesh)
        entry = { mesh, material }
        this.meshes.set(pose.id, entry)
      }
      const { mesh, material } = entry
      // The type can arrive after the aircraft first appears.
      if (mesh.geometry !== geometry) mesh.geometry = geometry
      material.color.set(pose.color)
      material.opacity = pose.opacity
      material.depthWrite = pose.opacity > 0.9

      mesh.scale.setScalar(dioramaPlaneScale(size.lengthM, pose.scale))
      mesh.position.set(pose.at.x, pose.at.y, pose.at.z)
      // Heading turns clockwise from north (+y); pitch raises the nose; bank lowers the right wing.
      mesh.rotation.set(rad(pose.pitch), rad(pose.bank), -rad(pose.heading), 'ZXY')
    }
    for (const [id, { mesh, material }] of this.meshes) {
      if (seen.has(id)) continue
      this.scene.remove(mesh)
      material.dispose()
      this.meshes.delete(id)
    }

    this.updateCamera(view)
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    for (const { material } of this.meshes.values()) material.dispose()
    this.meshes.clear()
    for (const geometry of geometries.values()) geometry.dispose()
    geometries.clear()
    this.renderer?.dispose()
  }

  /**
   * The 2D view maps box meters to screen pixels with an affine projection (see
   * createDioramaView). This writes the same mapping as clip space, plus a depth
   * along the viewing direction, straight into the camera's projection matrix.
   */
  private updateCamera(view: DioramaView) {
    const { cosR, sinR, sinE, cosE, scale, offsetX, offsetY, depthRange } = view.projection
    const [w, h, d] = [this.width, this.height, depthRange]
    const a = (2 * scale) / w
    const c = (2 * scale) / h
    const m = new Matrix4().set(
      // Screen x: the rotated east-west axis.
      a * cosR, -a * sinR, 0, (2 * offsetX) / w - 1,
      // Screen y (up): the rotated north-south axis foreshortened by the tilt, plus height.
      c * sinE * sinR, c * sinE * cosR, c * cosE, 1 - (2 * offsetY) / h,
      // Depth: distance along the viewing direction (farther = larger).
      (cosE * sinR) / d, (cosE * cosR) / d, -sinE / d, 0,
      0, 0, 0, 1,
    )
    this.camera.projectionMatrix.copy(m)
    this.camera.projectionMatrixInverse.copy(m).invert()
  }
}

function rad(deg: number) {
  return (deg * Math.PI) / 180
}

// ---- Models -------------------------------------------------------------------------

/** Types with four engines; everything else with jet engines gets two. */
const FOUR_ENGINES = new Set(['A388', 'A343', 'A346', 'B744', 'B748', 'A124', 'C17'])

/** Built once per type and shared by every aircraft of that type. */
const geometries = new Map<string, BufferGeometry>()

interface Proportions {
  /** Fuselage radius, as a fraction of length. */
  radius: number
  /** Wing planform, in fractions of length from the middle (+ toward the nose). */
  wing: { rootLead: number; rootTrail: number; tipLead: number; tipTrail: number; high: boolean }
  /** Tailplane span as a fraction of wingspan, and whether it sits on top of the fin. */
  tailplane: number
  tTail: boolean
  /** Fin height above the fuselage axis, as a fraction of length. */
  fin: number
  engines: 'wing' | 'tail' | 'props' | 'none'
}

const PROPORTIONS: Record<Exclude<ShapeKind, 'helicopter'>, Proportions> = {
  jet: {
    radius: 0.052,
    wing: { rootLead: 0.14, rootTrail: -0.05, tipLead: -0.1, tipTrail: -0.15, high: false },
    tailplane: 0.35,
    tTail: false,
    fin: 0.2,
    engines: 'wing',
  },
  widebody: {
    radius: 0.05,
    wing: { rootLead: 0.16, rootTrail: -0.07, tipLead: -0.12, tipTrail: -0.17, high: false },
    tailplane: 0.33,
    tTail: false,
    fin: 0.19,
    engines: 'wing',
  },
  regional: {
    radius: 0.05,
    wing: { rootLead: 0.08, rootTrail: -0.09, tipLead: -0.08, tipTrail: -0.13, high: false },
    tailplane: 0.4,
    tTail: true,
    fin: 0.22,
    engines: 'tail',
  },
  turboprop: {
    radius: 0.055,
    wing: { rootLead: 0.14, rootTrail: 0.0, tipLead: 0.12, tipTrail: 0.03, high: true },
    tailplane: 0.33,
    tTail: true,
    fin: 0.22,
    engines: 'props',
  },
  light: {
    radius: 0.07,
    wing: { rootLead: 0.22, rootTrail: 0.06, tipLead: 0.2, tipTrail: 0.07, high: true },
    tailplane: 0.32,
    tTail: false,
    fin: 0.2,
    engines: 'none',
  },
}

/**
 * The model for one type, in meters: nose toward +y, up +z, centered on the
 * fuselage axis and lifted so the wheels would rest on the ground.
 */
export function modelGeometry(kind: ShapeKind, length: number, span: number, type: string | null): BufferGeometry {
  const fourEngines = type !== null && FOUR_ENGINES.has(type.toUpperCase())
  const key = `${kind}|${length}|${span}|${fourEngines}`
  let geometry = geometries.get(key)
  if (!geometry) {
    const parts = kind === 'helicopter' ? helicopter(length, span) : airplane(PROPORTIONS[kind], length, span, fourEngines)
    geometry = mergeGeometries(parts.map(normalize))
    geometries.set(key, geometry)
  }
  return geometry
}

function airplane(p: Proportions, L: number, span: number, fourEngines: boolean): BufferGeometry[] {
  const r = p.radius * L
  const lift = r * 1.5
  const parts: BufferGeometry[] = []

  // Fuselage: a lathed profile from tail cone to nose.
  parts.push(
    lathe(
      [
        [0, -0.5],
        [0.25, -0.49],
        [0.6, -0.4],
        [1, -0.22],
        [1, 0.36],
        [0.85, 0.43],
        [0.5, 0.48],
        [0, 0.5],
      ].map(([fr, fy]) => [fr * r, fy * L]),
      lift,
    ),
  )

  // Wings: one flat planform across both sides.
  const w = p.wing
  const wingZ = lift + (w.high ? r * 0.85 : -r * 0.45)
  parts.push(planform(span, L, w.rootLead, w.rootTrail, w.tipLead, w.tipTrail, r, wingZ, L * 0.014))

  // Fin, then the tailplane (on top of the fin for a T-tail).
  const finTop = lift + p.fin * L
  parts.push(fin(L, r, lift, finTop))
  const tailZ = p.tTail ? finTop - L * 0.01 : lift + r * 0.2
  parts.push(planform(span * p.tailplane, L, -0.33, -0.47, -0.44, -0.495, r * 0.5, tailZ, L * 0.01))

  // Engines.
  if (p.engines === 'wing') {
    const er = 0.045 * L
    const stations = fourEngines ? [0.17, 0.3] : [0.17]
    for (const station of stations) {
      for (const side of [-1, 1]) {
        const x = side * station * span
        // Hung under the wing, a little ahead of its leading edge at that point.
        const along = (station * span) / (span / 2)
        const lead = w.rootLead + (w.tipLead - w.rootLead) * along
        parts.push(nacelle(er, L * 0.11, x, (lead + 0.02) * L, wingZ - er * 1.1))
      }
    }
  } else if (p.engines === 'tail') {
    const er = 0.04 * L
    for (const side of [-1, 1]) parts.push(nacelle(er, L * 0.13, side * (r + er * 1.2), -0.27 * L, lift + r * 0.35))
  } else if (p.engines === 'props') {
    const er = 0.03 * L
    for (const side of [-1, 1]) parts.push(nacelle(er, L * 0.15, side * 0.18 * span, (w.rootLead + 0.02) * L, wingZ - er * 0.3))
  }
  return parts
}

function helicopter(L: number, rotor: number): BufferGeometry[] {
  const r = 0.12 * L
  const lift = r * 1.2
  const parts: BufferGeometry[] = [
    // Cabin pod tapering into the tail boom.
    lathe(
      [
        [0, -0.5],
        [0.15, -0.49],
        [0.15, -0.1],
        [0.8, 0.04],
        [1, 0.17],
        [0.85, 0.3],
        [0.4, 0.4],
        [0, 0.42],
      ].map(([fr, fy]) => [fr * r, fy * L]),
      lift,
    ),
    fin(L, r * 0.3, lift, lift + 0.12 * L),
  ]
  // Two crossed main rotor blades on the mast.
  const blade = new BoxGeometry(rotor, rotor * 0.045, r * 0.08)
  blade.translate(0, 0.1 * L, lift + r * 1.15)
  const blade2 = blade.clone().rotateZ(Math.PI / 2)
  // Rotating the copy about the origin moves it off the mast; put it back.
  blade2.translate(0.1 * L, 0.1 * L, 0)
  parts.push(blade, blade2)
  return parts
}

/** A body of revolution around the y axis from [radius, y] points, raised to `z`. */
function lathe(points: number[][], z: number) {
  const geometry = new LatheGeometry(
    points.map(([x, y]) => new Vector2(x, y)),
    10,
  )
  // LatheGeometry spins around y, which is already our nose-to-tail axis.
  geometry.translate(0, 0, z)
  return geometry
}

/**
 * A flat, swept surface across both sides (wings or tailplane), from the
 * fuselage side out to the tips, `thickness` thick and centered at height `z`.
 */
function planform(
  span: number,
  L: number,
  rootLead: number,
  rootTrail: number,
  tipLead: number,
  tipTrail: number,
  root: number,
  z: number,
  thickness: number,
) {
  const half = span / 2
  const shape = new Shape([
    new Vector2(root, rootLead * L),
    new Vector2(half, tipLead * L),
    new Vector2(half, tipTrail * L),
    new Vector2(root, rootTrail * L),
    new Vector2(-root, rootTrail * L),
    new Vector2(-half, tipTrail * L),
    new Vector2(-half, tipLead * L),
    new Vector2(-root, rootLead * L),
  ])
  const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false })
  geometry.translate(0, 0, z - thickness / 2)
  return geometry
}

/** The vertical fin: a swept, thin plate standing on the rear fuselage. */
function fin(L: number, r: number, axisZ: number, top: number) {
  // Drawn as (along the length, height), then stood upright.
  const shape = new Shape([
    new Vector2(-0.28 * L, axisZ + r * 0.7),
    new Vector2(-0.43 * L, top),
    new Vector2(-0.49 * L, top),
    new Vector2(-0.5 * L, axisZ + r * 0.5),
  ])
  const thickness = L * 0.012
  const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false })
  // Shape x → length (y), shape y → height (z), extrusion → across (x).
  geometry.applyMatrix4(new Matrix4().set(0, 0, 1, -thickness / 2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1))
  return geometry
}

/** An engine nacelle: a short cylinder along the length, centered at (x, y, z). */
function nacelle(radius: number, length: number, x: number, y: number, z: number) {
  const geometry = new CylinderGeometry(radius * 0.85, radius, length, 8)
  // CylinderGeometry runs along y, nose-to-tail like the fuselage.
  geometry.translate(x, y, z)
  return geometry
}

/** Same attributes on every part (positions and normals, no indices or UVs) so they can be merged. */
function normalize(geometry: BufferGeometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry
  flat.deleteAttribute('uv')
  flat.clearGroups()
  if (!flat.getAttribute('normal')) flat.computeVertexNormals()
  return flat
}
