import { File as Hdf5File } from 'jsfive'
import { cropGrid, type Box, type GoesGrid } from '../../domain/geo/goesGrid'

/**
 * Decodes a GOES NetCDF-4 file off the main thread (a CONUS cloud mask takes a
 * few hundred milliseconds, which would stall the map) and sends back only the
 * named variables, cut down to `box`. The whole file is dropped with the worker.
 */

export interface DecodeRequest {
  buffer: ArrayBuffer
  names: string[]
  box: Box
  satelliteLon: number
}

export type DecodeResult =
  | { ok: true; grid: GoesGrid; values: Uint16Array[] }
  | { ok: false; error: string }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null
  postMessage(message: DecodeResult, transfer?: Transferable[]): void
}

scope.onmessage = ({ data: { buffer, names, box, satelliteLon } }) => {
  try {
    const file = new Hdf5File(buffer, 'goes.nc')
    const [ny, nx] = file.get(names[0]).shape
    const xb = file.get('x_image_bounds').value
    const yb = file.get('y_image_bounds').value
    const full = { satelliteLon, nx, ny, xBounds: [xb[0], xb[1]] as [number, number], yBounds: [yb[0], yb[1]] as [number, number] }
    const crops = names.map((name) => cropGrid(full, file.get(name).value, box))
    if (crops.some((c) => c === null)) throw new Error('Outside the satellite image')
    const values = crops.map((c) => c!.values)
    scope.postMessage({ ok: true, grid: crops[0]!.grid, values }, values.map((v) => v.buffer))
  } catch (err) {
    scope.postMessage({ ok: false, error: String(err) })
  }
}
