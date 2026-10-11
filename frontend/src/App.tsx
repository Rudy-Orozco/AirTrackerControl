import { useRef, useState } from 'react'
import { AirportDiorama } from './diorama/AirportDiorama'
import { AirTraffic3D } from './map3d/AirTraffic3D'
import { AirTrafficCanvas } from './map/AirTrafficCanvas'
import { AircraftPanel } from './ui/AircraftPanel'
import { AirportLogo } from './ui/AirportLogo'
import { Board } from './board/Board'
import { BootScreen } from './ui/BootScreen'
import { DIORAMA, MAP } from './config/config'
import { GroundTracker } from './tracking/groundTracker'
import { useSettingsVersion } from './config/settings'
import { SettingsPanel } from './ui/SettingsPanel'
import { Tracker } from './tracking/tracker'
import { useAircraftFeed } from './feed/useAircraftFeed'

export default function App() {
  const [tracker] = useState(() => new Tracker())
  const [ground] = useState(() => new GroundTracker())
  const { status, board, boot } = useAircraftFeed(tracker, ground)
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
      {DIORAMA.enabled && <AirportDiorama tracker={tracker} ground={ground} />}
      <AirportLogo />
      <Board board={board} status={status} ref={boardRef} />
      <AircraftPanel tracker={tracker} ground={ground} board={board} />
      <BootScreen boot={boot} />
      <SettingsPanel />
    </main>
  )
}
