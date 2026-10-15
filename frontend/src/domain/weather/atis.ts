/** One D-ATIS broadcast. Busy airports have separate arrival and departure ATIS; others one combined. */
export interface Atis {
  type: 'arr' | 'dep' | 'combined'
  /** The information letter, e.g. "Y" (pilots report "with information Yankee"). */
  code: string
  /** Full broadcast text. */
  datis: string
}

/** Shorter pieces (e.g. "NOTICE TO AIRMEN") are joined to the sentence that follows. */
const MIN_SENTENCE_CHARS = 24

/** Splits the operational text into sentences to show one at a time. */
export function atisSentences(text: string): string[] {
  const sentences: string[] = []
  let pending = ''
  for (const part of atisBody(text).split(/\.{3}\s*|\.\s+/)) {
    const sentence = part
      .replace(/\.+$/, '')
      // Tidy the source's stray spacing and doubled commas ("C10 , , TWY").
      .replace(/(\s*,)+/g, ',')
      .replace(/\s+/g, ' ')
      .trim()
    if (!sentence) continue
    pending = pending ? `${pending}. ${sentence}` : sentence
    if (pending.length >= MIN_SENTENCE_CHARS) {
      sentences.push(pending)
      pending = ''
    }
  }
  if (pending) sentences.push(pending)
  return sentences
}

/**
 * The operational part of the broadcast: runways, approaches, closures and
 * notices. Drops the opening weather report (the METAR line already shows it)
 * and the closing "advise you have info X".
 */
function atisBody(text: string) {
  return (
    text
      // Header and weather run through the sentence containing the altimeter (A3000).
      .replace(/^.*?\bA\d{4}\b[^.]*\.\s*/, '')
      .replace(/\.*\s*\.\.\.\s*ADVS? YOU HAVE.*$/i, '')
      .trim()
  )
}
