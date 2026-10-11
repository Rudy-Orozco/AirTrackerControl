import type { LatLon } from '../tracking/tracker'

function rad(deg: number) {
  return (deg * Math.PI) / 180
}

/**
 * Points along the great circle from `from` toward `to`, stopping after
 * `maxNm` nautical miles (or at `to`, if closer).
 */
export function greatCircle(from: LatLon, to: LatLon, maxNm: number, segments: number): LatLon[] {
  const toVec = ({ lat, lon }: LatLon) => {
    const [φ, λ] = [rad(lat), rad(lon)]
    return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)]
  }
  const a = toVec(from)
  const b = toVec(to)
  const angle = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
  if (angle < 1e-9) return [from, to]
  // Central angle covered: maxNm of arc, or the whole way.
  const reach = Math.min(angle, rad(maxNm / 60))
  const points: LatLon[] = []
  for (let i = 0; i <= segments; i++) {
    const f = (reach * i) / segments
    const [wa, wb] = [Math.sin(angle - f) / Math.sin(angle), Math.sin(f) / Math.sin(angle)]
    const [x, y, z] = [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]]
    points.push({ lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI })
  }
  return points
}

/** Great-circle distance in nautical miles. */
export function distanceNm(a: LatLon, b: LatLon) {
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * 60 * (180 / Math.PI)
}
