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
    assert.match(await page.textContent('#recBlocks .bays-title strong'), /9 × 12 TB · RAID 6 \+ spare/)

    // Codec and frame-rate changes recalculate
    const row = page.locator('#groupRows tr').first()
    await row.locator('[data-k="codec"]').selectOption('h264')
    assert.equal((await page.textContent('#sReq')).trim(), '90.18 TB')
    await row.locator('[data-k="fps"]').fill('30')
    assert.equal((await page.textContent('#sReq')).trim(), '148.97 TB')
    // ...and mark the preset as custom
    assert.equal(await row.locator('[data-k="preset"]').inputValue(), '')

    // A preset fills the camera fields
    await row.locator('[data-k="preset"]').selectOption('bullet8')
    const row0 = page.locator('#groupRows tr').first()
    assert.equal(await row0.locator('[data-k="resolution"]').inputValue(), '8MP')
    assert.equal(await row0.locator('[data-k="fps"]').inputValue(), '15')
    assert.equal(await row0.locator('[data-k="nightIR"]').isChecked(), true)
    assert.equal(await row0.locator('[data-k="poeW"]').inputValue(), '11')

    // Analog camera: switch and PoE disabled
    await row0.locator('[data-k="resolution"]').selectOption('D1')
    assert.equal(await row0.locator('[data-k="switch"]').isDisabled(), true)
    assert.equal(await row0.locator('[data-k="poeW"]').isDisabled(), true)

    // Verdict line explains a red badge; hidden when nothing is wrong
    assert.equal(await page.locator('#verdict').isHidden(), true)
    const rec = page.locator('#recorderRows tr').first()
    await rec.locator('[data-rk="raid"]').selectOption('jbod')
    assert.equal((await page.textContent('#status')).trim(), 'Does not meet SOP')
    assert.match(await page.textContent('#verdictText'), /No RAID/)
    await rec.locator('[data-rk="raid"]').selectOption('raid6')
    assert.equal(await page.locator('#verdict').isHidden(), true)

    // Existing-array mode shows days that fit
    await rec.locator('[data-rk="arrayMode"]').selectOption('existing')
    await rec.locator('[data-rk="existingDisks"]').fill('9')
    assert.match((await page.textContent('#sumCaption')), /fit on the existing array/)
    await rec.locator('[data-rk="arrayMode"]').selectOption('design')

    // Second recorder, a group moved to it, a cloud group and an SD-card group
    await page.click('#btnAddRecorder')
    assert.equal(await page.locator('#recorderRows tr').count(), 2)
    const rows = page.locator('#groupRows tr')
    const targets = await rows.nth(1).locator('[data-k="target"] option').allTextContents()
    assert.deepEqual(targets, ['NVR', 'NVR 2', 'Cloud (VSaaS)', 'Edge SD card'])
    await rows.nth(1).locator('[data-k="target"]').selectOption({ label: 'NVR 2' })
    assert.equal((await page.locator('#recorderRows tr').nth(1).locator('[data-rout="cams"]').textContent()).trim(), '6')
    await rows.nth(2).locator('[data-k="target"]').selectOption('cloud')
    assert.equal(await page.locator('#sCloudRow').isHidden(), false)
    await rows.nth(2).locator('[data-k="target"]').selectOption('edge')
    assert.equal(await rows.nth(2).locator('[data-k="sdGB"]').isDisabled(), false)
    await rows.nth(2).locator('[data-k="sdGB"]').fill('256')
    assert.equal(await page.locator('#sEdgeRow').isHidden(), false)

    // Archive tier
    await page.check('#pArchive')
    assert.equal(await page.inputValue('#pHot'), '7')
    assert.equal(await page.locator('#sArchiveRow').isHidden(), false)
    assert.match(await page.textContent('#sumCaption'), /7 on recorders/)

    // Copy / paste round trip through the textarea
    await page.click('#btnPasteProject')
    const json = await page.evaluate(() => JSON.stringify({ project: JSON.parse(localStorage.getItem('cctv-storage-calc-v1')).project, groups: JSON.parse(localStorage.getItem('cctv-storage-calc-v1')).groups }))
    await page.fill('#exportText', json.replace('"name":"Warehouse (example)"', '"name":"Pasted site"'))
    await page.click('#btnApplyPaste')
    assert.equal(await page.inputValue('#pName'), 'Pasted site')
    assert.equal(await page.locator('#recorderRows tr').count(), 2)

    // Report view renders and hides the app
    await page.click('#btnPrint')
    assert.equal(await page.locator('#reportView').isHidden(), false)
    assert.match(await page.textContent('#reportBody'), /Pasted site/)
    assert.match(await page.textContent('#reportBody'), /NVR 2/)
    await page.click('#btnBack')
    assert.equal(await page.locator('#reportView').isHidden(), true)

    // Inputs persist across a reload
    await page.reload()
    assert.equal(await page.inputValue('#pName'), 'Pasted site')
    assert.equal(await page.locator('#recorderRows tr').count(), 2)
    assert.equal(await page.locator('#groupRows tr').first().locator('[data-k="resolution"]').inputValue(), 'D1')

    // No horizontal page scroll at phone width
    await page.setViewportSize({ width: 400, height: 900 })
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    assert.ok(scrollWidth <= 400, `page scrolls sideways at phone width (${scrollWidth}px)`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
