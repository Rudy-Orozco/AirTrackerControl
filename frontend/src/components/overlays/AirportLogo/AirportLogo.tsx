import { useEffect, useRef, useState } from 'react'
import { AIRPORT_PRESET } from '../../../config/config'
import './AirportLogo.css'

/**
 * The airport's official logo in the top-left corner of the screen, redrawn
 * as a single-color silhouette in the app's text color, so it sits on the dark
 * map like the rest of the interface rather than as a bright sign. Logos are
 * drawn for light backgrounds, so their white (and near-white) parts are left
 * out, as the background showing through: the land on a globe, say. Nothing if
 * the airport has no logo (AIRPORT_PRESET.logo) or it fails to load.
 */
export function AirportLogo() {
  const [failed, setFailed] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!AIRPORT_PRESET.logo) return
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      if (!canvas || !img.naturalHeight) return
      // Drawn sharper than shown, so it stays crisp however it's scaled.
      const height = Math.round(canvas.clientHeight * (window.devicePixelRatio || 1) * OVERSAMPLE) || DEFAULT_HEIGHT_PX
      const width = Math.round((height * img.naturalWidth) / img.naturalHeight)
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, width, height)
      const image = ctx.getImageData(0, 0, width, height)
      const [r, g, b] = textColor()
      const px = image.data
      for (let i = 0; i < px.length; i += 4) {
        // How white it is (its darkest channel): white parts are the background showing through.
        const white = Math.min(Math.max((Math.min(px[i], px[i + 1], px[i + 2]) / 255 - WHITE_FROM) / (WHITE_FULL - WHITE_FROM), 0), 1)
        px[i + 3] *= 1 - white
        px[i] = r
        px[i + 1] = g
        px[i + 2] = b
      }
      ctx.putImageData(image, 0, 0)
    }
    img.onerror = () => setFailed(true)
    img.src = AIRPORT_PRESET.logo
  }, [])

  if (!AIRPORT_PRESET.logo || failed) return null
  return (
    <div className="airport-logo">
      <canvas ref={canvasRef} role="img" aria-label={AIRPORT_PRESET.name} />
    </div>
  )
}

/** The app's text color (index.css --text), as red, green and blue (0 to 255). */
function textColor(): [number, number, number] {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#f1f3f6'
  const hex = ctx.fillStyle.startsWith('#') ? ctx.fillStyle : '#f1f3f6'
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

/** Parts whose darkest channel is above WHITE_FROM (0 to 1) start to count as white, fully from WHITE_FULL. */
const WHITE_FROM = 0.7
const WHITE_FULL = 0.95
const OVERSAMPLE = 2
const DEFAULT_HEIGHT_PX = 104
