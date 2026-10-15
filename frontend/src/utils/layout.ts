/**
 * The part of the screen not covered by the overlay (the board), which sits
 * along the bottom (portrait) or the right (landscape). Its fade-in padding
 * counts half as visible. The maps center themselves in this area.
 */
export function uncoveredArea(width: number, height: number, overlay: HTMLElement | null) {
  if (!overlay) return { width, height }
  const rect = overlay.getBoundingClientRect()
  const style = getComputedStyle(overlay)
  if (rect.left > 0) return { width: rect.left + parseFloat(style.paddingLeft) / 2, height }
  return { width, height: rect.top + parseFloat(style.paddingTop) / 2 }
}
