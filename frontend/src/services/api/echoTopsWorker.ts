/**
 * Decodes an MRMS echo-tops file off the main thread: gzipped GRIB2 holding
 * one PNG-packed field over the continental US (7000 × 3500 cells, 0.01°). It
 * only unpacks rows down to the bottom of `box`, keeps the cells inside it, and
 * drops the rest with the worker.
 */

export interface EchoTopsRequest {
  buffer: ArrayBuffer
  box: { west: number; south: number; east: number; north: number }
}

/**
 * The echo tops over the box: a grid of cells `step` degrees apart, the first
 * centered on `north`, `west`, row-major from the north row; feet above sea
 * level, NaN where there's no echo that strong.
 */
export interface EchoTopsGrid {
  north: number
  west: number
  step: number
  nx: number
  ny: number
  topsFt: Float32Array
}

export type EchoTopsResult = { ok: true; grid: EchoTopsGrid } | { ok: false; error: string }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<EchoTopsRequest>) => void) | null
  postMessage(message: EchoTopsResult, transfer?: Transferable[]): void
}

const FT_PER_KM = 3280.84

scope.onmessage = async ({ data: { buffer, box } }) => {
  try {
    const grib = new DataView(await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    const field = readGrib(grib)
    const grid = await unpack(field, box)
    scope.postMessage({ ok: true, grid }, [grid.topsFt.buffer])
  } catch (err) {
    scope.postMessage({ ok: false, error: String(err) })
  }
}

/** A GRIB2 field's lat/lon grid (template 3.0), its packing (5.41, PNG) and the PNG. */
function readGrib(view: DataView) {
  if (String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== 'GRIB' || view.getUint8(7) !== 2) {
    throw new Error('Not GRIB2')
  }
  // Signed GRIB2 numbers keep their sign in the top bit.
  const signed = (at: number) => {
    const v = view.getUint32(at)
    return v & 0x80000000 ? -(v & 0x7fffffff) : v
  }
  let o = 16
  let grid: { nx: number; ny: number; lat1: number; lon1: number; dLon: number; dLat: number } | null = null
  let packing: { r: number; e: number; d: number; bits: number } | null = null
  let png: Uint8Array | null = null
  while (o < view.byteLength - 4) {
    const len = view.getUint32(o)
    const section = view.getUint8(o + 4)
    if (section === 3) {
      if (view.getUint16(o + 12) !== 0) throw new Error('Not a lat/lon grid')
      let lon1 = signed(o + 50) / 1e6
      if (lon1 > 180) lon1 -= 360
      grid = { nx: view.getUint32(o + 30), ny: view.getUint32(o + 34), lat1: signed(o + 46) / 1e6, lon1, dLon: view.getUint32(o + 63) / 1e6, dLat: view.getUint32(o + 67) / 1e6 }
      // Rows run north to south and columns west to east (scanning mode 0).
      if (view.getUint8(o + 71) !== 0) throw new Error('Unexpected scanning mode')
    } else if (section === 5) {
      if (view.getUint16(o + 9) !== 41) throw new Error('Not PNG-packed')
      packing = { r: view.getFloat32(o + 11), e: view.getInt16(o + 15), d: view.getInt16(o + 17), bits: view.getUint8(o + 19) }
    } else if (section === 7) {
      png = new Uint8Array(view.buffer, view.byteOffset + o + 5, len - 5)
    }
    o += len
  }
  if (!grid || !packing || !png) throw new Error('Incomplete GRIB2')
  return { grid, packing, png }
}

/** The cells inside `box`: unpacked from the PNG row by row, only as far down as needed. */
async function unpack({ grid, packing, png }: ReturnType<typeof readGrib>, box: EchoTopsRequest['box']): Promise<EchoTopsGrid> {
  const pngView = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const idat: Uint8Array[] = []
  let width = 0
  let bitDepth = 0
  for (let p = 8; p < png.byteLength; ) {
    const len = pngView.getUint32(p)
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7])
    if (type === 'IHDR') {
      width = pngView.getUint32(p + 8)
      bitDepth = png[p + 16]
      if (png[p + 17] !== 0) throw new Error('Not a grayscale PNG')
    } else if (type === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`Unexpected PNG bit depth ${bitDepth}`)
  const bytes = bitDepth / 8
  const stride = width * bytes

  const row0 = Math.max(0, Math.floor((grid.lat1 - box.north) / grid.dLat) - 1)
  const row1 = Math.min(grid.ny - 1, Math.ceil((grid.lat1 - box.south) / grid.dLat) + 1)
  const col0 = Math.max(0, Math.floor((box.west - grid.lon1) / grid.dLon) - 1)
  const col1 = Math.min(grid.nx - 1, Math.ceil((box.east - grid.lon1) / grid.dLon) + 1)
  const nx = col1 - col0 + 1
  const ny = row1 - row0 + 1
  const topsFt = new Float32Array(nx * ny).fill(NaN)
  const scale = 2 ** packing.e
  const divide = 10 ** packing.d

  // Each row is a filter byte and `stride` bytes, filtered against the row above (PNG filters).
  const reader = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
  let pending = new Uint8Array(0)
  let previous = new Uint8Array(stride)
  let current = new Uint8Array(stride)
  let y = 0
  while (y <= row1) {
    while (pending.length < stride + 1) {
      const { value, done } = await reader.read()
      if (done) throw new Error('PNG ended early')
      const joined = new Uint8Array(pending.length + value.length)
      joined.set(pending)
      joined.set(value, pending.length)
      pending = joined
    }
    let used = 0
    while (pending.length - used >= stride + 1 && y <= row1) {
      unfilter(pending[used], pending.subarray(used + 1, used + 1 + stride), previous, current, bytes)
      used += stride + 1
      if (y >= row0) {
        for (let c = col0; c <= col1; c++) {
          const raw = bytes === 2 ? (current[c * 2] << 8) | current[c * 2 + 1] : current[c]
          const km = (packing.r + raw * scale) / divide
          // 0 is no echo that strong, below 0 missing or no radar.
          if (km > 0) topsFt[(y - row0) * nx + c - col0] = km * FT_PER_KM
        }
      }
      ;[previous, current] = [current, previous]
      y++
    }
    pending = pending.subarray(used)
  }
  await reader.cancel()
  return { north: grid.lat1 - row0 * grid.dLat, west: grid.lon1 + col0 * grid.dLon, step: grid.dLon, nx, ny, topsFt }
}

/** Undoes one PNG row's filter (None, Sub, Up, Average or Paeth) into `out`, given the row above. */
function unfilter(filter: number, line: Uint8Array, above: Uint8Array, out: Uint8Array, bytes: number) {
  for (let i = 0; i < line.length; i++) {
    const left = i >= bytes ? out[i - bytes] : 0
    const up = above[i]
    const upLeft = i >= bytes ? above[i - bytes] : 0
    let v = line[i]
    if (filter === 1) v += left
    else if (filter === 2) v += up
    else if (filter === 3) v += (left + up) >> 1
    else if (filter === 4) {
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
    }
    out[i] = v & 255
  }
}
