"""Download minimalist basemaps from OpenStreetMap for the airport presets.

Reads the presets from frontend/airports.json, queries the Overpass API for
coastlines, lakes, rivers, freeways, runways and city names around each one,
simplifies the geometry, and writes frontend/public/basemaps/<CODE>.json.

    python3 scripts/build_basemap.py            # every preset
    python3 scripts/build_basemap.py LAX ATL    # just these
"""

import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AIRPORTS_FILE = ROOT / "frontend" / "airports.json"
OUT_DIR = ROOT / "frontend" / "public" / "basemaps"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# Cover a 9:16 portrait screen's corners, matching FETCH_RADIUS_NM in src/config/config.ts.
RADIUS_FACTOR = 2.1
# ~80 m: well under one pixel at typical zoom levels, so simplification is invisible.
SIMPLIFY_TOLERANCE_DEG = 0.0008
# Skip ponds and retention basins; keep lakes and reservoirs.
MIN_WATER_AREA_KM2 = 1.0
COORD_DECIMALS = 4


def bounding_box(lat: float, lon: float, radius_nm: float) -> tuple[float, float, float, float]:
    d_lat = radius_nm / 60
    d_lon = radius_nm / (60 * math.cos(math.radians(lat)))
    return (lat - d_lat, lon - d_lon, lat + d_lat, lon + d_lon)


def overpass(query: str) -> list[dict]:
    body = urllib.parse.urlencode({"data": query}).encode()
    # Overpass rejects requests without a User-Agent.
    req = urllib.request.Request(OVERPASS_URL, data=body, headers={"User-Agent": "AirTrackerControl-basemap/0.1"})
    with urllib.request.urlopen(req, timeout=180) as res:
        return json.load(res)["elements"]


def simplify(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker line simplification (iterative)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        (x1, y1), (x2, y2) = points[start], points[end]
        length = math.hypot(x2 - x1, y2 - y1)
        max_dist, index = 0.0, start
        for i in range(start + 1, end):
            x0, y0 = points[i]
            if length == 0:
                dist = math.hypot(x0 - x1, y0 - y1)
            else:
                dist = abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1) / length
            if dist > max_dist:
                max_dist, index = dist, i
        if max_dist > tolerance:
            keep[index] = True
            stack += [(start, index), (index, end)]
    return [p for p, k in zip(points, keep) if k]


def stitch(segments: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Join a multipolygon's outer member ways end-to-end into closed rings."""
    rings, open_segments = [], [s for s in segments if s]
    while open_segments:
        ring = list(open_segments.pop())
        while ring[0] != ring[-1]:
            for i, seg in enumerate(open_segments):
                if seg[0] == ring[-1]:
                    ring += seg[1:]
                elif seg[-1] == ring[-1]:
                    ring += seg[-2::-1]
                else:
                    continue
                open_segments.pop(i)
                break
            else:
                break  # Ring is clipped by the bounding box; keep what we have.
        rings.append(ring)
    return rings


def ring_area_km2(ring: list[tuple[float, float]]) -> float:
    lat0 = math.radians(ring[0][1])
    km_per_deg = 111.32
    area = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        area += (x1 * y2 - x2 * y1)
    return abs(area) / 2 * km_per_deg**2 * math.cos(lat0)


def geometry(element: dict) -> list[tuple[float, float]]:
    return [(p["lon"], p["lat"]) for p in element.get("geometry", [])]


def compact(points: list[tuple[float, float]]) -> list[list[float]]:
    simplified = simplify(points, SIMPLIFY_TOLERANCE_DEG)
    return [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in simplified]


def build(code: str, preset: dict) -> None:
    lat, lon = preset["lat"], preset["lon"]
    radius_nm = preset["radiusNm"] * RADIUS_FACTOR
    bbox = "{:.4f},{:.4f},{:.4f},{:.4f}".format(*bounding_box(lat, lon, radius_nm))
    print(f"{code}: fetching OpenStreetMap features around {lat}, {lon} ({radius_nm:.0f} nm)…")

    elements = overpass(f"""
        [out:json][timeout:180][bbox:{bbox}];
        (
          way["natural"="water"];
          relation["natural"="water"];
          way["natural"="coastline"];
          way["waterway"="river"];
          way["highway"="motorway"];
          way["aeroway"="runway"];
        );
        out geom;
        node["place"="city"];
        out;
    """)

    water, coastlines, rivers, highways, runways, cities = [], [], [], [], [], []
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "node":
            cities.append({"name": tags.get("name", ""), "lat": el["lat"], "lon": el["lon"]})
        elif tags.get("natural") == "water":
            if el["type"] == "relation":
                outers = [geometry(m) for m in el.get("members", []) if m.get("role") == "outer"]
                rings = stitch(outers)
            else:
                rings = [geometry(el)]
            water += [compact(r) for r in rings if len(r) > 2 and ring_area_km2(r) >= MIN_WATER_AREA_KM2]
        elif tags.get("natural") == "coastline":
            coastlines.append(compact(geometry(el)))
        elif tags.get("waterway") == "river":
            rivers.append(compact(geometry(el)))
        elif tags.get("highway") == "motorway":
            highways.append(compact(geometry(el)))
        elif tags.get("aeroway") == "runway":
            runways.append(compact(geometry(el)))

    basemap = {
        "attribution": "© OpenStreetMap contributors",
        "water": water,
        "coastlines": coastlines,
        "rivers": rivers,
        "highways": highways,
        "runways": runways,
        "cities": cities,
    }
    out_file = OUT_DIR / f"{code}.json"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(json.dumps(basemap, separators=(",", ":")))
    print(
        f"{code}: wrote {out_file.relative_to(ROOT)} ({out_file.stat().st_size / 1024:.0f} KB): "
        f"{len(water)} lakes, {len(coastlines)} coastline segments, {len(rivers)} river segments, "
        f"{len(highways)} freeway segments, {len(runways)} runways, {len(cities)} cities"
    )


def main() -> None:
    presets = json.loads(AIRPORTS_FILE.read_text())
    codes = [c.upper() for c in sys.argv[1:]] or list(presets)
    unknown = [c for c in codes if c not in presets]
    if unknown:
        sys.exit(f"Not in {AIRPORTS_FILE.relative_to(ROOT)}: {', '.join(unknown)}")
    for i, code in enumerate(codes):
        if i:
            time.sleep(5)  # Be polite to the shared Overpass server between queries.
        build(code, presets[code])


if __name__ == "__main__":
    main()
