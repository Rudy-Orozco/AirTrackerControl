import { useEffect, useState } from 'react'

/**
 * A counter that goes up every `getMs()` milliseconds. The interval is read
 * again before each tick, so a changed setting applies from the next one.
 */
export function useTick(getMs: () => number): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>
    const schedule = () => {
      id = setTimeout(() => {
        setTick((t) => t + 1)
        schedule()
      }, getMs())
    }
    schedule()
    return () => clearTimeout(id)
    // getMs is expected to read live config, not change identity meaningfully.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return tick
}
