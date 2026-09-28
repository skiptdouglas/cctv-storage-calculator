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

  // SOP §5 Step 2, Table 1 — H.264 planning bitrates in Mbps at 15 fps,
  // medium motion, medium quality. Other codecs scale by CODECS[].factor.
  const BASE_H264_MBPS = { '2MP': 4, '4MP': 6, '5MP': 8, '8MP': 12, '12MP': 16 }

  const RESOLUTIONS = [
    { id: '2MP', label: '2 MP (1080p)' },
    { id: '4MP', label: '4 MP (1440p)' },
    { id: '5MP', label: '5 MP' },
    { id: '8MP', label: '8 MP (4K)' },
    { id: '12MP', label: '12 MP (fisheye)' }
  ]

  const CODECS = [
    { id: 'h264', label: 'H.264', factor: 1 },
    { id: 'smart264', label: 'Smart H.264+', factor: 0.6, smart: true },
    { id: 'h265', label: 'H.265', factor: 0.5 },
    { id: 'smart', label: 'Smart H.265+', factor: 0.25, smart: true },
    { id: 'av1', label: 'AV1', factor: 0.35 },
    { id: 'mjpeg', label: 'MJPEG', factor: 5 }
  ]

  const QUALITIES = [
    { id: 'low', label: 'Low', factor: 0.7 },
    { id: 'medium', label: 'Medium', factor: 1 },
    { id: 'high', label: 'High', factor: 1.4 }
  ]

  // Derived Table 1 (Mbps) for display and reference: resolution × codec.
  const BASE_BITRATE = Object.fromEntries(
    Object.entries(BASE_H264_MBPS).map(([res, h264]) => [
      res,
      Object.fromEntries(CODECS.map((c) => [c.id, h264 * c.factor]))
    ])
  )

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
    BASE_FPS: 15,
    DEFAULT_NIGHT_HOURS: 12,
    SUBSTREAM_MBPS: 0.5, // typical live-view substream (D1/720p, H.264/H.265)
    UPLINK_UTILISATION: 0.7,
    POE_UTILISATION: 0.8,
    POE_BASE_W: 6, // fixed IP camera, day only
    POE_IR_W: 3, // IR illuminators on at night
    POE_HIRES_W: 2 // 8 MP and above
  }

  const LIVE_STREAM_TYPES = [
    { id: 'sub', label: 'Substream (low res)' },
    { id: 'main', label: 'Main stream (full res)' }
  ]

  const EPS = 1e-9
  const byId = (list, id) => list.find((x) => x.id === id)
  const num = (v, fallback = 0) => {
    const n = typeof v === 'number' ? v : parseFloat(v)
    return Number.isFinite(n) ? n : fallback
  }
  const ceil = (x) => Math.ceil(x - EPS)

  /**
   * Estimated bitrate at one frame rate (Mbps): Table 1 × codec × fps/15 ×
   * scene × quality, +20% for night IR, plus audio. `fps` defaults to g.fps.
   */
  function estimateBitrate(g, fps) {
    const h264 = BASE_H264_MBPS[g.resolution] ?? BASE_H264_MBPS['2MP']
    const codec = (byId(CODECS, g.codec) || byId(CODECS, 'h265')).factor
    const rate = Math.max(0, num(fps ?? g.fps, K.BASE_FPS))
    const scene = (byId(SCENES, g.scene) || byId(SCENES, 'medium')).factor
    const quality = (byId(QUALITIES, g.quality) || byId(QUALITIES, 'medium')).factor
    let mbps = h264 * codec * (rate / K.BASE_FPS) * scene * quality
    if (g.nightIR) mbps *= K.NIGHT_IR_FACTOR
    if (g.audio) mbps += K.AUDIO_MBPS
    return mbps
  }

  /** Night frame rate if one is set and differs from the day rate, else null. */
  function nightFps(g) {
    const n = num(g.nightFps, 0)
    return n > 0 && n !== num(g.fps, K.BASE_FPS) ? n : null
  }

  /**
   * Bitrates for one camera. `average` sizes storage (day and night frame rates
   * weighted by hours); `peak` sizes throughput (the higher of the two).
   * A measured bitrate always wins over the estimate.
   */
  function bitrates(g, nightHours = K.DEFAULT_NIGHT_HOURS) {
    const nf = nightFps(g)
    const day = estimateBitrate(g)
    let average = day
    let peak = day
    if (nf !== null) {
      const night = estimateBitrate(g, nf)
      const nh = Math.min(24, Math.max(0, num(nightHours, K.DEFAULT_NIGHT_HOURS)))
      average = (day * (24 - nh) + night * nh) / 24
      peak = Math.max(day, night)
    }
    const measured = num(g.measuredMbps, 0)
    if (measured > 0) return { estimate: average, average: measured, peak: measured, measured: true }
    return { estimate: average, average, peak, measured: false }
  }

  function groupBitrate(g, nightHours) {
    return bitrates(g, nightHours).average
  }

  /** Estimated PoE draw per camera (W). A value entered in poeW wins. */
  function estimatePoE(g) {
    let w = K.POE_BASE_W
    if (g.nightIR) w += K.POE_IR_W
    if (g.resolution === '8MP' || g.resolution === '12MP') w += K.POE_HIRES_W
    return w
  }

  function groupPoE(g) {
    const entered = num(g.poeW, 0)
    return entered > 0 ? entered : estimatePoE(g)
  }

  function dutyCycle(g) {
    const mode = byId(MODES, g.mode) || MODES[0]
    if (mode.id === 'scheduled') return Math.min(24, Math.max(0, num(g.hours, 24))) / 24
    return mode.duty
  }

  function calculateGroup(g, nightHours) {
    const qty = Math.max(0, Math.floor(num(g.qty, 0)))
    const b = bitrates(g, nightHours)
    const mbps = b.average
    const duty = dutyCycle(g)
    const gbPerDayPerCam = mbps * duty * K.GB_PER_MBPS_DAY
    return {
      qty,
      measured: b.measured,
      estimatedMbps: b.estimate,
      mbps,
      peakMbps: b.peak,
      duty,
      gbPerDayPerCam,
      gbPerDay: gbPerDayPerCam * qty,
      aggregateMbps: b.peak * qty,
      estimatedPoeW: estimatePoE(g),
      poeW: groupPoE(g),
      totalPoeW: groupPoE(g) * qty
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
    const rows = (groups || []).map((g) => calculateGroup(g, p.nightHours))

    const cameras = rows.reduce((s, r) => s + r.qty, 0)
    const gbPerDay = rows.reduce((s, r) => s + r.gbPerDay, 0)
    const aggregateMbps = rows.reduce((s, r) => s + r.aggregateMbps, 0)
    const rawTB = (gbPerDay * Math.max(0, retentionDays)) / 1000
    const requiredTB = rawTB * K.FS_OVERHEAD * headroom
    const minRecorderMbps = aggregateMbps / K.RECORDER_UTILISATION
    const array = planArray(requiredTB, p.diskTB, p.raid)
    const network = calculateNetwork(p, groups || [], rows)
    const viewing = calculateViewing(p, cameras, aggregateMbps)
    const disk = {
      writeMBps: aggregateMbps / 8,
      readMBps: viewing.playbackMbps / 8
    }
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
    const checks = runChecks(p, groups || [], totals, array, network, viewing)
    return { rows, totals, array, network, viewing, disk, checks, status: worstLevel(checks) }
  }

  /** Traffic and PoE per switch. Cameras with no switch are reported separately. */
  function calculateNetwork(p, groups, rows) {
    const switches = (p.switches || []).map((sw) => ({
      id: sw.id,
      name: sw.name || 'Switch',
      uplinkMbps: num(sw.uplinkMbps, 0),
      poeBudgetW: num(sw.poeBudgetW, 0),
      cameras: 0,
      mbps: 0,
      poeW: 0
    }))
    const unassigned = { cameras: 0, mbps: 0, poeW: 0 }
    groups.forEach((g, i) => {
      const r = rows[i]
      const target = switches.find((sw) => sw.id === g.switch) || unassigned
      target.cameras += r.qty
      target.mbps += r.aggregateMbps
      target.poeW += r.totalPoeW
    })
    switches.forEach((sw) => {
      sw.uplinkLoad = sw.uplinkMbps > 0 ? sw.mbps / sw.uplinkMbps : null
      sw.poeLoad = sw.poeBudgetW > 0 ? sw.poeW / sw.poeBudgetW : null
    })
    return { switches, unassigned }
  }

  /**
   * Live view and playback traffic served by the recorder. Main-stream views
   * use the average camera bitrate; substream views use K.SUBSTREAM_MBPS.
   */
  function calculateViewing(p, cameras, aggregateMbps) {
    const live = Math.max(0, Math.floor(num(p.liveStreams, 0)))
    const playback = Math.max(0, Math.floor(num(p.playbackStreams, 0)))
    const avgMainMbps = cameras > 0 ? aggregateMbps / cameras : 0
    const liveEach = p.liveStreamType === 'main' ? avgMainMbps : K.SUBSTREAM_MBPS
    const liveMbps = live * liveEach
    const playbackMbps = playback * avgMainMbps
    return {
      liveStreams: live,
      playbackStreams: playback,
      avgMainMbps,
      liveMbps,
      playbackMbps,
      totalMbps: liveMbps + playbackMbps
    }
  }

  const LEVEL_RANK = { ok: 0, info: 1, warn: 2, critical: 3 }

  function worstLevel(checks) {
    return checks.reduce(
      (worst, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[worst] ? c.level : worst),
      'ok'
    )
  }

  function runChecks(p, groups, t, a, net, view) {
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
    const pct = (x) => `${Math.round(x * 100)}%`
    ;(net ? net.switches : []).forEach((sw) => {
      if (sw.uplinkLoad !== null) {
        if (sw.uplinkLoad > 1) {
          out.push({ level: 'critical', text: `${sw.name}: cameras send ${fmt(sw.mbps, 0)} Mbps, more than its ${fmt(sw.uplinkMbps, 0)} Mbps uplink.` })
        } else if (sw.uplinkLoad > K.UPLINK_UTILISATION) {
          out.push({ level: 'warn', text: `${sw.name}: uplink is ${pct(sw.uplinkLoad)} loaded. Keep it at or below ${pct(K.UPLINK_UTILISATION)}; use a faster uplink or spread cameras across switches.` })
        }
      }
      if (sw.poeLoad !== null) {
        if (sw.poeLoad > 1) {
          out.push({ level: 'critical', text: `${sw.name}: cameras draw ${fmt(sw.poeW, 0)} W, more than its ${fmt(sw.poeBudgetW, 0)} W PoE budget. Some cameras will not power on.` })
        } else if (sw.poeLoad > K.POE_UTILISATION) {
          out.push({ level: 'warn', text: `${sw.name}: PoE budget is ${pct(sw.poeLoad)} used. Keep it at or below ${pct(K.POE_UTILISATION)} to allow for IR, heaters and start-up surges.` })
        }
      }
    })
    if (net && net.switches.length > 0 && net.unassigned.cameras > 0) {
      out.push({ level: 'info', text: `${net.unassigned.cameras} camera${net.unassigned.cameras === 1 ? ' is' : 's are'} not assigned to a switch, so their traffic and power are not checked.` })
    }
    if (view) {
      const out_ = num(p.recorderOutMbps, 0)
      if (out_ > 0 && view.totalMbps > out_) {
        out.push({ level: 'critical', text: `Viewing needs ${fmt(view.totalMbps, 1)} Mbps but the recorder is rated for ${fmt(out_, 0)} Mbps outbound. Reduce main-stream views or playback sessions.` })
      }
      const link = num(p.viewingLinkMbps, 0)
      if (link > 0 && view.totalMbps > link * K.UPLINK_UTILISATION) {
        out.push({
          level: view.totalMbps > link ? 'critical' : 'warn',
          text: `Viewing traffic of ${fmt(view.totalMbps, 1)} Mbps is ${pct(view.totalMbps / link)} of the ${fmt(link, 0)} Mbps viewing link. Use substreams for live view or add bandwidth.`
        })
      }
    }
    if (groups.some((g) => g.codec === 'mjpeg' && num(g.qty, 0) > 0 && !(num(g.measuredMbps, 0) > 0))) {
      out.push({
        level: 'info',
        text: 'MJPEG uses about 5× the storage of H.264. Switch those cameras to H.264 or H.265 unless an analytics system needs MJPEG.'
      })
    }
    if (groups.some((g) => (byId(CODECS, g.codec) || {}).smart && !(num(g.measuredMbps, 0) > 0))) {
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
      const nf = nightFps(g)
      const q = (byId(QUALITIES, g.quality) || byId(QUALITIES, 'medium')).label.toLowerCase()
      lines.push(
        `- ${g.name || `Group ${i + 1}`}: ${r.qty} × ${res} ${codec} @ ${g.fps} fps${nf !== null ? ` day / ${nf} fps night` : ''}, ${q} quality, ${mode}` +
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
    if (result.viewing) {
      const v = result.viewing
      lines.push(`Viewing: ${v.liveStreams} live (${p.liveStreamType === 'main' ? 'main stream' : 'substream'}) + ${v.playbackStreams} playback = ${fmt(v.totalMbps, 1)} Mbps`)
    }
    if (result.disk) {
      lines.push(`Disk throughput: ${fmt(result.disk.writeMBps, 1)} MB/s write, ${fmt(result.disk.readMBps, 1)} MB/s playback read`)
    }
    lines.push(
      `Array: ${a.totalDisks} × ${a.diskTB} TB, ${a.raidLabel}` +
        ` (${a.dataDisks} data + ${a.parityDisks} ${a.raid === 'raid10' ? 'mirror' : 'parity'}` +
        `${a.spareDisks ? ` + ${a.spareDisks} hot spare` : ''})`
    )
    lines.push(`Usable: ${fmt(a.usableTB, 1)} TB (${fmt(a.usableTiB, 1)} TiB shown by the OS)`)
    lines.push(`Expected retention: ${Number.isFinite(t.expectedRetentionDays) ? Math.floor(t.expectedRetentionDays) : '—'} days`)
    if (result.network && result.network.switches.length) {
      lines.push('')
      lines.push('Switches')
      result.network.switches.forEach((sw) => {
        lines.push(
          `- ${sw.name}: ${sw.cameras} cameras, ${fmt(sw.mbps, 1)} Mbps` +
            (sw.uplinkLoad !== null ? ` (${Math.round(sw.uplinkLoad * 100)}% of ${fmt(sw.uplinkMbps, 0)} Mbps uplink)` : '') +
            `, ${fmt(sw.poeW, 0)} W PoE` +
            (sw.poeLoad !== null ? ` (${Math.round(sw.poeLoad * 100)}% of ${fmt(sw.poeBudgetW, 0)} W)` : '')
        )
      })
      if (result.network.unassigned.cameras) lines.push(`- Not assigned: ${result.network.unassigned.cameras} cameras`)
    }
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
      'Group', 'Qty', 'Resolution', 'Codec', 'Quality', 'FPS', 'Night FPS', 'Scene', 'Mode', 'Hours', 'Night IR', 'Audio',
      'Bitrate Mbps', 'Peak Mbps', 'Bitrate source', 'Duty', 'GB/day/cam', 'GB/day', 'Switch', 'PoE W/cam'
    ]
    const switchName = (id) => ((result.network && result.network.switches.find((sw) => sw.id === id)) || {}).name || ''
    const rows = groups.map((g, i) => {
      const r = result.rows[i]
      return [
        g.name, r.qty, g.resolution, g.codec, g.quality || 'medium', g.fps, nightFps(g) ?? '', g.scene, g.mode,
        g.mode === 'scheduled' ? g.hours : '', g.nightIR ? 'yes' : 'no', g.audio ? 'yes' : 'no',
        r.mbps.toFixed(3), r.peakMbps.toFixed(3), r.measured ? 'measured' : 'estimate', r.duty.toFixed(3),
        r.gbPerDayPerCam.toFixed(2), r.gbPerDay.toFixed(2), switchName(g.switch), r.poeW.toFixed(1)
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
        recorderMbps: '',
        recorderOutMbps: '',
        nightHours: 12,
        liveStreams: 4,
        liveStreamType: 'sub',
        playbackStreams: 1,
        viewingLinkMbps: '',
        switches: [
          { id: 'sw1', name: 'SW1 · 24-port', uplinkMbps: 1000, poeBudgetW: 370 },
          { id: 'sw2', name: 'SW2 · 16-port', uplinkMbps: 1000, poeBudgetW: 240 }
        ]
      },
      groups: [
        { name: 'Aisles', qty: 24, resolution: '4MP', codec: 'h265', quality: 'medium', fps: 15, nightFps: '', scene: 'medium', mode: 'continuous', hours: 24, nightIR: false, audio: false, measuredMbps: '', switch: 'sw1', poeW: '' },
        { name: 'Loading docks', qty: 6, resolution: '8MP', codec: 'h265', quality: 'medium', fps: 20, nightFps: '', scene: 'high', mode: 'continuous', hours: 24, nightIR: false, audio: false, measuredMbps: '', switch: 'sw2', poeW: '' },
        { name: 'Offices', qty: 10, resolution: '2MP', codec: 'h265', quality: 'medium', fps: 15, nightFps: '', scene: 'low', mode: 'motion-medium', hours: 24, nightIR: false, audio: false, measuredMbps: '', switch: 'sw2', poeW: '' }
      ]
    }
  }

  function newGroup(n) {
    return {
      name: `Group ${n}`,
      qty: 1,
      resolution: '4MP',
      codec: 'h265',
      quality: 'medium',
      fps: 15,
      nightFps: '',
      scene: 'medium',
      mode: 'continuous',
      hours: 24,
      nightIR: false,
      audio: false,
      measuredMbps: '',
      switch: '',
      poeW: ''
    }
  }

  /** Fills fields added in later versions so older saved projects still load. */
  function withDefaults(project, groups) {
    const base = exampleProject().project
    const p = {
      ...base,
      name: '',
      recorderBays: '',
      recorderMbps: '',
      nightHours: K.DEFAULT_NIGHT_HOURS,
      liveStreams: 0,
      playbackStreams: 0,
      switches: [],
      ...(project || {})
    }
    if (!Array.isArray(p.switches)) p.switches = []
    const ids = new Set(p.switches.map((sw) => sw.id))
    const gs = (groups || []).map((g, i) => {
      const merged = { ...newGroup(i + 1), ...g }
      if (merged.switch && !ids.has(merged.switch)) merged.switch = ''
      return merged
    })
    return { project: p, groups: gs }
  }

  return {
    BASE_BITRATE,
    RESOLUTIONS,
    CODECS,
    QUALITIES,
    SCENES,
    MODES,
    RAID_LEVELS,
    DISK_SIZES_TB,
    LIVE_STREAM_TYPES,
    CONSTANTS: K,
    estimateBitrate,
    bitrates,
    nightFps,
    groupBitrate,
    dutyCycle,
    estimatePoE,
    calculateGroup,
    calculateNetwork,
    calculateViewing,
    withDefaults,
    planArray,
    calculateProject,
    formatReport,
    formatCSV,
    exampleProject,
    newGroup,
    fmt
  }
})
