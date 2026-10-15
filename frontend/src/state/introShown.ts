import { sessionStore } from '../services/storage'

/** Where the intro notes it's been shown: kept across reloads, cleared when the window closes. */
const SHOWN_KEY = 'intro-shown'

/** Whether the intro is still to play in this window (once per launch, not on a reload). */
export function introPending() {
  return sessionStore.getText(SHOWN_KEY) === null
}

export function markIntroShown() {
  // Without storage it plays on every load.
  sessionStore.setText(SHOWN_KEY, '1')
}
