/**
 * The browser's storage, for what's remembered between visits. Storage can be
 * unavailable (private windows, blocked site data) or full, so nothing here
 * throws: reads come back null and writes say whether they took. Callers fall
 * back to defaults, as the app would on a first visit.
 *
 * Imports nothing from the app, so any layer (config included) can use it.
 */
export interface Store {
  /** The stored text, or null if unset or storage is unavailable. */
  getText(key: string): string | null
  /** Whether it was stored. */
  setText(key: string, value: string): boolean
  /** The stored value parsed as JSON, or null if unset, unreadable or storage is unavailable. Check its shape before use. */
  getJson(key: string): unknown
  /** Whether it was stored. */
  setJson(key: string, value: unknown): boolean
  remove(key: string): void
}

function store(area: () => Storage): Store {
  const getText = (key: string) => {
    try {
      return area().getItem(key)
    } catch {
      return null
    }
  }
  const setText = (key: string, value: string) => {
    try {
      area().setItem(key, value)
      return true
    } catch {
      return false
    }
  }
  return {
    getText,
    setText,
    getJson(key) {
      const text = getText(key)
      if (text === null) return null
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    },
    setJson: (key, value) => setText(key, JSON.stringify(value)),
    remove(key) {
      try {
        area().removeItem(key)
      } catch {
        // Storage unavailable: nothing to remove.
      }
    },
  }
}

/** Kept until cleared: settings, saved setups, where panels sit. */
export const localStore = store(() => localStorage)
/** Kept across reloads, cleared when the window closes. */
export const sessionStore = store(() => sessionStorage)
