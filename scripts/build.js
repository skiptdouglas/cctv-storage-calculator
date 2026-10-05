// Inlines src/calc.js into src/page.html and writes the site:
//   dist/index.html    — complete HTML document; open directly or host anywhere.
//                        Fonts are embedded (src/fonts.css), so it works offline.
//   dist/artifact.html — body fragment for hosts that supply their own <html>/<head>
//   dist/presets/      — one static spec page per camera vendor, from PRESETS
//   dist/sitemap.xml   — every page above, for search engines
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const page = fs.readFileSync(path.join(root, 'src/page.html'), 'utf8')
const calc = fs.readFileSync(path.join(root, 'src/calc.js'), 'utf8')
const fonts = fs.readFileSync(path.join(root, 'src/fonts.css'), 'utf8')
const C = require(path.join(root, 'src/calc.js'))

// Public address of the GitHub Pages site. Links in the page use it so they
// also work from the artifact copy, which is hosted elsewhere.
const SITE = 'https://skiptdouglas.github.io/cctv-storage-calculator/'
const TITLE = 'CCTV Storage Calculator — NVR hard drive, RAID, bandwidth and PoE sizing'
const DESCRIPTION = 'Free CCTV storage calculator for IP camera systems: size NVR hard drives and RAID, ' +
  'recorder throughput, switch uplinks and PoE budgets, with datasheet presets for 500+ UniFi, Milesight, ' +
  'Hikvision, Dahua, Axis, Hanwha and Reolink cameras. Runs in your browser.'
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// Where each vendor's figures come from, and anything a buyer should know.
const VENDOR_INFO = {
  UniFi: { source: "Ubiquiti's spec sheets on techspecs.ui.com" },
  Milesight: { source: "Milesight's NDAA datasheets on resource.milesight.com" },
  Hikvision: { source: 'the datasheets linked on hikvision.com product pages', notice: 'Hikvision is on the US NDAA §889 and FCC covered lists.' },
  Dahua: { source: 'the datasheets linked on dahuasecurity.com product pages', notice: 'Dahua is on the US NDAA §889 and FCC covered lists.' },
  Axis: { source: 'the datasheets linked on axis.com product pages', notice: 'Axis states maximum power as the PoE class limit; typical draw is lower.' },
  Hanwha: { source: 'the spec tables on hanwhavision.com product pages' },
  Reolink: { source: 'the spec tables on reolink.com product pages', notice: 'Reolink gives one power limit for DC and PoE.' }
}
const vendors = C.PRESET_VENDORS.filter((v) => VENDOR_INFO[v])
const countOf = (v) => C.PRESETS.filter((p) => p.vendor === v).length

for (const marker of ['<!-- @calc -->', '<!-- @fonts -->', '<!-- @vendors -->']) {
  if (!page.includes(marker)) throw new Error(`src/page.html is missing the ${marker} marker`)
}
const vendorLinks = vendors
  .map((v) => `<a href="${SITE}presets/${slug(v)}.html">${esc(v)}</a> (${countOf(v)})`)
  .join(' · ')
const fragment = page
  .replace('<!-- @fonts -->', () => `<style>\n${fonts}</style>`)
  .replace('<!-- @calc -->', () => `<script>\n${calc}</script>`)
  .replace('<!-- @vendors -->', () => vendorLinks)

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'CCTV Storage Calculator',
  url: SITE,
  description: DESCRIPTION,
  applicationCategory: 'UtilitiesApplication',
  operatingSystem: 'Any (web browser)',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  isAccessibleForFree: true,
  license: 'https://opensource.org/licenses/MIT'
}

function head ({ title, description, url, extra = '' }) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CCTV Storage Calculator">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">${extra}`
}

// The fragment carries its own <title> for the artifact host; the full page
// gets the longer title in <head> instead.
const doc = `<!doctype html>
<html lang="en">
<head>
${head({ title: TITLE, description: DESCRIPTION, url: SITE, extra: `\n<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` })}
<style>body{margin:0}[hidden]{display:none!important}</style>
</head>
<body>
${fragment.replace(/<title>[^<]*<\/title>\n?/, '')}
</body>
</html>
`

// Vendor spec pages: static, script-free tables of every preset.
const PAGE_CSS = `
:root{--bg:#f6f8fa;--card:#fff;--ink:#15202b;--muted:#5a6876;--line:#d5dce3;--accent:#0b6bcb;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f171e;--card:#16212a;--ink:#e3e9ee;--muted:#93a2af;--line:#2a3843;--accent:#6cb4ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
a{color:var(--accent)}h1{font-size:1.6rem;line-height:1.25;margin:.2em 0 .4em}h2{font-size:1.15rem;margin:1.8em 0 .5em}
.eyebrow{color:var(--muted);font-size:.85rem;text-transform:uppercase;letter-spacing:.06em}
p{max-width:75ch}.cta{display:inline-block;margin:.4em 0 1em;padding:.5em .9em;border:1px solid var(--accent);border-radius:6px;text-decoration:none}
.tbl{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:.45em .6em;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--card);font-weight:600}td.n,th.n{text-align:right;white-space:nowrap}
tr:last-child td{border-bottom:0}td.m{white-space:nowrap;font-weight:600}.note{color:var(--muted)}
ul.v{padding-left:1.2em}footer{margin-top:2.5em;color:var(--muted);font-size:.85rem}
`

const MP = Object.fromEntries(C.RESOLUTIONS.map((r) => [r.id, r.label]))

function vendorPage (v) {
  const ps = C.PRESETS.filter((p) => p.vendor === v)
  const info = VENDOR_INFO[v]
  const url = `${SITE}presets/${slug(v)}.html`
  const title = `${v} camera specs for CCTV storage and PoE sizing — ${ps.length} models`
  const description = `Resolution, frame rate, night IR and maximum PoE draw for ${ps.length} ${v} IP cameras, ` +
    `from ${info.source}. Use them as presets in the free CCTV storage calculator.`
  const groups = [...new Set(ps.map((p) => p.family || 'Cameras'))]
  const tables = groups.map((g) => {
    const rows = ps.filter((p) => (p.family || 'Cameras') === g).map((p) => {
      const desc = p.label.split(' · ')[0].replace(p.model, '').trim()
      return `<tr><td class="m">${esc(p.model)}</td><td>${esc(desc)}</td><td>${esc(MP[p.resolution] || p.resolution)}</td>` +
        `<td class="n">${p.fps}</td><td>${p.nightIR ? 'Yes' : 'No'}</td><td class="n">${p.poeW} W</td>` +
        `<td class="note">${esc(p.note || '')}</td></tr>`
    }).join('\n')
    return `<h2>${esc(g)}</h2>
<div class="tbl"><table>
<thead><tr><th>Model</th><th>Type</th><th>Size bucket</th><th class="n">fps</th><th>Night IR</th><th class="n">Max PoE</th><th>Notes</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
  }).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
${head({ title, description, url })}
<style>${PAGE_CSS}</style>
</head>
<body><div class="wrap">
<div class="eyebrow"><a href="${SITE}">CCTV Storage Calculator</a> · <a href="${SITE}presets/">Camera presets</a></div>
<h1>${esc(v)} camera specs for storage and PoE sizing</h1>
<p>${ps.length} ${esc(v)} IP cameras with the figures that drive recording storage and network design: resolution, frame rate, night IR and maximum PoE draw. Values are from ${esc(info.source)}, checked October 2026.${info.notice ? ' ' + esc(info.notice) : ''}</p>
<p>Frame rate is the preset's recording rate (capped at 30 fps; notes give the camera's maximum). Max PoE is per calculator row: for multi-sensor cameras the notes give the per-unit total. Pick any of these as a preset in the calculator to size NVR disks, RAID, throughput, switch uplinks and PoE budgets.</p>
<a class="cta" href="${SITE}">Open the CCTV storage calculator</a>
${tables}
<footer>Figures are planning values from the manufacturer's published specs. A datasheet or a measured stream always beats a preset. <a href="https://github.com/skiptdouglas/cctv-storage-calculator">Source on GitHub</a> (MIT).</footer>
</div></body>
</html>
`
}

function indexPage () {
  const url = `${SITE}presets/`
  const title = `IP camera specs for CCTV storage and PoE sizing — ${vendors.reduce((n, v) => n + countOf(v), 0)} models`
  const description = 'Datasheet resolution, frame rate, night IR and PoE draw for UniFi, Milesight, Hikvision, Dahua, Axis, Hanwha and Reolink IP cameras, used as presets in the free CCTV storage calculator.'
  const items = vendors.map((v) => `<li><a href="${SITE}presets/${slug(v)}.html">${esc(v)}</a>: ${countOf(v)} cameras, from ${esc(VENDOR_INFO[v].source)}</li>`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
${head({ title, description, url })}
<style>${PAGE_CSS}</style>
</head>
<body><div class="wrap">
<div class="eyebrow"><a href="${SITE}">CCTV Storage Calculator</a></div>
<h1>IP camera specs for storage and PoE sizing</h1>
<p>Every camera preset in the CCTV storage calculator, by manufacturer. Each list gives resolution, frame rate, night IR and maximum PoE draw from the manufacturer's own published specs.</p>
<ul class="v">
${items}
</ul>
<a class="cta" href="${SITE}">Open the CCTV storage calculator</a>
<footer><a href="https://github.com/skiptdouglas/cctv-storage-calculator">Source on GitHub</a> (MIT).</footer>
</div></body>
</html>
`
}

const today = new Date().toISOString().slice(0, 10)
const urls = [SITE, `${SITE}presets/`, ...vendors.map((v) => `${SITE}presets/${slug(v)}.html`)]
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>
`

const dist = path.join(root, 'dist')
fs.mkdirSync(path.join(dist, 'presets'), { recursive: true })
fs.writeFileSync(path.join(dist, 'index.html'), doc)
fs.writeFileSync(path.join(dist, 'artifact.html'), fragment)
fs.writeFileSync(path.join(dist, 'presets/index.html'), indexPage())
for (const v of vendors) fs.writeFileSync(path.join(dist, `presets/${slug(v)}.html`), vendorPage(v))
fs.writeFileSync(path.join(dist, 'sitemap.xml'), sitemap)
console.log(`Built dist/index.html, dist/artifact.html, ${vendors.length + 1} preset pages and dist/sitemap.xml`)
