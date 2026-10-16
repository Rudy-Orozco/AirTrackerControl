import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, ShaderMaterial } from 'three'
import { PRECIP, type Radar } from '../map/radar'

/** The curtains stand in rows this far apart (nm), both east–west and north–south... */
const SPACING_NM = 1
/** ...each in steps this long, following the rain and the cloud base along it. */
const STEP_NM = 0.4
/** The radar is averaged over this many pixels each way around each step, so the curtains' edges are soft. */
const BLUR_PX = 2
/** Precipitation lighter than this (0–1 of the heaviest) still shows this strong, so drizzle is faintly there. */
const LIGHTEST = 0.25
/**
 * Curtains closer to the camera than this (drawn nm) aren't drawn, fading in
 * by NEAR_FADE_END: inside a shower, the ones all around would show as a mess
 * of panels, where what you'd see is the rain further off.
 */
const NEAR_FADE_START = 1.5
const NEAR_FADE_END = 6
/**
 * How opaque one curtain is (times the opacity setting) where it's coming down
 * hardest: looking through a shower a few miles across, a handful add up to a solid wall.
 */
const PER_CURTAIN = 0.22

/** The 3D map's frame, as precip.ts needs it. */
export interface PrecipFrame {
  /** The map reaches this far (nm) from the airport each way, as the radar does. */
  radiusNm: number
  /** The cloud base (feet above sea level) at a point, nm east and north of the airport; null where there's no cloud. */
  baseAt(x: number, y: number): number | null
  /**
   * How high the precipitation core reaches around a point (feet above sea
   * level), and how much of the area around it has one (0–1); null where none does.
   */
  coreTopAt(x: number, y: number): { heightFt: number; share: number } | null
  /** Where it falls from without a cloud overhead, feet above sea level. */
  defaultBaseFt: number
  /** Drawn height of an altitude (feet above sea level), and of the ground at a point. */
  heightOf(altitudeFt: number): number
  groundZ(x: number, y: number): number
}

/**
 * Rain, snow and hail on the 3D map, as they look from afar: translucent grey
 * curtains hanging from the cloud base to the ground wherever the radar says
 * precipitation is reaching it (see map/radar.ts), densest where it's coming
 * down hardest, thickest under the cloud and thinning toward the ground. Where
 * a shower's or storm's precipitation core reaches up into the cloud (its
 * echo top, see echoTops.ts), the curtain rises with it, so storms stand tall.
 *
 * Built from rows of thin vertical curtains both ways across the map: looking
 * through a shower, the curtains in it add up to a soft, solid wall, the wider
 * the shower the denser, from any direction. Each fades where it's seen edge
 * on, so they never show as lines.
 */
export class PrecipShafts {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>

  constructor() {
    this.mesh = new Mesh(
      new BufferGeometry(),
      new ShaderMaterial({
        uniforms: { uOpacity: { value: 1 } },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    )
    this.mesh.frustumCulled = false
    // Among the clouds' sheets, so the two blend.
    this.mesh.renderOrder = 1
  }

  /** Replaces the curtains with `radar`'s (none without it). */
  build(radar: Radar | null, frame: PrecipFrame) {
    const positions: number[] = []
    const strength: number[] = []
    const down: number[] = []
    const kind: number[] = []
    const facing: number[] = []
    if (radar) {
      const r = frame.radiusNm
      const at = sampler(radar, r)
      const rows = Math.floor((2 * r) / SPACING_NM)
      const steps = Math.ceil((2 * r) / STEP_NM)
      // Curtains running east–west (facing north), then north–south (facing east).
      for (const eastWest of [true, false]) {
        for (let row = 1; row < rows; row++) {
          const across = -r + row * SPACING_NM
          let previous: { x: number; y: number; top: number; bottom: number; s: number; k: number } | null = null
          for (let step = 0; step <= steps; step++) {
            const along = -r + step * STEP_NM
            const x = eastWest ? along : across
            const y = eastWest ? across : along
            const { s, k } = at(x, y)
            const bottom = frame.groundZ(x, y)
            // From the cloud base, or higher where the shower's core reaches up into the cloud, tapering at its edges.
            const baseFt = frame.baseAt(x, y) ?? frame.defaultBaseFt
            const core = s > 0 ? frame.coreTopAt(x, y) : null
            const topFt = core ? baseFt + Math.max(core.heightFt - baseFt, 0) * core.share : baseFt
            const top = Math.max(frame.heightOf(topFt), bottom)
            const here = { x, y, top, bottom, s, k }
            // A quad between this step and the last, where either has precipitation.
            if (previous && (previous.s > 0 || s > 0)) {
              const k = Math.max(previous.k, here.k)
              // Two triangles: the last step's top and bottom with this one's top, then this one's top and bottom with the last's bottom.
              for (const [p, d] of [
                [previous, 0],
                [previous, 1],
                [here, 0],
                [here, 0],
                [previous, 1],
                [here, 1],
              ] as const) {
                // Top corners at the cloud base, bottom corners at the ground.
                const corner = p as typeof here
                positions.push(corner.x, corner.y, d === 0 ? corner.top : corner.bottom)
                strength.push(corner.s)
                down.push(d)
                kind.push(k)
                facing.push(eastWest ? 1 : 0)
              }
            }
            previous = here
          }
        }
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    geometry.setAttribute('aStrength', new BufferAttribute(new Float32Array(strength), 1))
    geometry.setAttribute('aDown', new BufferAttribute(new Float32Array(down), 1))
    geometry.setAttribute('aKind', new BufferAttribute(new Float32Array(kind), 1))
    geometry.setAttribute('aFacesNorth', new BufferAttribute(new Float32Array(facing), 1))
    this.mesh.geometry.dispose()
    this.mesh.geometry = geometry
  }

  /** Each curtain as opaque as `opacity` allows where it's coming down hardest. */
  update(opacity: number, visible: boolean) {
    this.mesh.visible = visible && (this.mesh.geometry.getAttribute('position')?.count ?? 0) > 0
    this.mesh.material.uniforms.uOpacity.value = opacity
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}

/**
 * How hard (0–1, 0 for none) and what (a PRECIP kind) is coming down at a
 * point, nm east and north of the airport, from the radar averaged around it.
 */
function sampler(radar: Radar, radiusNm: number) {
  const n = radar.size
  return (x: number, y: number) => {
    // The radar covers the same square as the map, north row first.
    const col = Math.floor(((x + radiusNm) / (2 * radiusNm)) * n)
    const row = Math.floor(((radiusNm - y) / (2 * radiusNm)) * n)
    let sum = 0
    let count = 0
    const kinds = [0, 0, 0, 0]
    for (let j = row - BLUR_PX; j <= row + BLUR_PX; j++) {
      for (let i = col - BLUR_PX; i <= col + BLUR_PX; i++) {
        count++
        if (i < 0 || j < 0 || i >= n || j >= n) continue
        const p = j * n + i
        const k = radar.kind[p]
        if (k === PRECIP.none) continue
        sum += LIGHTEST + (1 - LIGHTEST) * (radar.intensity[p] / 255)
        kinds[k]++
      }
    }
    // The commonest kind around (snow and hail over rain where they're as common).
    const k = kinds.reduce((best, c, i) => (i > 0 && c > 0 && c >= kinds[best] ? i : best), 0)
    return { s: sum / count, k }
  }
}

const VERTEX_SHADER = /* glsl */ `
  attribute float aStrength;
  attribute float aDown;
  attribute float aKind;
  attribute float aFacesNorth;
  varying float vStrength;
  varying float vDown;
  varying float vKind;
  varying float vFacesNorth;
  varying vec3 vWorld;
  void main() {
    vStrength = aStrength;
    vDown = aDown;
    vKind = aKind;
    vFacesNorth = aFacesNorth;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  varying float vStrength;
  varying float vDown;
  varying float vKind;
  varying float vFacesNorth;
  varying vec3 vWorld;
  void main() {
    // How squarely the camera looks at the curtain here: 0 edge-on, 1 face-on. Per
    // pixel, as up close it changes too much across a curtain to blend between its corners.
    vec3 normal = vFacesNorth > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    float facing = abs(dot(normal, normalize(cameraPosition - vWorld)));
    bool snow = abs(vKind - ${PRECIP.snow.toFixed(1)}) < 0.5;
    bool hail = abs(vKind - ${PRECIP.hail.toFixed(1)}) < 0.5;
    // Out of the cloud base, densest just under it, thinning toward the ground.
    float profile = smoothstep(0.0, 0.08, vDown) * (1.0 - 0.55 * smoothstep(0.35, 1.0, vDown));
    // Faded where seen edge-on, so the curtains don't show as lines.
    float face = smoothstep(0.15, 0.7, facing);
    float near = smoothstep(${NEAR_FADE_START.toFixed(2)}, ${NEAR_FADE_END.toFixed(2)}, distance(cameraPosition, vWorld));
    vec3 color = snow ? vec3(0.9, 0.93, 0.98) : hail ? vec3(0.88, 0.82, 0.9) : vec3(0.6, 0.65, 0.72);
    float alpha = uOpacity * ${PER_CURTAIN.toFixed(3)} * vStrength * profile * face * near;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(color, alpha);
  }
`
