# AirTrackerControl

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
  public/procedures/   STARs, SIDs and approaches per airport (see "Procedures" below)
  public/logos/        airport logos
  src/
    App.tsx            top-level layout: maps, diorama, board, settings
    index.css          global styles: fonts, color variables, page and shared map canvas
    config/            tunable defaults (config.ts) and the live settings store (settings.ts)
    feed/              fetching aircraft and routes, and the polling hook
    tracking/          flight classification, smoothed air and ground tracks, airport stats
    procedures/        STARs, SIDs and approaches: loading, importing, and matching flights to them
    map/               2D map: canvas renderer, labels, basemap, radar, terrain
    map3d/             3D map (three.js)
    diorama/           3D airport view
    aircraft/          aircraft silhouettes and 3D models, shared by map3d and diorama
    board/             split-flap arrivals/departures board
    weather/           METAR and ATIS: parsing, strips and icons
    ui/                boot screen, settings panel, logo, icons
    lib/               small shared helpers (hooks, layout, desktop bridge)
scripts/               Python tools that build basemaps and airport layouts (OpenStreetMap) and procedures (FAA CIFP)
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
3. For a US airport, build its STARs, SIDs and approaches (see below):
   ```sh
   python3 scripts/build_procedures.py <CODE>
   ```

## Procedures: STARs, SIDs and approaches

A study tool for the airport's standard arrivals (STARs), standard departures
(SIDs) and instrument approaches, off by default: turn on **Procedures** in
Settings › General › Procedures. That section also sets where they're drawn (2D
map and minimap, 3D map), waypoint names, opacity and their colors: periwinkle for
STARs, gold for SIDs and mint for approaches by default, akin to the arrival blue
and departure orange but apart from the aircraft.

- **The procedures button** (in the toolbar, once it's on) opens a panel listing
  them, a tab each (approaches by runway: `ILS 08L`, `RNAV (RNP) Z 08L`...). Each has a switch: off, it's left out altogether (not matched,
  predicted or drawn), for procedures no longer flown or not used in the current
  flow. Its eye shows it on the maps. Both have All buttons, and both are kept per
  airport. Find one by name or by a waypoint on it, or show only those flights are
  on now (each shows how many). Open one to read it: its transitions, route and runway transitions,
  waypoint by waypoint, with the altitudes and speeds to cross them at. Nothing is
  drawn until it's picked, so the view stays clear.
- **Click a flight** (on the map, the minimap or the board) to see the procedure
  it's flying, worked out from its path: the way it's come, fainter, through the
  waypoints it's passed; the way ahead, bright, with chevrons and the altitude to
  cross each waypoint at; and dashed, the branches it may still take, each named at
  its end: a STAR's runway transitions, or a SID's exits, until its path shows
  which. With the runways in use known (from the runway assist), a STAR's runway
  transitions for runways not being landed on are left out (one left is simply the
  way ahead), and a SID starts from the runway transition for a departure runway in
  use, the one nearest the flight, until its path shows which it took. Its details say which procedure and transition (`STAR CHPPR1 · BBABE`) and
  the next waypoint (`Next fix MRCHH · 9000`); the stats under the logo list the
  busiest (`via CHPPR1 6 VRSTY3 4`).
- **The Waypoints tab** lists every waypoint in the procedures (not runway
  thresholds), each with the altitude a procedure has aircraft cross it at and the
  procedures using it, and shows them on their own, without lines: all of them
  (**Show all**), or those with their eye on. Its settings: names; the altitude
  they're drawn at on the 3D map (as charted, else on the ground; on the ground;
  or all at one altitude); a drop line from one in the air down to a dot on the
  ground; size, opacity and color (a neutral grey-blue by default, apart from the
  procedures').
- **Identify flights** (in the panel and the settings, on by default): off, it's
  purely a study tool. Nothing runs: no flight's path is kept or compared, nothing
  is predicted, and what depends on it (a followed flight's procedure, its details,
  the stats' "via", the panel's flight counts and "Landing now") is left out. The
  panel, picking and reading procedures, and the Waypoints tab all still work.
- **Predicted path** (in the panel, on by default) narrows that down: before its
  path shows a procedure, its likeliest (see below), and of the branches, the one
  it's on or likely to take, by the runways in use. Turn it off for no guessing: a
  flight shows a procedure only once its path does, with every branch it may take
  (its entries or exits, and all its runway transitions) dashed.
- **On the 2D map and minimap** each is a thin line with a soft glow, chevrons
  pointing the way it's flown, and its waypoints as four-pointed stars (as on the
  charts), named. **On the 3D map**, where a procedure charts its altitudes
  they're in the air: each waypoint at the altitude the procedure has aircraft cross
  it at, filled in by distance flown between two charted ones, so arrivals are seen
  coming down them. Where it doesn't (before its first charted altitude, past its
  last, or none at all, as on most SIDs), the line is traced on the ground instead,
  with a faint curtain rising from it to an estimate of where aircraft usually are,
  and a dashed line along the curtain's top. The estimate carries on from the
  nearest charted altitude at the usual 3-to-1 profile (300 ft per nm, descending
  along a STAR, climbing along a SID, between 1,500 ft above the field and 18,000 ft),
  or with none charted, 300 ft per nm from the airport. Each waypoint has one
  altitude across the whole procedure, so its transitions, route and runway
  transitions meet. Lines in the air are drawn in 1 nm steps, kept at least 500 ft
  above the ground under them, so a long leg doesn't cut through hills.

### Approaches

An approach takes an arrival from the end of its STAR to the runway: its
**transitions** (from the initial approach fixes), its **final approach** (to the
runway threshold, at the threshold's height, so on the 3D map it's the glide path
down to the runway), and its **missed approach** (where a go-around climbs to, and
holds), drawn dashed. Approaches chart their altitudes far more than SIDs do, so
they're nearly all in the air.

A followed arrival shows its approach after its STAR, matched by where it is now:
its last six positions (about a minute), at least three of them within 0.4 nm of a
final approach. Parallel runways' finals can be as little as 1,000 ft apart (ATL's
08L and 08R), so the final it's nearest on average wins; a localizer is flown to
within a few tens of meters. Approaches to the same runway often share a final (ILS,
LOC and RNAV), so between those, it's the one airliners usually fly: ILS, then RNAV
(RNP), RNAV (GPS), LOC. Its transition is the one most of its earlier positions were
within 1 nm of.
Before that, with **Predicted path** on, it's predicted once the runway it's bound
for is down to one (its STAR's runway transition, among the runways being landed
on): that runway's ILS, or else its likeliest approach. Its details show the
approach (`Approach · ILS 08L`), and the next waypoint on it once it's flying it.

### How flights are matched

Neither the flight feed nor the route database says which procedure a flight was
given, so it's worked out from where it flies. Each arrival's and departure's
positions over the last 25 minutes (within 120 nm) are compared with every STAR
(arrivals) or SID (departures). A position within 2 nm of a procedure's line
counts as on it. The procedure with the most positions on it wins, as long as
that's at least 4 positions and at least half of those near it (within 10 nm:
cruise far away, before the procedure starts, doesn't count against it), and it
counts once it's held for three updates running. The transitions it's taken are
the ones it's had at least two positions on.

Near the airport, procedures share their last waypoints, so a flight's earlier
path further out is what tells them apart: a flight is usually matched once it's
been on its procedure a few minutes. Flights vectored by the controllers (taken
off the procedure, as often happens near the airport) keep the procedure they
were on. SIDs made of headings and altitudes only, with no waypoints ("fly
heading 270, climb to 5000, expect vectors"), can't be drawn or matched.

### Predicting a flight's procedure

Until its path shows which procedure it's on, a followed flight shows its
likeliest one, marked *predicted* (its details say `STAR · predicted`, and its
way ahead is dashed). STARs start out where arrivals come from, and each SID's
exits lead off toward where departures go, so:

- **An arrival:** the STAR whose entry waypoint (each transition's first) lies
  most nearly the way it's coming in, judged by where it is now (relative to the
  airport) and by the airport it came from.
- **A departure:** the SID whose exit (each transition's last waypoint) lies most
  nearly toward the airport it's going to. This works from the moment it shows up
  taxiing.
- Only within 40°: a flight coming from nowhere near any STAR's entry (or going
  nowhere near a SID's exit) gets no prediction.
- With the runways in use known (from the runway assist), procedures that serve
  none of them are ruled out, and the runway transition is one for a runway in use.

Once its path matches a procedure (as above), that replaces the prediction. Origins
and destinations come from the route database, which is sometimes wrong (see the
classifier's check in `tracking/flights.ts`); a prediction can only be as good.

### Where the procedures come from

Built in: `frontend/public/procedures/<CODE>.json`, loaded for the airport on
screen if there is one. A file imported in the settings replaces it in that browser.

For US airports, `scripts/build_procedures.py` builds these files from the FAA's
CIFP (Coded Instrument Flight Procedures): every US procedure, free, in the
ARINC 424 format. Procedures change; the FAA publishes a new cycle every 28 days,
so re-run it now and then:

```sh
python3 scripts/build_procedures.py               # every US airport in airports.json, downloading the current cycle
python3 scripts/build_procedures.py ATL DFW       # just these
python3 scripts/build_procedures.py --cifp CIFP_261001.zip   # from a cycle already downloaded
```

Downloads are listed at
<https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/>.
Some US procedures aren't in the CIFP (its `Not_In_CIFP.xlsx` lists them); airports
outside the US (FRA, LHR, HND, YYZ here) aren't in it at all. For those, write
the file by hand from the published charts (the national AIP: e.g. DFS for
Germany, NATS for the UK, NAV CANADA for Canada, JCAB for Japan) and import it.

### Importing your own

Settings › General › Procedures:

- **Import JSON…** loads a file in the format below for the airport on screen.
  It's checked first: anything wrong (a waypoint a procedure uses but doesn't
  list, a missing name) is shown there, and nothing changes.
- **Download** saves the procedures in use (built in or imported) as JSON, a
  good starting point for editing.
- **Remove imported** goes back to the built-in file, if there is one.

The line under the section's title says what's loaded and where it came from.

### File format

One JSON file per airport:

```json
{
  "airport": "ATL",
  "source": "FAA CIFP (cycle 2026-10-01)",
  "effective": "2026-10-01",
  "waypoints": {
    "BBABE": { "lat": 34.791, "lon": -85.5751 },
    "LEMKE": { "lat": 34.3601, "lon": -85.17003 },
    "CHPPR": { "lat": 34.14383, "lon": -84.96878 },
    "MRCHH": { "lat": 34.01252, "lon": -84.8445 },
    "JAGRR": { "lat": 33.89991, "lon": -84.83268 }
  },
  "stars": [
    {
      "name": "CHPPR1",
      "transitions": {
        "BBABE": ["BBABE", "LEMKE", { "fix": "CHPPR", "alt": "13000" }],
        "LEMKE": ["LEMKE", { "fix": "CHPPR", "alt": "13000" }]
      },
      "route": [{ "fix": "CHPPR", "alt": "13000" }, "MRCHH"],
      "runwayTransitions": {
        "RW08B": ["MRCHH", { "fix": "JAGRR", "alt": "9000" }]
      },
      "runways": ["08L", "08R"]
    }
  ],
  "sids": [],
  "approaches": [
    {
      "name": "ILS 08L",
      "id": "I08L",
      "runway": "08L",
      "transitions": {
        "JAAJJ": [{ "fix": "JAAJJ", "alt": "+5000" }, { "fix": "BAZAR", "alt": "+4000" }]
      },
      "route": [{ "fix": "BAZAR", "alt": "+4000" }, { "fix": "SCHEL", "alt": "+2900" }, { "fix": "RW08L", "alt": "1065" }],
      "missedApproach": [{ "fix": "RW08L", "alt": "1065" }, { "fix": "TROYS", "alt": "+3500" }]
    }
  ]
}
```

(Part of ATL's CHPPR ONE arrival, from the FAA's CIFP: two of its transitions and one of its runway transitions.)

| Field | Required | What it is |
| --- | --- | --- |
| `airport` | yes | The airport's code from `airports.json` (or its ICAO code). An import for another airport is refused. |
| `source`, `effective` | no | Where the data came from and the date it took effect, shown in the settings. |
| `waypoints` | yes | Every waypoint the procedures use: `"NAME": { "lat": degrees, "lon": degrees }` (north and east positive). |
| `stars`, `sids` | yes (may be empty) | The arrivals and departures, each as below. |
| `approaches` | no | The instrument approaches, each as below. |

Each STAR or SID:

| Field | Required | What it is |
| --- | --- | --- |
| `name` | yes | As charted, e.g. `CHPPR1`. |
| `transitions` | no | Named branches, each a list of waypoints in the order flown: into the common route for a STAR (from where it starts), out of it for a SID (to where it ends). |
| `route` | yes (may be empty) | The common part every aircraft on it flies, in order. |
| `runwayTransitions` | no | Branches to (STAR) or from (SID) particular runways, named `RW26R`, `RW26B` (all the parallel 26s) or `ALL`. |
| `runways` | no | The runways it serves, e.g. `["26R", "27L"]`. |

Each approach:

| Field | Required | What it is |
| --- | --- | --- |
| `name` | yes | As charted, without "RWY": `ILS 08L`, `RNAV (GPS) Y 26R`. Its type (the start of its name) decides, among approaches sharing a final, which a flight is matched to. |
| `id` | no | Its identifier in the FAA's data, e.g. `I08L`. |
| `runway` | no | The runway it's to, e.g. `08L`; used to predict it from the runways in use. |
| `transitions` | no | Named branches from its initial approach fixes into the final approach. |
| `route` | yes | The final approach, in order, to the runway threshold (as a waypoint, e.g. `RW08L` at its elevation) or missed approach point. |
| `missedApproach` | no | The missed approach, from the threshold (or missed approach point) on. |

The CIFP's runway thresholds (`RW08L`) are waypoints like any other, with their
positions in `waypoints`.

Flown in order: a STAR is a transition, then the route, then a runway transition;
a SID is a runway transition, then the route, then a transition; an approach a
transition, then the final approach, then (going around) the missed approach. Consecutive parts
share the waypoint where they meet (list it at the end of one and the start of the
next), which joins them up when drawn.

Each waypoint in a list is its name, or an object with the restrictions to cross it at:

| Field | What it is |
| --- | --- |
| `fix` | The waypoint's name, listed in `waypoints`. |
| `alt` | Altitude, as charted: `"13000"` (at), `"+5000"` (at or above), `"-FL190"` (at or below), `"5000-7000"` (between). Flight levels as `FL190`. |
| `speed` | Speed limit in knots. |

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
