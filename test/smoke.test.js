// Browser smoke test: opens the built page in Chromium and drives the main
// controls. Needs `playwright` (CI installs it); skipped when it is missing.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const dist = path.join(__dirname, '..', 'dist', 'index.html')
let chromium = null
try {
  ;({ chromium } = require('playwright'))
} catch (e) {
  // not installed
}

const launch = () =>
  chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })

test('built page loads, calculates and survives a reload', { skip: !chromium || !fs.existsSync(dist) }, async () => {
  const browser = await launch()
  try {
    const errors = []
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('file://' + dist)

    // Worked example on first load
    assert.equal((await page.textContent('#sReq')).trim(), '60.79 TB')
    assert.equal((await page.textContent('#arrayTitle')).trim(), '9 × 12 TB · RAID 6 + spare')

    // Codec and frame-rate changes recalculate
    const row = page.locator('#groupRows tr').first()
    await row.locator('[data-k="codec"]').selectOption('h264')
    assert.equal((await page.textContent('#sReq')).trim(), '90.18 TB')
    await row.locator('[data-k="fps"]').fill('30')
    assert.equal((await page.textContent('#sReq')).trim(), '148.97 TB')

    // Analog camera: switch and PoE disabled
    await row.locator('[data-k="resolution"]').selectOption('D1')
    assert.equal(await row.locator('[data-k="switch"]').isDisabled(), true)
    assert.equal(await row.locator('[data-k="poeW"]').isDisabled(), true)

    // Verdict line explains a red badge; hidden when nothing is wrong
    assert.equal(await page.locator('#verdict').isHidden(), true)
    await page.selectOption('#pRaid', 'jbod')
    assert.equal((await page.textContent('#status')).trim(), 'Does not meet SOP')
    assert.match(await page.textContent('#verdictText'), /No RAID/)
    await page.selectOption('#pRaid', 'raid6')
    assert.equal(await page.locator('#verdict').isHidden(), true)

    // Existing-array mode shows days that fit
    await page.selectOption('#pArrayMode', 'existing')
    await page.fill('#pExisting', '9')
    assert.match((await page.textContent('#sumCaption')), /fit on the existing array/)

    // Inputs persist across a reload
    await page.reload()
    assert.equal(await page.inputValue('#pExisting'), '9')
    assert.equal(await row.locator('[data-k="resolution"]').inputValue(), 'D1')

    // No horizontal page scroll at phone width
    await page.setViewportSize({ width: 400, height: 900 })
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    assert.ok(scrollWidth <= 400, `page scrolls sideways at phone width (${scrollWidth}px)`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
