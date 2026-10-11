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
}

export const desktop: DesktopBridge | undefined = (window as Window & { desktop?: DesktopBridge }).desktop
