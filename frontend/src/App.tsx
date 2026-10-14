import { useCallback, useEffect, useRef, useState } from 'react'
import { AirportDiorama } from './diorama/AirportDiorama'
import { AirTraffic3D } from './map3d/AirTraffic3D'
import { Minimap } from './map3d/Minimap'
import { minimapShown } from './map3d/tower'
import { AirTrafficCanvas } from './map/AirTrafficCanvas'
import { AircraftPanel } from './ui/AircraftPanel'
import { AirportLogo } from './ui/AirportLogo'
import { AirportStats } from './ui/AirportStats'
import { UpdateNotice } from './ui/UpdateNotice'
import { Board } from './board/Board'
import { BootScreen } from './ui/BootScreen'
import { FeedLost } from './ui/FeedLost'
import { Intro } from './ui/Intro'
import { introPending } from './ui/introShown'
import { AIRPORT, DIORAMA, MAP, METAR, STATS } from './config/config'
import { fetchAirportLayout } from './diorama/diorama'
import { GroundTracker } from './tracking/groundTracker'
import { useSettingsVersion } from './config/settings'
import { SettingsPanel } from './ui/SettingsPanel'
import { Tracker } from './tracking/tracker'
import { MetarStrip } from './weather/MetarStrip'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { useAircraftFeed } from './feed/useAircraftFeed'

/** The product's name, for now. */
const PRODUCT_NAME = 'Air Tracker Control'

// This is testing

export default function App() {
  const [intro] = useState(introPending)
  // Nothing loads (no aircraft feed, weather, radar or maps) until the intro's done.
  const [started, setStarted] = useState(!intro)
  const start = useCallback(() => setStarted(true), [])

  return (
    <>
      {started && <Dashboard />}
      {intro && <Intro name={PRODUCT_NAME} onExit={start} />}
    </>
  )
}

/** The maps, board and panels, with the aircraft feed behind them. */
function Dashboard() {
  const [tracker] = useState(() => new Tracker())
  const [ground] = useState(() => new GroundTracker())
  const { status, board, stats, boot } = useAircraftFeed(tracker, ground)
  // The airport's layout keeps ground traffic on its taxiways and lines approaches and
  // climb-outs up with its runways, whichever view is showing.
  useEffect(() => {
    const controller = new AbortController()
    fetchAirportLayout(AIRPORT, controller.signal)
      .then((layout) => {
        tracker.setLayout(layout)
        ground.setLayout(layout)
      })
      .catch((err) => {
        if (!controller.signal.aborted) console.warn('Airport layout unavailable:', err)
      })
    return () => controller.abort()
  }, [tracker, ground])
  const boardRef = useRef<HTMLElement>(null)
  // Re-render on settings changes so the board and the 3D view toggle pick them up.
  useSettingsVersion()
  // The font setting reaches the stylesheet's flight information (the map labels read it directly).
  useEffect(() => {
    document.documentElement.style.setProperty('--mono', MAP.fontFamily)
  })

  return (
    <main className="app">
      {MAP.view === '3d' ? (
        <AirTraffic3D tracker={tracker} ground={ground} overlay={boardRef} />
      ) : (
        <AirTrafficCanvas tracker={tracker} ground={ground} overlay={boardRef} />
      )}
      {minimapShown() && <Minimap tracker={tracker} ground={ground} />}
      {DIORAMA.enabled && <AirportDiorama tracker={tracker} ground={ground} />}
      <AirportLogo />
      <Board board={board} status={status} ref={boardRef} />
      <FeedLost status={status} board={boardRef} />
      {METAR.position === 'corner' && (
        <ErrorBoundary name="Weather (METAR)">
          <MetarStrip layout="column" />
        </ErrorBoundary>
      )}
      <div className="corner-stack">
        {STATS.enabled && <AirportStats stats={stats} tracker={tracker} airborne={status.count} />}
        <AircraftPanel tracker={tracker} ground={ground} board={board} />
      </div>
      <BootScreen boot={boot} board={boardRef} />
      <div className="product-name">{PRODUCT_NAME}</div>
      <SettingsPanel />
      <UpdateNotice />
    </main>
  )
}
