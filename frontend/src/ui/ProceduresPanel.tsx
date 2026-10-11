import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { PROCEDURES } from '../config/config'
import { IDENTIFY_SETTING, PREDICT_SETTING, setSetting, useSettingsVersion, WAYPOINT_SETTINGS } from '../config/settings'
import { SettingRow } from './SettingsPanel'
import { useTick } from '../lib/useTick'
import { identifying, procedureMatcher } from '../procedures/matcher'
import { procedureColor } from '../map/procedureLayer'
import {
  fixOf,
  isPicked,
  isSwitchedOn,
  isWaypointPicked,
  setWaypointsPicked,
  waypointInfo,
  PROCEDURE_KINDS,
  setPicked,
  setSwitchedOn,
  togglePicked,
  useProcedures,
  type Leg,
  type Procedure,
  type ProcedureKind,
} from '../procedures/procedures'
import './ProceduresPanel.css'

/**
 * The STARs, SIDs and approaches, for study: switch each on or off (off, it's left out of
 * matching, predicting and drawing), pick which to show on the maps, and open one
 * to read it (its transitions, its route and its runway transitions, with the
 * altitude to cross each waypoint at). Each says how many flights are on it
 * now. Opened by the toolbar's procedures button, when PROCEDURES.enabled.
 *
 * Drag its title bar to move it (double-click it to put it back); where it
 * sits is remembered in this browser.
 */
export function ProceduresPanel({ onClose }: { onClose: () => void }) {
  const { data, origin } = useProcedures()
  const [tab, setTab] = useState<ProcedureKind | 'waypoints'>('star')
  // On the Waypoints tab, the procedure lists aren't in use.
  const kind: ProcedureKind = tab === 'waypoints' ? 'star' : tab
  const [filter, setFilter] = useState('')
  const [flyingOnly, setFlyingOnly] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  /** Runways opened or folded (approaches tab); those not in it are open while being landed on. */
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const identify = identifying()
  // Known only while identifying flights.
  const landing = identify ? procedureMatcher.runwaysInUse().landing : []
  // The counts of flights on each change as flights move.
  useTick(() => 3000)
  useSettingsVersion()
  const [place, setPlace] = useState(loadPlace)

  /** Moves the panel with the pointer, keeping its title bar on screen. */
  const startDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return
    const panel = e.currentTarget.parentElement!
    const start = panel.getBoundingClientRect()
    const [x0, y0] = [e.clientX, e.clientY]
    const header = e.currentTarget
    header.setPointerCapture(e.pointerId)
    let latest: Place = { left: start.left, top: start.top }
    const move = (ev: PointerEvent) => {
      latest = {
        left: clamp(start.left + ev.clientX - x0, KEEP_ON_SCREEN - start.width, window.innerWidth - KEEP_ON_SCREEN),
        top: clamp(start.top + ev.clientY - y0, 0, window.innerHeight - header.offsetHeight),
      }
      setPlace(latest)
    }
    const up = () => {
      header.removeEventListener('pointermove', move)
      header.removeEventListener('pointerup', up)
      header.removeEventListener('pointercancel', up)
      storePlace(latest)
    }
    header.addEventListener('pointermove', move)
    header.addEventListener('pointerup', up)
    header.addEventListener('pointercancel', up)
  }

  const all = data ? data[LIST_OF[kind]] : []
  const query = filter.trim().toUpperCase()
  const list = all.filter((p) => (!query || p.name.includes(query) || legsOf(p).some((l) => fixOf(l).includes(query))) && (!identify || !flyingOnly || procedureMatcher.countOn(p) > 0))
  const color = procedureColor(kind)

  return (
    <aside
      className="settings-panel procedures-panel"
      aria-label="Procedures"
      style={placed(place)}
    >
      <header
        className="settings-header procedures-header"
        title="Drag to move · double-click to put it back"
        onPointerDown={startDrag}
        onDoubleClick={() => {
          setPlace(null)
          storePlace(null)
        }}
      >
        <h2>Procedures</h2>
        <button type="button" className="settings-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <nav className="settings-tabs" role="tablist" aria-label="STARs, SIDs or approaches">
        {PROCEDURE_KINDS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={k === tab} className={`settings-tab${k === tab ? ' is-active' : ''}`} onClick={() => setTab(k)}>
            {TAB_LABELS[k]} ({data?.[LIST_OF[k]].length ?? 0})
          </button>
        ))}
        <button type="button" role="tab" aria-selected={tab === 'waypoints'} className={`settings-tab${tab === 'waypoints' ? ' is-active' : ''}`} onClick={() => setTab('waypoints')}>
          Waypoints ({data ? waypointInfo().length : 0})
        </button>
      </nav>
      <div className="settings-body">
        {!data ? (
          <p className="procedures-empty">
            None loaded for this airport. Import a JSON file in Settings › General › Procedures (the format is in README.md).
          </p>
        ) : tab === 'waypoints' ? (
          <WaypointsTab />
        ) : (
          <>
            <div className="procedures-tools">
              <input
                type="search"
                className="procedures-filter"
                placeholder="Find a procedure or waypoint"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {identify && (
                <label className="procedures-flying">
                  <input type="checkbox" checked={flyingOnly} onChange={(e) => setFlyingOnly(e.target.checked)} />
                  Flying now
                </label>
              )}
            </div>
            <label className="procedures-predict" title={IDENTIFY_SETTING.hint}>
              <input type="checkbox" role="switch" className="settings-switch" checked={PROCEDURES.identify} onChange={(e) => setSetting(IDENTIFY_SETTING, e.target.checked)} />
              <span>
                Identify flights
                <small>
                  {identify ? "Works out each flight's procedure: click one to see it" : 'Off: just for study, nothing running'}
                </small>
              </span>
            </label>
            {identify && (
            <label className="procedures-predict" title={PREDICT_SETTING.hint}>
              <input type="checkbox" role="switch" className="settings-switch" checked={PROCEDURES.predict} onChange={(e) => setSetting(PREDICT_SETTING, e.target.checked)} />
              <span>
                Predicted path
                <small>
                  {PROCEDURES.predict
                    ? "A followed flight's likeliest procedure and branch, before its path shows them"
                    : 'Only once its path shows a procedure, with every branch it may take'}
                </small>
              </span>
            </label>
            )}
            <div className="procedures-bulk">
              <span>
                {list.filter((p) => isSwitchedOn(kind, p.name)).length} of {list.length} on
              </span>
              <button type="button" className="settings-action" title="Switch them all on" onClick={() => setSwitchedOn(kind, list.map((p) => p.name), true)}>
                All on
              </button>
              <button type="button" className="settings-action" title="Switch them all off" onClick={() => setSwitchedOn(kind, list.map((p) => p.name), false)}>
                All off
              </button>
            </div>
            <div className="procedures-bulk">
              <span>
                {list.filter((p) => isSwitchedOn(kind, p.name) && isPicked(kind, p.name)).length} shown on the map
              </span>
              <button type="button" className="settings-action" title="Show them all on the map" onClick={() => setPicked(kind, list.map((p) => p.name), true)}>
                Show all
              </button>
              <button type="button" className="settings-action" title="Hide them all from the map" onClick={() => setPicked(kind, list.map((p) => p.name), false)}>
                Hide all
              </button>
            </div>
            {/* The runways being landed on: a click shows (or hides) their approaches on the map. */}
            {kind === 'approach' && landing.length > 0 && (
              <div className="procedures-landing">
                <span>Landing now</span>
                {landing.map((runway) => {
                  const group = all.filter((p) => p.runway === runway && isSwitchedOn(kind, p.name))
                  const shown = group.length > 0 && group.every((p) => isPicked(kind, p.name))
                  return (
                    <button
                      key={runway}
                      type="button"
                      className={`procedure-chip${shown ? ' is-on' : ''}`}
                      aria-pressed={shown}
                      disabled={group.length === 0}
                      title={group.length === 0 ? 'No approaches on for it' : shown ? `Hide ${runway}'s approaches` : `Show ${runway}'s approaches on the map`}
                      onClick={() => setPicked(kind, group.map((p) => p.name), !shown)}
                      style={{ '--procedure': color } as CSSProperties}
                    >
                      {runway}
                    </button>
                  )
                })}
              </div>
            )}
            <ul className="procedures-list" style={{ '--procedure': color } as CSSProperties}>
              {(() => {
                  const row = (p: Procedure) => {
                const flying = identify ? procedureMatcher.countOn(p) : 0
                const expanded = open === `${kind}:${p.name}`
                const on = isSwitchedOn(kind, p.name)
                const shown = on && isPicked(kind, p.name)
                return (
                  <li key={p.name} className={`procedure${expanded ? ' is-open' : ''}${on ? '' : ' is-off'}`}>
                    <div className="procedure-row">
                      <button
                        type="button"
                        className={`procedure-show${shown ? ' is-on' : ''}`}
                        aria-pressed={shown}
                        aria-label={shown ? `Hide ${p.name} from the map` : `Show ${p.name} on the map`}
                        title={!on ? 'Switched off' : shown ? 'Shown on the map: click to hide' : 'Show on the map'}
                        disabled={!on}
                        onClick={() => togglePicked(kind, p.name)}
                      >
                        <EyeIcon open={shown} />
                      </button>
                      <span className="procedure-name">{p.name}</span>
                      {on && flying > 0 && (
                        <span className="procedure-flying" title={`${flying} flight${flying > 1 ? 's' : ''} on it now`}>
                          ● {flying}
                        </span>
                      )}
                      <span className="procedure-runways">{kind === 'approach' ? '' : (p.runways?.join(' ') ?? '')}</span>
                      <input
                        type="checkbox"
                        role="switch"
                        className="settings-switch procedure-switch"
                        aria-label={`${p.name} ${on ? 'on' : 'off'}`}
                        title={on ? 'On: matched, predicted and drawn. Switch off to leave it out' : 'Off: left out of matching, predicting and drawing'}
                        checked={on}
                        onChange={() => setSwitchedOn(kind, [p.name], !on)}
                      />
                      <button
                        type="button"
                        className="procedure-expand"
                        aria-expanded={expanded}
                        aria-label={expanded ? `Close ${p.name}` : `Open ${p.name}`}
                        onClick={() => setOpen(expanded ? null : `${kind}:${p.name}`)}
                      >
                        ›
                      </button>
                    </div>
                    {expanded && <ProcedureDetail procedure={p} kind={kind} />}
                  </li>
                )
                  }
                  // Approaches by runway, each with a heading to show or switch them all, and to fold away.
                  // The runways being landed on come first, open; the rest folded until opened.
                  if (kind !== 'approach') return list.map(row)
                  return groupByRunway(list, landing).map(([runway, group]) => {
                    const names = group.map((p) => p.name)
                    const allOn = group.every((p) => isSwitchedOn(kind, p.name))
                    const allShown = group.every((p) => isSwitchedOn(kind, p.name) && isPicked(kind, p.name))
                    const inUse = landing.includes(runway)
                    // Searching, every runway's open, so what matches shows.
                    const unfolded = query ? true : (folds[runway] ?? inUse)
                    return (
                      <li key={runway} className={`procedure-group${unfolded ? ' is-open' : ''}`}>
                        <div className="procedure-group-row">
                          <button
                            type="button"
                            className="procedure-expand procedure-fold"
                            aria-expanded={unfolded}
                            aria-label={unfolded ? `Fold runway ${runway}` : `Open runway ${runway}`}
                            onClick={() => setFolds((f) => ({ ...f, [runway]: !unfolded }))}
                          >
                            ›
                          </button>
                          <button
                            type="button"
                            className={`procedure-show${allShown ? ' is-on' : ''}`}
                            aria-pressed={allShown}
                            aria-label={allShown ? `Hide runway ${runway}'s approaches` : `Show runway ${runway}'s approaches`}
                            title={allShown ? 'Hide them all from the map' : 'Show them all on the map'}
                            onClick={() => setPicked(kind, names, !allShown)}
                          >
                            <EyeIcon open={allShown} />
                          </button>
                          <h4>{runway === 'Other' ? 'Other' : `RWY ${runway}`}</h4>
                          {inUse && <span className="procedure-in-use">Landing</span>}
                          <span className="procedure-group-count">{group.length}</span>
                          <input
                            type="checkbox"
                            role="switch"
                            className="settings-switch procedure-switch"
                            aria-label={`Runway ${runway}'s approaches ${allOn ? 'on' : 'off'}`}
                            title={allOn ? 'Switch them all off' : 'Switch them all on'}
                            checked={allOn}
                            onChange={() => setSwitchedOn(kind, names, !allOn)}
                          />
                        </div>
                        {unfolded && <ul className="procedures-list">{group.map(row)}</ul>}
                      </li>
                    )
                  })
                })()}
            </ul>
            {list.length === 0 && <p className="procedures-empty">None match.</p>}
          </>
        )}
      </div>
      <footer className="procedures-footer">
        {data && (
          <span>
            {origin === 'imported' ? 'Imported' : 'Built in'}
            {data.source ? ` · ${data.source}` : ''}
          </span>
        )}
        {identify && <span>Click a flight to see its procedure: flown, ahead and its possible branches.</span>}
      </footer>
    </aside>
  )
}

/**
 * Waypoints on their own: how they're shown (all, or those with their eye on;
 * names, altitude on the 3D map, drop line and dot, size, opacity, color), and
 * the list of them, each with its charted altitude and the procedures using it.
 */
function WaypointsTab() {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toUpperCase()
  const list = waypointInfo().filter((w) => !query || w.name.includes(query) || w.usedBy.some((p) => p.toUpperCase().includes(query)))
  const names = list.map((w) => w.name)
  return (
    <>
      <section className="settings-group waypoint-settings">
        {WAYPOINT_SETTINGS.map((s) => (
          <SettingRow key={s.path} setting={s} />
        ))}
      </section>
      <div className="procedures-tools">
        <input type="search" className="procedures-filter" placeholder="Find a waypoint, or a procedure using it" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="procedures-bulk">
        <span>
          {PROCEDURES.showWaypoints ? `All ${list.length} shown` : `${list.filter((w) => isWaypointPicked(w.name)).length} of ${list.length} shown`}
        </span>
        <button type="button" className="settings-action" disabled={PROCEDURES.showWaypoints} onClick={() => setWaypointsPicked(names, true)}>
          Show all
        </button>
        <button type="button" className="settings-action" disabled={PROCEDURES.showWaypoints} onClick={() => setWaypointsPicked(names, false)}>
          Hide all
        </button>
      </div>
      <ul className="procedures-list" style={{ '--procedure': PROCEDURES.waypointColor } as CSSProperties}>
        {list.map((w) => {
          const shown = PROCEDURES.showWaypoints || isWaypointPicked(w.name)
          return (
            <li key={w.name} className="procedure">
              <div className="procedure-row">
                <button
                  type="button"
                  className={`procedure-show${shown ? ' is-on' : ''}`}
                  aria-pressed={shown}
                  aria-label={shown ? `Hide ${w.name}` : `Show ${w.name}`}
                  title={PROCEDURES.showWaypoints ? 'All are shown (Show all is on)' : shown ? 'Shown on the map: click to hide' : 'Show on the map'}
                  disabled={PROCEDURES.showWaypoints}
                  onClick={() => setWaypointsPicked([w.name], !shown)}
                >
                  <EyeIcon open={shown} />
                </button>
                <span className="procedure-name">{w.name}</span>
                {w.alt && <span className="waypoint-alt">{w.alt}</span>}
                <span className="procedure-runways" title={w.usedBy.join(', ')}>
                  {w.usedBy.length === 1 ? w.usedBy[0] : `${w.usedBy.length} procedures`}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      {list.length === 0 && <p className="procedures-empty">None match.</p>}
    </>
  )
}

/** Approaches by runway: the runways in `first` (being landed on) at the top in their order, then the rest as listed. */
function groupByRunway(list: Procedure[], first: string[]): [string, Procedure[]][] {
  const byRunway = new Map<string, Procedure[]>()
  for (const p of list) byRunway.set(p.runway ?? 'Other', [...(byRunway.get(p.runway ?? 'Other') ?? []), p])
  const rank = (runway: string) => (first.includes(runway) ? first.indexOf(runway) : first.length)
  return [...byRunway].sort((a, b) => rank(a[0]) - rank(b[0]))
}

/** Each tab's name, and the list it shows. */
const TAB_LABELS: Record<ProcedureKind, string> = { star: 'STARs', sid: 'SIDs', approach: 'Approaches' }
const LIST_OF = { star: 'stars', sid: 'sids', approach: 'approaches' } as const

/** Where the panel sits (pixels from the window's top-left), or null for its corner. */
type Place = { left: number; top: number } | null

const PLACE_KEY = 'proceduresPanel'
/** At least this much of it (pixels) stays on screen, to grab again. */
const KEEP_ON_SCREEN = 80

function loadPlace(): Place {
  try {
    const saved = JSON.parse(localStorage.getItem(PLACE_KEY) ?? 'null')
    return saved && Number.isFinite(saved.left) && Number.isFinite(saved.top) ? { left: saved.left, top: saved.top } : null
  } catch {
    return null
  }
}

function storePlace(place: Place) {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(place))
  } catch {
    // Not remembered; it opens in its corner next time.
  }
}

/** Its position, kept on screen (the window may have shrunk since), and no taller than the room below it. */
function placed(place: Place): CSSProperties | undefined {
  if (!place) return undefined
  const top = clamp(place.top, 0, window.innerHeight - KEEP_ON_SCREEN)
  return { left: clamp(place.left, KEEP_ON_SCREEN - 420, window.innerWidth - KEEP_ON_SCREEN), top, right: 'auto', maxHeight: window.innerHeight - top - 12 }
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max)
}

/** A procedure's parts, in the order flown, each a line of waypoints with their altitudes. */
function ProcedureDetail({ procedure, kind }: { procedure: Procedure; kind: ProcedureKind }) {
  const transitions = Object.entries(procedure.transitions ?? {})
  const runways = Object.entries(procedure.runwayTransitions ?? {})
  const route: [string, Leg[]][] = procedure.route.length ? [['', procedure.route]] : []
  const parts: [string, [string, Leg[]][]][] =
    kind === 'approach'
      ? [
          ['Transitions', transitions],
          ['Final approach', route],
          ['Missed approach', procedure.missedApproach?.length ? [['', procedure.missedApproach]] : []],
        ]
      : kind === 'star'
        ? [
            ['Transitions', transitions],
            ['Route', route],
            ['Runway transitions', runways],
          ]
        : [
            ['Runway transitions', runways],
            ['Route', route],
            ['Transitions', transitions],
          ]
  return (
    <div className="procedure-detail">
      {parts
        .filter(([, list]) => list.length > 0)
        .map(([title, list]) => (
          <section key={title}>
            <h4>{title}</h4>
            {list.map(([name, legs]) => (
              <p key={name || title}>
                {name && <b>{name}</b>}
                {legs.map((leg, i) => (
                  <span key={i}>
                    {i > 0 && <span className="procedure-arrow"> › </span>}
                    {fixOf(leg)}
                    {typeof leg !== 'string' && (leg.alt || leg.speed) && (
                      <small>
                        {leg.alt ?? ''}
                        {leg.speed ? ` ${leg.speed}kt` : ''}
                      </small>
                    )}
                  </span>
                ))}
              </p>
            ))}
          </section>
        ))}
    </div>
  )
}

/** An eye, open (shown on the map) or struck through. */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
      {!open && <path d="M4 20L20 4" />}
    </svg>
  )
}

function legsOf(p: Procedure): Leg[] {
  return [...p.route, ...Object.values(p.transitions ?? {}).flat(), ...Object.values(p.runwayTransitions ?? {}).flat()]
}
