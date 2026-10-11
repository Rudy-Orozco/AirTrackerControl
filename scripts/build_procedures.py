"""Build each US airport's STARs, SIDs and approaches, with their waypoints, from the FAA's CIFP.

The FAA publishes every US instrument procedure, free, as CIFP (Coded Instrument
Flight Procedures, in the ARINC 424 format), updated every 28 days. This reads
it and writes frontend/public/procedures/<CODE>.json in the app's procedures
format (see README.md).

    python3 scripts/build_procedures.py               # every US preset, downloading the current CIFP
    python3 scripts/build_procedures.py ATL DFW       # just these
    python3 scripts/build_procedures.py --cifp CIFP_261001.zip   # from a CIFP already downloaded (.zip or FAACIFP18)

Airports outside the US aren't in the CIFP: write their files by hand.
"""

import argparse
import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

from build_basemap import AIRPORTS_FILE, ROOT

OUT_DIR = ROOT / "frontend" / "public" / "procedures"
DOWNLOAD_PAGE = "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/"
CIFP_FILE = "FAACIFP18"
COORD_DECIMALS = 5


def col(line: str, start: int, end: int) -> str:
    """ARINC 424 columns, counted from 1 as in the spec."""
    return line[start - 1 : end]


def read_cifp(path: str | None) -> tuple[list[str], str]:
    """The CIFP's records, and its file name: from a file given (.zip or FAACIFP18), or the current cycle downloaded from the FAA."""
    if path:
        data = Path(path).read_bytes()
        name = path
    else:
        page = urllib.request.urlopen(DOWNLOAD_PAGE, timeout=60).read().decode("utf-8", "replace")
        links = sorted(set(re.findall(r"https://aeronav\.faa\.gov/[^\"']*CIFP_(\d{6})\.zip", page)))
        if not links:
            sys.exit(f"No CIFP download found on {DOWNLOAD_PAGE}; download it yourself and pass --cifp.")
        # The page lists the current cycle and the next; the earlier one is in effect now.
        cycle = links[0]
        name = f"CIFP_{cycle}.zip"
        url = next(u for u in re.findall(r"https://aeronav\.faa\.gov/[^\"']*\.zip", page) if cycle in u)
        print(f"Downloading {url}")
        data = urllib.request.urlopen(url, timeout=600).read()
    if name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            data = z.read(next(n for n in z.namelist() if n.endswith(CIFP_FILE)))
    return data.decode("latin-1").splitlines(), name


def effective_date(name: str | None) -> str | None:
    """2026-10-01 from CIFP_261001.zip."""
    match = re.search(r"(\d{2})(\d{2})(\d{2})", Path(name or "").name)
    return f"20{match[1]}-{match[2]}-{match[3]}" if match else None


def coordinate(text: str) -> float | None:
    """N33380302 (DDMMSSss) or W084473588 (DDDMMSSss) as signed degrees."""
    text = text.strip()
    if len(text) not in (9, 10) or text[0] not in "NSEW":
        return None
    digits = text[1:]
    whole = 2 if text[0] in "NS" else 3
    try:
        deg, minutes, sec = int(digits[:whole]), int(digits[whole : whole + 2]), int(digits[whole + 2 :]) / 100
    except ValueError:
        return None
    value = deg + minutes / 60 + sec / 3600
    return round(-value if text[0] in "SW" else value, COORD_DECIMALS)


def position(line: str, lat_at: int = 33) -> dict | None:
    lat = coordinate(col(line, lat_at, lat_at + 8))
    lon = coordinate(col(line, lat_at + 9, lat_at + 18))
    return {"lat": lat, "lon": lon} if lat is not None and lon is not None else None


def fixes(lines: list[str]) -> dict:
    """Every fix's position, keyed by (section, airport or "", ident)."""
    found = {}
    for line in lines:
        # Primary records only (continuation records, numbered in column 22 here, hold other details).
        if not line.startswith("S") or col(line, 22, 22) not in "01":
            continue
        section = col(line, 5, 5)
        if section == "E" and col(line, 6, 6) == "A":  # enroute waypoint
            key, at = ("EA", "", col(line, 14, 18).strip()), position(line)
        elif section == "D":  # VOR (or DME only), or NDB
            sub = col(line, 6, 6)
            at = position(line) or (position(line, 56) if sub == " " else None)
            key = ("DB" if sub == "B" else "D ", "", col(line, 14, 17).strip())
        elif section == "P" and col(line, 13, 13) in "CGAN":  # terminal waypoint, runway, airport, terminal NDB
            sub = col(line, 13, 13)
            key, at = ("P" + sub, col(line, 7, 10), col(line, 14, 18).strip()), position(line)
        else:
            continue
        if at:
            found.setdefault(key, at)
    return found


def altitude(line: str) -> str | None:
    """The leg's altitude restriction as charted text: "13000", "+5000" (at or above), "-FL190" (at or below), "5000-7000"."""

    def value(text: str) -> str | None:
        text = text.strip()
        if not text:
            return None
        return text if text.startswith("FL") else str(int(text)) if text.isdigit() else None

    first, second = value(col(line, 85, 89)), value(col(line, 90, 94))
    if first is None:
        return None
    match col(line, 83, 83):
        # At or above (approaches also say so with glideslope variants: V, H, J).
        case "+" | "V" | "H" | "J":
            return f"+{first}"
        case "-":
            return f"-{first}"
        case "B" if second:
            return f"{second}-{first}"
        case _:
            return first


def leg(line: str) -> str | dict:
    fix = col(line, 30, 34).strip()
    alt = altitude(line)
    speed = col(line, 100, 102).strip()
    if not alt and not speed.isdigit():
        return fix
    out: dict = {"fix": fix}
    if alt:
        out["alt"] = alt
    if speed.isdigit():
        out["speed"] = int(speed)
    return out


def fix_name(entry: str | dict) -> str:
    return entry if isinstance(entry, str) else entry["fix"]


def runways_for(transition: str, runways: list[str]) -> list[str]:
    """RW26R -> 26R; RW26B (both, or all, parallels) -> 26L 26R; ALL -> every runway."""
    if transition == "ALL":
        return runways
    if not transition.startswith("RW"):
        return []
    name = transition[2:]
    if name.endswith("B"):
        return [r for r in runways if re.fullmatch(name[:-1] + r"[LCR]?", r)]
    return [name] if name in runways else []


# Approach types, by the first letter of their CIFP identifier.
APPROACH_TYPES = {
    "I": "ILS", "L": "LOC", "R": "RNAV (GPS)", "H": "RNAV (RNP)", "B": "LOC BC", "X": "LDA",
    "D": "VOR/DME", "S": "VOR/DME", "V": "VOR", "N": "NDB", "Q": "NDB/DME", "P": "GPS",
    "G": "IGS", "J": "GLS", "T": "TACAN", "U": "SDF",
}


def approach_name(ident: str) -> tuple[str, str | None]:
    """ "ILS 08L", "RNAV (GPS) Y 08L", "RNAV (RNP) Z 10", and the runway, from I08L, R08LY, H10-Z."""
    kind = APPROACH_TYPES.get(ident[0], ident[0])
    match = re.fullmatch(r"(\d{2}[LCR]?)-?([A-Z]?)", ident[1:])
    if not match:
        return f"{kind} {ident[1:]}".strip(), None
    runway, variant = match[1], match[2]
    return f"{kind}{f' {variant}' if variant else ''} {runway}", runway


def procedures(lines: list[str], icao: str, positions: dict) -> tuple[dict, list, list, list]:
    """The airport's STARs, SIDs and approaches, and the waypoints they use."""
    runways = sorted(
        {col(l, 14, 18).strip()[2:] for l in lines if l.startswith(f"SUSAP {icao}") and col(l, 13, 13) == "G"},
        key=lambda r: (int(re.match(r"\d+", r)[0]), r),
    )
    built: dict[tuple[str, str], dict] = {}
    waypoints: dict[str, dict] = {}
    for line in lines:
        if not line.startswith(f"SUSAP {icao}") or col(line, 13, 13) not in "DEF" or col(line, 39, 39) not in "01":
            continue
        fix = col(line, 30, 34).strip()
        # Legs without a fix (climb to an altitude, fly a heading) aren't plotted.
        if not fix:
            continue
        section = col(line, 37, 38)
        where = col(line, 7, 10) if section[0] == "P" else ""
        at = positions.get((section, where, fix))
        if not at:
            continue
        waypoints.setdefault(fix, at)
        kind = {"E": "star", "D": "sid", "F": "approach"}[col(line, 13, 13)]
        name = col(line, 14, 19).strip()
        transition = col(line, 21, 25).strip()
        proc = built.setdefault((kind, name), {"name": name, "route": [], "transitions": {}, "runwayTransitions": {}, "missed": [], "pastMap": False})
        if kind == "approach" and col(line, 20, 20) != "A":
            # The final approach, to its missed approach point (column 43: "M"), then the missed approach.
            legs = proc["missed"] if proc["pastMap"] else proc["route"]
            if col(line, 43, 43) == "M":
                proc["pastMap"] = True
                proc["missed"].append(leg(line))
        elif kind == "approach":
            legs = proc["transitions"].setdefault(transition, [])
        elif transition.startswith("RW") or transition == "ALL":
            legs = proc["runwayTransitions"].setdefault(transition, [])
        elif not transition:
            legs = proc["route"]
        else:
            legs = proc["transitions"].setdefault(transition, [])
        entry = leg(line)
        # A leg ending at the fix before it (e.g. a hold there) adds nothing to the path.
        if legs and fix_name(legs[-1]) == fix:
            continue
        legs.append(entry)

    stars, sids, approaches = [], [], []
    for (kind, _), proc in sorted(built.items()):
        if kind == "approach":
            name, runway = approach_name(proc["name"])
            out = {"name": name, "id": proc["name"]}
            if runway:
                out["runway"] = runway
            if proc["transitions"]:
                out["transitions"] = proc["transitions"]
            out["route"] = proc["route"]
            if len(proc["missed"]) > 1:
                out["missedApproach"] = proc["missed"]
            if out["route"]:
                approaches.append(out)
            continue
        served = sorted({r for t in proc["runwayTransitions"] for r in runways_for(t, runways)}, key=runways.index)
        out = {"name": proc["name"]}
        if proc["transitions"]:
            out["transitions"] = proc["transitions"]
        out["route"] = proc["route"]
        if proc["runwayTransitions"]:
            out["runwayTransitions"] = proc["runwayTransitions"]
        if served:
            out["runways"] = served
        (stars if kind == "star" else sids).append(out)
    # By runway, then type (ILS first), as the charts are listed.
    order = list(APPROACH_TYPES.values())
    approaches.sort(key=lambda a: (a.get("runway") or "~", order.index(a["name"].rsplit(" ", 1)[0].rstrip(" YZXW")) if a["name"].rsplit(" ", 1)[0].rstrip(" YZXW") in order else 99, a["name"]))
    return waypoints, stars, sids, approaches


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("codes", nargs="*", help="airport codes from airports.json (default: every US one)")
    parser.add_argument("--cifp", help="a CIFP already downloaded: the .zip, or the FAACIFP18 file in it")
    args = parser.parse_args()

    presets = json.loads(AIRPORTS_FILE.read_text())
    codes = [c.upper() for c in args.codes] or [c for c, p in presets.items() if p["icao"].startswith("K")]
    lines, name = read_cifp(args.cifp)
    effective = effective_date(name)
    positions = fixes(lines)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for code in codes:
        icao = presets[code]["icao"]
        waypoints, stars, sids, approaches = procedures(lines, icao, positions)
        if not stars and not sids and not approaches:
            print(f"{code}: no procedures in the CIFP for {icao} (outside the US?)")
            continue
        out = {
            "airport": code,
            "source": "FAA CIFP" + (f" (cycle {effective})" if effective else ""),
            "effective": effective,
            "waypoints": dict(sorted(waypoints.items())),
            "stars": stars,
            "sids": sids,
            "approaches": approaches,
        }
        if not effective:
            del out["effective"]
        path = OUT_DIR / f"{code}.json"
        path.write_text(json.dumps(out, separators=(",", ":")) + "\n")
        print(f"{code}: {len(stars)} STARs, {len(sids)} SIDs, {len(approaches)} approaches, {len(waypoints)} waypoints -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
