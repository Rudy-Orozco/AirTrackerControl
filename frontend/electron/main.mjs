/**
 * Desktop app (Electron). Serves the built app (dist/) from a private app://
 * address and relays the data APIs that don't allow browser requests, the
 * same way the Vite dev server does (api-routes.mjs). Settings and layout are
 * kept per user, as in a browser.
 *
 *   F11            full screen on/off (Esc leaves it)
 *   Ctrl+scroll    zoom the page, like a browser (also Ctrl+plus/minus, Ctrl+0 to reset)
 *   Ctrl+R         reload
 *   Ctrl+Shift+I   developer tools
 *   --kiosk        start full screen with no way out but closing (for a wall display)
 *
 * Installed copies update themselves from the GitHub releases (see the publish
 * settings in package.json): a new version downloads in the background, then
 * the page counts down (UPDATE_COUNTDOWN_MS) to installing it, which can be put
 * off UPDATE_DEFERS times, and the app restarts on its own, in kiosk mode if it
 * was in it.
 */
import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron'
import updater from 'electron-updater'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES } from '../api-routes.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
// A fixed origin, so what the page keeps in localStorage (settings, layout) survives restarts.
const ORIGIN = 'app://airtrackercontrol'
/** Kiosk mode: from --kiosk, or carried over from before an update restarted the app (see installUpdates). */
const KIOSK = process.argv.includes('--kiosk') || takeRelaunchState().kiosk === true
/** Zoom levels: each step is ×1.2 (Chromium's scale); this range is about 35% to 300%. */
const ZOOM_STEP = 0.5
const MIN_ZOOM = -5.5
const MAX_ZOOM = 6
/** How often to look for a new release. */
const UPDATE_CHECK_MS = 60 * 60_000
/** Once one has downloaded: how long the page counts down before installing it... */
const UPDATE_COUNTDOWN_MS = 30_000
/** ...how many times it can be put off, and for how long each time. */
const UPDATE_DEFERS = 3
const UPDATE_DEFER_MS = 15 * 60_000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

/** Answers the page's requests: API relays, otherwise files from dist/. */
async function handle(request) {
  const url = new URL(request.url)
  const route = API_ROUTES[url.pathname]
  if (route) {
    const upstream = route.rewrite(url.pathname + url.search)
    if (!upstream) return new Response('Bad request', { status: 400 })
    return net.fetch(route.target + upstream, {
      method: request.method,
      headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
    })
  }

  const file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)))
  if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 })
  try {
    const body = await readFile(file)
    return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

// ---- Updates ----------------------------------------------------------------------

/** Where the app notes how it was running before an update restarts it (the installer starts it without its arguments). */
function relaunchFile() {
  return path.join(app.getPath('userData'), 'relaunch.json')
}

/** What was noted before the last update's restart, removed once read so it applies only once. Synchronous: it's needed before the app's ready. */
function takeRelaunchState() {
  try {
    const state = JSON.parse(readFileSync(relaunchFile(), 'utf8'))
    rmSync(relaunchFile(), { force: true })
    return state
  } catch {
    return {}
  }
}

/**
 * Where updating has got to, for the settings' Updates section (see
 * electron/preload.cjs): state is 'unavailable' (not an installed copy),
 * 'idle', 'checking', 'latest', 'downloading' (with percent), 'ready' (counting
 * down to installAt, with defersLeft), 'deferred' (until promptAt), 'installing'
 * or 'error' (with message).
 */
let updateStatus = { state: 'idle', version: app.getVersion(), exe: process.execPath }

function setUpdateStatus(status) {
  updateStatus = { ...status, version: app.getVersion(), exe: process.execPath }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update-status', updateStatus)
}

/** Looks for a new release (it downloads by itself if there is one). */
async function checkForUpdates() {
  if (['unavailable', 'downloading', 'ready', 'deferred', 'installing'].includes(updateStatus.state)) return updateStatus
  setUpdateStatus({ state: 'checking' })
  await updater.autoUpdater.checkForUpdates().catch(() => {})
  return updateStatus
}

ipcMain.handle('update-status', () => updateStatus)
ipcMain.handle('check-for-updates', () => checkForUpdates())
ipcMain.handle('install-update', () => installUpdateNow())
ipcMain.handle('defer-update', () => deferUpdate())

/** Times the countdown to installing, or the end of a deferral. */
let installTimer = null
let defersLeft = UPDATE_DEFERS

/** A downloaded update: the page shows a countdown, and it installs at the end unless put off. */
function promptInstall(version) {
  clearTimeout(installTimer)
  setUpdateStatus({ state: 'ready', next: version, installAt: Date.now() + UPDATE_COUNTDOWN_MS, defersLeft })
  installTimer = setTimeout(installUpdateNow, UPDATE_COUNTDOWN_MS)
}

/** Installs the downloaded update quietly and starts the app again. */
async function installUpdateNow() {
  if (updateStatus.state !== 'ready' && updateStatus.state !== 'deferred') return updateStatus
  clearTimeout(installTimer)
  console.log(`Installing ${updateStatus.next} and restarting`)
  setUpdateStatus({ state: 'installing', next: updateStatus.next })
  await writeFile(relaunchFile(), JSON.stringify({ kiosk: KIOSK })).catch(() => {})
  updater.autoUpdater.quitAndInstall(true, true)
  return updateStatus
}

/** Puts the countdown off for UPDATE_DEFER_MS, while there are deferrals left. */
function deferUpdate() {
  if (updateStatus.state !== 'ready' || defersLeft <= 0) return updateStatus
  clearTimeout(installTimer)
  defersLeft--
  const version = updateStatus.next
  setUpdateStatus({ state: 'deferred', next: version, promptAt: Date.now() + UPDATE_DEFER_MS, defersLeft })
  installTimer = setTimeout(() => promptInstall(version), UPDATE_DEFER_MS)
  return updateStatus
}

/**
 * Where the installer last installed the app (Windows), which is where an
 * update goes, or null if it can't tell. Read from the uninstall entry Windows
 * keeps for it.
 */
function registeredDir() {
  try {
    const uninstaller = readdirSync(path.dirname(process.execPath)).find((f) => /^Uninstall .*\.exe$/i.test(f))
    if (!uninstaller) return null
    for (const root of ['HKCU', 'HKLM']) {
      let out
      try {
        out = execFileSync('reg', ['query', `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', uninstaller, '/d'], { encoding: 'utf8' })
      } catch {
        continue // Nothing found under this root.
      }
      const match = out.match(/UninstallString\s+REG_SZ\s+"([^"]+)"/)
      if (match) return path.dirname(match[1])
    }
  } catch {
    // Fall through.
  }
  return null
}

/**
 * Whether this is the copy an update replaces: the one the installer last put
 * in place. Any other (development, the zip, a local build in release/, or an
 * older install in another folder) would install the update over that one
 * instead and stay old itself, updating again at every start.
 */
function installedCopy() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return { installed: false, installedAt: null }
  if (process.platform !== 'win32') return { installed: true, installedAt: null }
  const dir = registeredDir()
  return { installed: dir !== null && path.relative(dir, path.dirname(process.execPath)) === '', installedAt: dir }
}

/**
 * Checks for a new release now and every UPDATE_CHECK_MS. Once one has
 * downloaded, counts down to installing it (see promptInstall) and restarts,
 * so a wall display with nobody at it still updates and is never left closed. Only in an installed copy: not in development or the portable zip.
 */
function installUpdates() {
  const { installed, installedAt } = installedCopy()
  if (!installed) {
    setUpdateStatus({ state: 'unavailable', installedAt })
    return
  }
  const { autoUpdater } = updater
  autoUpdater.autoDownload = true
  autoUpdater.on('update-not-available', () => setUpdateStatus({ state: 'latest' }))
  autoUpdater.on('update-available', (info) => setUpdateStatus({ state: 'downloading', next: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (p) => setUpdateStatus({ ...updateStatus, state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('error', (err) => {
    console.warn('Update failed:', err?.message ?? err)
    setUpdateStatus({ state: 'error', message: String(err?.message ?? err).split('\n')[0] })
  })
  autoUpdater.on('update-downloaded', (info) => promptInstall(info.version))
  checkForUpdates()
  setInterval(checkForUpdates, UPDATE_CHECK_MS)
}

// ---- Window size and position, remembered between runs ------------------------------

const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json')

async function loadWindowState() {
  try {
    return JSON.parse(await readFile(STATE_FILE(), 'utf8'))
  } catch {
    // First run: a tall window, like the portrait display the app is designed for.
    return { width: 760, height: 1280 }
  }
}

function saveWindowState(win) {
  const state = {
    ...win.getNormalBounds(),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
    zoom: win.webContents.getZoomLevel(),
  }
  writeFile(STATE_FILE(), JSON.stringify(state)).catch(() => {})
}

/** Zooms the page a step in or out (`step` in zoom levels), or back to 100% for 0, and tells the page. */
function zoomWindow(win, step) {
  const level = step === 0 ? 0 : win.webContents.getZoomLevel() + step
  win.webContents.setZoomLevel(Math.min(Math.max(level, MIN_ZOOM), MAX_ZOOM))
  win.webContents.send('zoom', win.webContents.getZoomFactor())
}

// The page's zoom buttons: +1 / -1 a step, 0 to reset, null just to ask the current factor.
ipcMain.handle('zoom', (event, direction) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return 1
  if (direction !== null) zoomWindow(win, Math.sign(direction) * ZOOM_STEP)
  return win.webContents.getZoomFactor()
})

// The settings' Shut down button.
ipcMain.handle('quit', () => app.quit())

async function createWindow() {
  const state = await loadWindowState()
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 480,
    minHeight: 480,
    backgroundColor: '#03050a',
    title: 'AirTrackerControl',
    // Lets the page's zoom buttons reach zoomWindow (electron/preload.cjs).
    webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs') },
    autoHideMenuBar: true,
    kiosk: KIOSK,
    fullscreen: KIOSK || state.fullScreen === true,
    show: false,
  })
  win.setMenuBarVisibility(false)
  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  // A crashed or killed page comes straight back, so a wall display never sits blank.
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') win.webContents.reload()
  })
  win.on('close', () => saveWindowState(win))

  // Links (e.g. map attribution) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Page zoom, like a browser: Ctrl+scroll (Electron reports it as this event) and the keys below.
  const zoomBy = (step) => zoomWindow(win, step)
  win.webContents.on('zoom-changed', (_event, direction) => zoomBy(direction === 'in' ? ZOOM_STEP : -ZOOM_STEP))
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomLevel(state.zoom ?? 0)
    win.webContents.send('zoom', win.webContents.getZoomFactor())
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    if (input.key === 'F11' && !KIOSK) win.setFullScreen(!win.isFullScreen())
    else if (ctrl && (input.key === '=' || input.key === '+')) zoomBy(ZOOM_STEP)
    else if (ctrl && (input.key === '-' || input.key === '_')) zoomBy(-ZOOM_STEP)
    else if (ctrl && input.key === '0') zoomBy(0)
    else if (input.key === 'Escape' && win.isFullScreen() && !KIOSK) win.setFullScreen(false)
    else if (ctrl && input.key.toLowerCase() === 'r') win.webContents.reload()
    else if (ctrl && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools()
    else return
    event.preventDefault()
  })

  await win.loadURL(`${ORIGIN}/`)
}

app.whenReady().then(() => {
  protocol.handle('app', handle)
  createWindow()
  installUpdates()
  // macOS: reopen a window when the dock icon is clicked.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
