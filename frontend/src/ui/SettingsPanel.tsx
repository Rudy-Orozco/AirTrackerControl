import { useEffect, useId, useState } from 'react'
import { DIORAMA, MAP, MAP3D } from '../config/config'
import { desktop } from '../lib/desktop'
import { AIRPORT_AT_START, currentLayout, hasUnsavedChanges, LAYOUT_LABELS, revertToSaved, savedAt, saveSetup } from '../config/profiles'
import { clearAnchor, toggleAnchor, useOrbitAnchor } from '../map3d/orbitAnchor'
import type { FlightKind } from '../tracking/flights'
import {
  getSetting,
  KIND_LABELS,
  KINDS,
  needsReload,
  ORBIT_SETTING,
  resetDioramaPlacement,
  resetSettings,
  setSetting,
  SETTING_TABS,
  TERRAIN_SETTING,
  VIEW_SETTING,
  useSettingsVersion,
  type Setting,
  type SettingGroup,
} from '../config/settings'
import './SettingsPanel.css'

/**
 * Gear button in the top-right corner that opens a panel for changing the
 * settings in config.ts while the app runs. Changes apply immediately (a few,
 * like the airport, after a reload) and are remembered in this browser.
 */
export function SettingsPanel() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState(loadTab)
  const [kind, setKind] = useState(loadKind)
  const fullScreen = useFullScreen()
  useSettingsVersion()
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
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const is3d = MAP.view === '3d'
  const terrain = MAP.terrain
  const orbit = MAP3D.orbit
  const { anchor, picking } = useOrbitAnchor()
  // Buttons the 3D map adds to the left of the others, which the zoom control moves over for.
  const extraButtons = is3d ? (orbit ? 2 : 1) : 0
  return (
    <>
      {desktop && <ZoomControl shift={extraButtons} />}
      {is3d && orbit && (
        <button
          type="button"
          className={`toolbar-button axis-button${picking ? ' is-on is-picking' : ''}`}
          aria-label={picking ? 'Cancel placing the orbit point' : anchor ? 'Move the orbit point' : 'Place the orbit point'}
          aria-pressed={picking !== false}
          title={
            picking === 'axis'
              ? 'Click a spot on the map to stand the axis there (Esc to cancel)'
              : picking === 'height'
                ? 'Click to set how high up the axis to orbit around (Esc to cancel)'
                : anchor
                  ? 'Move the orbit point: click the map for an axis, then click again for a height up it'
                  : 'Place the orbit point: click the map for an axis, then click again for a height up it'
          }
          onClick={toggleAnchor}
        >
          <AxisIcon />
        </button>
      )}
      {is3d && (
        <button
          type="button"
          className={`toolbar-button orbit-button${orbit ? ' is-on' : ''}`}
          aria-label={orbit ? 'Stop orbiting' : 'Orbit'}
          aria-pressed={orbit}
          title={orbit ? 'Stop orbiting' : 'Orbit around the point the camera looks at (direction and speed in Settings › 3D Map)'}
          onClick={() => {
            // The orbit point goes with the orbit (the camera stays put, free to pan again).
            if (orbit) clearAnchor()
            setSetting(ORBIT_SETTING, !orbit)
          }}
        >
          <OrbitIcon />
        </button>
      )}
      {DIORAMA.enabled && (
        <button
          type="button"
          className="toolbar-button place-button"
          aria-label="Bring back the airport view"
          title="Bring the 3D airport view back to its corner (keeps its angle)"
          onClick={() => resetDioramaPlacement({ keepAngle: true })}
        >
          <PlaceIcon />
        </button>
      )}
      {document.fullscreenEnabled && (
        <button
          type="button"
          className={`toolbar-button fullscreen-button${fullScreen ? ' is-on' : ''}`}
          aria-label={fullScreen ? 'Exit full screen' : 'Full screen'}
          aria-pressed={fullScreen}
          title={fullScreen ? 'Exit full screen (Esc)' : 'Full screen'}
          onClick={toggleFullScreen}
        >
          <FullScreenIcon exit={fullScreen} />
        </button>
      )}
      <button
        type="button"
        className={`toolbar-button terrain-button${terrain ? ' is-on' : ''}`}
        aria-label={terrain ? 'Hide terrain' : 'Show terrain'}
        aria-pressed={terrain}
        title={terrain ? 'Hide terrain' : 'Show terrain'}
        onClick={() => setSetting(TERRAIN_SETTING, !terrain)}
      >
        <MountainIcon />
      </button>
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
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>
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
              </section>
              )
            })}
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
            </div>
          </footer>
        </aside>
      )}
    </>
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
function ZoomControl({ shift }: { shift: number }) {
  const [factor, setFactor] = useState(1)
  useEffect(() => {
    desktop!.zoomFactor().then(setFactor, () => {})
    return desktop!.onZoom(setFactor)
  }, [])
  const zoom = (direction: number) => desktop!.zoom(direction).then(setFactor, () => {})
  const percent = `${Math.round(factor * 100)}%`
  return (
    <div className="zoom-control" style={{ right: 222 + shift * 42 }} role="group" aria-label="Page zoom">
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

function SettingRow({ setting }: { setting: Setting }) {
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
    case 'select':
      return (
        <select id={id} value={String(value)} onChange={(e) => setSetting(setting, e.target.value)}>
          {setting.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
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
