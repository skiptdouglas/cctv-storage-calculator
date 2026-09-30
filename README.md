# CCTV Storage Calculator

Works out how much recording storage a CCTV / IP camera system needs, and which
disk array to buy, following the procedure in [`docs/SOP.md`](docs/SOP.md)
(SOP-VSS-001).

It's a single self-contained web page: no server, no install, no account.
Everything you type stays in your browser.

## What it does

- **Camera groups:** enter quantity, resolution (analog CIF, D1 and 960H, then 1 to 12 MP), codec (H.264, Smart H.264+,
  H.265, Smart H.265+, AV1 or MJPEG), quality, frame rate with an optional
  lower night frame rate, scene activity, recording mode (continuous,
  scheduled or motion), night IR and audio. Each group gets an estimated bitrate from the SOP planning table.
  Enter a **measured bitrate** to override the estimate.
- **Two estimate methods:** typical bitrates from the SOP table (default), or
  raw pixels (width × height × color depth × fps, with 16-bit color below 4K
  and 30-bit at 4K and above) divided by an editable compression ratio per
  codec. The other method's result is always shown for comparison.
- **Storage:** GB per day per camera (`Mbps × duty × 10.8`), raw recording for
  the retention period, then ×1.05 file-system overhead and ×1.20 (or more)
  headroom.
- **Disk array:** picks the disk count for RAID 6, RAID 5, RAID 10 or no RAID,
  adds a hot spare at 8+ disks, and shows usable TB and the TiB figure the OS
  will display. A bay diagram shows data, parity and spare disks.
- **Throughput:** total camera traffic and the minimum recorder rating
  (traffic ÷ 0.7), viewing traffic out of the recorder (live view on sub or
  main streams, plus playback), and disk write and playback read in MB/s.
- **Switches:** assign camera groups to PoE switches to see each uplink's load
  (limit 70%) and PoE power draw (limit 80% of budget). PoE is estimated per
  camera, or you can enter the datasheet figure.
- **Design checks:** flags no-RAID arrays (critical for evidential footage,
  a warning for systems marked non-critical), oversized RAID 5, headroom below ×1.20, too
  few drive bays, an under-rated recorder, overloaded switch uplinks or PoE
  budgets, viewing traffic beyond the recorder or WAN link, and unverified
  smart-codec savings.
  It also confirms the expected retention in days.
- **Existing sites:** set a recorder to "Check existing", enter the disks
  installed, and see the days that fit, the storage to add if it falls short,
  or roughly how many more cameras it has room for.
- **Several recorders:** add NVRs or DVRs in the Recorders panel and choose
  which one each camera group records to. Each is sized on its own.
- **Presets:** pick a generic camera type (dome, bullet, PTZ, LPR, fisheye,
  multi-sensor, HD-over-coax, analog) to fill in resolution, codec, frame
  rate, IR and PoE.
- **Cloud, SD cards and archive:** groups can record to a cloud plan (sized
  in GB, uploads checked against the internet connection) or to SD cards
  (days per card), and an archive tier can hold older footage off the
  recorders.
- **Save, load and print:** save a project as a `.cctv.json` file or copy it
  as text, load it back later, and print a report or save it as PDF.
- **Export:** copy a plain-text report or a CSV of the camera groups.

The page opens with the SOP's worked example (40 cameras, 30 days → 60.8 TB
usable, 9 × 12 TB RAID 6 + hot spare). Use **Clear all** to start your own.

## Use it

```bash
npm run build        # writes dist/index.html
open dist/index.html # or double-click it; any static host works too
```

`dist/index.html` is one file with everything inlined. You can email it, put it
on a file share, or host it on GitHub Pages (turn on Pages once under Settings →
Pages → Source: GitHub Actions; every push to `main` then publishes). It works
fully offline: the fonts are embedded in the file.

## Develop

Requires Node 18 or newer. There are no dependencies.

```bash
npm test             # unit tests for the calculation engine (node:test)
npm run build        # build dist/index.html and dist/artifact.html
npm run test:smoke   # browser smoke test; needs `npm i --no-save playwright`
npm run serve        # build and serve dist/ on http://localhost:8080
```

| Path                    | What it is                                                      |
| ----------------------- | --------------------------------------------------------------- |
| `src/calc.js`           | Calculation engine. Pure functions, works in browser and Node.  |
| `src/page.html`         | UI: markup, styles and app script. `<!-- @calc -->` marks where the engine is inlined. |
| `scripts/build.js`      | Inlines the engine and fonts and writes the single-file builds. |
| `scripts/fetch-fonts.js`| Re-downloads the fonts into `src/fonts.css` (needs network).    |
| `src/fonts.css`         | Embedded fonts (SIL Open Font License).                         |
| `test/calc.test.js`     | Engine tests, including the SOP worked example.                 |
| `test/smoke.test.js`    | Browser smoke test of the built page (Playwright).              |
| `CHANGELOG.md`          | What changed in each version.                                   |
| `docs/SOP.md`           | The standard operating procedure the calculator implements.     |
| `docs/HANDOFF.md`       | Where things stand and what to do next.                         |

To change a planning bitrate, duty cycle or threshold, edit the tables and the
`K` constants at the top of `src/calc.js`. Update `docs/SOP.md` to match and
run `npm test`.

## Limits

- Table 1 bitrates are generic planning figures. Use the manufacturer's
  calculator or measured bitrates for final designs, and measure after install
  (SOP §7).
- Cloud plans are sized in GB only; pricing and per-camera plan limits vary by
  provider.
- Generic presets are planning types, not vendor models. The UniFi presets
  use Ubiquiti's published specs (see below) but the bitrate is still an
  estimate: UniFi Protect sets it from a quality level, so read the actual
  figure in the camera's settings and enter it as Measured.

## UniFi presets

Values were checked against techspecs.ui.com and Ubiquiti's datasheets in
October 2026. Presets assume Enhanced (H.265) encoding; Standard is
H.264.

| Preset | Resolution | Max fps | IR | Max PoE |
| --- | --- | --- | --- | --- |
| G4 Bullet | 4 MP 2688×1512 | 24 | yes | 4 W |
| G4 Dome | 4 MP | 24 | yes | 5 W |
| G4 Pro | 8 MP 4K | 50 (preset 30) | yes | 12.5 W |
| G4 PTZ | 8 MP 4K, 22× | 24 | yes | 42.9 W PoE++ |
| G4 Doorbell Pro | 2 MP 1600×1200 | 30 | yes | 10 W (16–24 V AC or USB-C; PoE via adapter) |
| G5 Bullet / Flex / Turret Ultra | 4 MP 2688×1512 | 30 | yes | 4 W |
| G5 Dome | 4 MP | 30 | yes | 5 W |
| G5 Dome Ultra | 4 MP | 30 | yes | 4.2 W |
| G5 Pro | 8 MP 4K, 3× | 30 | yes | 10 W (12.95 W with Enhancer) |
| G5 PTZ | 4 MP, 2× | 30 | yes, 20 m | 14 W PoE+ |
| G6 Bullet | 8 MP 4K | 30 | yes | 9.9 W |
| G6 Turret | 8 MP 4K | 30 | yes | 12.5 W |
| G6 Dome | 8 MP 4K | 30 | yes | 9.25 W |
| G6 Pro Dome | 8 MP 4K | 30 | yes | 15 W |
| G6 PTZ | 8 MP 4K dual lens | 30 | yes | 24.5 W |
| AI Pro | 8 MP 4K | 30 | yes | 11 W (22 W with Enhancer) |
| AI Turret | 8 MP 4K | 30 | yes, 40 m | 20 W PoE+ |
| AI Dome | 8 MP 4K | 30 | yes | 10 W |
| AI LPR | 8 MP 4K, 3× | 30 | yes, 15 m | 25.5 W PoE+ |
| AI 360 | 4 MP 1920×1920 | 30 | yes | 8.64 W |
| AI Theta | 8 MP 3264×2448 (360 lens: 6 MP, 20 fps) | 24 | unverified | 12.5 W |
| AI Theta Pro | 4 MP 2160×2160 | 24 | unverified | 12.5 W |

Not included: G4/G6 Instant and the doorbells other than G4 Doorbell Pro
(USB or Wi-Fi powered, no PoE figure), AI Bullet, AI DSLR and G6 Entry (no
power figure found). "Unverified" means the spec sheet does not say whether
the model has IR illumination; the Theta models are set to no IR. The Theta's
360-lens resolution (6 MP) is also unconfirmed.

## Milesight presets

Values were checked against Milesight's datasheets (resource.milesight.com,
linked from milesight.com/support/download/datasheet) in October 2026. Power
is the datasheet maximum with IR on (PoE figure where both PoE and DC are
given). All models support H.265+; presets assume plain H.265, so tick the
smart codec yourself if you will enable it. Where a camera runs faster than
30 fps the preset uses 30.

| Preset | Models | Resolution | fps (max) | Max PoE (IR on) |
| --- | --- | --- | --- | --- |
| AI Weather-proof Mini Dome | MS-C2975 / C5375 / C8175-PD | 2 / 5 MP / 4K | 30 (2 MP R: 60) | 5.1 / 5.8 / 6.6 W |
| AI Vandal-proof Mini Dome | MS-C2973 / C5373 / C8173-PD | 2 / 5 MP / 4K | 30 (2 MP R: 60) | 4.7 / 6 / 6.1 W |
| AI Motorized Dome | MS-C2975 / C5375 / C8175-FPD | 2 / 5 MP / 4K | 30 (2 MP R: 60) | 6.4 / 6.5 / 8.4 W |
| AI Motorized Pro Dome | MS-C2972-RFPE / C5372 / C8172-FPE | 2 / 5 MP / 4K | 30 (2 MP: 60) | 8.5 / 6.8 / 8.1 W |
| AI 12× PTZ Dome | MS-C5371-X12PE | 5 MP | 30 | 17.3 W PoE+ |
| AI Vandal-proof Mini Bullet | MS-C2964 / C5364 / C8164-PD | 2 / 5 MP / 4K | 30 | 5.1 / 5.4 / 5.8 W |
| AI Motorized Bullet | MS-C2964-RFPE / C5364 / C8164-FPE | 2 / 5 MP / 4K | 30 (2 MP: 60) | 11.5 / 11 / 13 W |
| AI Motorized Pro Bullet Plus | MS-C2966-RFPE / C5366 / C8166-FPE | 2 / 5 MP / 4K | 30 (2 MP: 60) | 16.1 / 11 / 12.1 W |
| AI LPR Pro Bullet Plus | MS-C2966-RFLPE | 2 MP | 30 (60) | 10.54 W |
| AI 180° Panoramic Mini Dome | MS-C5376-PE / MS-C8176-PE | 4 MP 2560×1440 (5 MP sensor) / 4K | 30 / 25 | 8.8 / 9 W |
| AI 180° Panoramic Mini Bullet | MS-C5365-PE / MS-C8165-PE | 4 MP 2560×1440 (5 MP sensor) / 4K | 30 / 25 | 7.7 / 8.4 W |
| AI 360° Fisheye | MS-C8274-PA / MS-C9674-PA | 4K / 12 MP 4000×3000 | 30 (25 at 50 Hz) | 8 / 11 W |
| AI 12× PTZ Bullet | MS-C2961-X12PE / MS-C5361-X12PE | 2 / 5 MP | 30 (2 MP: 60) | 20.2 / 19.3 W PoE+ |
| AI Speed Dome 25× / 30× / 42× | MS-C2941-X25 / X30 / X42RPE | 2 MP | 30 (60) | 28.7 / 28 / 24.2 W |
| AI Speed Dome 25× / 30× / 42× | MS-C5341-X25 / X30 / X42PE | 5 MP | 30 | 27.7 / 25.2 / 25.5 W |
| AI Speed Dome 36× | MS-C8241-X36PE | 4K | 30 | 28.4 W |
| AI Road Traffic Pro Bullet Plus | TS2966-X12TPE / TS4466-X4RPE / TS5366-X12PE / TS8266-X4PE | 2 / 4 / 5 MP / 4K | 30 (2 MP: 90, 4 MP: 60) | 11.4 / 13.1 / 12.7 / 12.35 W |
| AI Road Traffic PTZ Bullet Plus | TS4467-X20RPE / TS5367-X12PE | 4 / 5 MP | 30 (4 MP: 60) | 25.9 / 21.7 W |
| AI Road Traffic Speed Dome | TS4441-X36RPE | 4 MP | 30 (60) | 26.8 W |

Speed domes and some traffic cameras draw more than the 25.5 W an 802.3at
(PoE+) port delivers, although the datasheet lists 802.3at. Plan a PoE++ port
or the camera's 24 V AC/DC (or 12 V DC) supply for those.

Not included: thermal and bi-spectrum cameras (none found on Milesight's
datasheet page), a 5 MP fisheye (no longer listed), the 4 MP speed dome
MS-C4441, and the other traffic families (supplement lights, radar,
TrafficX), which were not checked.

## License

MIT
