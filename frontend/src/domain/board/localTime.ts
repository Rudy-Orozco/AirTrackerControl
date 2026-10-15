import { AIRPORT_PRESET, BOARD } from '../../config/config'

/**
 * Times in the airport's own time zone (AIRPORT_PRESET.timeZone), whatever the
 * zone of the computer showing them, in the board's 12- or 24-hour style.
 */

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(key: string, options: Intl.DateTimeFormatOptions, locale?: string) {
  const id = `${key}|${locale ?? ''}|${BOARD.use24Hour}`
  let f = formatters.get(id)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: AIRPORT_PRESET.timeZone, ...options })
    formatters.set(id, f)
  }
  return f
}

function clockOptions(seconds: boolean): Intl.DateTimeFormatOptions {
  return {
    hour: BOARD.use24Hour ? '2-digit' : 'numeric',
    minute: '2-digit',
    second: seconds ? '2-digit' : undefined,
    hour12: !BOARD.use24Hour,
  }
}

/** e.g. "3:42 PM" or "15:42", optionally with seconds. */
export function formatLocalTime(ms: number, { seconds = false } = {}) {
  return (
    formatter(seconds ? 'hms' : 'hm', clockOptions(seconds))
      .format(ms)
      // Some locales separate "PM" with a narrow no-break space.
      .replace(/\s/g, ' ')
  )
}

/**
 * The zone's short name at `ms`, e.g. "EDT" or "CEST" (it changes with daylight
 * saving). US English names American zones but gives others as "GMT+2", so
 * British English is asked too, which names the European ones.
 */
export function localZoneName(ms: number) {
  const name = (locale: string) =>
    formatter('zone', { timeZoneName: 'short' }, locale)
      .formatToParts(ms)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  const us = name('en-US')
  return us.startsWith('GMT') ? name('en-GB') : us
}

/** e.g. "Sat 10 Oct". */
export function formatLocalDate(ms: number) {
  return formatter('date', { weekday: 'short', day: 'numeric', month: 'short' }, 'en-GB').format(ms)
}
