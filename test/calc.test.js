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
