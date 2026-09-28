# Changelog

All notable changes to the calculator. The SOP it implements has its own
revision history in [`docs/SOP.md`](docs/SOP.md).

## 0.6.1 — 2026-09-28

Security review.

### Fixed
- CSV export: cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed
  with a quote so spreadsheets don't run them as formulas.
- Bay diagram no longer loops over absurd disk counts.

### Hardened
- `dist/index.html` carries a Content Security Policy (no external scripts,
  no network calls, no framing) and sends no referrer.
- GitHub Actions pinned to commit SHAs; CI token limited to read; Dependabot
  keeps the pins current.
- Dev server pinned to `http-server@14.1.1`.

## 0.6.0 — 2026-09-28

Fixes and additions from a review of the whole project.

### Fixed
- Analog cameras (CIF, D1, 960H) no longer draw PoE power or add traffic to
  a switch. They connect to the DVR by coax, so those columns are disabled
  for them and their entries are ignored.
- A night frame rate is no longer applied to scheduled recording. Scheduled
  groups record fixed hours, so day/night averaging doesn't apply.
- SOP appendices are back in order (A, B, C) and the worksheet has the
  quality, night FPS, switch and PoE columns.

### Added
- **Check an existing array.** Enter the disks already installed and the
  page shows how many days fit, how far short it falls with the storage to
  add, or how many more cameras it has room for.
- Blank quantity, frame rate or hours fields raise a warning instead of
  silently using a default.
- A shortfall message now says how many days short and how much storage to
  add.
- GitHub Pages workflow (`.github/workflows/pages.yml`) to host the page,
  run by hand from the Actions tab.
- Browser smoke test in CI (Playwright) that drives the built page.

## 0.5.0 — 2026-09-28
- Analog DVR resolutions CIF, D1 and 960H.
- "Evidential or regulated footage" setting. No RAID is a warning, not a
  failure, for systems marked non-critical.

## 0.4.0 — 2026-09-28
- Resolutions 1 MP (720p), 3 MP and 6 MP.
- Raw-pixel estimate method (width × height × color depth × fps ÷
  compression ratio) with editable ratios, shown beside the typical-bitrate
  result.

## 0.3.0 — 2026-09-28
- Codecs Smart H.264+, AV1 and MJPEG.
- Quality setting per group.
- Optional night frame rate per group with site-wide night hours.

## 0.2.0 — 2026-09-28
- Switch uplink and PoE loading per switch.
- Viewing traffic (live view and playback) against recorder outbound and
  WAN link.
- Disk write and playback read rates.

## 0.1.0 — 2026-09-28
- First version: camera groups, storage sizing per SOP-VSS-001, RAID disk
  planning, recorder throughput, design checks, report and CSV export.
