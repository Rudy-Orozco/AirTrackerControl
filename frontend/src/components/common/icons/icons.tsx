/** A padlock, closed or open (the shackle swings up and off to the left). */
export function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      {/* Open: the shackle swings up and off to the left. */}
      <path d={locked ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-1.9'} />
    </svg>
  )
}
