import type { AirportPreset } from './config'

/**
 * How busy an airport usually is at a given time, from the hours hardcoded in
 * its preset (AirportPreset.traffic), not from live traffic.
 */
export type TrafficLevel = 'busy' | 'slow' | 'dead'

/** Shown before each airport in the settings panel's picker (a native select can't draw colored dots). */
export const TRAFFIC_ICONS: Record<TrafficLevel, string> = { busy: '🟢', slow: '🟡', dead: '🔴' }

/** The hour (0-23) in `timeZone` at `ms`. */
function localHour(timeZone: string, ms: number) {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(ms)
    .find((p) => p.type === 'hour')?.value
  return Number(hour) % 24
}

/** Whether `hour` is in [from, to), which wraps past midnight when from > to. */
function inRange(hour: number, [from, to]: number[]) {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to
}

export function trafficLevel(preset: AirportPreset, ms = Date.now()): TrafficLevel {
  const hour = localHour(preset.timeZone, ms)
  if (preset.traffic.busy.some((r) => inRange(hour, r))) return 'busy'
  if (preset.traffic.dead.some((r) => inRange(hour, r))) return 'dead'
  return 'slow'
}
