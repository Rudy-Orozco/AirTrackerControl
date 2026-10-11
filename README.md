# AirTrafficArt

Live air traffic around an airport: a 2D radar-style map, a 3D map, a 3D airport
diorama and a split-flap arrivals/departures board with live weather (METAR/ATIS).
Runs in the browser or as a desktop app (Electron).

## Getting started

From `frontend/`:

```sh
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # typecheck and build to dist/
npm run lint
```

The default airport is set in `frontend/.env` (`VITE_AIRPORT`); override it with
`?airport=LAX` in the URL. Timings, colors and other tunables are in
`frontend/src/config/config.ts`.

## Project layout

```
frontend/
  airports.json        airport presets (name, ICAO, position, time zone, country, usual busy hours, logo)
  api-routes.mjs       upstream API proxy routes, shared by Vite and Electron
  electron/            desktop app shell (main process, preload, launcher)
  public/basemaps/     prebuilt map data per airport (see scripts/)
  public/logos/        airport logos
  src/
    App.tsx            top-level layout: maps, diorama, board, settings
    index.css          global styles: fonts, color variables, page and shared map canvas
    config/            tunable defaults (config.ts) and the live settings store (settings.ts)
    feed/              fetching aircraft and routes, and the polling hook
    tracking/          flight classification, smoothed air and ground tracks
    map/               2D map: canvas renderer, labels, basemap, radar, terrain
    map3d/             3D map (three.js)
    diorama/           3D airport view
    aircraft/          aircraft silhouettes and 3D models, shared by map3d and diorama
    board/             split-flap arrivals/departures board
    weather/           METAR and ATIS: parsing, strips and icons
    ui/                boot screen, settings panel, logo, icons
    lib/               small shared helpers (hooks, layout, desktop bridge)
scripts/               Python tools that build basemaps and airport layouts from OpenStreetMap
```

Each component's styles sit next to it (`Board.tsx` + `Board.css`) and are imported
by the component. Shared variables (`--bg`, `--text`, fonts) live in `src/index.css`.

## Adding an airport

1. Add a preset to `frontend/airports.json` (and a logo under `public/logos/`).
2. Build its maps:
   ```sh
   python3 scripts/build_basemap.py <CODE>
   python3 scripts/build_airport_layout.py <CODE>
   ```

## Desktop app

From `frontend/`:

| Command | What it does |
| --- | --- |
| `npm run desktop` | Build and open the desktop app |
| `npm run desktop:kiosk` | Same, full screen with no way out but closing (for a wall display) |
| `npm run dist:win` | Windows installer and portable zip (run on Windows; the installer needs Wine on Linux) |
| `npm run dist:win:zip` | Windows portable zip only (works from Linux too) |
| `npm run dist:linux` / `npm run dist:mac` | Linux AppImage / macOS disk image (build the Mac one on a Mac) |

Packages land in `frontend/release/`. In the app: F11 toggles full screen, Ctrl+R reloads, Ctrl+Shift+I opens developer tools.
