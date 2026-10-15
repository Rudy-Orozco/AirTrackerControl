import { useEffect, useState, type CSSProperties } from 'react'
import { BOARD, MAP, MAP3D } from '../../../config/config'
import { FlapText } from '../../board/FlapText/FlapText'
import { markIntroShown } from '../../../state/introShown'
import './Intro.css'

/** How long the intro stays up before fading, and how long the fade takes. */
const HOLD_MS = 5000
const FADE_MS = 800
/** When the name starts flipping in. */
const FLIP_START_MS = 300

/** The services and data the app is built on. */
const CREDITS = [
  'adsb.lol',
  'adsb.fi',
  'adsb.im',
  'aviationweather.gov',
  'atis.info',
  'NOAA NCEP',
  'Mapzen / AWS',
  '© OpenStreetMap contributors',
  'FAA CIFP',
]

/**
 * The opening titles in the flight information's monospace: the product's name
 * flipping in on split-flap tiles as on the board, who made it and the
 * credits. A click or key skips it. onExit fires as it starts to fade, so the
 * app underneath can start up.
 */
export function Intro({ name, onExit }: { name: string; onExit: () => void }) {
  const [hiding, setHiding] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    markIntroShown()
    const id = setTimeout(() => setHiding(true), HOLD_MS)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!hiding) return
    onExit()
    const id = setTimeout(() => setGone(true), FADE_MS)
    return () => clearTimeout(id)
  }, [hiding, onExit])

  useEffect(() => {
    if (hiding) return
    const skip = () => setHiding(true)
    window.addEventListener('keydown', skip)
    return () => window.removeEventListener('keydown', skip)
  }, [hiding])

  if (gone) return null

  return (
    <div className={`intro${hiding ? ' is-hiding' : ''}`} style={introStyle()} onClick={() => setHiding(true)} role="presentation">
      <div className="intro-center">
        <div className="intro-tag">
          <span>Live air traffic</span>
        </div>
        <h1 className="intro-title" aria-label={name}>
          {words(name).map(({ word, at }, i) => (
            <FlapText key={i} text={word} length={word.length} delay={FLIP_START_MS + at * BOARD.flip.charStaggerMs} />
          ))}
        </h1>
        <div className="intro-rule" aria-hidden />
        <p className="intro-author">
          <span className="intro-prompt">&gt;</span> by <b>Rudy Orozco</b>
        </p>
      </div>

      <p className="intro-credits">
        <span className="intro-credits-label">Data</span> {CREDITS.join(' / ')}
      </p>
      <i className="intro-progress" style={{ animationDuration: `${HOLD_MS}ms` }} aria-hidden />
    </div>
  )
}

/** The name's words, each with where it starts in the name, so the cascade runs on across the gaps. */
function words(name: string) {
  let at = 0
  return name.split(' ').map((word) => {
    const w = { word, at }
    at += word.length + 1
    return w
  })
}

/** The arrival and departure colors of whichever map is showing, and the chosen monospace (the app sets it once it's up). */
function introStyle() {
  const { traffic } = MAP.view === '3d' ? MAP3D : MAP
  return { '--arrival': traffic.arrival.color, '--departure': traffic.departure.color, '--mono': MAP.fontFamily } as CSSProperties
}
