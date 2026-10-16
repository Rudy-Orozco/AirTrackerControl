/**
 * The GOES-R ABI fixed grid: where the satellite sees each point on Earth, as
 * scan angles (radians) from straight down, per the GOES-R Product User
 * Guide's navigation formulas. Products come as images on this grid; these
 * helpers crop them to an area and read them at a latitude and longitude.
 * Imports nothing, so the decoding worker (goesWorker.ts) can use it too.
 */

/** An image on the fixed grid, or a crop of one. */
export interface GoesGrid {
  /** The satellite's longitude: GOES West's (-137) or GOES East's (-75). */
  satelliteLon: number
  nx: number
  ny: number
  /** Scan angles of the image's outer edges: [west, east] and [north, south]. */
  xBounds: [number, number]
  yBounds: [number, number]
}

export interface Box {
  west: number
  south: number
  east: number
  north: number
}

/** The GRS80 ellipsoid, and the satellite's distance from Earth's center (its height plus the equatorial radius). */
const R_EQ = 6_378_137
const R_POL = 6_356_752.31414
const E2 = 0.0066943800699785
const H = 35_786_023 + R_EQ

export function fixedGrid(lat: number, lon: number, satelliteLon: number) {
  const phi = (lat * Math.PI) / 180
  const lambda = ((lon - satelliteLon) * Math.PI) / 180
  const phiC = Math.atan(((R_POL * R_POL) / (R_EQ * R_EQ)) * Math.tan(phi))
  const rC = R_POL / Math.sqrt(1 - E2 * Math.cos(phiC) ** 2)
  const sx = H - rC * Math.cos(phiC) * Math.cos(lambda)
  const sy = -rC * Math.cos(phiC) * Math.sin(lambda)
  const sz = rC * Math.sin(phiC)
  return { x: Math.asin(-sy / Math.hypot(sx, sy, sz)), y: Math.atan(sz / sx) }
}

/** A point's position in the image, in cells: whole numbers at cell centers. */
export function gridPosition(grid: GoesGrid, lat: number, lon: number) {
  const { x, y } = fixedGrid(lat, lon, grid.satelliteLon)
  return cellAt(grid, x, y)
}

/** The same from the point's scan angles, which are the same in every product of a satellite. */
function cellAt(grid: GoesGrid, x: number, y: number) {
  return {
    fi: ((x - grid.xBounds[0]) / (grid.xBounds[1] - grid.xBounds[0])) * grid.nx - 0.5,
    fj: ((y - grid.yBounds[0]) / (grid.yBounds[1] - grid.yBounds[0])) * grid.ny - 0.5,
  }
}

/**
 * The part of `grid` covering `box` (with a cell to spare), and `values`
 * (row-major over the whole grid) cut down to it; null if they don't overlap.
 */
export function cropGrid(grid: GoesGrid, values: ArrayLike<number>, box: Box): { grid: GoesGrid; values: Uint16Array } | null {
  // The grid isn't aligned with latitude and longitude, so trace the box's edges.
  let i0 = Infinity
  let i1 = -Infinity
  let j0 = Infinity
  let j1 = -Infinity
  const steps = 16
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const lat = box.south + (box.north - box.south) * t
    const lon = box.west + (box.east - box.west) * t
    for (const [la, lo] of [[lat, box.west], [lat, box.east], [box.south, lon], [box.north, lon]]) {
      const { fi, fj } = gridPosition(grid, la, lo)
      i0 = Math.min(i0, fi)
      i1 = Math.max(i1, fi)
      j0 = Math.min(j0, fj)
      j1 = Math.max(j1, fj)
    }
  }
  const left = Math.max(0, Math.floor(i0) - 1)
  const right = Math.min(grid.nx - 1, Math.ceil(i1) + 1)
  const top = Math.max(0, Math.floor(j0) - 1)
  const bottom = Math.min(grid.ny - 1, Math.ceil(j1) + 1)
  if (right < left || bottom < top) return null
  const nx = right - left + 1
  const ny = bottom - top + 1
  const out = new Uint16Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) out[j * nx + i] = values[(top + j) * grid.nx + left + i]
  }
  const dx = (grid.xBounds[1] - grid.xBounds[0]) / grid.nx
  const dy = (grid.yBounds[1] - grid.yBounds[0]) / grid.ny
  return {
    grid: {
      satelliteLon: grid.satelliteLon,
      nx,
      ny,
      xBounds: [grid.xBounds[0] + left * dx, grid.xBounds[0] + (right + 1) * dx],
      yBounds: [grid.yBounds[0] + top * dy, grid.yBounds[0] + (bottom + 1) * dy],
    },
    values: out,
  }
}

/**
 * `values` at a point (its scan angles `x` and `y`, from fixedGrid), blended
 * between the four nearest cells after `decode` turns each into a number (null
 * for missing ones, which are left out of the blend); null off the grid or
 * where all four are missing.
 */
export function sampleGrid(grid: GoesGrid, values: ArrayLike<number>, x: number, y: number, decode: (v: number) => number | null): number | null {
  const { fi, fj } = cellAt(grid, x, y)
  const i = Math.floor(fi)
  const j = Math.floor(fj)
  if (i < 0 || j < 0 || i + 1 >= grid.nx || j + 1 >= grid.ny) return null
  const tx = fi - i
  const ty = fj - j
  let sum = 0
  let weights = 0
  // Written out: this runs for every pixel of every cloud sheet.
  const at = j * grid.nx + i
  for (let k = 0; k < 4; k++) {
    const v = decode(values[at + (k & 1) + (k >> 1) * grid.nx])
    if (v === null) continue
    const w = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty)
    sum += v * w
    weights += w
  }
  return weights > 0 ? sum / weights : null
}
