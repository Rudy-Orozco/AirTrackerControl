import { useCallback, useEffect, useRef, useState } from 'react'
import { AirportDiorama } from '../components/diorama/AirportDiorama/AirportDiorama'
import { AirTraffic3D } from '../components/map3d/AirTraffic3D/AirTraffic3D'
import { Minimap } from '../components/map3d/Minimap/Minimap'
import { minimapShown } from '../rendering/map3d/tower'
import { AirTrafficCanvas } from '../components/map/AirTrafficCanvas/AirTrafficCanvas'
import { AircraftPanel } from '../components/panels/AircraftPanel/AircraftPanel'
import { AirportLogo } from '../components/overlays/AirportLogo/AirportLogo'
import { AirportStats } from '../components/panels/AirportStats/AirportStats'
import { UpdateNotice } from '../components/overlays/UpdateNotice/UpdateNotice'
import { Board } from '../components/board/Board/Board'
import { BootScreen } from '../components/overlays/BootScreen/BootScreen'
import { FeedLost } from '../components/overlays/FeedLost/FeedLost'
import { Intro } from '../components/overlays/Intro/Intro'
import { introPending } from '../state/introShown'
import { AIRPORT, DIORAMA, MAP, METAR, STATS } from '../config/config'
import { fetchAirportLayout } from '../services/api/basemap'
import { GroundTracker } from '../domain/tracking/groundTracker'
import { useSettingsVersion } from '../state/settings'
import { SettingsPanel } from '../components/panels/SettingsPanel/SettingsPanel'
import { Tracker } from '../domain/tracking/tracker'
import { MetarStrip } from '../components/weather/MetarStrip/MetarStrip'
import { ErrorBoundary } from '../components/common/ErrorBoundary/ErrorBoundary'
import { useAircraftFeed } from '../hooks/useAircraftFeed'

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
