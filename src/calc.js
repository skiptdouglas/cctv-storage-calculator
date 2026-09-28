/*
 * CCTV storage calculation engine.
 *
 * Implements SOP-VSS-001 (docs/SOP.md). Pure functions, no DOM access, so the
 * same file runs in the browser (window.StorageCalc) and in Node (require).
 */
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.StorageCalc = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  // SOP §5 Step 2, Table 1 — planning bitrates in Mbps at 15 fps, medium motion.
  const BASE_BITRATE = {
    '2MP': { h264: 4, h265: 2, smart: 1 },
    '4MP': { h264: 6, h265: 3, smart: 1.5 },
    '5MP': { h264: 8, h265: 4, smart: 2 },
    '8MP': { h264: 12, h265: 6, smart: 3 },
    '12MP': { h264: 16, h265: 8, smart: 4 }
  }

  const RESOLUTIONS = [
    { id: '2MP', label: '2 MP (1080p)' },
    { id: '4MP', label: '4 MP (1440p)' },
    { id: '5MP', label: '5 MP' },
    { id: '8MP', label: '8 MP (4K)' },
    { id: '12MP', label: '12 MP (fisheye)' }
  ]

  const CODECS = [
    { id: 'h264', label: 'H.264' },
    { id: 'h265', label: 'H.265' },
    { id: 'smart', label: 'Smart H.265+' }
  ]

  const SCENES = [
    { id: 'low', label: 'Low motion', factor: 0.7 },
    { id: 'medium', label: 'Medium', factor: 1 },
    { id: 'high', label: 'High motion', factor: 1.5 }
  ]

  // SOP §5 Step 3 — duty cycles.
  const MODES = [
    { id: 'continuous', label: 'Continuous 24/7', duty: 1 },
    { id: 'scheduled', label: 'Scheduled', duty: null },
    { id: 'motion-low', label: 'Motion · quiet area', duty: 0.2 },
    { id: 'motion-medium', label: 'Motion · medium', duty: 0.35 },
    { id: 'motion-high', label: 'Motion · busy area', duty: 0.5 }
  ]

  const RAID_LEVELS = [
    { id: 'raid6', label: 'RAID 6', parity: 2, minDisks: 4 },
    { id: 'raid5', label: 'RAID 5', parity: 1, minDisks: 3 },
    { id: 'raid10', label: 'RAID 10', parity: null, minDisks: 4 },
    { id: 'jbod', label: 'JBOD (no RAID)', parity: 0, minDisks: 1 }
  ]

  const DISK_SIZES_TB = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]

  const K = {
    GB_PER_MBPS_DAY: 10.8, // 86,400 s ÷ 8 bits ÷ 1,000 MB
    FS_OVERHEAD: 1.05,
    MIN_HEADROOM: 1.2,
    NIGHT_IR_FACTOR: 1.2,
    AUDIO_MBPS: 0.064,
    RECORDER_UTILISATION: 0.7,
    TB_TO_TIB: 1e12 / 2 ** 40,
    HOT_SPARE_FROM_DISKS: 8,
    RAID5_MAX_DISKS: 6,
    RAID5_MAX_DISK_TB: 8,
    BASE_FPS: 15
  }

  const EPS = 1e-9
  const byId = (list, id) => list.find((x) => x.id === id)
  const num = (v, fallback = 0) => {
    const n = typeof v === 'number' ? v : parseFloat(v)
    return Number.isFinite(n) ? n : fallback
  }
  const ceil = (x) => Math.ceil(x - EPS)

  /** Estimated bitrate from Table 1 plus SOP adjustments (Mbps). */
  function estimateBitrate(g) {
    const base = (BASE_BITRATE[g.resolution] || BASE_BITRATE['2MP'])[g.codec] ?? 0
    const fps = Math.max(0, num(g.fps, K.BASE_FPS))
    const scene = (byId(SCENES, g.scene) || byId(SCENES, 'medium')).factor
    let mbps = base * (fps / K.BASE_FPS) * scene
    if (g.nightIR) mbps *= K.NIGHT_IR_FACTOR
    if (g.audio) mbps += K.AUDIO_MBPS
    return mbps
  }

  /** Bitrate used for sizing: a measured value always wins over the estimate. */
  function groupBitrate(g) {
    const measured = num(g.measuredMbps, 0)
    return measured > 0 ? measured : estimateBitrate(g)
  }

  function dutyCycle(g) {
    const mode = byId(MODES, g.mode) || MODES[0]
    if (mode.id === 'scheduled') return Math.min(24, Math.max(0, num(g.hours, 24))) / 24
    return mode.duty
  }

  function calculateGroup(g) {
    const qty = Math.max(0, Math.floor(num(g.qty, 0)))
    const measured = num(g.measuredMbps, 0) > 0
    const mbps = groupBitrate(g)
    const duty = dutyCycle(g)
    const gbPerDayPerCam = mbps * duty * K.GB_PER_MBPS_DAY
    return {
      qty,
      measured,
      estimatedMbps: estimateBitrate(g),
      mbps,
      duty,
      gbPerDayPerCam,
      gbPerDay: gbPerDayPerCam * qty,
      aggregateMbps: mbps * qty
    }
  }

  /** SOP §5 Step 7 — disk count for a required usable capacity. */
  function planArray(requiredTB, diskTB, raidId) {
    const raid = byId(RAID_LEVELS, raidId) || RAID_LEVELS[0]
    const size = Math.max(0, num(diskTB, 0))
    const needData = size > 0 ? Math.max(0, ceil(requiredTB / size)) : 0
    let dataDisks
    let parityDisks
    if (raid.id === 'raid10') {
      dataDisks = Math.max(raid.minDisks / 2, needData)
      parityDisks = dataDisks // mirror copies
    } else {
      const total = Math.max(raid.minDisks, needData + raid.parity)
      dataDisks = total - raid.parity
      parityDisks = raid.parity
    }
    const arrayDisks = dataDisks + parityDisks
    const spareDisks = raid.id !== 'jbod' && arrayDisks >= K.HOT_SPARE_FROM_DISKS ? 1 : 0
    const usableTB = dataDisks * size
    return {
      raid: raid.id,
      raidLabel: raid.label,
      diskTB: size,
      dataDisks,
      parityDisks,
      spareDisks,
      arrayDisks,
      totalDisks: arrayDisks + spareDisks,
      rawTB: (arrayDisks + spareDisks) * size,
      usableTB,
      usableTiB: usableTB * K.TB_TO_TIB
    }
  }

  function calculateProject(project, groups) {
    const p = project || {}
    const retentionDays = num(p.retentionDays, 0)
    const headroom = num(p.headroom, K.MIN_HEADROOM)
    const rows = (groups || []).map(calculateGroup)

    const cameras = rows.reduce((s, r) => s + r.qty, 0)
    const gbPerDay = rows.reduce((s, r) => s + r.gbPerDay, 0)
    const aggregateMbps = rows.reduce((s, r) => s + r.aggregateMbps, 0)
    const rawTB = (gbPerDay * Math.max(0, retentionDays)) / 1000
    const requiredTB = rawTB * K.FS_OVERHEAD * headroom
    const minRecorderMbps = aggregateMbps / K.RECORDER_UTILISATION
    const array = planArray(requiredTB, p.diskTB, p.raid)
    const dailyTBOnDisk = (gbPerDay * K.FS_OVERHEAD) / 1000
    const expectedRetentionDays = dailyTBOnDisk > 0 ? array.usableTB / dailyTBOnDisk : Infinity

    const totals = {
      cameras,
      gbPerDay,
      rawTB,
      requiredTB,
      aggregateMbps,
      minRecorderMbps,
      expectedRetentionDays
    }
    const checks = runChecks(p, groups || [], totals, array)
    return { rows, totals, array, checks, status: worstLevel(checks) }
  }

  const LEVEL_RANK = { ok: 0, info: 1, warn: 2, critical: 3 }

  function worstLevel(checks) {
    return checks.reduce(
      (worst, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[worst] ? c.level : worst),
      'ok'
    )
  }

  function runChecks(p, groups, t, a) {
    const out = []
    const retention = num(p.retentionDays, 0)
    const headroom = num(p.headroom, K.MIN_HEADROOM)

    if (t.cameras === 0) {
      out.push({ level: 'info', text: 'Add at least one camera group to size storage.' })
      return out
    }
    if (retention <= 0) {
      out.push({ level: 'critical', text: 'Set a retention period of at least 1 day.' })
    }
    if (a.raid === 'jbod') {
      out.push({
        level: 'critical',
        text: 'JBOD has no redundancy. One failed disk loses footage. Not permitted for evidential or regulated recordings.'
      })
    }
    if (a.raid === 'raid5' && (a.arrayDisks > K.RAID5_MAX_DISKS || a.diskTB > K.RAID5_MAX_DISK_TB)) {
      out.push({
        level: 'warn',
        text: `RAID 5 is only for arrays of ${K.RAID5_MAX_DISKS} disks or fewer at ${K.RAID5_MAX_DISK_TB} TB or smaller. Rebuild risk is high here; use RAID 6.`
      })
    }
    if (headroom < K.MIN_HEADROOM) {
      out.push({
        level: 'warn',
        text: `Headroom ×${headroom.toFixed(2)} is below the ×${K.MIN_HEADROOM.toFixed(2)} minimum. Recorders begin overwriting at 90–95% full.`
      })
    }
    const bays = num(p.recorderBays, 0)
    if (bays > 0 && a.totalDisks > bays) {
      out.push({
        level: 'critical',
        text: `Needs ${a.totalDisks} disks but the recorder has ${bays} bays. Use larger disks or add an expansion unit.`
      })
    }
    const rated = num(p.recorderMbps, 0)
    if (rated > 0 && t.minRecorderMbps > rated) {
      out.push({
        level: 'critical',
        text: `Cameras send ${fmt(t.aggregateMbps, 0)} Mbps. The recorder needs at least ${fmt(t.minRecorderMbps, 0)} Mbps rated inbound, but it is rated for ${fmt(rated, 0)} Mbps.`
      })
    }
    if (groups.some((g) => g.codec === 'smart' && !(num(g.measuredMbps, 0) > 0))) {
      out.push({
        level: 'info',
        text: 'Smart-codec savings only count if the feature is enabled and verified at commissioning.'
      })
    }
    if (groups.some((g) => !(num(g.measuredMbps, 0) > 0))) {
      out.push({
        level: 'info',
        text: 'Some bitrates are planning estimates. Measure actual bitrates within 7 days of install and re-run if any group is 15% higher.'
      })
    }
    if (retention > 0 && Number.isFinite(t.expectedRetentionDays)) {
      if (t.expectedRetentionDays + EPS >= retention) {
        out.push({
          level: 'ok',
          text: `Meets the ${retention}-day requirement. About ${Math.floor(t.expectedRetentionDays)} days fit at design bitrates.`
        })
      } else {
        out.push({
          level: 'critical',
          text: `Array holds only about ${Math.floor(t.expectedRetentionDays)} days of footage.`
        })
      }
    }
    return out
  }

  function fmt(n, digits = 1) {
    if (!Number.isFinite(n)) return '—'
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  }

  function formatReport(project, groups, result) {
    const p = project || {}
    const { totals: t, array: a } = result
    const lines = []
    lines.push(`CCTV storage sizing — ${p.name || 'Untitled site'}`)
    lines.push(`Method: SOP-VSS-001. Retention ${p.retentionDays} days, headroom ×${num(p.headroom).toFixed(2)}, file-system overhead ×${K.FS_OVERHEAD}.`)
    lines.push('')
    lines.push('Camera groups')
    groups.forEach((g, i) => {
      const r = result.rows[i]
      const res = (byId(RESOLUTIONS, g.resolution) || {}).label || g.resolution
      const codec = (byId(CODECS, g.codec) || {}).label || g.codec
      const mode = (byId(MODES, g.mode) || {}).label || g.mode
      lines.push(
        `- ${g.name || `Group ${i + 1}`}: ${r.qty} × ${res} ${codec} @ ${g.fps} fps, ${mode}` +
          ` — ${fmt(r.mbps, 2)} Mbps${r.measured ? ' (measured)' : ' (est.)'}, duty ${fmt(r.duty, 2)},` +
          ` ${fmt(r.gbPerDayPerCam, 1)} GB/day/cam, ${fmt(r.gbPerDay, 1)} GB/day`
      )
    })
    lines.push('')
    lines.push(`Cameras: ${t.cameras}`)
    lines.push(`Recording per day: ${fmt(t.gbPerDay, 1)} GB`)
    lines.push(`Raw recording: ${fmt(t.rawTB, 2)} TB`)
    lines.push(`Required usable: ${fmt(t.requiredTB, 2)} TB`)
    lines.push(`Aggregate bitrate: ${fmt(t.aggregateMbps, 1)} Mbps (recorder rated ≥ ${fmt(t.minRecorderMbps, 0)} Mbps)`)
    lines.push(
      `Array: ${a.totalDisks} × ${a.diskTB} TB, ${a.raidLabel}` +
        ` (${a.dataDisks} data + ${a.parityDisks} ${a.raid === 'raid10' ? 'mirror' : 'parity'}` +
        `${a.spareDisks ? ` + ${a.spareDisks} hot spare` : ''})`
    )
    lines.push(`Usable: ${fmt(a.usableTB, 1)} TB (${fmt(a.usableTiB, 1)} TiB shown by the OS)`)
    lines.push(`Expected retention: ${Number.isFinite(t.expectedRetentionDays) ? Math.floor(t.expectedRetentionDays) : '—'} days`)
    lines.push('')
    lines.push('Checks')
    result.checks.forEach((c) => lines.push(`- [${c.level.toUpperCase()}] ${c.text}`))
    return lines.join('\n')
  }

  function formatCSV(groups, result) {
    const esc = (v) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const head = [
      'Group', 'Qty', 'Resolution', 'Codec', 'FPS', 'Scene', 'Mode', 'Hours', 'Night IR', 'Audio',
      'Bitrate Mbps', 'Bitrate source', 'Duty', 'GB/day/cam', 'GB/day'
    ]
    const rows = groups.map((g, i) => {
      const r = result.rows[i]
      return [
        g.name, r.qty, g.resolution, g.codec, g.fps, g.scene, g.mode,
        g.mode === 'scheduled' ? g.hours : '', g.nightIR ? 'yes' : 'no', g.audio ? 'yes' : 'no',
        r.mbps.toFixed(3), r.measured ? 'measured' : 'estimate', r.duty.toFixed(3),
        r.gbPerDayPerCam.toFixed(2), r.gbPerDay.toFixed(2)
      ]
    })
    return [head, ...rows].map((row) => row.map(esc).join(',')).join('\n')
  }

  /** SOP §6 worked example. Used as the app's sample data and in tests. */
  function exampleProject() {
    return {
      project: {
        name: 'Warehouse (example)',
        retentionDays: 30,
        headroom: 1.2,
        diskTB: 12,
        raid: 'raid6',
        recorderBays: '',
        recorderMbps: ''
      },
      groups: [
        { name: 'Aisles', qty: 24, resolution: '4MP', codec: 'h265', fps: 15, scene: 'medium', mode: 'continuous', hours: 24, nightIR: false, audio: false, measuredMbps: '' },
        { name: 'Loading docks', qty: 6, resolution: '8MP', codec: 'h265', fps: 20, scene: 'high', mode: 'continuous', hours: 24, nightIR: false, audio: false, measuredMbps: '' },
        { name: 'Offices', qty: 10, resolution: '2MP', codec: 'h265', fps: 15, scene: 'low', mode: 'motion-medium', hours: 24, nightIR: false, audio: false, measuredMbps: '' }
      ]
    }
  }

  function newGroup(n) {
    return {
      name: `Group ${n}`,
      qty: 1,
      resolution: '4MP',
      codec: 'h265',
      fps: 15,
      scene: 'medium',
      mode: 'continuous',
      hours: 24,
      nightIR: false,
      audio: false,
      measuredMbps: ''
    }
  }

  return {
    BASE_BITRATE,
    RESOLUTIONS,
    CODECS,
    SCENES,
    MODES,
    RAID_LEVELS,
    DISK_SIZES_TB,
    CONSTANTS: K,
    estimateBitrate,
    groupBitrate,
    dutyCycle,
    calculateGroup,
    planArray,
    calculateProject,
    formatReport,
    formatCSV,
    exampleProject,
    newGroup,
    fmt
  }
})
