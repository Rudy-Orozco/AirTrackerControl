import { BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'
import { CLOUD_BANDS_FT } from '../../services/api/goes'
import { boxBlur, DENSITY_SOFTNESS, smoothstep, type CloudField, type StationLayer } from '../map/clouds'

/** Where a band's base is drawn when no station reports a layer in it, feet above sea level. */
const DEFAULT_BASE_FT = [3000, 7000, 13_000, 20_000, 28_000]
/**
 * How thick a cloud is drawn when its top isn't known: without the satellite's
 * tops, or when it's under a separate, higher cloud whose top is what the satellite sees.
 */
const UNSEEN_THICKNESS_FT = 2000
/** The thinnest a cloud is drawn, feet. */
const MIN_THICKNESS_FT = 300
/** Sheets per band, from its base to its top, so clouds have thickness. */
const SLICES = 8
/**
 * Toward a cloud's own base and top, the sheets fade out over this share of
 * its thickness, so it has soft edges rather than a hard first and last sheet.
 */
const FEATHER = 0.35
/** The faintest the outermost sheet of a feathered edge gets. */
const FEATHER_MIN = 0.12
/** A band counts as cloudy at a point when its cloud there is at least this opaque (on average, around it). */
const CLOUDY = 0.03
const CLOUD_COLOR = 0xdfe6ee
/** A cloud's base is drawn this much as bright as its top: shaded underneath, as clouds are lit from above. */
const BASE_SHADE = 0.68
/** How many steps each sheet's heights follow across the map. */
const HEIGHT_STEPS = 48

/** A label for the clouds: where it's drawn (scenery heights), and what it says. */
export interface CloudLabel {
  at: Vector3
  text: string
}

/**
 * The clouds (see map/clouds.ts) on the 3D map: each height band a stack of
 * translucent sheets as cloudy as the field says, from the cloud's base up to
 * its top, so clouds have their thickness.
 *
 * The base is what the METARs of stations with a layer in that band report
 * (blended between them), or a typical height for the band if none do; where
 * the band below is cloudy too, it's the same cloud carrying on up, from the
 * band's floor. The top is the satellite's cloud top, for the highest cloud
 * there (kept within its band); where the band above is cloudy too, the cloud
 * carries on up into it. A cloud under a separate, higher one, or without the
 * satellite's tops, is drawn UNSEEN_THICKNESS_FT thick.
 *
 * The sheets blend into one another: each fades toward the cloud's own base
 * and top (FEATHER), and where a cloud carries on from one band into the next,
 * the two sheets that meet there go half as strong, so the bands join seamlessly.
 *
 * Seen from the side, flat sheets would show as stripes, so the clouds are
 * also built from rows of thin vertical curtains both ways across the map
 * (see buildCurtains), from each cloud's base to its top: looking across at a
 * cloud, the curtains in it add up to a solid body. Each set fades where the
 * other shows the cloud better: the sheets when seen edge-on from the side,
 * the curtains when seen from above.
 */
export class CloudLayers {
  readonly group = new Group()
  /** Per band, its sheets from base to top, sharing one material. */
  private readonly stacks: { material: MeshBasicMaterial; sheets: Mesh<PlaneGeometry, MeshBasicMaterial>[] }[] = []
  /**
   * The cloud base at each of the sheets' vertices, feet above sea level, for
   * baseAt: the lowest cloud's where there's cloud, carried over from around
   * where there isn't (so rain falls from one smooth base); null without any cloud.
   */
  private rainBase: Float32Array | null = null
  private radiusNm = 0
  /** The vertical curtains, for seeing the clouds from the side. */
  private readonly curtains = new Mesh(new BufferGeometry(), curtainMaterial(MIN_DENSITY))

  constructor() {
    this.curtains.frustumCulled = false
    this.curtains.renderOrder = 1
    this.group.add(this.curtains)
  }

  /**
   * Replaces the clouds with `field`'s, raised with `heightOf` (feet above sea
   * level to drawn height); returns the label of the cloud tops the satellite
   * sees over the airport, if it sees any.
   */
  set(field: CloudField, heightOf: (altitudeFt: number) => number): CloudLabel[] {
    // Every sheet's vertices lie at the same points across the map.
    const stack = this.stacks[0] ?? this.addStack(0, field.radiusNm)
    const coarse = coarsen(field, stack.sheets[0].geometry)
    const cloudy = (band: number, v: number) => band >= 0 && band < coarse.bands.length && (coarse.bands[band]?.[v] ?? 0) > CLOUDY
    const lowestBase = new Float32Array(coarse.x.length).fill(NaN)
    const heights: (BandHeights | null)[] = field.bands.map(() => null)

    field.bands.forEach((alpha, band) => {
      const stack = this.stacks[band] ?? this.addStack(band, field.radiusNm)
      stack.material.alphaMap?.dispose()
      stack.material.alphaMap = alpha && cloudTexture(alpha, field.size)
      stack.material.needsUpdate = true
      for (const sheet of stack.sheets) sheet.visible = alpha !== null
      if (!alpha) return

      const [floor, ceiling] = CLOUD_BANDS_FT[band]
      const reported = stationBases(field.layers[band])
      const vertices = coarse.x.length
      const bases = new Float32Array(vertices)
      const tops = new Float32Array(vertices)
      // Whether the cloud carries on from the band below, and into the band above (1), or ends there (0).
      const joinsBelow = new Float32Array(vertices)
      const joinsAbove = new Float32Array(vertices)
      for (let v = 0; v < vertices; v++) {
        joinsBelow[v] = cloudy(band - 1, v) ? 1 : 0
        joinsAbove[v] = cloudy(band + 1, v) ? 1 : 0
        // The same cloud carrying on up from the band below, or a cloud of its own.
        const base = joinsBelow[v] ? floor : (blendedBase(reported, coarse.x[v], coarse.y[v]) ?? DEFAULT_BASE_FT[band])
        let top: number
        if (joinsAbove[v]) top = ceiling
        else {
          const above = coarse.bands.some((_, b) => b > band + 1 && cloudy(b, v))
          const seen = coarse.topsFt[v]
          // The satellite sees the top of the highest cloud only.
          top = above || Number.isNaN(seen) ? base + UNSEEN_THICKNESS_FT : seen
          top = Math.min(top, Math.max(ceiling, base + MIN_THICKNESS_FT))
        }
        bases[v] = base
        tops[v] = Math.max(top, base + MIN_THICKNESS_FT)
      }
      // Eased between neighbors, so where a cloud's base or top changes how it's
      // found, the sheets slope there rather than fold.
      smoothGrid(bases, SMOOTHING_PASSES)
      smoothGrid(tops, SMOOTHING_PASSES)
      smoothGrid(joinsBelow, SMOOTHING_PASSES)
      smoothGrid(joinsAbove, SMOOTHING_PASSES)
      for (let v = 0; v < vertices; v++) {
        tops[v] = Math.max(tops[v], bases[v] + MIN_THICKNESS_FT)
        if (cloudy(band, v) && !(bases[v] >= lowestBase[v])) lowestBase[v] = bases[v]
      }
      heights[band] = { bases, tops, joinsBelow, joinsAbove }
      stack.sheets.forEach((sheet, k) => {
        const pos = sheet.geometry.getAttribute('position') as BufferAttribute
        const color = sheet.geometry.getAttribute('color') as BufferAttribute
        const t = k / (SLICES - 1)
        for (let v = 0; v < vertices; v++) {
          pos.setZ(v, heightOf(bases[v] + (tops[v] - bases[v]) * t))
          const strength = edgeStrength(t, joinsBelow[v]) * edgeStrength(1 - t, joinsAbove[v])
          // Darker toward the cloud's own base, not where it carries on down into the band below.
          const shade = 1 - (1 - BASE_SHADE) * (1 - t) * (1 - joinsBelow[v])
          color.setXYZW(v, shade, shade, shade, strength)
        }
        pos.needsUpdate = true
        color.needsUpdate = true
      })
    })

    this.rainBase = fillGaps(lowestBase)
    this.radiusNm = field.radiusNm
    this.curtains.geometry.dispose()
    this.curtains.geometry = buildCurtains(field, heights, heightOf)
    const topHere = airportTop(field)
    return topHere === null ? [] : [{ at: new Vector3(0, 0, heightOf(topHere)), text: `TOPS ${(Math.round(topHere / 100) * 100).toLocaleString()}` }]
  }

  /**
   * The cloud base at a point (nm east and north of the airport), feet above
   * sea level, for rain to fall from: smooth across the map, blended between
   * the sheets' vertices; null when there's no cloud anywhere.
   */
  baseAt(x: number, y: number): number | null {
    return this.rainBase && gridAt(this.rainBase, this.radiusNm, x, y)
  }

  /** Leaves out cloud thinner than `minDensity` (0–1, 1 being solid; see MAP3D.clouds.minDensity). */
  setMinDensity(minDensity: number) {
    MIN_DENSITY.value = minDensity
  }

  /** Each band's sheets together are about `opacity` opaque where it's all cloud, seen from straight above. */
  setOpacity(opacity: number) {
    const perSheet = 1 - (1 - Math.min(opacity, 0.999)) ** (1 / SHEETS_AT_FULL_STRENGTH)
    for (const s of this.stacks) s.material.opacity = Math.min(perSheet, 1)
    this.curtains.material.uniforms.uOpacity.value = opacity
  }

  dispose() {
    for (const s of this.stacks) {
      for (const sheet of s.sheets) sheet.geometry.dispose()
      s.material.alphaMap?.dispose()
      s.material.dispose()
    }
    this.curtains.geometry.dispose()
    this.curtains.material.dispose()
    this.group.clear()
  }

  private addStack(band: number, radiusNm: number) {
    // Each vertex's alpha (its color's fourth part) is how strong the sheet is there (see edgeStrength).
    const material = new MeshBasicMaterial({ color: CLOUD_COLOR, transparent: true, depthWrite: false, side: DoubleSide, vertexColors: true })
    fadeEdgeOn(material, MIN_DENSITY)
    const sheets = Array.from({ length: SLICES }, (_, k) => {
      const geometry = new PlaneGeometry(radiusNm * 2, radiusNm * 2, HEIGHT_STEPS, HEIGHT_STEPS)
      geometry.setAttribute('color', new BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 4).fill(1), 4))
      const sheet = new Mesh(geometry, material)
      // Drawn after the ground; lowest first, so higher sheets lie over lower ones seen from above.
      sheet.renderOrder = 1 + band * 0.01 + k * 0.001
      sheet.frustumCulled = false
      this.group.add(sheet)
      return sheet
    })
    this.stacks[band] = { material, sheets }
    return this.stacks[band]
  }
}

/**
 * The field averaged around each vertex of the sheets (they follow heights in
 * HEIGHT_STEPS steps, not per pixel): each band's cloud, and the cloud tops,
 * with where each vertex is (nm east and north of the airport).
 */
function coarsen(field: CloudField, geometry: PlaneGeometry) {
  const pos = geometry.getAttribute('position') as BufferAttribute
  const n = field.size
  const r = field.radiusNm
  const half = Math.ceil(n / HEIGHT_STEPS / 2)
  const x = new Float32Array(pos.count)
  const y = new Float32Array(pos.count)
  const bands = field.bands.map((alpha) => (alpha ? new Float32Array(pos.count) : null))
  const topsFt = new Float32Array(pos.count).fill(NaN)
  for (let v = 0; v < pos.count; v++) {
    x[v] = pos.getX(v)
    y[v] = pos.getY(v)
    // Rows run north to south.
    const col = Math.round(((x[v] + r) / (2 * r)) * n)
    const row = Math.round(((r - y[v]) / (2 * r)) * n)
    const j0 = Math.max(0, row - half)
    const j1 = Math.min(n, row + half)
    const i0 = Math.max(0, col - half)
    const i1 = Math.min(n, col + half)
    const count = Math.max((j1 - j0) * (i1 - i0), 1)
    // Plain loops: this runs over every pixel for every band.
    for (let b = 0; b < field.bands.length; b++) {
      const alpha = field.bands[b]
      const out = bands[b]
      if (!alpha || !out) continue
      let sum = 0
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) sum += alpha[j * n + i]
      out[v] = sum / count
    }
    if (field.topsFt) {
      let topSum = 0
      let topCount = 0
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          const top = field.topsFt[j * n + i]
          if (Number.isNaN(top)) continue
          topSum += top
          topCount++
        }
      }
      if (topCount) topsFt[v] = topSum / topCount
    }
  }
  return { x, y, bands, topsFt }
}

/** The density threshold every cloud shader reads (see CloudLayers.setMinDensity). */
const MIN_DENSITY = { value: 0 }

/** GLSL: how much of cloud `density` thick is drawn under threshold `uMinDensity` (as densityGate in map/clouds.ts). */
const DENSITY_GATE_GLSL = `
  uniform float uMinDensity;
  float densityGate(float density) {
    return uMinDensity <= 0.0 ? 1.0 : smoothstep(uMinDensity, uMinDensity + ${DENSITY_SOFTNESS.toFixed(3)}, density);
  }
`

/** Seen edge-on, a sheet keeps this much of its strength (the curtains show the cloud from the side)... */
const EDGE_ON_STRENGTH = 0.15
/** ...rising to all of it by this steep a view (the sine of the angle from level). */
const EDGE_ON_ANGLE = 0.35

/**
 * Fades a sheet where it's seen nearly edge-on, from the side, where its
 * translucency piles up along one line: without this, a stack of sheets shows
 * as stripes from the side, rather than one body of cloud.
 */
function fadeEdgeOn(material: MeshBasicMaterial, minDensity: { value: number }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMinDensity = minDensity
    shader.vertexShader = `varying float vCloudFacing;\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      // How steeply the camera looks at this point of the sheet: 0 level with it, 1 straight down.
      vec4 cloudWorld = modelMatrix * vec4(transformed, 1.0);
      vCloudFacing = abs(normalize(cameraPosition - cloudWorld.xyz).z);`,
    )
    shader.fragmentShader = `varying float vCloudFacing;\n${DENSITY_GATE_GLSL}\n${shader.fragmentShader}`
      .replace(
        '#include <alphamap_fragment>',
        // The cloud's density is the alpha map; thinner than the threshold, it isn't drawn.
        `float cloudDensity = texture2D(alphaMap, vAlphaMapUv).g;
        diffuseColor.a *= cloudDensity * densityGate(cloudDensity);`,
      )
      .replace(
        '#include <opaque_fragment>',
        `diffuseColor.a *= mix(${EDGE_ON_STRENGTH.toFixed(3)}, 1.0, smoothstep(0.0, ${EDGE_ON_ANGLE.toFixed(3)}, vCloudFacing));
        #include <opaque_fragment>`,
      )
  }
}

/**
 * How strong a sheet is, `t` of the way up from one end of the cloud (0 at
 * the end, 1 at the other): fading out toward an end where the cloud really
 * ends, or half strength right at it where the cloud carries on into the next
 * band (`joins` 1), whose sheet there makes up the other half. In between, blended.
 */
function edgeStrength(t: number, joins: number) {
  const feathered = FEATHER_MIN + (1 - FEATHER_MIN) * smoothstep(t / FEATHER)
  const joined = t < 0.5 / (SLICES - 1) ? 0.5 : 1
  return feathered + (joined - feathered) * joins
}

/**
 * About how many full-strength sheets a band's stack adds up to, seen from
 * above (its feathered ends count for less), for setting each sheet's opacity.
 */
const SHEETS_AT_FULL_STRENGTH = Array.from({ length: SLICES }, (_, k) => {
  const t = k / (SLICES - 1)
  return edgeStrength(t, 0) * edgeStrength(1 - t, 0)
}).reduce((a, b) => a + b, 0)

/**
 * `bases` (one per vertex, NaN where there's no cloud) with the gaps filled in
 * from around them, a ring at a time, then smoothed; null if there's no cloud at all.
 */
function fillGaps(bases: Float32Array): Float32Array | null {
  const side = HEIGHT_STEPS + 1
  let filled = Float32Array.from(bases)
  if (filled.every((b) => Number.isNaN(b))) return null
  while (filled.some((b) => Number.isNaN(b))) {
    const next = Float32Array.from(filled)
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        const v = row * side + col
        if (!Number.isNaN(filled[v])) continue
        let sum = 0
        let count = 0
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const r = row + dr
          const c = col + dc
          if (r < 0 || c < 0 || r >= side || c >= side) continue
          const b = filled[r * side + c]
          if (Number.isNaN(b)) continue
          sum += b
          count++
        }
        if (count) next[v] = sum / count
      }
    }
    filled = next
  }
  smoothGrid(filled, SMOOTHING_PASSES * 2)
  return filled
}

/** A band's cloud base and top at each of the sheets' vertices, and whether it carries on below and above (see set). */
interface BandHeights {
  bases: Float32Array
  tops: Float32Array
  joinsBelow: Float32Array
  joinsAbove: Float32Array
}

/** A value given at each of the sheets' vertices, at a point (nm east and north of the airport), blended between them. */
function gridAt(values: Float32Array, radiusNm: number, x: number, y: number) {
  const side = HEIGHT_STEPS + 1
  // The sheets' vertices run west to east, north row first.
  const fx = Math.min(Math.max(((x + radiusNm) / (2 * radiusNm)) * HEIGHT_STEPS, 0), HEIGHT_STEPS)
  const fy = Math.min(Math.max(((radiusNm - y) / (2 * radiusNm)) * HEIGHT_STEPS, 0), HEIGHT_STEPS)
  const ix = Math.min(Math.floor(fx), HEIGHT_STEPS - 1)
  const iy = Math.min(Math.floor(fy), HEIGHT_STEPS - 1)
  const tx = fx - ix
  const ty = fy - iy
  const at = (cx: number, cy: number) => values[cy * side + cx]
  const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx
  const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx
  return top + (bottom - top) * ty
}

// ---- Curtains, for the side view --------------------------------------------------------

/** The curtains follow the cloud in steps this long (nm)... */
const CURTAIN_STEP_NM = 0.5
/** ...and stand in rows every this many steps (1.5 nm apart), both east–west and north–south. */
const CURTAIN_EVERY = 3
/** The field is averaged over this many pixels each way around each step, so the curtains' edges are soft. */
const CURTAIN_BLUR_PX = 2
/**
 * How opaque one curtain is (times the opacity setting) where it's all cloud:
 * looking across a cloud a few miles wide, a handful add up to a solid body.
 */
const PER_CURTAIN = 0.1
/** Curtains closer to the camera than this (drawn nm) aren't drawn, fading in by the second, so flying in cloud isn't a mess of panels. */
const CURTAIN_NEAR_FADE: [number, number] = [1, 4]

/**
 * Rows of vertical curtains both ways across the map: for each band with cloud
 * along them, a strip from its base to its top as opaque as the cloud there,
 * soft where the cloud really ends and seamless where it carries on into the
 * next band.
 *
 * Everything is worked out once per band on a grid of the curtains' steps,
 * and each step's top and bottom vertices are shared by the strips either
 * side, in arrays sized up front: over an overcast map there are a few hundred
 * thousand of them, rebuilt with each satellite scan.
 */
function buildCurtains(field: CloudField, heights: (BandHeights | null)[], heightOf: (altitudeFt: number) => number) {
  const r = field.radiusNm
  const n = field.size
  // Grid points across, CURTAIN_STEP_NM apart, from the map's west (north) edge.
  const m = Math.floor((2 * r) / CURTAIN_STEP_NM) + 1
  const lines: { eastWest: boolean; index: number }[] = []
  for (let k = CURTAIN_EVERY; k < m - 1; k += CURTAIN_EVERY) lines.push({ eastWest: true, index: k }, { eastWest: false, index: k })
  const bands = field.bands.map((alpha, b) => (alpha && heights[b] ? b : -1)).filter((b) => b >= 0)
  const maxVertices = bands.length * lines.length * m * 2
  const position = new Float32Array(maxVertices * 3)
  const strength = new Float32Array(maxVertices)
  const down = new Float32Array(maxVertices)
  const softTop = new Float32Array(maxVertices)
  const softBottom = new Float32Array(maxVertices)
  const facesNorth = new Float32Array(maxVertices)
  const index: number[] = []
  let vertices = 0

  for (const band of bands) {
    const h = heights[band]!
    // The band's cloud, blurred once, and its heights at every grid point.
    const blurred = boxBlur(field.bands[band]!, n, CURTAIN_BLUR_PX)
    const a = new Float32Array(m * m)
    const top = new Float32Array(m * m)
    const bottom = new Float32Array(m * m)
    const sTop = new Float32Array(m * m)
    const sBottom = new Float32Array(m * m)
    for (let j = 0; j < m; j++) {
      const y = r - j * CURTAIN_STEP_NM
      const row = Math.min(n - 1, Math.floor((j * CURTAIN_STEP_NM * n) / (2 * r)))
      for (let i = 0; i < m; i++) {
        const x = -r + i * CURTAIN_STEP_NM
        const g = j * m + i
        a[g] = blurred[row * n + Math.min(n - 1, Math.floor((i * CURTAIN_STEP_NM * n) / (2 * r)))]
        if (a[g] <= 0.01) continue
        top[g] = heightOf(gridAt(h.tops, r, x, y))
        bottom[g] = heightOf(gridAt(h.bases, r, x, y))
        sTop[g] = 1 - gridAt(h.joinsAbove, r, x, y)
        sBottom[g] = 1 - gridAt(h.joinsBelow, r, x, y)
      }
    }
    for (const line of lines) {
      // The grid point `k` along the line.
      const at = (k: number) => (line.eastWest ? line.index * m + k : k * m + line.index)
      let last = -1
      for (let k = 0; k < m - 1; k++) {
        const g0 = at(k)
        const g1 = at(k + 1)
        if (a[g0] <= 0.01 && a[g1] <= 0.01) continue
        // The top and bottom vertices of each end, shared with the strip before if it was just made.
        const first = last === k ? vertices - 2 : vertices
        if (last !== k) vertices = addPair(g0, k)
        vertices = addPair(g1, k + 1)
        const second = vertices - 2
        index.push(first, first + 1, second, second, first + 1, second + 1)
        last = k + 1

        function addPair(g: number, k: number) {
          const x = line.eastWest ? -r + k * CURTAIN_STEP_NM : -r + line.index * CURTAIN_STEP_NM
          const y = line.eastWest ? r - line.index * CURTAIN_STEP_NM : r - k * CURTAIN_STEP_NM
          // Where there's no cloud, the strip's end tapers to nothing at the neighbor's heights.
          const other = g === g0 ? g1 : g0
          const t = a[g] > 0.01 ? g : other
          for (const d of [0, 1]) {
            const v = vertices + d
            position[v * 3] = x
            position[v * 3 + 1] = y
            position[v * 3 + 2] = d === 0 ? top[t] : bottom[t]
            strength[v] = a[g]
            down[v] = d
            softTop[v] = sTop[t]
            softBottom[v] = sBottom[t]
            facesNorth[v] = line.eastWest ? 1 : 0
          }
          return vertices + 2
        }
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position.slice(0, vertices * 3), 3))
  geometry.setAttribute('aStrength', new BufferAttribute(strength.slice(0, vertices), 1))
  geometry.setAttribute('aDown', new BufferAttribute(down.slice(0, vertices), 1))
  geometry.setAttribute('aSoftTop', new BufferAttribute(softTop.slice(0, vertices), 1))
  geometry.setAttribute('aSoftBottom', new BufferAttribute(softBottom.slice(0, vertices), 1))
  geometry.setAttribute('aFacesNorth', new BufferAttribute(facesNorth.slice(0, vertices), 1))
  geometry.setIndex(vertices > 65535 ? new BufferAttribute(Uint32Array.from(index), 1) : new BufferAttribute(Uint16Array.from(index), 1))
  return geometry
}

function curtainMaterial(minDensity: { value: number }) {
  const color = `vec3(${[(CLOUD_COLOR >> 16) & 255, (CLOUD_COLOR >> 8) & 255, CLOUD_COLOR & 255].map((c) => (c / 255).toFixed(3)).join(', ')})`
  return new ShaderMaterial({
    uniforms: { uOpacity: { value: 1 }, uMinDensity: minDensity },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aStrength;
      attribute float aDown;
      attribute float aSoftTop;
      attribute float aSoftBottom;
      attribute float aFacesNorth;
      varying float vStrength;
      varying float vDown;
      varying float vSoftTop;
      varying float vSoftBottom;
      varying float vFacesNorth;
      varying vec3 vWorld;
      void main() {
        vStrength = aStrength;
        vDown = aDown;
        vSoftTop = aSoftTop;
        vSoftBottom = aSoftBottom;
        vFacesNorth = aFacesNorth;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      ${DENSITY_GATE_GLSL}
      varying float vStrength;
      varying float vDown;
      varying float vSoftTop;
      varying float vSoftBottom;
      varying float vFacesNorth;
      varying vec3 vWorld;
      void main() {
        // Faded where seen edge-on (from above, or along the row), so the curtains never show as lines.
        vec3 normal = vFacesNorth > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        float face = smoothstep(0.15, 0.7, abs(dot(normal, normalize(cameraPosition - vWorld))));
        float near = smoothstep(${CURTAIN_NEAR_FADE[0].toFixed(2)}, ${CURTAIN_NEAR_FADE[1].toFixed(2)}, distance(cameraPosition, vWorld));
        // Soft toward the cloud's own top and base; not where it carries on into the next band.
        float top = mix(1.0, smoothstep(0.0, ${FEATHER.toFixed(2)}, vDown), vSoftTop);
        float bottom = mix(1.0, smoothstep(0.0, ${FEATHER.toFixed(2)}, 1.0 - vDown), vSoftBottom);
        float alpha = uOpacity * ${PER_CURTAIN.toFixed(3)} * vStrength * densityGate(vStrength) * face * near * top * bottom;
        if (alpha < 0.003) discard;
        // Darker toward the cloud's own base, as clouds are lit from above.
        float shade = 1.0 - ${(1 - BASE_SHADE).toFixed(2)} * vDown * vSoftBottom;
        gl_FragColor = vec4(${color} * shade, alpha);
      }
    `,
  })
}

/** How many times the sheets' heights are eased between neighboring vertices. */
const SMOOTHING_PASSES = 2

/** Replaces each vertex's value with the mean of its 3×3 neighbors (the sheets' vertices are a square grid), `passes` times. */
function smoothGrid(values: Float32Array, passes: number) {
  const side = HEIGHT_STEPS + 1
  const copy = new Float32Array(values.length)
  for (let pass = 0; pass < passes; pass++) {
    copy.set(values)
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        let sum = 0
        let count = 0
        for (let j = Math.max(0, row - 1); j <= Math.min(side - 1, row + 1); j++) {
          for (let i = Math.max(0, col - 1); i <= Math.min(side - 1, col + 1); i++) {
            sum += copy[j * side + i]
            count++
          }
        }
        values[row * side + col] = sum / count
      }
    }
  }
}

/** Each station's lowest layer in a band: its cloud base there. */
function stationBases(layers: StationLayer[]) {
  const bases = new Map<string, StationLayer>()
  for (const l of layers) {
    const kept = bases.get(l.icao)
    if (!kept || l.baseFt < kept.baseFt) bases.set(l.icao, l)
  }
  return [...bases.values()]
}

/** The stations' bases blended at a point, nearer ones counting more; null if none report one. */
function blendedBase(reported: StationLayer[], x: number, y: number) {
  if (!reported.length) return null
  let sum = 0
  let weights = 0
  for (const l of reported) {
    const w = 1 / (Math.hypot(x - l.x, y - l.y) ** 2 + 1)
    sum += l.baseFt * w
    weights += w
  }
  return sum / weights
}

/** The satellite's cloud tops right over the airport (averaged over a mile or so), if it sees any. */
function airportTop(field: CloudField) {
  if (!field.topsFt) return null
  const n = field.size
  const c = n / 2
  let sum = 0
  let count = 0
  for (let j = c - 2; j < c + 2; j++) {
    for (let i = c - 2; i < c + 2; i++) {
      const top = field.topsFt[j * n + i]
      if (Number.isNaN(top)) continue
      sum += top
      count++
    }
  }
  return count ? sum / count : null
}

/** An alpha map from each pixel's opacity, fading out toward the map's edges like the ground. */
function cloudTexture(alpha: Float32Array, n: number) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = n
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(n, n)
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col
      const r = Math.hypot(col - n / 2 + 0.5, row - n / 2 + 0.5) / (n / 2)
      const v = Math.round(255 * alpha[i] * (1 - smoothstep((r - 0.6) / 0.4)))
      image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = v
      image.data[i * 4 + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return new CanvasTexture(canvas)
}
