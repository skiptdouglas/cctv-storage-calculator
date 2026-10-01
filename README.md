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
| G6 PTZ | 8 MP 4K, wide + tele, 10× hybrid | 30 | yes, 30 m | 24.5 W PoE+ |
| AI Pro | 8 MP 4K | 30 | yes | 11 W (22 W with Enhancer) |
| AI Turret | 8 MP 4K | 30 | yes, 40 m | 20 W PoE+ |
| AI Dome | 8 MP 4K | 30 | yes | 10 W |
| AI LPR | 8 MP 4K, 3× | 30 | yes, 15 m | 25.5 W PoE+ |
| AI PTZ Precision | 8 MP 4K, 31× | 30 | yes, 100 m | 51 W PoE++ |
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

Presets are grouped by family in the dropdown, as below. Notes on each preset
give the exact resolution where it differs from the size bucket, the
camera's top frame rate, and power caveats.

### Domes

| Preset | Models | Resolution | Max PoE (IR on) |
| --- | --- | --- | --- |
| AI Weather-proof Mini Dome | MS-C2975-PD / MS-C5375-PD / MS-C8175-PD / MS-C4575-PD | 2 MP / 5 MP / 4K / 4 MP | 5.1 W / 5.8 W / 6.6 W / 5.8 W |
| AI Vandal-proof Mini Dome | MS-C2973-PD / MS-C5373-PD / MS-C8173-PD / MS-C4573-PD | 2 MP / 5 MP / 4K / 4 MP | 4.7 W / 6 W / 6.1 W / 6 W |
| AI Motorized Dome | MS-C2975-FPD / MS-C5375-FPD / MS-C8175-FPD / MS-C4575-FPD | 2 MP / 5 MP / 4K / 4 MP | 6.4 W / 6.5 W / 8.4 W / 6.5 W |
| AI Motorized Pro Dome | MS-C2972-RFPE / MS-C5372-FPE / MS-C8172-FPE / MS-C4472-RFPE / MS-C6772-FPE / MS-C8272-FPE | 2 MP / 5 MP / 4K / 4 MP / 6 MP / 4K | 8.5 W / 6.8 W / 8.1 W / 7.6 W / 7 W / 8 W |
| AI IR Mini Dome | MS-C2983-PD / MS-C4583-PD / MS-C5383-PD / MS-C8183-PD | 2 MP / 4 MP / 5 MP / 4K | 4.6 W / 5 W / 5 W / 5.4 W |
| AI TrueColor Pro Dome | MS-CQ4472-HPG1 / MS-CQ5472-HPG1 / MS-CQ8172-HPG1 / MS-CQ8272-HPG1 | 4 MP / 5 MP / 4K / 4K | 7.72 W / 8 W / 8.5 W / 9.6 W |
| AI TrueColor Turret | MS-CQ4431-HYPG1 / MS-CQ5431-HYPG1 / MS-CQ8131-HYPG1 / MS-CQ8231-HYPG1 | 4 MP / 5 MP / 4K / 4K | 9.62 W / 10 W / 11.5 W / 11.5 W |
| OpenVision Pro Dome | MS-C5372-RFIPKG1 / MS-C8272-RFIPKG1 | 5 MP / 4K | 10.5 W / 11 W |

### Bullets

| Preset | Models | Resolution | Max PoE (IR on) |
| --- | --- | --- | --- |
| AI Vandal-proof Mini Bullet | MS-C2964-PD / MS-C5364-PD / MS-C8164-PD / MS-C4564-PD | 2 MP / 5 MP / 4K / 4 MP | 5.1 W / 5.4 W / 5.8 W / 5.4 W |
| AI Motorized Bullet | MS-C2964-RFPE / MS-C5364-FPE / MS-C8164-FPE / MS-C2964-FPD | 2 MP / 5 MP / 4K / 2 MP | 11.5 W / 11 W / 13 W / 7 W |
| AI Motorized Pro Bullet Plus | MS-C2966-RFPE / MS-C5366-FPE / MS-C8166-FPE / MS-C4466-RFPE / MS-C6766-FPE / MS-C8266-FPE | 2 MP / 5 MP / 4K / 4 MP / 6 MP / 4K | 16.1 W / 11 W / 12.1 W / 16.1 W / 10.5 W / 13.7 W |
| AIoT Pro Bullet Plus 12× | MS-C2966-X12ROPC | 2 MP | 15 W |
| AI Color+ Vandal-proof Mini Bullet | MS-C2964-UPD / MS-C5364-UPD / MS-C8164-UPD | 2 MP / 5 MP / 4K | 5 W / 5 W / 6 W |
| AI Weather-proof Mini Bullet | MS-C2963-RPE / MS-C5363-PE / MS-C8163-PE / MS-C2963-PD | 2 MP / 5 MP / 4K / 2 MP | 9 W / 9 W / 10.2 W / 9 W |
| AI Pro Bullet Plus 12× | MS-C2966-X12RPE / MS-C5366-X12PE | 2 MP / 5 MP | 16.1 W / 15.2 W |
| AI Pro Bullet Plus 4× | MS-C4466-X4RPE / MS-C8266-X4PE | 4 MP / 4K | 15.6 W / 16 W |
| AI Motorized Pro Bullet | MS-C2962-RFPE / MS-C5362-FPE / MS-C6762-FPE / MS-C8162-FPE | 2 MP / 5 MP / 6 MP / 4K | 10.6 W / 9.7 W / 9.6 W / 10.6 W |
| AI TrueColor Bullet | MS-CQ4468-HYPG1 / MS-CQ5468-HYPG1 / MS-CQ8168-HYPG1 / MS-CQ8268-HYPG1 | 4 MP / 5 MP / 4K / 4K | 9.86 W / 10 W / 11.5 W / 11.5 W |
| OpenVision Pro Bullet Plus | MS-C5366-RFIPKG1 / MS-C8266-RFIPKG1 | 5 MP / 4K | 16 W / 17.5 W |

### Panoramic & multi-sensor

| Preset | Models | Resolution | Max PoE (IR on) |
| --- | --- | --- | --- |
| AI 180° Panoramic Mini Dome | MS-C5376-PE / MS-C8176-PE | 4 MP 2560×1440 / 4K | 8.8 W / 9 W |
| AI 180° Panoramic Mini Bullet | MS-C5365-PE / MS-C8165-PE | 4 MP 2560×1440 / 4K | 7.7 W / 8.4 W |
| AI 360° Fisheye | MS-C8274-PA / MS-C9674-PA | 4K / 12 MP | 8 W / 11 W |
| AI 4×5 MP Multi-directional | MS-C5321-FPE | 5 MP | 22.4 W per unit |
| AI Dual-sensor 180° Panoramic | MS-C8477-PC | 5084×1520 | 12 W |
| OpenVision TrueColor Dual-sensor 180° Panoramic | MS-C8477-HPKG1 | 5120×1520 | 15 W |

### PTZ & speed domes

| Preset | Models | Resolution | Max PoE (IR on) |
| --- | --- | --- | --- |
| AI 12× PTZ Dome | MS-C5371-X12PE | 5 MP | 17.3 W |
| AI 12× PTZ Bullet | MS-C2961-X12PE / MS-C5361-X12PE | 2 MP / 5 MP | 20.2 W / 19.3 W |
| AI 25× Speed Dome | MS-C2941-X25RPE / MS-C5341-X25PE | 2 MP / 5 MP | 28.7 W / 27.7 W |
| AI 30× Speed Dome | MS-C2941-X30RPE / MS-C5341-X30PE | 2 MP / 5 MP | 28 W / 25.2 W |
| AI 42× Speed Dome | MS-C2941-X42RPE / MS-C5341-X42PE | 2 MP / 5 MP | 24.2 W / 25.5 W |
| AI 36× Speed Dome | MS-C8241-X36PE | 4K | 28.4 W |
| AI PTZ Bullet Plus 12× | MS-C2967-X12RPE / MS-C5367-X12PE | 2 MP / 5 MP | 25.3 W / 21.7 W |
| AI PTZ Bullet Plus 23× | MS-C2967-X23RPE / MS-C5367-X23PE | 2 MP / 5 MP | 21.7 W / 25 W |
| AI PTZ Bullet Plus 20× | MS-C4467-X20RPE / MS-C8267-X20PE | 4 MP / 4K | 24 W / 25 W |
| AI PTZ Dome 12× | MS-C2971-X12RPE | 2 MP | 17 W |
| AI PTZ Dome 23× | MS-C2971-X23RPE | 2 MP | 19 W |
| AI PTZ Dome 20× | MS-C4471-X20RPE | 4 MP | 20.3 W |
| AI Speed Dome 36× | MS-C4441-X36RPE | 4 MP | 26.8 W |
| AI 5-inch Speed Dome 25× | MS-C5342-X25RPG1 | 5 MP | 21 W |

### Traffic & LPR

| Preset | Models | Resolution | Max PoE (IR on) |
| --- | --- | --- | --- |
| AI LPR Pro Bullet Plus | MS-C2966-RFLPE | 2 MP | 10.54 W |
| AI Road Traffic Pro Bullet Plus 12× | TS2966-X12TPE / TS5366-X12PE / TS5366-X12RIPG1 | 2 MP / 5 MP / 5 MP | 11.4 W / 12.7 W / 16.7 W |
| AI Road Traffic Pro Bullet Plus 4× | TS4466-X4RPE / TS8266-X4PE / TS4466-X4RIPG1 / TS8266-X4RIPG1 | 4 MP / 4K / 4 MP / 4K | 13.1 W / 12.35 W / 17.8 W / 19.1 W |
| AI Road Traffic PTZ Bullet Plus 20× | TS4467-X20RPE | 4 MP | 25.9 W |
| AI Road Traffic PTZ Bullet Plus 12× | TS5367-X12PE | 5 MP | 21.7 W |
| AI Road Traffic Speed Dome 36× | TS4441-X36RPE | 4 MP | 26.8 W |
| AI Road Traffic Radar Pro Bullet Plus 4× | TS4466-X4RIVPG1 / TS8266-X4RIVPG1 / TS4466-X4RVPE / TS8266-X4VPE | 4 MP / 4K / 4 MP / 4K | 21 W / 21.6 W / 15.6 W / 16.6 W |
| AI Road Traffic Radar Motorized Pro Bullet Plus | TS4466-RFIVPG1 / TS8266-RFIVPG1 | 4 MP / 4K | 20.4 W / 21 W |
| AI Road Traffic Radar Pro Bullet Plus 12× | TS2966-X12TVPE / TS5366-X12VPE | 2 MP / 5 MP | 17 W / 16 W |
| AI Road Traffic PTZ Bullet 12× | TS2961-X12TPE | 2 MP | 18.9 W |

Speed domes and some traffic cameras draw more than the 25.5 W an 802.3at
(PoE+) port delivers, although the datasheet lists 802.3at. Plan a PoE++ port
or the camera's 24 V AC/DC (or 12 V DC) supply for those.

Not included: thermal and bi-spectrum cameras (none on Milesight's datasheet
page); solar, 4G and 5G kits; project-based and pre-NDAA datasheet copies;
models that run only from 12 V or 24 V (TrafficX, road-traffic supplement-light
cameras, the TS4441 24 V variant); and the AI TrueColor Dual-sensor 180°
Panoramic, whose datasheet link returned 404. The AI 4×5 MP Multi-directional
camera is one row per sensor: enter 4 cameras per unit.

## Hikvision presets

Values are from the datasheets linked on hikvision.com product pages
(assets.hikvision.com), October 2026: the Pro Series (DS-2CD2xxx), Ultra
Series (DS-2CD3xxx), DeepinView (iDS-2CD7xxx), PanoVu and fisheye
(DS-2CD6xxx) and PTZ (DS-2DE) lines. Power is the datasheet's PoE maximum.
Presets assume H.265; Hikvision's H.265+ is the smart codec.

Hikvision is on the US NDAA §889 and FCC covered lists: barred from US federal
procurement and from new FCC equipment authorisations. Check whether that
applies to your project before specifying it.

ColorVu models use white light instead of IR, so their presets have night IR
off. Smart hybrid light models default to IR. Model codes keep Hikvision's
bracketed option letters, e.g. `DS-2CD2147G2-L(SU)`.

### Domes

| Model | Type | Resolution | fps | Max PoE |
| --- | --- | --- | --- | --- |
| DS-2CD2143G2-IS | Pro AcuSense Fixed Dome | 4 MP | 30 | 6.5 W |
| DS-2CD2146G2-I | Pro AcuSense Fixed Dome | 4 MP | 30 | 6.5 W |
| DS-2CD2147G2-L(SU) | Pro ColorVu Fixed Dome | 4 MP | 30 | 6.5 W |
| DS-2CD2147G3-LI(S2U)Y | Pro Smart Hybrid Light with ColorVu Fixed Dome | 4 MP | 30 | 9 W |
| DS-2CD2166G2-ISU | Pro AcuSense Fixed Dome | 6 MP | 30 | 7.5 W |
| DS-2CD2167G3-LIS2UY | Pro Smart Hybrid Light ColorVu Fixed Dome | 6 MP | 30 | 10.5 W |
| DS-2CD2183G2-IS | Pro AcuSense Vandal WDR Fixed Dome | 4K | 20 | 7.5 W |
| DS-2CD2186G2-I(SU) | Pro AcuSense DarkFighter Fixed Dome | 4K | 24 | 7.5 W |
| DS-2CD2187G2-LSU | Pro ColorVu Fixed Dome | 4K | 24 | 8.5 W |
| DS-2CD2187G3-LIS2UY | Pro Smart Hybrid Light with ColorVu Fixed Mini Dome | 4K | 30 | 10.5 W |
| DS-2CD2343G2-I(U) | Pro AcuSense Fixed Turret | 4 MP | 30 | 7 W |
| DS-2CD2346G2-I(U) | Pro AcuSense DarkFighter Fixed Turret | 4 MP | 30 | 6.8 W |
| DS-2CD2347G2-L(U) | Pro ColorVu Fixed Turret | 4 MP | 30 | 7.6 W |
| DS-2CD2347G3-LI2UY | Pro Smart Hybrid Light with ColorVu Fixed Turret | 4 MP | 30 | 11 W |
| DS-2CD2366G2-I | Pro AcuSense Fixed Turret | 6 MP | 30 | 6.5 W |
| DS-2CD2367G2-L | Pro ColorVu Fixed Turret | 6 MP | 24 | 10.5 W |
| DS-2CD2383G2-I | Pro AcuSense Fixed Turret | 4K | 20 | 7.5 W |
| DS-2CD2386G2-I(U) | Pro AcuSense DarkFighter Fixed Turret | 4K | 24 | 6.8 W |
| DS-2CD2387G2-L(U) | Pro ColorVu Fixed Turret | 4K | 24 | 6.5 W |
| DS-2CD2387G3-LI2UY | Pro Smart Hybrid Light with ColorVu Fixed Turret | 4K | 30 | 11 W |
| DS-2CD2H86G2-IZS | Pro AcuSense DarkFighter Motorized Varifocal Turret | 4K | 24 | 12.5 W |
| DS-2CD3143G2-I(S)U | Ultra Vandal WDR Fixed Dome | 4 MP | 30 | 10 W |
| DS-2CD3146G2-IS(U) | Ultra AcuSense Fixed Dome | 4 MP | 30 | 9 W |
| DS-2CD3147G3-LISUY | Ultra Dual Illumination Fixed Mini Dome | 4 MP | 30 | 11 W |
| DS-2CD3186G2-IS(U)(H) | Ultra AcuSense Fixed Dome | 4K | 24 | 9.5 W |
| DS-2CD3187G3-LISUY | Ultra Dual Illumination Fixed Mini Dome | 4K | 30 | 11.5 W |
| DS-2CD3343G2-I(S)U(B) | Ultra AcuSense Fixed Turret | 4 MP | 30 | 9 W |
| DS-2CD3346G2-IS(U) | Ultra AcuSense Fixed Turret | 4 MP | 30 | 8.5 W |
| DS-2CD3347G2-LS(U) | Ultra ColorVu Fixed Turret | 4 MP | 30 | 7.6 W |
| DS-2CD3347G3-LISUY | Ultra Dual Illumination Fixed Turret | 4 MP | 30 | 11 W |
| DS-2CD3386G2-IS(U)(H) | Ultra AcuSense Fixed Turret | 4K | 24 | 9.5 W |
| DS-2CD3387G2-LSU | Ultra ColorVu Fixed Turret | 4K | 24 | 6.6 W |
| DS-2CD3387G3-LISU | Ultra Dual Illumination Fixed Turret | 4K | 30 | 11 W |
| iDS-2CD7146G2-IZ(H)S(Y)(1T) | DeepinView Moto Varifocal Dome | 4 MP | 30 | 16.8 W (PoE+) |
| iDS-2CD7547G2-XZHS(Y) | DarkFighterS DeepinView PTRZ Dome | 4 MP | 30 | 20.5 W (PoE+) |

### Bullets

| Model | Type | Resolution | fps | Max PoE |
| --- | --- | --- | --- | --- |
| DS-2CD2043G2-I(U) | Pro AcuSense Fixed Bullet | 4 MP | 30 | 7 W |
| DS-2CD2046G2-I(U) | Pro AcuSense DarkFighter Fixed Bullet | 4 MP | 30 | 7 W |
| DS-2CD2047G2-L(U) | Pro ColorVu Fixed Mini Bullet | 4 MP | 30 | 7.5 W |
| DS-2CD2047G3-LIY | Pro Smart Hybrid Light with ColorVu Fixed Mini Bullet | 4 MP | 30 | 6.5 W |
| DS-2CD2066G2-IU | Pro AcuSense Fixed Bullet | 6 MP | 30 | 7.2 W |
| DS-2CD2067G2-LU | Pro ColorVu Fixed Mini Bullet | 6 MP | 24 | 7.5 W |
| DS-2CD2083G2-I | Pro AcuSense Fixed Bullet | 4K | 20 | 7.2 W |
| DS-2CD2086G2-I(U) | Pro AcuSense DarkFighter Fixed Mini Bullet | 4K | 24 | 7.2 W |
| DS-2CD2087G2-L(U) | Pro ColorVu Fixed Bullet | 4K | 24 | 7.5 W |
| DS-2CD2087G3-LIY | Pro Smart Hybrid Light with ColorVu Fixed Mini Bullet | 4K | 30 | 7 W |
| DS-2CD2T46G2-4IY | Pro AcuSense DarkFighter Fixed Bullet | 4 MP | 30 | 12 W |
| DS-2CD2T47G2-L | Pro ColorVu Fixed Bullet | 4 MP | 30 | 10.5 W |
| DS-2CD2T87G2-L | Pro ColorVu Fixed Bullet | 4K | 24 | 9.5 W |
| DS-2CD2T87G3-LIY | Pro Smart Hybrid Light Fixed Bullet | 4K | 30 | 12.5 W |
| DS-2CD3043G2-LIU | Ultra AcuSense Smart Hybrid Light Fixed Bullet | 4 MP | 30 | 8 W |
| DS-2CD3043G3-LIUY | Ultra AcuSense Smart Hybrid Light Fixed Bullet | 4 MP | 30 | 7.3 W |
| DS-2CD3046G3-IUY | Ultra AcuSense Fixed Mini Bullet | 4 MP | 30 | 8 W |
| DS-2CD3047G2-LS | Ultra ColorVu Fixed Mini Bullet | 4 MP | 30 | 8.5 W |
| DS-2CD3047G3-LIUY | Ultra Dual Illumination Fixed Mini Bullet | 4 MP | 30 | 6.5 W |
| DS-2CD3086G3-LIU(Y) | Ultra Dual Illumination Fixed Mini Bullet | 4K | 30 | 7 W |
| DS-2CD3087G2-LSU | Ultra ColorVu Fixed Bullet | 4K | 24 | 8.5 W |
| DS-2CD3087G3-LIU | Ultra Dual Illumination Fixed Mini Bullet | 4K | 30 | 7 W |
| DS-2CD3646G3T-IZSUY | Ultra AcuSense Varifocal Bullet | 4 MP | 30 | 18 W (PoE+) |
| DS-2CD3686G2-IZS | Ultra AcuSense IR Varifocal Bullet | 4K | 24 | 15 W |
| IDS-2CD7A46G2/V-XZHS(Y) | DeepinViewX Moto Varifocal Bullet | 4 MP | 30 | 23.1 W (PoE+) |
| IDS-2CD7A86G2/V-XZHS(Y) | DeepinViewX Moto Varifocal Bullet | 4K | 30 | 24.7 W (PoE+) |
| iDS-2CD7A87G2-XZHS(Y) | DarkFighterS DeepinView Moto Varifocal Bullet | 4K | 30 | 25 W (PoE+) |
| iDS-2CD7T46G2/VX3-I(H)S(Y) | DeepinView Triple Fixed Lens Bullet | 4 MP | 30 | 25.5 W (PoE+) |

### Panoramic & multi-sensor

| Model | Type | Resolution | fps | Max PoE |
| --- | --- | --- | --- | --- |
| DS-2CD2347G3P-LIS2UY/S(L)(RB) | Pro Panoramic ColorVu Fixed Turret | 3040×1368 | 24 | 24 W (PoE+) |
| DS-2CD2387G2P-LSU/SL | Pro Panoramic Fixed Turret | 5120×1440 | 20 | 12.5 W |
| DS-2CD2T87G2P-LSU/SL | Pro Panoramic Fixed Bullet | 5120×1440 | 20 | 12.5 W |
| DS-2CD3956G2-IS(U) | Ultra AcuSense Fisheye | 2560×1920 | 30 | 7.5 W |
| DS-2CD6365G1-IVS | DeepinView Fisheye | 2560×2560 | 30 | 12.5 W |
| DS-2CD63C5G1-IVS | DeepinView IR Fisheye | 3504×3504 | 30 | 12.5 W |
| DS-2CD6944G1-IHS(U)Y | 180° PanoVu | 4800×2688 | 30 | 25 W (PoE+) |
| DS-2CD6D54G2-IZHS | 4-Directional Multisensor | 5 MP | 30 | 25 W (PoE+) per unit |
| DS-2CD6D82G2-IS | Dual-Directional PanoVu | 4K | 20 | 14 W per unit |
| DS-2CD6W65G1-IVS | DeepinView Fisheye | 2560×2560 | 30 | 10 W |

### PTZ & speed domes

| Model | Type | Resolution | fps | Max PoE |
| --- | --- | --- | --- | --- |
| DS-2DE2A404IW-DE3(S6) | 4x IR PTZ | 4 MP | 30 | 9.2 W |
| DS-2DE2A404IWG1-E | 4X IR Mini Outdoor AcuSense PTZ | 4 MP | 30 | 9.2 W |
| DS-2DE3A404IW-DE(S6) | 4 x IR PTZ | 4 MP | 30 | 14 W |
| DS-2DE4A225IWG-E | 25X DarkFighter IR AcuSense Speed Dome | 2 MP | 30 | 24 W (PoE+) |
| DS-2DE4A425IWG1-E | 25X DarkFighter IR AcuSense Speed Dome | 4 MP | 30 | 24 W (PoE+) |
| DS-2DE5425IWG-E | 25x IR Speed Dome | 4 MP | 30 | 24 W (PoE+) |
| DS-2DE5425IWG1-E | 25X DarkFighter IR AcuSense Speed Dome | 4 MP | 30 | 24 W (PoE+) |
| DS-2DE5432IWG1-E | 32X DarkFighter IR AcuSense Speed Dome | 4 MP | 30 | 24 W (PoE+) |
| DS-2DE7A232IWG-EB | 32 x IR Speed Dome | 2 MP | 30 | 42 W (Hi-PoE) |
| DS-2DE7A232IWG1-E | 32X DarkFighter IR AcuSense Speed Dome | 2 MP | 30 | 48 W (PoE++) |
| DS-2DE7A425IWG1-E | 25X DarkFighter IR AcuSense Speed Dome | 4 MP | 30 | 48 W (PoE++) |
| DS-2DE7A432IWG1-E | 32X DarkFighter IR AcuSense Speed Dome | 4 MP | 30 | 48 W (PoE++) |
| DS-2DE7A825IWG-EB | 25 x IR Speed Dome | 4K | 24 | 42 W (Hi-PoE) |
| DS-2DE7A825IWG1-E | 25X DarkFighter IR AcuSense Speed Dome | 4K | 30 | 48 W (PoE++) |

Not included: Value Series (DS-2CD1xxx) and HiLook, Wi-Fi, 4G, solar, thermal
and explosion-proof models, LPR cameras (no PoE-powered model found), and the
TandemVu PTZs (DS-2SE4C425 gives no wattage; DS-2SE7C425 pairs a 60 W PTZ with
a panoramic channel that doesn't fit one camera row). The DS-2CD6D54G2 and
DS-2CD6D82G2 multi-directional cameras are one row per sensor.

## License

MIT
