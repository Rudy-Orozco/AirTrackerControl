/**
 * What the desktop app (Electron) adds to the page through electron/preload.cjs.
 * Undefined in a normal browser.
 */
export interface DesktopBridge {
  /** +1 zooms in a step, -1 out, 0 back to 100%. Resolves to the new zoom factor. */
  zoom(direction: number): Promise<number>
  zoomFactor(): Promise<number>
  /** Calls back with the zoom factor whenever it changes; returns a function to stop. */
  onZoom(callback: (factor: number) => void): () => void
  /** Shuts the app down. */
  quit(): Promise<void>
  /** Where updating has got to. */
  updateStatus(): Promise<UpdateStatus>
  /** Looks for a new release now (it downloads and installs by itself); resolves to the status after. */
  checkForUpdates(): Promise<UpdateStatus>
  /** Calls back with the status whenever it changes; returns a function to stop. */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void
}

/** Where the desktop app's updating has got to (electron/main.mjs). */
export interface UpdateStatus {
  /** unavailable: not the installed copy (development, the zip or a local build), so it doesn't update itself. */
  state: 'unavailable' | 'idle' | 'checking' | 'latest' | 'downloading' | 'installing' | 'error'
  /** The version running. */
  version: string
  /** The app file running, to tell an installed copy from another. */
  exe?: string
  /** Where the installed copy is, when this isn't it (Windows). */
  installedAt?: string | null
  /** The version being downloaded or installed. */
  next?: string
  percent?: number
  message?: string
}

export const desktop: DesktopBridge | undefined = (window as Window & { desktop?: DesktopBridge }).desktop
