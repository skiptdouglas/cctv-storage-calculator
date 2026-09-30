const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../src/calc.js')

const close = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`)

test('GB per day follows Mbps × duty × 10.8', () => {
  const r = C.calculateGroup({ qty: 1, resolution: '4MP', codec: 'h265', fps: 15, scene: 'medium', mode: 'continuous' })
  close(r.mbps, 3)
  close(r.gbPerDayPerCam, 32.4)
})

test('bitrate adjustments: fps, scene, night IR, audio', () => {
  close(C.estimateBitrate({ resolution: '8MP', codec: 'h265', fps: 20, scene: 'high' }), 12)
  close(C.estimateBitrate({ resolution: '2MP', codec: 'h264', fps: 30, scene: 'low' }), 5.6)
  close(C.estimateBitrate({ resolution: '2MP', codec: 'h265', fps: 15, scene: 'medium', nightIR: true }), 2.4)
  close(C.estimateBitrate({ resolution: '2MP', codec: 'h265', fps: 15, scene: 'medium', audio: true }), 2.064, 0.0001)
})

test('measured bitrate overrides the estimate', () => {
  const r = C.calculateGroup({ qty: 2, resolution: '8MP', codec: 'h264', fps: 30, scene: 'high', mode: 'continuous', measuredMbps: '5' })
  assert.equal(r.measured, true)
  close(r.mbps, 5)
  close(r.gbPerDay, 108)
})

test('duty cycles', () => {
  assert.equal(C.dutyCycle({ mode: 'continuous' }), 1)
  assert.equal(C.dutyCycle({ mode: 'scheduled', hours: 12 }), 0.5)
  assert.equal(C.dutyCycle({ mode: 'scheduled', hours: 40 }), 1)
  assert.equal(C.dutyCycle({ mode: 'motion-low' }), 0.2)
  assert.equal(C.dutyCycle({ mode: 'motion-medium' }), 0.35)
  assert.equal(C.dutyCycle({ mode: 'motion-high' }), 0.5)
})

test('SOP §6 worked example reproduces 60.8 TB and 9 × 12 TB RAID 6', () => {
  const { project, groups } = C.exampleProject()
  const r = C.calculateProject(project, groups)
  close(r.totals.gbPerDay, 1608.12)
  close(r.totals.rawTB, 48.24)
  close(r.totals.requiredTB, 60.79)
  close(r.totals.aggregateMbps, 158)
  close(r.totals.minRecorderMbps, 225.71)
  assert.equal(r.array.dataDisks, 6)
  assert.equal(r.array.parityDisks, 2)
  assert.equal(r.array.spareDisks, 1)
  assert.equal(r.array.totalDisks, 9)
  assert.equal(r.array.usableTB, 72)
  close(r.array.usableTiB, 65.48)
  assert.equal(Math.floor(r.totals.expectedRetentionDays), 42)
  assert.ok(r.checks.some((c) => c.level === 'ok'))
  assert.notEqual(r.status, 'critical')
})

test('RAID layouts and minimum disk counts', () => {
  assert.deepEqual(pick(C.planArray(1, 8, 'raid5')), [2, 1, 0, 3])
  assert.deepEqual(pick(C.planArray(1, 8, 'raid6')), [2, 2, 0, 4])
  assert.deepEqual(pick(C.planArray(20, 8, 'raid10')), [3, 3, 0, 6])
  assert.deepEqual(pick(C.planArray(1, 8, 'raid10')), [2, 2, 0, 4])
  assert.deepEqual(pick(C.planArray(20, 8, 'jbod')), [3, 0, 0, 3])
  // 8-disk array gets a hot spare
  assert.deepEqual(pick(C.planArray(48, 8, 'raid6')), [6, 2, 1, 9])
  // exact multiple does not round up an extra disk
  assert.equal(C.planArray(36, 12, 'raid6').dataDisks, 3)
})

function pick(a) {
  return [a.dataDisks, a.parityDisks, a.spareDisks, a.totalDisks]
}

test('checks flag unsafe designs', () => {
  const { project, groups } = C.exampleProject()
  const levels = (p) => C.calculateProject({ ...project, ...p }, groups).checks.map((c) => c.level)

  assert.ok(levels({ raid: 'jbod' }).includes('critical'))
  assert.ok(!levels({ raid: 'jbod', evidential: false }).includes('critical'))
  assert.ok(levels({ raid: 'raid5' }).includes('warn'))
  assert.ok(levels({ headroom: 1.0 }).includes('warn'))
  assert.ok(levels({ recorderBays: 8 }).includes('critical'))
  assert.ok(levels({ recorderMbps: 200 }).includes('critical'))
  assert.equal(C.calculateProject({ ...project, recorderBays: 16, recorderMbps: 320 }, groups).status, 'info')
  assert.equal(C.calculateProject(project, []).checks[0].level, 'info')
})

test('report and CSV include every group', () => {
  const { project, groups } = C.exampleProject()
  const r = C.calculateProject(project, groups)
  const report = C.formatReport(project, groups, r)
  assert.match(report, /Required usable: 60\.79 TB/)
  assert.match(report, /9 × 12 TB, RAID 6/)
  const csv = C.formatCSV(groups, r).split('\n')
  assert.equal(csv.length, groups.length + 1)
  assert.match(csv[1], /^Aisles,24,4MP,h265/)
})

test('switch traffic and PoE per switch', () => {
  const { project, groups } = C.exampleProject()
  const r = C.calculateProject(project, groups)
  const [sw1, sw2] = r.network.switches
  assert.equal(sw1.cameras, 24)
  close(sw1.mbps, 72)
  close(sw1.uplinkLoad, 0.072)
  close(sw1.poeW, 144) // 24 × 6 W
  assert.equal(sw2.cameras, 16)
  close(sw2.mbps, 86)
  close(sw2.poeW, 108) // 6 × 8 W + 10 × 6 W
  assert.equal(r.network.unassigned.cameras, 0)
})

test('PoE estimate and override', () => {
  assert.equal(C.estimatePoE({ resolution: '4MP' }), 6)
  assert.equal(C.estimatePoE({ resolution: '8MP', nightIR: true }), 11)
  assert.equal(C.calculateGroup({ qty: 2, resolution: '4MP', codec: 'h265', fps: 15, mode: 'continuous', poeW: 25 }).totalPoeW, 50)
})

test('switch checks flag overloaded uplinks and PoE budgets', () => {
  const { project, groups } = C.exampleProject()
  const run = (sw1) => C.calculateProject({ ...project, switches: [{ ...project.switches[0], ...sw1 }, project.switches[1]] }, groups).checks
  const texts = (cs, level) => cs.filter((c) => c.level === level).map((c) => c.text).join(' | ')
  assert.match(texts(run({ uplinkMbps: 100 }), 'warn'), /SW1.*uplink is 72% loaded/)
  assert.match(texts(run({ uplinkMbps: 50 }), 'critical'), /SW1.*more than its 50 Mbps uplink/)
  assert.match(texts(run({ poeBudgetW: 170 }), 'warn'), /SW1.*PoE budget is 85% used/)
  assert.match(texts(run({ poeBudgetW: 120 }), 'critical'), /SW1.*more than its 120 W PoE budget/)
  const unassigned = C.calculateProject(project, groups.map((g, i) => (i === 2 ? { ...g, switch: '' } : g)))
  assert.equal(unassigned.network.unassigned.cameras, 10)
  assert.match(texts(unassigned.checks, 'info'), /10 cameras are not assigned/)
})

test('viewing traffic and disk throughput', () => {
  const { project, groups } = C.exampleProject()
  const r = C.calculateProject(project, groups)
  close(r.viewing.avgMainMbps, 3.95)
  close(r.viewing.liveMbps, 2) // 4 × 0.5 Mbps substream
  close(r.viewing.playbackMbps, 3.95)
  close(r.viewing.totalMbps, 5.95)
  close(r.disk.writeMBps, 19.75)
  close(r.disk.readMBps, 0.49)

  const main = C.calculateProject({ ...project, liveStreamType: 'main', liveStreams: 16, playbackStreams: 4 }, groups)
  close(main.viewing.totalMbps, 79)
  const lv = (p) => C.calculateProject({ ...project, liveStreamType: 'main', liveStreams: 16, playbackStreams: 4, ...p }, groups).checks
  assert.ok(lv({ recorderOutMbps: 60 }).some((c) => c.level === 'critical' && /outbound/.test(c.text)))
  assert.ok(lv({ viewingLinkMbps: 100 }).some((c) => c.level === 'warn' && /viewing link/.test(c.text)))
  assert.ok(lv({ viewingLinkMbps: 50 }).some((c) => c.level === 'critical' && /viewing link/.test(c.text)))
})

test('older saved projects load with defaults', () => {
  const { project, groups } = C.withDefaults(
    { name: 'Old', retentionDays: 14, headroom: 1.3, diskTB: 8, raid: 'raid6' },
    [{ name: 'Cams', qty: 4, resolution: '2MP', codec: 'h264', fps: 15, scene: 'medium', mode: 'continuous', switch: 'gone' }]
  )
  assert.deepEqual(project.switches, [])
  assert.equal(project.liveStreams, 0)
  assert.equal(groups[0].switch, '')
  assert.equal(groups[0].poeW, '')
  const r = C.calculateProject(project, groups)
  close(r.totals.gbPerDay, 172.8)
})

test('codec table: every codec scales from the H.264 baseline', () => {
  const at = (codec) => C.estimateBitrate({ resolution: '2MP', codec, fps: 15, scene: 'medium' })
  close(at('h264'), 4)
  close(at('smart264'), 2.4)
  close(at('h265'), 2)
  close(at('smart'), 1)
  close(at('av1'), 1.4)
  close(at('mjpeg'), 20)
  close(C.BASE_BITRATE['8MP'].h265, 6)
})

test('quality setting scales the estimate', () => {
  const at = (quality) => C.estimateBitrate({ resolution: '4MP', codec: 'h265', fps: 15, scene: 'medium', quality })
  close(at('low'), 2.1)
  close(at('medium'), 3)
  close(at('high'), 4.2)
  close(at(undefined), 3)
})

test('night frame rate: storage uses the average, throughput uses the peak', () => {
  const g = { qty: 10, resolution: '4MP', codec: 'h265', fps: 30, nightFps: 10, scene: 'medium', mode: 'continuous' }
  // day 6 Mbps, night 2 Mbps; 12 h each → 4 Mbps average
  const r = C.calculateGroup(g, 12)
  close(r.mbps, 4)
  close(r.peakMbps, 6)
  close(r.gbPerDayPerCam, 43.2)
  close(r.aggregateMbps, 60)
  // 8 night hours → (6×16 + 2×8) / 24
  close(C.calculateGroup(g, 8).mbps, 4.667)
  // night rate equal to day rate, or blank, changes nothing
  close(C.calculateGroup({ ...g, nightFps: 30 }, 12).mbps, 6)
  close(C.calculateGroup({ ...g, nightFps: '' }, 12).mbps, 6)
  // measured bitrate wins over both
  const m = C.calculateGroup({ ...g, measuredMbps: 3 }, 12)
  close(m.mbps, 3)
  close(m.peakMbps, 3)
})

test('night hours come from the project', () => {
  const { project, groups } = C.exampleProject()
  const gs = groups.map((g, i) => (i === 0 ? { ...g, fps: 30, nightFps: 10 } : g))
  const r12 = C.calculateProject(project, gs)
  const r16 = C.calculateProject({ ...project, nightHours: 16 }, gs)
  close(r12.rows[0].mbps, 4)
  close(r16.rows[0].mbps, (6 * 8 + 2 * 16) / 24)
  close(r12.totals.aggregateMbps, 6 * 24 + 72 + 14)
})

test('MJPEG and smart H.264 raise notes', () => {
  const { project, groups } = C.exampleProject()
  const notes = (codec) => C.calculateProject(project, groups.map((g, i) => (i === 2 ? { ...g, codec } : g))).checks.map((c) => c.text).join(' | ')
  assert.match(notes('mjpeg'), /MJPEG uses about 5×/)
  assert.match(notes('smart264'), /Smart-codec savings/)
  assert.doesNotMatch(notes('h265'), /MJPEG|Smart-codec/)
})

test('new resolutions: 720p, 3 MP and 6 MP', () => {
  const at = (resolution) => C.estimateBitrate({ resolution, codec: 'h264', fps: 15, scene: 'medium' })
  close(at('1MP'), 2)
  close(at('3MP'), 5)
  close(at('6MP'), 10)
  close(C.estimateBitrate({ resolution: '6MP', codec: 'h265', fps: 15, scene: 'medium' }), 5)
})

test('raw-pixel method: color depth 16-bit below 4K, 30-bit at 4K and above', () => {
  assert.equal(C.colorDepth('6MP'), 16)
  assert.equal(C.colorDepth('8MP'), 30)
  assert.equal(C.colorDepth('12MP'), 30)
  // 1920 × 1080 × 16 × 15 = 497.66 Mbps raw ÷ 100 (H.264)
  close(C.rawCompressedMbps({ resolution: '2MP', codec: 'h264' }, 15), 4.977)
  // 3840 × 2160 × 30 × 15 = 3,732.48 Mbps raw ÷ 200 (H.265)
  close(C.rawCompressedMbps({ resolution: '8MP', codec: 'h265' }, 15), 18.662)
  // MJPEG 20:1
  close(C.rawCompressedMbps({ resolution: '2MP', codec: 'mjpeg' }, 15), 24.883)
  // scene, quality, night IR still apply
  const model = { method: 'raw', ratios: {} }
  close(C.estimateBitrate({ resolution: '2MP', codec: 'h264', fps: 15, scene: 'high', quality: 'high' }, undefined, model), 4.977 * 1.5 * 1.4)
  // entered ratio overrides the default
  close(C.estimateBitrate({ resolution: '2MP', codec: 'h264', fps: 15, scene: 'medium' }, undefined, { method: 'raw', ratios: { h264: 200 } }), 2.488)
})

test('project method switch changes the estimate, bitrate stays the default', () => {
  const { project, groups } = C.exampleProject()
  const bitrate = C.calculateProject(project, groups)
  const raw = C.calculateProject({ ...project, method: 'raw' }, groups)
  close(bitrate.totals.requiredTB, 60.79)
  // Aisles 4 MP H.265: 2560×1440×16×15 ÷ 200 = 4.424 Mbps
  close(raw.rows[0].mbps, 4.424)
  // Docks 8 MP H.265 20 fps high motion: 3840×2160×30×20 ÷ 200 × 1.5 = 37.32 Mbps
  close(raw.rows[1].mbps, 37.325)
  assert.ok(raw.totals.requiredTB > bitrate.totals.requiredTB)
  const report = C.formatReport({ ...project, method: 'raw' }, groups, raw)
  assert.match(report, /Estimate: Raw pixels ÷ compression ratio\. Typical bitrates \(SOP Table 1\) gives 60\.79 TB/)
  assert.match(report, /H\.264 100:1/)
})

test('older projects get default method and compression ratios', () => {
  const { project } = C.withDefaults({ retentionDays: 7, compressionRatios: { h264: 150 } }, [])
  assert.equal(project.method, 'bitrate')
  assert.equal(project.compressionRatios.h264, 150)
  assert.equal(project.compressionRatios.h265, 200)
})

test('analog DVR resolutions: CIF, D1, 960H', () => {
  const at = (resolution, codec = 'h264') => C.estimateBitrate({ resolution, codec, fps: 15, scene: 'medium' })
  close(at('CIF'), 0.5)
  close(at('D1'), 1)
  close(at('960H'), 1.3)
  close(at('960H', 'h265'), 0.65)
  assert.equal(C.colorDepth('D1'), 16)
  // 720 × 480 × 16 × 15 ÷ 100
  close(C.rawCompressedMbps({ resolution: 'D1', codec: 'h264' }, 15), 0.829)
  // 16 D1 cameras, 24/7, 30 days ≈ 5.18 TB raw
  const r = C.calculateProject({ retentionDays: 30, headroom: 1.2, diskTB: 4, raid: 'raid6' }, [
    { qty: 16, resolution: 'D1', codec: 'h264', fps: 15, scene: 'medium', mode: 'continuous' }
  ])
  close(r.totals.rawTB, 5.184)
})

test('no-RAID is critical for evidential footage, a warning otherwise', () => {
  const { project, groups } = C.exampleProject()
  const level = (p) => C.calculateProject({ ...project, raid: 'jbod', ...p }, groups).checks.find((c) => /No RAID/.test(c.text)).level
  assert.equal(level({}), 'critical')
  assert.equal(level({ evidential: true }), 'critical')
  assert.equal(level({ evidential: false }), 'warn')
  assert.equal(C.withDefaults({}, []).project.evidential, true)
})

test('analog coax cameras have no PoE and no switch traffic', () => {
  const g = { qty: 16, resolution: 'D1', codec: 'h264', fps: 15, scene: 'medium', mode: 'continuous', switch: 'sw1', poeW: 8 }
  const r = C.calculateGroup(g)
  assert.equal(r.coax, true)
  assert.equal(r.poeW, 0)
  assert.equal(r.totalPoeW, 0)
  const p = { ...C.exampleProject().project }
  const res = C.calculateProject(p, [g])
  assert.equal(res.network.switches[0].cameras, 0)
  assert.equal(res.network.coax.cameras, 16)
  close(res.network.coax.mbps, 16)
  assert.ok(res.checks.some((c) => /coax/.test(c.text)))
  assert.match(C.formatCSV([g], res), /,coax,0\.0,NVR,$/m)
})

test('night fps is ignored for scheduled recording', () => {
  const g = { qty: 1, resolution: '4MP', codec: 'h265', fps: 30, nightFps: 10, scene: 'medium', mode: 'scheduled', hours: 8 }
  assert.equal(C.nightFps(g), null)
  const r = C.calculateGroup(g, 12)
  close(r.mbps, 6)
  close(r.duty, 8 / 24)
})

test('existing array mode reports days that fit and spare cameras', () => {
  const { project, groups } = C.exampleProject()
  // 16-bay NVR with 9 × 12 TB RAID 6 → 1 spare, 6 data
  const r = C.calculateProject({ ...project, arrayMode: 'existing', existingDisks: 9 }, groups)
  assert.equal(r.array.existing, true)
  assert.deepEqual([r.array.dataDisks, r.array.parityDisks, r.array.spareDisks, r.array.totalDisks], [6, 2, 1, 9])
  assert.equal(Math.floor(r.totals.expectedRetentionDays), 42)
  // 72 / 1.2 − 48.24 × 1.05 = 9.35 TB spare; avg 1.266 TB/cam → 7 cameras
  close(r.totals.spareTB, 9.35, 0.02)
  assert.equal(r.totals.spareCameras, 7)
  assert.ok(r.checks.some((c) => c.level === 'info' && /7 more cameras/.test(c.text)))
  // Too small: 5 × 12 TB RAID 6 → 3 data = 36 TB → about 21 days
  const small = C.calculateProject({ ...project, arrayMode: 'existing', existingDisks: 5 }, groups)
  assert.equal(small.array.spareDisks, 0)
  assert.equal(Math.floor(small.totals.expectedRetentionDays), 21)
  assert.ok(small.checks.some((c) => c.level === 'critical' && /Add about/.test(c.text)))
  // Fewer disks than RAID needs
  const none = C.calculateProject({ ...project, arrayMode: 'existing', existingDisks: 2 }, groups)
  assert.equal(none.array.dataDisks, 0)
  assert.ok(none.checks.some((c) => c.level === 'critical' && /needs more than 2 disks/.test(c.text)))
  // RAID 10 with 6 existing disks → 3 data + 3 mirror
  const r10 = C.planArray(0, 8, 'raid10', 6)
  assert.deepEqual([r10.dataDisks, r10.parityDisks, r10.usableTB], [3, 3, 24])
  // design mode unaffected
  assert.equal(C.calculateProject({ ...project, arrayMode: 'design', existingDisks: 5 }, groups).array.existing, false)
})

test('blank quantity or frame rate raises a warning', () => {
  const { project, groups } = C.exampleProject()
  const gs = groups.map((g, i) => (i === 0 ? { ...g, qty: '' } : i === 1 ? { ...g, fps: '' } : g))
  const texts = C.calculateProject(project, gs).checks.filter((c) => c.level === 'warn').map((c) => c.text)
  assert.ok(texts.some((t) => /Aisles: quantity is blank/.test(t)))
  assert.ok(texts.some((t) => /Loading docks: frame rate is blank/.test(t)))
  assert.equal(C.calculateProject(project, groups).checks.filter((c) => /blank/.test(c.text)).length, 0)
})

test('CSV export neutralises spreadsheet formulas', () => {
  const { project, groups } = C.exampleProject()
  const gs = groups.map((g, i) => (i === 0 ? { ...g, name: '=HYPERLINK("http://x","click")' } : i === 1 ? { ...g, name: '-2+3' } : { ...g, name: 'Plain, name' }))
  const r = C.calculateProject(project, gs)
  const lines = C.formatCSV(gs, r).split('\n')
  assert.ok(lines[1].startsWith(`"'=HYPERLINK(""http://x"",""click"")",`), lines[1])
  assert.ok(lines[2].startsWith(`'-2+3,`), lines[2])
  assert.ok(lines[3].startsWith(`"Plain, name",`), lines[3])
})

test('legacy single-recorder fields migrate into recorders[0]', () => {
  const { project } = C.withDefaults({ retentionDays: 14, diskTB: 8, raid: 'raid5', recorderBays: 4, recorderMbps: 100, arrayMode: 'existing', existingDisks: 3 }, [])
  assert.equal(project.recorders.length, 1)
  assert.deepEqual(
    [project.recorders[0].diskTB, project.recorders[0].raid, project.recorders[0].bays, project.recorders[0].inboundMbps, project.recorders[0].arrayMode, project.recorders[0].existingDisks],
    [8, 'raid5', 4, 100, 'existing', 3]
  )
  assert.equal('diskTB' in project, false)
  assert.deepEqual(project.archive, { enabled: false, hotDays: '' })
})

test('two recorders are sized separately and summed', () => {
  const { project, groups } = C.exampleProject()
  const p = { ...project, recorders: [
    { id: 'r1', name: 'NVR A', diskTB: 12, raid: 'raid6', bays: '', inboundMbps: '', arrayMode: 'design', existingDisks: '' },
    { id: 'r2', name: 'NVR B', diskTB: 10, raid: 'raid5', bays: '', inboundMbps: '', arrayMode: 'design', existingDisks: '' }
  ] }
  const gs = groups.map((g, i) => ({ ...g, recorder: i === 0 ? 'r1' : 'r2' }))
  const r = C.calculateProject(p, gs)
  assert.equal(r.recorders.length, 2)
  assert.equal(r.recorders[0].cameras, 24)
  assert.equal(r.recorders[1].cameras, 16)
  close(r.recorders[0].requiredTB, 777.6 * 30 / 1000 * 1.26)
  close(r.recorders[1].requiredTB, (777.6 + 52.9) * 30 / 1000 * 1.26, 0.05)
  close(r.totals.requiredTB, r.recorders[0].requiredTB + r.recorders[1].requiredTB)
  assert.equal(r.recorders[1].array.raid, 'raid5')
  // checks are prefixed with the recorder name when there is more than one
  assert.ok(r.checks.some((c) => /^NVR B: RAID 5/.test(c.text)))
  assert.ok(r.checks.some((c) => /^NVR A: Meets the 30-day/.test(c.text)))
  // a group pointing at a missing recorder falls back to the first
  const fb = C.calculateProject(p, gs.map((g) => ({ ...g, recorder: 'nope' })))
  assert.equal(fb.recorders[0].cameras, 40)
})

test('cloud groups leave the recorder and are checked against internet upload', () => {
  const { project, groups } = C.exampleProject()
  const gs = groups.map((g, i) => (i === 2 ? { ...g, target: 'cloud' } : g))
  const r = C.calculateProject(project, gs)
  assert.equal(r.cloud.cameras, 10)
  close(r.cloud.gbPerDay, 52.92, 0.05)
  close(r.cloud.retentionTB, 1.5876, 0.01)
  close(r.cloud.monthlyGB, 52.92 * 30.44, 2)
  close(r.cloud.uploadMbps, 14)
  assert.equal(r.recorders[0].cameras, 30)
  close(r.totals.aggregateMbps, 144)
  assert.ok(r.checks.some((c) => c.level === 'info' && /record to the cloud/.test(c.text)))
  const tight = C.calculateProject({ ...project, internetUploadMbps: 15 }, gs)
  assert.ok(tight.checks.some((c) => c.level === 'warn' && /internet upload/.test(c.text)))
  const over = C.calculateProject({ ...project, internetUploadMbps: 10 }, gs)
  assert.ok(over.checks.some((c) => c.level === 'critical' && /more than the 10 Mbps/.test(c.text)))
})

test('edge SD groups report days per card', () => {
  const { project, groups } = C.exampleProject()
  const gs = groups.map((g, i) => (i === 0 ? { ...g, target: 'edge', sdGB: 256 } : g))
  const r = C.calculateProject(project, gs)
  assert.equal(r.edge.length, 1)
  // 32.4 GB/day × 1.05 → 256 GB holds 7.5 days
  close(r.edge[0].daysFit, 256 / (32.4 * 1.05), 0.01)
  assert.equal(r.recorders[0].cameras, 16)
  assert.ok(r.checks.some((c) => c.level === 'critical' && /SD card holds about 7\.5 days/.test(c.text)))
  const big = C.calculateProject(project, gs.map((g) => (g.target === 'edge' ? { ...g, sdGB: 2048 } : g)))
  assert.ok(!big.checks.some((c) => /SD card holds/.test(c.text)))
  const blank = C.calculateProject(project, gs.map((g) => (g.target === 'edge' ? { ...g, sdGB: '' } : g)))
  assert.ok(blank.checks.some((c) => c.level === 'warn' && /no card size/.test(c.text)))
})

test('archive tier sizes recorders for the hot days and the archive for the rest', () => {
  const { project, groups } = C.exampleProject()
  const r = C.calculateProject({ ...project, archive: { enabled: true, hotDays: 7 } }, groups)
  assert.equal(C.hotDaysOf({ ...project, archive: { enabled: true, hotDays: 7 } }), 7)
  assert.equal(r.archive.enabled, true)
  assert.equal(r.archive.archiveDays, 23)
  close(r.recorders[0].rawTB, 1608.12 * 7 / 1000, 0.01)
  close(r.archive.rawTB, 1608.12 * 23 / 1000, 0.01)
  close(r.archive.requiredTB, r.archive.rawTB * 1.26, 0.01)
  assert.ok(r.checks.some((c) => /Meets the 7-day requirement on the recorder/.test(c.text)))
  assert.ok(r.checks.some((c) => c.level === 'info' && /Archive tier/.test(c.text)))
  // hot days at or above retention means no archive
  assert.equal(C.calculateProject({ ...project, archive: { enabled: true, hotDays: 30 } }, groups).archive.enabled, false)
  assert.equal(C.calculateProject({ ...project, archive: { enabled: false, hotDays: 7 } }, groups).archive.enabled, false)
})

test('presets fill in camera settings and keep the rest', () => {
  const g = { ...C.newGroup(1), name: 'Car park', qty: 6, switch: 'sw1', mode: 'motion-high' }
  const p = C.applyPreset(g, 'ptz2')
  assert.equal(p.preset, 'ptz2')
  assert.deepEqual([p.resolution, p.codec, p.fps, p.nightIR, p.poeW, p.scene], ['2MP', 'h265', 25, true, 25, 'high'])
  assert.deepEqual([p.name, p.qty, p.switch, p.mode], ['Car park', 6, 'sw1', 'motion-high'])
  assert.equal(C.applyPreset(g, 'nope').preset, '')
  assert.ok(C.PRESETS.every((pr) => C.RESOLUTIONS.some((r) => r.id === pr.resolution) && C.CODECS.some((c) => c.id === pr.codec)))
})

test('UniFi presets carry spec-sheet values and are grouped by vendor', () => {
  assert.deepEqual(C.PRESET_VENDORS, ['Generic', 'UniFi', 'Milesight'])
  const g5 = C.applyPreset(C.newGroup(1), 'uvc-g5-bullet')
  assert.deepEqual([g5.resolution, g5.codec, g5.fps, g5.nightIR, g5.poeW], ['4MP', 'h265', 30, true, 4])
  const pro = C.applyPreset(C.newGroup(1), 'uvc-g5-pro')
  assert.deepEqual([pro.resolution, pro.fps, pro.poeW], ['8MP', 30, 10])
  const ptz = C.applyPreset(C.newGroup(1), 'uvc-g6-ptz')
  assert.deepEqual([ptz.resolution, ptz.poeW, ptz.scene], ['8MP', 24.5, 'high'])
  const unifi = C.PRESETS.filter((p) => p.vendor === 'UniFi')
  assert.ok(unifi.length >= 20)
  assert.ok(unifi.every((p) => p.model && p.model.startsWith('UVC-') && typeof p.poeW === 'number' && p.poeW > 0))
})

test('Milesight presets carry datasheet values', () => {
  const ms = C.PRESETS.filter((p) => p.vendor === 'Milesight')
  assert.ok(ms.length >= 25)
  assert.ok(ms.every((p) => p.model && p.model.startsWith('MS-C') && typeof p.poeW === 'number' && p.poeW > 0 && p.nightIR === true))
  const fisheye = C.applyPreset(C.newGroup(1), 'ms-c9674')
  assert.deepEqual([fisheye.resolution, fisheye.fps, fisheye.poeW], ['12MP', 25, 11])
  const ptz = C.applyPreset(C.newGroup(1), 'ms-c5361-ptz')
  assert.deepEqual([ptz.resolution, ptz.poeW, ptz.scene], ['5MP', 19.3, 'high'])
  const ids = C.PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, 'preset ids are unique')
})
