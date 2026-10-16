/** The parts of jsfive (a pure-JS HDF5 reader) the app uses, for reading GOES NetCDF-4 files. */
declare module 'jsfive' {
  export class Dataset {
    readonly shape: number[]
    readonly value: ArrayLike<number>
  }
  export class File {
    constructor(buffer: ArrayBuffer, filename?: string)
    get(path: string): Dataset
  }
}
