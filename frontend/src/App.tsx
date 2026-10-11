import { useEffect, useRef, useState } from 'react'
import { AirportDiorama } from './diorama/AirportDiorama'
import { AirTraffic3D } from './map3d/AirTraffic3D'
import { Minimap } from './map3d/Minimap'
import { minimapShown } from './map3d/tower'
import { AirTrafficCanvas } from './map/AirTrafficCanvas'
import { AircraftPanel } from './ui/AircraftPanel'
import { AirportLogo } from './ui/AirportLogo'
import { AirportStats } from './ui/AirportStats'
import { Board } from './board/Board'
import { BootScreen } from './ui/BootScreen'
import { AIRPORT, DIORAMA, MAP, STATS } from './config/config'
import { fetchAirportLayout } from './diorama/diorama'
import { GroundTracker } from './tracking/groundTracker'
import { useSettingsVersion } from './config/settings'
import { SettingsPanel } from './ui/SettingsPanel'
import { Tracker } from './tracking/tracker'
import { useAircraftFeed } from './feed/useAircraftFeed'

export default function App() {
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
      <div className="corner-stack">
        {STATS.enabled && <AirportStats stats={stats} tracker={tracker} />}
        <AircraftPanel tracker={tracker} ground={ground} board={board} />
      </div>
      <BootScreen boot={boot} />
      <SettingsPanel />
    </main>
  )
}
