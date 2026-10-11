import airports from '../../airports.json'

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

/** What a save holds: these localStorage entries, as stored. */
const SAVED_KEYS = ['settings', 'map3dCamera', 'map3dOrbitAnchor', 'airportDiorama', 'minimap']
/** Which airport and layout the stored values are for. */
const ACTIVE_KEY = 'activeSetup'
const SETTINGS_KEY = 'settings'

/** Sent before saving, so the 3D map stores its camera as it is right now. */
export const STORE_CAMERA_EVENT = 'map3d:storeCamera'

interface Setup {
  /** Each saved localStorage entry's text, or null if it wasn't set. */
  entries: Record<string, string | null>
  savedAt: number
}

/** The airport the app opens, chosen as config.ts does (it can't be imported here: it reads what this swaps). */
function startingAirport(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('airport')
  let saved: unknown
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')?.AIRPORT
  } catch {
    saved = null
  }
  const requested = (fromUrl ?? (typeof saved === 'string' ? saved : null) ?? import.meta.env.VITE_AIRPORT ?? 'DFW').toUpperCase()
  return requested in airports ? requested : 'DFW'
}

const setupKey = (airport: string, layout: Layout) => `setup:${airport}:${layout}`
/** Where an airport and layout was left, saved or not ("ATL:portrait", as ACTIVE_KEY holds). */
const leftKey = (active: string) => `left:${active}`

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function loadSetup(airport: string, layout: Layout): Setup | null {
  return loadFrom(setupKey(airport, layout))
}

function loadFrom(key: string): Setup | null {
  try {
    const setup = JSON.parse(read(key) ?? 'null') as Setup | null
    return setup && typeof setup.entries === 'object' ? setup : null
  } catch {
    return null
  }
}

/** Where `active` was left if anything changed since, else its save. */
function setupFor(active: string): Setup | null {
  const [airport, layout] = active.split(':') as [string, Layout]
  return loadFrom(leftKey(active)) ?? loadSetup(airport, layout)
}

/** Keeps the stored values as where `active` (what they're for) was left. */
function putAway(active: string) {
  try {
    localStorage.setItem(leftKey(active), JSON.stringify({ entries: currentEntries(), savedAt: Date.now() } satisfies Setup))
  } catch {
    // Storage unavailable: that layout comes back as saved instead.
  }
}

function setActive(active: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, active)
  } catch {
    // Storage unavailable.
  }
}

/** The stored entries, with the settings' airport left out: the save is already per airport. */
function currentEntries(): Record<string, string | null> {
  const entries: Record<string, string | null> = {}
  for (const key of SAVED_KEYS) entries[key] = read(key)
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
        const chosen = JSON.parse(read(SETTINGS_KEY) ?? '{}')?.AIRPORT
        if (chosen !== undefined) settings.AIRPORT = chosen
        localStorage.setItem(key, JSON.stringify(settings))
      } else if (value === null || value === undefined) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    }
  } catch {
    // Storage unavailable: start with what's there.
  }
}

/** The airport and layout the app opened with. */
export const AIRPORT_AT_START = startingAirport()
const layoutAtStart = currentLayout()

// On start: if the stored values were for another airport or layout, put them away
// and bring in where this one was left (or its save).
{
  const active = `${AIRPORT_AT_START}:${layoutAtStart}`
  const previous = read(ACTIVE_KEY)
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
  const previous = read(ACTIVE_KEY)
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
  try {
    localStorage.setItem(setupKey(AIRPORT_AT_START, currentLayout()), JSON.stringify(setup))
    localStorage.setItem(ACTIVE_KEY, `${AIRPORT_AT_START}:${currentLayout()}`)
  } catch (err) {
    console.warn('Could not save the setup:', err)
  }
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
  try {
    localStorage.removeItem(leftKey(`${AIRPORT_AT_START}:${currentLayout()}`))
  } catch {
    // Storage unavailable.
  }
  window.location.reload()
}
