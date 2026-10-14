# Changelog

What changed in each release. `npm run release` (in `frontend/`) asks what
changed and adds it here; each version's section becomes its release notes on
GitHub and shows in the app under Settings › General › Updates › What's new.

Each release is a `## <version> — <date>` heading followed by `- ` lines.

## 0.1.4 — 2026-10-13

- "Only registered app installed"

## 0.1.3 — 2026-10-13

- Fixed Update Loop when not running installed copy

## 0.1.2 — 2026-10-13

- What's new: this changelog, in Settings › General › Updates and on each GitHub release.
- The installer is always called `AirTrackerControl-Setup.exe`, so one link always downloads the latest.
- Added Change Log
- Additional Automation Tests

## 0.1.1 — 2026-10-13

- Settings › General › Updates shows the build (commit and time), to tell releases apart.

## 0.1.0 — 2026-10-13

- Renamed to AirTrackerControl.
- Startup intro with the name, author and credits; the data starts loading once it's done.
- Updates itself from GitHub releases: downloads in the background, installs and restarts, back in kiosk mode if it was in it.
- Check for updates button in Settings › General.
- The page reloads itself if it crashes, so a wall display never sits blank.
