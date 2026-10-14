/** Where the intro notes it's been shown: kept across reloads, cleared when the window closes. */
const SHOWN_KEY = 'intro-shown'

/** Whether the intro is still to play in this window (once per launch, not on a reload). */
export function introPending() {
  try {
    return sessionStorage.getItem(SHOWN_KEY) === null
  } catch {
    return true
  }
}

export function markIntroShown() {
  try {
    sessionStorage.setItem(SHOWN_KEY, '1')
  } catch {
    // Without storage it plays on every load.
  }
}
