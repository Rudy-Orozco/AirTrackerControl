import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { DIORAMA, MAP, MAP3D, PROCEDURES } from '../config/config'
import { desktop, type UpdateStatus } from '../lib/desktop'
import { AIRPORT_AT_START, currentLayout, hasUnsavedChanges, LAYOUT_LABELS, revertToSaved, savedAt, saveSetup } from '../config/profiles'
import { cancelPicking, clearAnchor, toggleAnchor, useOrbitAnchor } from '../map3d/orbitAnchor'
import { leaveStreetView, toggleStreetView, useStreetView } from '../map3d/streetView'
import { minimapShown, TOWER_SPOT } from '../map3d/tower'
import type { FlightKind } from '../tracking/flights'
import {
  getSetting,
  KIND_LABELS,
  KINDS,
  needsReload,
  ORBIT_SETTING,
  resetDioramaPlacement,
  resetMinimapPlacement,
  resetSettings,
  setSetting,
  SETTING_TABS,
  TERRAIN_SETTING,
  TOWER_SETTING,
  VIEW_SETTING,
  useSettingsVersion,
  type Setting,
  type SettingGroup,
} from '../config/settings'
import { useProcedures } from '../procedures/procedures'
import { ProceduresPanel } from './ProceduresPanel'
import './SettingsPanel.css'

/**
 * Gear button in the top-right corner that opens a panel for changing the
 * settings in config.ts while the app runs. Changes apply immediately (a few,
 * like the airport, after a reload) and are remembered in this browser.
 */
export function SettingsPanel() {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<'camera' | 'more' | null>(null)
  const [proceduresOpen, setProceduresOpen] = useState(false)
  const [tab, setTab] = useState(loadTab)
  const [kind, setKind] = useState(loadKind)
  const fullScreen = useFullScreen()
  useSettingsVersion()
  // What's loaded shows in the Procedures section, and changes on import.
  useProcedures()
  const activeTab = SETTING_TABS[tab] ?? SETTING_TABS[0]

  const chooseTab = (index: number) => {
    setTab(index)
    try {
      localStorage.setItem(TAB_KEY, String(index))
    } catch {
      // Not remembered; harmless.
    }
  }

  const chooseKind = (k: FlightKind) => {
    setKind(k)
    try {
      localStorage.setItem(KIND_KEY, k)
    } catch {
      // Not remembered; harmless.
    }
  }

  useEffect(() => {
    if (!open && !menu && !proceduresOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      setMenu(null)
      setProceduresOpen(false)
    }
    // A menu closes when anything else is pressed.
    const onPointer = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.('.toolbar-menu')) setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [open, menu, proceduresOpen])

  const is3d = MAP.view === '3d'
  const terrain = MAP.terrain
  const orbit = MAP3D.orbit
  const tower = is3d && MAP3D.tower && TOWER_SPOT !== null
  const minimap = minimapShown()
  const { anchor, picking } = useOrbitAnchor()
  const street = useStreetView()
  const toolbar = useToolbarReveal(open || proceduresOpen || menu !== null || picking !== false || street.state !== 'off')
  return (
    <>
      <div className={`toolbar${toolbar.shown ? ' is-shown' : ''}`} onPointerDownCapture={toolbar.onPointerDown}>
      {PROCEDURES.enabled && (
        <button
          type="button"
          className={`toolbar-button procedures-button${proceduresOpen ? ' is-on' : ''}`}
          aria-label="Procedures"
          aria-pressed={proceduresOpen}
          title="Procedures (STARs, SIDs, approaches): pick which to show on the map, and read them"
          onClick={() => {
            setProceduresOpen((o) => !o)
            setOpen(false)
            setMenu(null)
          }}
        >
          <RouteIcon />
        </button>
      )}
      {/* The 3D camera's ways of moving and standing, in one menu; its button shows the one in use. */}
      {is3d && (
        <ToolbarMenu
          label="Camera"
          title="Camera: orbit, tower view, street view"
          icon={tower ? <TowerIcon /> : street.state !== 'off' ? <PersonIcon /> : orbit ? <OrbitIcon /> : <CameraIcon />}
          open={menu === 'camera'}
          onToggle={() => setMenu(menu === 'camera' ? null : 'camera')}
          active={orbit || tower || street.state !== 'off'}
          picking={picking !== false || street.state === 'placing'}
        >
          <MenuItem
            icon={<OrbitIcon />}
            label={orbit ? 'Stop orbiting' : tower || street.state !== 'off' ? 'Turn the view slowly' : 'Orbit'}
            hint="Direction and speed in Settings › 3D Map"
            on={orbit}
            onClick={() => {
              // The orbit point goes with the orbit (the camera stays put, free to pan again).
              if (orbit) clearAnchor()
              setSetting(ORBIT_SETTING, !orbit)
            }}
          />
          {/* No orbit point to place while standing still: the view turns in place. */}
          {orbit && !tower && street.state === 'off' && (
            <MenuItem
              icon={<AxisIcon />}
              label={picking ? 'Cancel placing the orbit point' : anchor ? 'Move the orbit point' : 'Place the orbit point'}
              hint="Click the map for an axis, then again for a height up it (Esc to cancel)"
              on={picking !== false}
              picking={picking !== false}
              onClick={toggleAnchor}
            />
          )}
          {TOWER_SPOT && (
            <MenuItem
              icon={<TowerIcon />}
              label={tower ? 'Leave tower view' : 'Tower view'}
              hint="From the control tower cab, with the minimap in the board (Esc to leave)"
              on={tower}
              onClick={() => {
                cancelPicking()
                leaveStreetView()
                setSetting(TOWER_SETTING, !tower)
              }}
            />
          )}
          {/* Offered while the camera is near the airport. */}
          {(street.available || street.state !== 'off') && (
            <MenuItem
              icon={<PersonIcon />}
              label={street.state === 'off' ? 'Street view' : street.state === 'placing' ? 'Cancel street view' : 'Leave street view'}
              hint={street.state === 'placing' ? 'Click a spot on the ground at the airport (Esc to cancel)' : 'Stand at the airport, 6 ft up'}
              on={street.state !== 'off'}
              picking={street.state === 'placing'}
              onClick={() => {
                cancelPicking()
                // Down from the tower to pick a spot in the street.
                if (tower) setSetting(TOWER_SETTING, false)
                toggleStreetView()
              }}
            />
          )}
        </ToolbarMenu>
      )}
      <ToolbarMenu
        label="More"
        title="Terrain, full screen, and more"
        icon={<MoreIcon />}
        open={menu === 'more'}
        onToggle={() => setMenu(menu === 'more' ? null : 'more')}
        active={false}
        picking={false}
      >
        <MenuItem icon={<MountainIcon />} label="Terrain" hint="Hill shading in 2D, relief in 3D" on={terrain} onClick={() => setSetting(TERRAIN_SETTING, !terrain)} />
        {document.fullscreenEnabled && (
          <MenuItem icon={<FullScreenIcon exit={fullScreen} />} label={fullScreen ? 'Exit full screen' : 'Full screen'} on={fullScreen} onClick={toggleFullScreen} />
        )}
        {(DIORAMA.enabled || minimap) && (
          <MenuItem
            icon={<PlaceIcon />}
            label="Bring back panels"
            hint={DIORAMA.enabled && minimap ? 'The 3D airport view (keeping its angle) and the minimap' : DIORAMA.enabled ? 'The 3D airport view, keeping its angle' : 'The minimap'}
            onClick={() => {
              if (DIORAMA.enabled) resetDioramaPlacement({ keepAngle: true })
              if (minimap) resetMinimapPlacement()
            }}
          />
        )}
        {desktop && (
          <div className="toolbar-item toolbar-zoom">
            <span>Page zoom</span>
            <ZoomControl />
          </div>
        )}
      </ToolbarMenu>
      <button
        type="button"
        className={`toolbar-button view-button${is3d ? ' is-3d' : ''}`}
        aria-label={is3d ? 'Switch to 2D map' : 'Switch to 3D map'}
        title={is3d ? 'Switch to the flat 2D map' : 'Switch to the 3D map'}
        onClick={() => setSetting(VIEW_SETTING, is3d ? '2d' : '3d')}
      >
        {is3d ? '2D' : '3D'}
      </button>
      <button
        type="button"
        className={`toolbar-button settings-button${open ? ' is-open' : ''}`}
        aria-label="Settings"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o)
          setProceduresOpen(false)
          setMenu(null)
        }}
      >
        <GearIcon />
      </button>
      </div>
      {proceduresOpen && PROCEDURES.enabled && <ProceduresPanel onClose={() => setProceduresOpen(false)} />}
      {open && (
        <aside className="settings-panel" aria-label="Settings">
          <header className="settings-header">
            <h2>Settings</h2>
            <button type="button" className="settings-close" aria-label="Close settings" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
            {SETTING_TABS.map((t, i) => (
              <button
                key={t.title}
                type="button"
                role="tab"
                aria-selected={t === activeTab}
                className={`settings-tab${t === activeTab ? ' is-active' : ''}`}
                onClick={() => chooseTab(i)}
              >
                {t.title}
              </button>
            ))}
          </nav>
          <div className="settings-body" role="tabpanel" aria-label={activeTab.title}>
            {activeTab.groups.some((g) => g.perKind) && (
              <KindSwitch kind={kind} onChange={chooseKind} colorOf={(k) => kindColor(activeTab.groups, k)} />
            )}
            {activeTab.groups.map((group) => {
              const kindSettings = group.perKind?.(kind) ?? []
              if (group.settings.length === 0 && kindSettings.length === 0) return null
              return (
              <section key={group.title} className="settings-group">
                <h3>{group.title}</h3>
                {group.note && <p className="settings-note-line">{group.note()}</p>}
                {group.settings.map((s) => (
                  <SettingRow key={s.path} setting={s} />
                ))}
                {kindSettings.length > 0 && (
                  <h4 className="settings-kind-heading">
                    <span className="settings-kind-dot" style={{ background: kindColor(activeTab.groups, kind) ?? undefined }} />
                    {KIND_LABELS[kind]}
                  </h4>
                )}
                {kindSettings.map((s) => (
                  <SettingRow key={s.path} setting={s} />
                ))}
                {group.action && (
                  <button type="button" className="settings-action" onClick={group.action.run}>
                    {group.action.label}
                  </button>
                )}
                {group.actions && (
                  <div className="settings-actions">
                    {group.actions.map((a) => (
                      <button key={a.label} type="button" className="settings-action" title={a.title} onClick={a.run}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </section>
              )
            })}
            {/* Desktop app only: a web page is always the latest. */}
            {desktop && activeTab.title === 'General' && <UpdatesGroup />}
          </div>
          <footer className="settings-footer">
            <SaveRow />
            <div className="settings-footer-actions">
            {/* Highlighted when a changed setting only applies after a reload. */}
            {needsReload() ? (
              <button type="button" className="settings-action is-primary" onClick={() => window.location.reload()}>
                Reload to apply
              </button>
            ) : (
              <button type="button" className="settings-action" onClick={() => window.location.reload()}>
                Reload page
              </button>
            )}
            <button type="button" className="settings-action" onClick={resetSettings}>
              Reset all to defaults
            </button>
            {/* Desktop app only: a web page can't close the browser. */}
            {desktop && (
              <button type="button" className="settings-action" title="Quit the app" onClick={() => desktop!.quit()}>
                Shut down
              </button>
            )}
            </div>
          </footer>
        </aside>
      )}
    </>
  )
}

/**
 * A toolbar button that opens a short menu under it. `active` marks the button
 * while something in it is on; `picking`, while it waits for a click on the map.
 */
function ToolbarMenu({
  label,
  title,
  icon,
  open,
  onToggle,
  active,
  picking,
  children,
}: {
  label: string
  title: string
  icon: ReactNode
  open: boolean
  onToggle: () => void
  active: boolean
  picking: boolean
  children: ReactNode
}) {
  return (
    <div className="toolbar-menu">
      <button
        type="button"
        className={`toolbar-button${active ? ' is-on' : ''}${picking ? ' is-picking' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={onToggle}
      >
        {icon}
      </button>
      {open && (
        <div
          className="toolbar-popover"
          role="menu"
          aria-label={label}
          // Picking something closes the menu (out of the way of a click on the map, say); the page zoom stays open to step through.
          onClick={(e) => {
            const target = e.target as Element
            if (target.closest('.toolbar-item') && !target.closest('.toolbar-zoom')) onToggle()
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** One choice in a toolbar menu: an icon, a label and a line of help; `on` while it's on. */
function MenuItem({
  icon,
  label,
  hint,
  on = false,
  picking = false,
  onClick,
}: {
  icon: ReactNode
  label: string
  hint?: string
  on?: boolean
  picking?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      className={`toolbar-item${on ? ' is-on' : ''}${picking ? ' is-picking' : ''}`}
      onClick={onClick}
    >
      <span className="toolbar-item-icon">{icon}</span>
      <span className="toolbar-item-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </button>
  )
}

/**
 * Saves the whole setup for this airport in the layout on screen (portrait or
 * desktop), and can go back to that save. Highlighted when there are changes
 * since it was saved.
 */
function SaveRow() {
  const [, rerender] = useState(0)
  const layout = currentLayout()
  // Turning the screen switches which save this is about.
  useEffect(() => {
    const media = window.matchMedia('(min-aspect-ratio: 1/1)')
    const update = () => rerender((n) => n + 1)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const saved = savedAt()
  const unsaved = hasUnsavedChanges()
  const where = `${AIRPORT_AT_START} · ${LAYOUT_LABELS[layout]}`
  return (
    <div className="settings-save">
      <span className="settings-save-status">
        {where}
        <small>{saved === null ? 'Not saved yet' : unsaved ? 'Changed since saved' : `Saved ${new Date(saved).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`}</small>
      </span>
      {saved !== null && unsaved && (
        <button type="button" className="settings-action" title="Discard changes since the save (reloads)" onClick={revertToSaved}>
          Revert
        </button>
      )}
      <button
        type="button"
        className={`settings-action${unsaved ? ' is-primary' : ''}`}
        title={`Save the settings, 3D camera and airport view for ${AIRPORT_AT_START} in ${LAYOUT_LABELS[layout].toLowerCase()} layout`}
        onClick={() => {
          saveSetup()
          rerender((n) => n + 1)
        }}
      >
        Save
      </button>
    </div>
  )
}

/**
 * − 100% + : page zoom, like Ctrl+scroll (desktop app only; a web page can't
 * change the browser's zoom). Clicking the percentage goes back to 100%.
 */
function ZoomControl() {
  const [factor, setFactor] = useState(1)
  useEffect(() => {
    desktop!.zoomFactor().then(setFactor, () => {})
    return desktop!.onZoom(setFactor)
  }, [])
  const zoom = (direction: number) => desktop!.zoom(direction).then(setFactor, () => {})
  const percent = `${Math.round(factor * 100)}%`
  return (
    <div className="zoom-control" role="group" aria-label="Page zoom">
      <button type="button" aria-label="Zoom out" title="Zoom out (Ctrl+minus, Ctrl+scroll)" onClick={() => zoom(-1)}>
        −
      </button>
      <button type="button" className="zoom-reset" aria-label={`Zoom ${percent}, reset to 100%`} title="Reset to 100% (Ctrl+0)" onClick={() => zoom(0)}>
        {percent}
      </button>
      <button type="button" aria-label="Zoom in" title="Zoom in (Ctrl+plus, Ctrl+scroll)" onClick={() => zoom(1)}>
        +
      </button>
    </div>
  )
}

/** How long the toolbar stays after a tap, once nothing in it is touched. */
const TOOLBAR_TOUCH_MS = 5000
/** Shown at first, so it's clear there's something in the corner. */
const TOOLBAR_INTRO_MS = 4000

/**
 * The toolbar stays out of sight until the pointer is over its corner (CSS) or
 * it's tapped: then it shows until it's left alone for a few seconds. `keep`
 * holds it up (settings open, placing the orbit point). A tap on the hidden
 * toolbar only reveals it, rather than pressing whatever is under the finger.
 */
function useToolbarReveal(keep: boolean) {
  const [revealed, setRevealed] = useState(true)
  const timer = useRef(0)
  const hideAfter = (ms: number) => {
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setRevealed(false), ms)
  }
  useEffect(() => {
    hideAfter(TOOLBAR_INTRO_MS)
    return () => clearTimeout(timer.current)
  }, [])
  const shown = keep || revealed
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return
    if (!shown) {
      e.preventDefault()
      e.stopPropagation()
    }
    setRevealed(true)
    hideAfter(TOOLBAR_TOUCH_MS)
  }
  return { shown, onPointerDown }
}

/** Whether the page is full screen, kept up to date (Esc can leave it too). */
function useFullScreen() {
  const [on, setOn] = useState(() => document.fullscreenElement !== null)
  useEffect(() => {
    const update = () => setOn(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])
  return on
}

function toggleFullScreen() {
  const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()
  request.catch((err) => console.warn('Full screen unavailable:', err))
}

/** The last tab opened, remembered in this browser. */
const TAB_KEY = 'settingsTab'

function loadTab(): number {
  try {
    const saved = Number(localStorage.getItem(TAB_KEY))
    return Number.isInteger(saved) && saved >= 0 && saved < SETTING_TABS.length ? saved : 0
  } catch {
    return 0
  }
}

/** Arrivals / Departures / Other switch at the top of a tab, picking the kind its groups show settings for. */
function KindSwitch({ kind, onChange, colorOf }: { kind: FlightKind; onChange: (kind: FlightKind) => void; colorOf: (kind: FlightKind) => string | null }) {
  return (
    <div className="settings-kinds" role="radiogroup" aria-label="Traffic">
      {KINDS.map((k) => {
        const color = colorOf(k)
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={k === kind}
            className={`settings-kind${k === kind ? ' is-active' : ''}`}
            onClick={() => onChange(k)}
          >
            {color && <span className="settings-kind-dot" style={{ background: color }} />}
            {KIND_LABELS[k]}
          </button>
        )
      })}
    </div>
  )
}

/** The kind's color setting in this tab, for the dots on the switch. */
function kindColor(groups: SettingGroup[], kind: FlightKind): string | null {
  for (const g of groups) {
    const color = g.perKind?.(kind).find((s) => s.type === 'color')
    if (color) return String(getSetting(color))
  }
  return null
}

/** The traffic kind last picked, remembered in this browser. */
const KIND_KEY = 'settingsKind'

function loadKind(): FlightKind {
  try {
    const saved = localStorage.getItem(KIND_KEY)
    return KINDS.find((k) => k === saved) ?? 'arrival'
  } catch {
    return 'arrival'
  }
}

/** One setting with its control (also used in the procedures panel's Waypoints tab). */
export function SettingRow({ setting }: { setting: Setting }) {
  const id = useId()
  const value = getSetting(setting)
  return (
    <div className="settings-row">
      <label htmlFor={id}>
        {setting.label}
        {setting.reload && <span className="settings-note"> · reload</span>}
        {setting.hint && <small>{setting.hint}</small>}
      </label>
      <Control id={id} setting={setting} value={value} />
    </div>
  )
}

function Control({ id, setting, value }: { id: string; setting: Setting; value: unknown }) {
  switch (setting.type) {
    case 'toggle':
      return (
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="settings-switch"
          checked={Boolean(value)}
          onChange={(e) => setSetting(setting, e.target.checked)}
        />
      )
    case 'color':
      return <input id={id} type="color" value={String(value)} onChange={(e) => setSetting(setting, e.target.value)} />
    case 'select': {
      const option = (o: { value: string; label: string }) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      )
      // Options with a group go under its heading, in the order the groups first appear.
      const groups = new Map<string, typeof setting.options>()
      for (const o of setting.options) groups.set(o.group ?? '', [...(groups.get(o.group ?? '') ?? []), o])
      return (
        <select id={id} value={String(value)} onChange={(e) => setSetting(setting, e.target.value)}>
          {[...groups].map(([group, options]) =>
            group ? (
              <optgroup key={group} label={group}>
                {options.map(option)}
              </optgroup>
            ) : (
              options.map(option)
            ),
          )}
        </select>
      )
    }
    case 'range': {
      const scale = setting.scale ?? 1
      const shown = Number(value) / scale
      return (
        <span className="settings-range">
          <input
            id={id}
            type="range"
            min={setting.min / scale}
            max={setting.max / scale}
            step={setting.step / scale}
            value={shown}
            onChange={(e) => setSetting(setting, Math.round(Number(e.target.value) * scale * 1000) / 1000)}
          />
          <NumberField setting={setting} shown={shown} />
          {setting.unit && <span className="settings-unit">{setting.unit}</span>}
        </span>
      )
    }
  }
}

/**
 * The slider's value, which can also be typed in. Applied on Enter or when
 * leaving the field, kept between the slider's ends; Esc puts it back.
 */
function NumberField({ setting, shown }: { setting: Extract<Setting, { type: 'range' }>; shown: number }) {
  const scale = setting.scale ?? 1
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const typed = Number(draft)
    setDraft(null)
    if (draft.trim() === '' || !Number.isFinite(typed)) return
    const value = Math.min(setting.max, Math.max(setting.min, typed * scale))
    setSetting(setting, Math.round(value * 1000) / 1000)
  }
  return (
    <input
      type="number"
      className="settings-number"
      aria-label={`${setting.label}${setting.unit ? ` (${setting.unit})` : ''}`}
      min={setting.min / scale}
      max={setting.max / scale}
      step={setting.step / scale}
      value={draft ?? formatNumber(shown)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          e.stopPropagation()
          setDraft(null)
        }
      }}
    />
  )
}

function formatNumber(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '')
}

/** A screen with the airport view's spot in its top-right corner, and an arrow into it. */
function PlaceIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="13" y="7" width="5" height="5" rx="1" />
      <path d="M6 17l5-5M11 12H7.5M11 12v3.5" />
    </svg>
  )
}

/** Corner brackets pointing out (enter) or in (exit). */
function FullScreenIcon({ exit }: { exit: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path
        d={
          exit
            ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5'
            : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'
        }
      />
    </svg>
  )
}

/** A vertical axis standing on a ring on the ground. */
function AxisIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3v15" strokeDasharray="2.5 2.5" />
      <ellipse cx="12" cy="18" rx="7" ry="2.5" />
      <circle cx="12" cy="18" r="1" fill="currentColor" />
    </svg>
  )
}

/** A control tower: a cab with slanted windows on a tall shaft. */
function TowerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2v2M7 4h10l-1.5 5h-7z" />
      <path d="M8.5 9h7M10 9l-.5 11M14 9l.5 11M7 20h10" />
    </svg>
  )
}

/** A person standing on the ground. */
function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2" />
      <path d="M12 8v6M8.5 10.5L12 9l3.5 1.5M12 14l-2.5 5M12 14l2.5 5M5 20h14" />
    </svg>
  )
}

/** A route through waypoints: a line bending through three points. */
function RouteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19l6-7 5 3 5-10" />
      <path d="M10 9.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5L6.5 13 9 12z" fill="currentColor" stroke="none" />
      <circle cx="4" cy="19" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="20" cy="5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** A camera body with its lens. */
function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h4l2-3h6l2 3h4v11H3z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  )
}

/** Three dots. */
function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  )
}

/**
 * The version running and where updating has got to, with a button to look for
 * a new release now. One found downloads, installs and restarts the app by
 * itself (electron/main.mjs).
 */
function UpdatesGroup() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    desktop!.updateStatus().then(setStatus, () => {})
    return desktop!.onUpdateStatus(setStatus)
  }, [])

  const busy = status?.state === 'checking' || status?.state === 'downloading' || status?.state === 'installing'
  return (
    <section className="settings-group">
      <h3>Updates</h3>
      <p className="settings-note-line">{status ? updateText(status) : 'Loading…'}</p>
      {/* Changes with every release, to see an update has landed. */}
      <p className="settings-note-line">
        Build {__BUILD__.commit} · {new Date(__BUILD__.time).toLocaleString()}
      </p>
      {status?.state !== 'unavailable' && (
        <button type="button" className="settings-action" disabled={busy} onClick={() => desktop!.checkForUpdates().then(setStatus, () => {})}>
          {status?.state === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      )}
    </section>
  )
}

function updateText(s: UpdateStatus) {
  const running = `Version ${s.version}`
  switch (s.state) {
    case 'unavailable':
      return `${running}. Only the installed app updates itself (not this copy).`
    case 'checking':
      return `${running}. Checking for a new version…`
    case 'latest':
      return `${running}, the latest.`
    case 'downloading':
      return `${running}. Downloading ${s.next ?? 'the new version'}: ${s.percent ?? 0}%`
    case 'installing':
      return `Installing ${s.next ?? 'the new version'}; the app restarts in a moment.`
    case 'error':
      return `${running}. Couldn't check for updates: ${s.message ?? 'unknown error'}`
    default:
      return `${running}. Checks for updates every hour.`
  }
}

/** A dot with an arrow circling it. */
function OrbitIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <path d="M19.5 9.5A8 8 0 1 0 20 13" />
      <path d="M21.5 6.5l-2 3-3-1.5" />
    </svg>
  )
}

function MountainIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 19 9 8l4 6 3-4 6 9z" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
