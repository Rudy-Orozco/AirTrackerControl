import airports from '../../airports.json'
import { localStore } from '../services/storage'

/**
 * Saved setups: the settings panel's Save button keeps everything you've set
 * up (settings, the 3D camera and orbit point, where the airport view and minimap sit)
 * for the current airport in the current layout: portrait (board along the
 * bottom) or landscape (board on the right, as on a desktop screen).
 *
 * Changes are remembered as you make them, for each airport and layout on its
 * own: turning the screen (or starting with another airport) puts away the
 * current setup and brings back where that layout was left, or else its save.
 * "Revert to saved" goes back to the save.
 *
 * Imported first in main.tsx: it swaps the stored values before the rest of
 * the app reads them.
 */

export type Layout = 'portrait' | 'landscape'

/** The same split as the stylesheets' `min-aspect-ratio: 1/1`. */
const LANDSCAPE = '(min-aspect-ratio: 1/1)'

export function currentLayout(): Layout {
  return window.matchMedia(LANDSCAPE).matches ? 'landscape' : 'portrait'
}

export const LAYOUT_LABELS: Record<Layout, string> = { portrait: 'Portrait', landscape: 'Desktop' }

/** What a save holds: these stored entries, as stored (services/storage). */
const SAVED_KEYS = ['settings', 'map3dCamera', 'map3dOrbitAnchor', 'airportDiorama', 'minimap']
/** Which airport and layout the stored values are for. */
const ACTIVE_KEY = 'activeSetup'
const SETTINGS_KEY = 'settings'

/** Sent before saving, so the 3D map stores its camera as it is right now. */
export const STORE_CAMERA_EVENT = 'map3d:storeCamera'

interface Setup {
  /** Each saved entry's text, or null if it wasn't set. */
  entries: Record<string, string | null>
  savedAt: number
}

/** The airport the app opens, chosen as config.ts does (it can't be imported here: it reads what this swaps). */
function startingAirport(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('airport')
  const saved = (localStore.getJson(SETTINGS_KEY) as { AIRPORT?: unknown } | null)?.AIRPORT
  const requested = (fromUrl ?? (typeof saved === 'string' ? saved : null) ?? import.meta.env.VITE_AIRPORT ?? 'DFW').toUpperCase()
  return requested in airports ? requested : 'DFW'
}

const setupKey = (airport: string, layout: Layout) => `setup:${airport}:${layout}`
/** Where an airport and layout was left, saved or not ("ATL:portrait", as ACTIVE_KEY holds). */
const leftKey = (active: string) => `left:${active}`

function loadSetup(airport: string, layout: Layout): Setup | null {
  return loadFrom(setupKey(airport, layout))
}

function loadFrom(key: string): Setup | null {
  const setup = localStore.getJson(key) as Setup | null
  return setup && typeof setup.entries === 'object' ? setup : null
}

/** Where `active` was left if anything changed since, else its save. */
function setupFor(active: string): Setup | null {
  const [airport, layout] = active.split(':') as [string, Layout]
  return loadFrom(leftKey(active)) ?? loadSetup(airport, layout)
}

/** Keeps the stored values as where `active` (what they're for) was left. */
function putAway(active: string) {
  // If storage is unavailable, that layout comes back as saved instead.
  localStore.setJson(leftKey(active), { entries: currentEntries(), savedAt: Date.now() } satisfies Setup)
}

function setActive(active: string) {
  localStore.setText(ACTIVE_KEY, active)
}

/** The stored entries, with the settings' airport left out: the save is already per airport. */
function currentEntries(): Record<string, string | null> {
  const entries: Record<string, string | null> = {}
  for (const key of SAVED_KEYS) entries[key] = localStore.getText(key)
  try {
    const settings = JSON.parse(entries[SETTINGS_KEY] ?? '{}')
    delete settings.AIRPORT
    entries[SETTINGS_KEY] = JSON.stringify(settings)
  } catch {
    // Unreadable settings are saved as they are.
  }
  return entries
}

/** Puts a save's entries in place, keeping the airport chosen in the settings. */
function restore(setup: Setup) {
  try {
    for (const key of SAVED_KEYS) {
      const value = setup.entries[key]
      if (key === SETTINGS_KEY) {
        const settings = JSON.parse(value ?? '{}')
        const chosen = (localStore.getJson(SETTINGS_KEY) as { AIRPORT?: unknown } | null)?.AIRPORT
        if (chosen !== undefined) settings.AIRPORT = chosen
        localStore.setJson(key, settings)
      } else if (value === null || value === undefined) localStore.remove(key)
      else localStore.setText(key, value)
    }
  } catch {
    // The save's settings are unreadable: start with what's there.
  }
}

/** The airport and layout the app opened with. */
export const AIRPORT_AT_START = startingAirport()
const layoutAtStart = currentLayout()

// On start: if the stored values were for another airport or layout, put them away
// and bring in where this one was left (or its save).
{
  const active = `${AIRPORT_AT_START}:${layoutAtStart}`
  const previous = localStore.getText(ACTIVE_KEY)
  if (previous !== active) {
    if (previous) putAway(previous)
    const setup = setupFor(active)
    if (setup) restore(setup)
  }
  setActive(active)
}

// Turned into the other layout: put this one away, and reload into where that one was
// left (or its save). With neither, carry on as things are, now for that layout.
window.matchMedia(LANDSCAPE).addEventListener('change', () => {
  const previous = localStore.getText(ACTIVE_KEY)
  const active = `${AIRPORT_AT_START}:${currentLayout()}`
  if (!previous || previous === active) return
  window.dispatchEvent(new Event(STORE_CAMERA_EVENT))
  putAway(previous)
  const setup = setupFor(active)
  if (setup) {
    restore(setup)
    setActive(active)
    window.location.reload()
  } else setActive(active)
})

/** Saves everything as it is now for this airport in the current layout. */
export function saveSetup() {
  window.dispatchEvent(new Event(STORE_CAMERA_EVENT))
  const setup: Setup = { entries: currentEntries(), savedAt: Date.now() }
  const stored =
    localStore.setJson(setupKey(AIRPORT_AT_START, currentLayout()), setup) &&
    localStore.setText(ACTIVE_KEY, `${AIRPORT_AT_START}:${currentLayout()}`)
  if (!stored) console.warn('Could not save the setup: storage is unavailable or full')
}

/** When this airport's setup for the current layout was saved, or null if it hasn't been. */
export function savedAt(): number | null {
  return loadSetup(AIRPORT_AT_START, currentLayout())?.savedAt ?? null
}

/** Whether anything differs from this layout's save (true if there is none). */
export function hasUnsavedChanges(): boolean {
  const setup = loadSetup(AIRPORT_AT_START, currentLayout())
  if (!setup) return true
  const now = currentEntries()
  return SAVED_KEYS.some((key) => (now[key] ?? null) !== (setup.entries[key] ?? null))
}

/** Back to this layout's save, discarding changes since (reloads the page). */
export function revertToSaved() {
  const setup = loadSetup(AIRPORT_AT_START, currentLayout())
  if (!setup) return
  restore(setup)
  // Where it was left is now the save, too.
  localStore.remove(leftKey(`${AIRPORT_AT_START}:${currentLayout()}`))
  window.location.reload()
}
