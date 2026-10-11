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
 */
import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES } from '../api-routes.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
// A fixed origin, so what the page keeps in localStorage (settings, layout) survives restarts.
const ORIGIN = 'app://airtrafficart'
const KIOSK = process.argv.includes('--kiosk')
/** Zoom levels: each step is ×1.2 (Chromium's scale); this range is about 35% to 300%. */
const ZOOM_STEP = 0.5
const MIN_ZOOM = -5.5
const MAX_ZOOM = 6

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
    title: 'Air Traffic Art',
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
  // macOS: reopen a window when the dock icon is clicked.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
