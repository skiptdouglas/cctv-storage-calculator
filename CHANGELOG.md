# Changelog

All notable changes to the calculator. The SOP it implements has its own
revision history in [`docs/SOP.md`](docs/SOP.md).

## 0.7.3 — 2026-10-01

### Fixed
- **Vendor presets checked against the manufacturers' own datasheets**
  (techspecs.ui.com, dl.ui.com, resource.milesight.com) instead of reseller
  copies.
- UniFi: G4 PTZ has IR (was set to no IR). IR confirmed on G5 PTZ and AI 360.
  G4 Doorbell Pro notes that its 10 W comes from AC or USB-C, not PoE.
- Milesight: corrected maximum power on 14 presets, model codes on the mini
  bullets (MS-Cxx64-PD) and motorized domes (MS-Cxx75-FPD), and the MS-C5371,
  which is a 12× PTZ dome drawing 17.3 W. The 5 MP 180° panoramics are now
  sized at 2560×1440, their largest stream. The 12 MP fisheye runs 30 fps.
  Removed the unsupported "up to 17.8 W" and "PB variant" notes.

### Added
- Milesight Motorized Pro Domes (MS-C2972 / C5372 / C8172), the 4K fisheye
  MS-C8274-PA, seven AI Speed Domes (MS-C2941 / C5341 / C8241) and seven
  road-traffic cameras (TS series). Presets whose ids predate the check keep
  them so saved projects still load.

## 0.7.2 — 2026-09-30

### Added
- **Milesight presets.** 27 Milesight AI-series cameras (mini, vandal-proof,
  weather-proof and motorized domes; mini, motorized and Pro Bullet Plus
  bullets; LPR; 180° panoramic; 360° fisheye; 12× PTZ bullets) with datasheet
  resolution, frame rate, IR and maximum PoE draw.

## 0.7.1 — 2026-09-30

### Added
- **UniFi presets.** 24 Ubiquiti UniFi Protect cameras (G4, G5, G6 and AI
  series, PTZs, LPR, 360/Theta, Doorbell Pro) with resolution, maximum frame
  rate, IR and maximum PoE draw from the published spec sheets. Presets are
  now grouped by vendor in the dropdown.

## 0.7.0 — 2026-09-30

### Added
- **Several recorders per site.** A Recorders panel lists each NVR/DVR with its
  own disk size, RAID, bays and rated input; camera groups pick which one they
  record to. Each is sized separately; the summary shows the total and a bay
  diagram per recorder.
- **Camera presets.** A per-group dropdown of generic camera types (domes,
  bullets, PTZ, LPR, fisheye, multi-sensor, HD-over-coax, analog) that fills
  in resolution, codec, frame rate, IR and PoE. Editing any of those marks the
  group Custom again.
- **Cloud (VSaaS) recording.** Groups sent to the cloud are sized in GB for
  the plan (per retention period and per month) and their uploads are checked
  against the internet upload speed.
- **Edge SD-card recording.** Groups on SD cards report the days each card
  holds against the retention requirement.
- **Archive tier.** Keep recent days on the recorders and size a NAS or cloud
  archive for the rest.
- **Save and load projects** as `.cctv.json` files, plus copy/paste as text
  for hosts that block downloads.
- **Printable report** with summary, recorders, camera groups, switches,
  checks and sign-off lines; prints or saves as PDF from the browser.
- GitHub Pages now deploys on every push to `main`.

### Changed
- Recorder settings moved from the Site panel into the Recorders panel.
  Saved projects from earlier versions load unchanged.

## 0.6.3 — 2026-09-30

### Changed
- The reason for a red or amber status is now shown directly under the
  headline figure, not only in the check list further down.

## 0.6.2 — 2026-09-30

### Changed
- Fonts are embedded in the page, so it works with no internet connection and
  makes no external requests at all. The file grows by about 260 KB.
  `npm run fonts` refreshes them.

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
