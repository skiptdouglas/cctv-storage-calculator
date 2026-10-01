# Handoff — CCTV Storage Calculator

Written 30 September 2026 at the end of the cloud session that built this
project. It is for whoever continues the work on a desktop machine.

## Where everything is

| What | Where |
| --- | --- |
| Code | https://github.com/skiptdouglas/cctv-storage-calculator (public, MIT, `main`) |
| Hosted page | https://skiptdouglas.github.io/cctv-storage-calculator/ (redeploys on every push to `main`) |
| Private copy in Claude | https://claude.ai/artifact/VjbDwATm8AhqxGgZhN5C8A (updated by republishing `dist/artifact.html`) |
| SOP | `docs/SOP.md` (v1.6). A copy also lives on the `claude/surveillance-storage-calculator-sop-4cfuxe` branch of `skiptdouglas/lina` at `docs/sop/surveillance-storage-calculator.md` |
| Change log | `CHANGELOG.md`; current version 0.7.3 |

## State of the project

Finished and working. CI (unit tests, build, Playwright browser test) is
green on `main`; Pages deploys from the same push. No open pull requests.

What the calculator does is listed in `README.md`. In short: camera groups
with estimated or measured bitrates, several recorders, RAID planning,
throughput, switch uplink and PoE loading, viewing traffic, cloud/SD/archive
targets, presets (generic, UniFi, Milesight), save/load, printable report.

## Set up on a desktop

```bash
git clone https://github.com/skiptdouglas/cctv-storage-calculator.git
cd cctv-storage-calculator
npm test                      # 37 engine tests, no dependencies needed
npm run build                 # writes dist/index.html (open it in a browser)
npm i --no-save playwright@1.49.1 && npx playwright install chromium
npm run test:smoke            # browser test of the built page
```

Node 18+ is enough. There are no runtime dependencies; Playwright is only
for the smoke test.

## How the code is laid out

- `src/calc.js` — the whole calculation engine. Pure functions, runs in Node
  and the browser. Tables at the top (`BASE_H264_MBPS`, `CODECS`, `PRESETS`,
  `K` constants) are the numbers to tune.
- `src/page.html` — the UI. `<!-- @fonts -->` and `<!-- @calc -->` are
  replaced at build time.
- `src/fonts.css` — embedded fonts (regenerate with `npm run fonts`).
- `scripts/build.js` — writes `dist/index.html` (standalone, with CSP) and
  `dist/artifact.html` (body fragment for the Claude artifact).
- `test/calc.test.js`, `test/smoke.test.js` — engine and browser tests.

Conventions used so far: Conventional-Commit messages (`feat:`, `fix:`,
`docs:`, `ci:`), bump `package.json` version and add a `CHANGELOG.md` entry
per release, bump the SOP revision table when the method changes, and keep
the `lina` copy of the SOP in sync if you keep that branch.

## Why the session moved to desktop

The cloud environment's network policy blocks the vendor sites needed to
verify camera specs: `techspecs.ui.com`, `dl.ui.com`, `help.ui.com`,
`milesight.com`, `resource.milesight.com`, and most third-party spec
mirrors. The UniFi and Milesight presets were therefore built from search
results that quote the datasheets, not from the datasheets themselves.

## What to do first on the desktop

Steps 1 and 2 were done on 1 October 2026 (0.7.3): every UniFi and Milesight
preset was checked against the vendor datasheets, and the missing Milesight
speed domes, fisheye and traffic cameras were added. Still open: IR on the
UniFi AI Theta / Theta Pro and the Theta's 360-lens resolution (not stated
on techspecs), and thermal Milesight models (none found).

1. **Verify the vendor presets against the real datasheets.** Open the
   `PRESETS` array in `src/calc.js` and check each UniFi and Milesight row
   (resolution, max fps, IR, max PoE draw) against techspecs.ui.com and
   milesight.com/support/download/datasheet. The README tables list every
   preset and mark the entries that could not be confirmed:
   - UniFi: IR unknown for G4 PTZ, G5 PTZ, AI 360, AI Theta, AI Theta Pro.
   - Milesight: Speed Domes (MS-C2941/C5341/C8241), 5 MP fisheye, thermal
     and traffic cameras were left out for lack of a reliable power figure.
   Fix any wrong value, remove the `unverified` field, run `npm test`, and
   note the check in `CHANGELOG.md`.
2. **Add the missing models** from step 1 once their datasheets are open.
3. **Next vendors** if wanted: Hikvision, Dahua, Axis, Hanwha, Reolink. The
   pattern is the same: add rows to `PRESETS` with `vendor`, `model`, `label`,
   `resolution`, `codec`, `fps`, `nightIR`, `poeW`, optional `scene` and
   `note`; the dropdown groups by vendor automatically; extend the vendor
   list in the preset test.

## Other open items

- Check the generic planning numbers (bitrate table, PoE estimates,
  compression ratios) against the cameras actually installed.
- Decide what to do with the `lina` branch (merge or delete).
- Try "Save file" inside the Claude artifact viewer and "Print / Save as
  PDF" on the Pages site; both were implemented but could not be exercised
  from the cloud session.
- Ideas not started: quote pricing on the report, shareable links that
  encode a project, a short illustrated user guide, a card layout for phones.

## Updating the Claude artifact from another session

Republish `dist/artifact.html` and pass the artifact URL above as `url`.
The artifact declares the `downloads` capability so "Save file" works inside
the viewer; republishing without `capabilities` keeps that declaration.
