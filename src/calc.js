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
  const BASE_H264_MBPS = { CIF: 0.5, D1: 1, '960H': 1.3, '1MP': 2, '2MP': 4, '3MP': 5, '4MP': 6, '5MP': 8, '6MP': 10, '8MP': 12, '12MP': 16 }

  // Pixel sizes are used by the raw-pixel method only.
  const RESOLUTIONS = [
    { id: 'CIF', label: 'CIF (analog)', width: 352, height: 240, coax: true },
    { id: 'D1', label: 'D1 (analog)', width: 720, height: 480, coax: true },
    { id: '960H', label: '960H (analog)', width: 960, height: 480, coax: true },
    { id: '1MP', label: '1 MP (720p)', width: 1280, height: 720 },
    { id: '2MP', label: '2 MP (1080p)', width: 1920, height: 1080 },
    { id: '3MP', label: '3 MP', width: 2048, height: 1536 },
    { id: '4MP', label: '4 MP (1440p)', width: 2560, height: 1440 },
    { id: '5MP', label: '5 MP', width: 2592, height: 1944 },
    { id: '6MP', label: '6 MP', width: 3072, height: 2048 },
    { id: '8MP', label: '8 MP (4K)', width: 3840, height: 2160 },
    { id: '12MP', label: '12 MP (fisheye)', width: 4000, height: 3000 }
  ]

  const METHODS = [
    { id: 'bitrate', label: 'Typical bitrates (SOP Table 1)' },
    { id: 'raw', label: 'Raw pixels ÷ compression ratio' }
  ]

  // Raw-pixel method: uncompressed bits ÷ ratio. Editable per project.
  const DEFAULT_COMPRESSION_RATIOS = {
    mjpeg: 20,
    h264: 100,
    smart264: 170,
    h265: 200,
    smart: 400,
    av1: 285
  }

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
    { id: 'jbod', label: 'No RAID (separate drives)', parity: 0, minDisks: 1 }
  ]

  const DISK_SIZES_TB = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]

  const K = {
    GB_PER_MBPS_DAY: 10.8, // 86,400 s ÷ 8 bits ÷ 1,000 MB
    DAYS_PER_MONTH: 30.44,
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
    COLOR_DEPTH_4K: 30, // bits per pixel at 4K (8.3 MP) and above
    COLOR_DEPTH_STD: 16, // bits per pixel below 4K
    PIXELS_4K: 3840 * 2160,
    SUBSTREAM_MBPS: 0.5, // typical live-view substream (D1/720p, H.264/H.265)
    UPLINK_UTILISATION: 0.7,
    POE_UTILISATION: 0.8,
    POE_BASE_W: 6, // fixed IP camera, day only
    POE_IR_W: 3, // IR illuminators on at night
    POE_HIRES_W: 2 // 8 MP and above
  }

  // Where a camera group's footage is kept.
  const TARGETS = [
    { id: 'recorder', label: 'Recorder' },
    { id: 'cloud', label: 'Cloud (VSaaS)' },
    { id: 'edge', label: 'Edge SD card' }
  ]

  // Generic camera-type presets. Vendor-neutral planning values; datasheet
  // figures beat them. Editable here; the UI lists them in this order.
  const PRESETS = [
    { id: 'dome2', label: 'Dome 2 MP, H.265, IR', resolution: '2MP', codec: 'h265', fps: 15, nightIR: true, poeW: 6 },
    { id: 'dome4', label: 'Dome 4 MP, H.265, IR', resolution: '4MP', codec: 'h265', fps: 15, nightIR: true, poeW: 7 },
    { id: 'bullet4', label: 'Bullet 4 MP, H.265, long IR', resolution: '4MP', codec: 'h265', fps: 15, nightIR: true, poeW: 9 },
    { id: 'bullet8', label: 'Bullet 8 MP (4K), H.265, IR', resolution: '8MP', codec: 'h265', fps: 15, nightIR: true, poeW: 11 },
    { id: 'turret5', label: 'Turret 5 MP, Smart H.265+, IR', resolution: '5MP', codec: 'smart', fps: 15, nightIR: true, poeW: 7 },
    { id: 'lpr', label: 'LPR / ANPR 2 MP, 30 fps', resolution: '2MP', codec: 'h264', fps: 30, nightIR: true, poeW: 12, scene: 'high' },
    { id: 'ptz2', label: 'PTZ 2 MP 25×, H.265 (PoE+)', resolution: '2MP', codec: 'h265', fps: 25, nightIR: true, poeW: 25, scene: 'high' },
    { id: 'ptz4', label: 'PTZ 4 MP 32×, IR, heater (PoE++)', resolution: '4MP', codec: 'h265', fps: 25, nightIR: true, poeW: 60, scene: 'high' },
    { id: 'fisheye12', label: 'Fisheye 12 MP, H.265', resolution: '12MP', codec: 'h265', fps: 15, nightIR: false, poeW: 9 },
    { id: 'multi4x5', label: 'Multi-sensor 4 × 5 MP (one sensor per camera row)', resolution: '5MP', codec: 'h265', fps: 15, nightIR: true, poeW: 6, note: 'Enter 4 cameras per unit.' },
    { id: 'tvi2', label: 'HD-TVI / AHD 2 MP over coax', resolution: '2MP', codec: 'h265', fps: 15, nightIR: true, poeW: '', coax: true },
    { id: 'analog960', label: 'Analog 960H over coax', resolution: '960H', codec: 'h264', fps: 15, nightIR: true, poeW: '' },
    { id: 'indoor2', label: 'Indoor cube 2 MP, no IR', resolution: '2MP', codec: 'h265', fps: 10, nightIR: false, poeW: 4, scene: 'low' }
  ]

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
  function estimateBitrate(g, fps, model) {
    const rate = Math.max(0, num(fps ?? g.fps, K.BASE_FPS))
    const scene = (byId(SCENES, g.scene) || byId(SCENES, 'medium')).factor
    const quality = (byId(QUALITIES, g.quality) || byId(QUALITIES, 'medium')).factor
    const base = model && model.method === 'raw'
      ? rawCompressedMbps(g, rate, model.ratios)
      : (BASE_H264_MBPS[g.resolution] ?? BASE_H264_MBPS['2MP']) *
        (byId(CODECS, g.codec) || byId(CODECS, 'h265')).factor *
        (rate / K.BASE_FPS)
    let mbps = base * scene * quality
    if (g.nightIR) mbps *= K.NIGHT_IR_FACTOR
    if (g.audio) mbps += K.AUDIO_MBPS
    return mbps
  }

  /** Bits per pixel for the raw-pixel method: 30 at 4K and above, else 16. */
  function colorDepth(resolution) {
    const r = byId(RESOLUTIONS, resolution) || byId(RESOLUTIONS, '2MP')
    return r.width * r.height >= K.PIXELS_4K ? K.COLOR_DEPTH_4K : K.COLOR_DEPTH_STD
  }

  function compressionRatio(codec, ratios) {
    const entered = num(ratios && ratios[codec], 0)
    return entered > 0 ? entered : DEFAULT_COMPRESSION_RATIOS[codec] ?? DEFAULT_COMPRESSION_RATIOS.h265
  }

  /** Raw-pixel method: width × height × color depth × fps ÷ compression ratio (Mbps). */
  function rawCompressedMbps(g, fps, ratios) {
    const r = byId(RESOLUTIONS, g.resolution) || byId(RESOLUTIONS, '2MP')
    const rawBps = r.width * r.height * colorDepth(g.resolution) * fps
    return rawBps / compressionRatio(g.codec, ratios) / 1e6
  }

  /** The estimating method and settings for a project. */
  function modelFor(p) {
    return {
      method: p && p.method === 'raw' ? 'raw' : 'bitrate',
      ratios: (p && p.compressionRatios) || {}
    }
  }

  /**
   * Night frame rate if one is set and differs from the day rate, else null.
   * Scheduled groups record fixed hours, so a night rate does not apply.
   */
  function nightFps(g) {
    if (g.mode === 'scheduled') return null
    const n = num(g.nightFps, 0)
    return n > 0 && n !== num(g.fps, K.BASE_FPS) ? n : null
  }

  /**
   * Bitrates for one camera. `average` sizes storage (day and night frame rates
   * weighted by hours); `peak` sizes throughput (the higher of the two).
   * A measured bitrate always wins over the estimate.
   */
  function bitrates(g, nightHours = K.DEFAULT_NIGHT_HOURS, model) {
    const nf = nightFps(g)
    const day = estimateBitrate(g, undefined, model)
    let average = day
    let peak = day
    if (nf !== null) {
      const night = estimateBitrate(g, nf, model)
      const nh = Math.min(24, Math.max(0, num(nightHours, K.DEFAULT_NIGHT_HOURS)))
      average = (day * (24 - nh) + night * nh) / 24
      peak = Math.max(day, night)
    }
    const measured = num(g.measuredMbps, 0)
    if (measured > 0) return { estimate: average, average: measured, peak: measured, measured: true }
    return { estimate: average, average, peak, measured: false }
  }

  function groupBitrate(g, nightHours, model) {
    return bitrates(g, nightHours, model).average
  }

  /** Analog cameras connect to a DVR by coax: no PoE, no network switch. */
  function isCoax(g) {
    return !!((byId(RESOLUTIONS, g.resolution) || {}).coax)
  }

  /** Estimated PoE draw per camera (W). A value entered in poeW wins. Coax cameras draw none. */
  function estimatePoE(g) {
    if (isCoax(g)) return 0
    let w = K.POE_BASE_W
    if (g.nightIR) w += K.POE_IR_W
    if (g.resolution === '8MP' || g.resolution === '12MP') w += K.POE_HIRES_W
    return w
  }

  function groupPoE(g) {
    if (isCoax(g)) return 0
    const entered = num(g.poeW, 0)
    return entered > 0 ? entered : estimatePoE(g)
  }

  function dutyCycle(g) {
    const mode = byId(MODES, g.mode) || MODES[0]
    if (mode.id === 'scheduled') return Math.min(24, Math.max(0, num(g.hours, 24))) / 24
    return mode.duty
  }

  function calculateGroup(g, nightHours, model) {
    const qty = Math.max(0, Math.floor(num(g.qty, 0)))
    const b = bitrates(g, nightHours, model)
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
      totalPoeW: groupPoE(g) * qty,
      coax: isCoax(g)
    }
  }

  /**
   * SOP §5 Step 7 — disk count for a required usable capacity. With
   * `existingDisks` set, describes that array instead (existing-site mode).
   */
  function planArray(requiredTB, diskTB, raidId, existingDisks) {
    const raid = byId(RAID_LEVELS, raidId) || RAID_LEVELS[0]
    const size = Math.max(0, num(diskTB, 0))
    const existing = Math.max(0, Math.floor(num(existingDisks, 0)))
    let dataDisks
    let parityDisks
    let spareDisks
    if (existing > 0) {
      spareDisks = raid.id !== 'jbod' && existing >= K.HOT_SPARE_FROM_DISKS + 1 ? 1 : 0
      const inArray = existing - spareDisks
      if (raid.id === 'raid10') {
        dataDisks = Math.floor(inArray / 2)
        parityDisks = inArray - dataDisks
      } else {
        dataDisks = Math.max(0, inArray - raid.parity)
        parityDisks = inArray - dataDisks
      }
    } else {
      const needData = size > 0 ? Math.max(0, ceil(requiredTB / size)) : 0
      if (raid.id === 'raid10') {
        dataDisks = Math.max(raid.minDisks / 2, needData)
        parityDisks = dataDisks // mirror copies
      } else {
        const total = Math.max(raid.minDisks, needData + raid.parity)
        dataDisks = total - raid.parity
        parityDisks = raid.parity
      }
      spareDisks = raid.id !== 'jbod' && dataDisks + parityDisks >= K.HOT_SPARE_FROM_DISKS ? 1 : 0
    }
    const arrayDisks = dataDisks + parityDisks
    const usableTB = dataDisks * size
    return {
      existing: existing > 0,
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

  function newRecorder(n) {
    return { id: `r${n}`, name: n === 1 ? 'NVR' : `NVR ${n}`, diskTB: 12, raid: 'raid6', bays: '', inboundMbps: '', arrayMode: 'design', existingDisks: '' }
  }

  /**
   * The site's recorders. Older projects (and tests) describe one recorder with
   * flat fields on the project; those override the first recorder when present.
   */
  function recordersOf(p) {
    const list = Array.isArray(p.recorders) && p.recorders.length ? p.recorders.map((r) => ({ ...r })) : [newRecorder(1)]
    const legacy = {
      diskTB: p.diskTB, raid: p.raid, bays: p.recorderBays, inboundMbps: p.recorderMbps,
      arrayMode: p.arrayMode, existingDisks: p.existingDisks
    }
    Object.entries(legacy).forEach(([k, v]) => { if (v !== undefined) list[0][k] = v })
    return list
  }

  function targetOf(g) {
    return byId(TARGETS, g.target) ? g.target : 'recorder'
  }

  /** Apply a camera preset to a group. Quantity, name, mode and switch are kept. */
  function applyPreset(g, presetId) {
    const pr = byId(PRESETS, presetId)
    if (!pr) return { ...g, preset: '' }
    const out = { ...g, preset: pr.id, resolution: pr.resolution, codec: pr.codec, fps: pr.fps, nightIR: !!pr.nightIR, poeW: pr.poeW ?? '', measuredMbps: '' }
    if (pr.scene) out.scene = pr.scene
    return out
  }

  /** Days the recorder itself must hold: all of retention, or the hot tier only. */
  function hotDaysOf(p) {
    const retention = Math.max(0, num(p.retentionDays, 0))
    const a = p.archive || {}
    const hot = num(a.hotDays, 0)
    return a.enabled && hot > 0 && hot < retention ? hot : retention
  }

  function calculateProject(project, groups) {
    const p = project || {}
    const gs = groups || []
    const retentionDays = Math.max(0, num(p.retentionDays, 0))
    const headroom = num(p.headroom, K.MIN_HEADROOM)
    const model = modelFor(p)
    const recorders = recordersOf(p)
    const rows = gs.map((g) => {
      const r = calculateGroup(g, p.nightHours, model)
      r.target = targetOf(g)
      r.recorderId = r.target === 'recorder' ? ((byId(recorders, g.recorder) || recorders[0]).id) : ''
      return r
    })
    const sum = (list, key) => list.reduce((s, r) => s + r[key], 0)

    const cameras = sum(rows, 'qty')
    const gbPerDay = sum(rows, 'gbPerDay')
    const hotDays = hotDaysOf(p)

    // Each recorder is sized for the groups that record to it.
    const recResults = recorders.map((rec) => {
      const mine = rows.filter((r) => r.recorderId === rec.id)
      const rCams = sum(mine, 'qty')
      const rGb = sum(mine, 'gbPerDay')
      const rAgg = sum(mine, 'aggregateMbps')
      const rawTB = (rGb * hotDays) / 1000
      const requiredTB = rawTB * K.FS_OVERHEAD * headroom
      const array = planArray(requiredTB, rec.diskTB, rec.raid, rec.arrayMode === 'existing' ? rec.existingDisks : 0)
      const dailyTBOnDisk = (rGb * K.FS_OVERHEAD) / 1000
      const expectedRetentionDays = dailyTBOnDisk > 0 ? array.usableTB / dailyTBOnDisk : Infinity
      // Existing-site mode: capacity left once the required days are covered,
      // with headroom kept, expressed as extra cameras at this recorder's average.
      const spareTB = array.usableTB / headroom - rawTB * K.FS_OVERHEAD
      const avgTBPerCam = rCams > 0 ? (rawTB * K.FS_OVERHEAD) / rCams : 0
      const spareCameras = avgTBPerCam > 0 ? Math.floor(Math.max(0, spareTB) / avgTBPerCam) : 0
      return {
        ...rec,
        cameras: rCams,
        gbPerDay: rGb,
        rawTB,
        requiredTB,
        aggregateMbps: rAgg,
        minRecorderMbps: rAgg / K.RECORDER_UTILISATION,
        array,
        expectedRetentionDays,
        spareTB,
        spareCameras,
        hotDays
      }
    })

    // Cloud-recorded groups: storage is bought per GB, uploads leave the site.
    const cloudRows = rows.filter((r) => r.target === 'cloud')
    const cloudGb = sum(cloudRows, 'gbPerDay')
    const cloud = {
      cameras: sum(cloudRows, 'qty'),
      gbPerDay: cloudGb,
      retentionTB: (cloudGb * retentionDays) / 1000,
      monthlyGB: cloudGb * K.DAYS_PER_MONTH,
      uploadMbps: sum(cloudRows, 'aggregateMbps'),
      uploadLimitMbps: num(p.internetUploadMbps, 0)
    }
    cloud.uploadLoad = cloud.uploadLimitMbps > 0 ? cloud.uploadMbps / cloud.uploadLimitMbps : null

    // Edge-recorded groups: each camera keeps its own footage on an SD card.
    const edge = rows.map((r, i) => ({ r, g: gs[i], i })).filter((x) => x.r.target === 'edge').map(({ r, g, i }) => {
      const sdGB = num(g.sdGB, 0)
      return {
        index: i,
        name: g.name || `Group ${i + 1}`,
        cameras: r.qty,
        sdGB,
        gbPerDayPerCam: r.gbPerDayPerCam,
        daysFit: r.gbPerDayPerCam > 0 && sdGB > 0 ? sdGB / (r.gbPerDayPerCam * K.FS_OVERHEAD) : sdGB > 0 ? Infinity : 0
      }
    })

    // Archive tier: footage older than the hot days moves off the recorders.
    const recorderGb = sum(recResults, 'gbPerDay')
    const archiveDays = retentionDays - hotDays
    const archive = {
      enabled: archiveDays > 0,
      hotDays,
      archiveDays,
      rawTB: (recorderGb * archiveDays) / 1000,
      requiredTB: (recorderGb * archiveDays * K.FS_OVERHEAD * headroom) / 1000
    }

    const aggregateMbps = sum(recResults, 'aggregateMbps')
    const recorderCams = sum(recResults, 'cameras')
    const network = calculateNetwork(p, gs, rows)
    const viewing = calculateViewing(p, recorderCams, aggregateMbps)
    const disk = { writeMBps: aggregateMbps / 8, readMBps: viewing.playbackMbps / 8 }
    const withCams = recResults.filter((r) => r.cameras > 0)
    const expectedRetentionDays = withCams.length ? Math.min(...withCams.map((r) => r.expectedRetentionDays)) : Infinity

    const totals = {
      cameras,
      gbPerDay,
      recorderCameras: recorderCams,
      recorderGbPerDay: recorderGb,
      rawTB: sum(recResults, 'rawTB'),
      requiredTB: sum(recResults, 'requiredTB'),
      aggregateMbps,
      minRecorderMbps: aggregateMbps / K.RECORDER_UTILISATION,
      expectedRetentionDays,
      spareTB: recResults.reduce((s, r) => s + Math.max(0, r.spareTB), 0),
      spareCameras: sum(recResults, 'spareCameras'),
      hotDays
    }
    const result = { rows, totals, recorders: recResults, array: recResults[0].array, cloud, edge, archive, network, viewing, disk }
    result.checks = runChecks(p, gs, result)
    result.status = worstLevel(result.checks)
    return result
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
    const coax = { cameras: 0, mbps: 0 }
    groups.forEach((g, i) => {
      const r = rows[i]
      if (r.coax) {
        coax.cameras += r.qty
        coax.mbps += r.aggregateMbps
        return
      }
      const target = switches.find((sw) => sw.id === g.switch) || unassigned
      target.cameras += r.qty
      target.mbps += r.aggregateMbps
      target.poeW += r.totalPoeW
    })
    switches.forEach((sw) => {
      sw.uplinkLoad = sw.uplinkMbps > 0 ? sw.mbps / sw.uplinkMbps : null
      sw.poeLoad = sw.poeBudgetW > 0 ? sw.poeW / sw.poeBudgetW : null
    })
    return { switches, unassigned, coax }
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

  function runChecks(p, groups, res) {
    const { totals: t, network: net, viewing: view, cloud, edge, archive } = res
    const out = []
    const retention = num(p.retentionDays, 0)
    const headroom = num(p.headroom, K.MIN_HEADROOM)
    const many = res.recorders.length > 1
    const tag = (rec) => (many ? `${rec.name || 'Recorder'}: ` : '')

    if (t.cameras === 0) {
      out.push({ level: 'info', text: 'Add at least one camera group to size storage.' })
      return out
    }
    if (retention <= 0) {
      out.push({ level: 'critical', text: 'Set a retention period of at least 1 day.' })
    }
    const isBlank = (v) => v === '' || v === undefined || v === null
    groups.forEach((g, i) => {
      const name = g.name || `Group ${i + 1}`
      const blank = []
      if (isBlank(g.qty)) blank.push('quantity')
      if (isBlank(g.fps)) blank.push('frame rate')
      if (g.mode === 'scheduled' && isBlank(g.hours)) blank.push('hours per day')
      if (blank.length) {
        out.push({ level: 'warn', text: `${name}: ${blank.join(' and ')} ${blank.length > 1 ? 'are' : 'is'} blank, so the group counts as ${blank[0] === 'quantity' ? 'no cameras' : 'the default'}. Enter a value.` })
      }
    })
    groups.forEach((g, i) => {
      if (targetOf(g) === 'edge' && (g.sdGB === '' || g.sdGB === undefined || g.sdGB === null || num(g.sdGB, 0) <= 0)) {
        out.push({ level: 'warn', text: `${g.name || `Group ${i + 1}`}: records to an SD card but no card size is entered.` })
      }
    })
    res.recorders.forEach((rec) => {
      const a = rec.array
      if (rec.cameras === 0 && many) {
        out.push({ level: 'info', text: `${tag(rec)}no camera groups record to it.` })
        return
      }
      if (a.existing && a.dataDisks === 0) {
        out.push({ level: 'critical', text: `${tag(rec)}${a.raidLabel} needs more than ${a.totalDisks} disk${a.totalDisks === 1 ? '' : 's'}. Add disks or choose a different RAID level.` })
      }
      if (a.raid === 'jbod') {
        out.push(p.evidential === false
          ? {
              level: 'warn',
              text: `${tag(rec)}No RAID: a failed disk loses the footage on it. Acceptable only because this system is marked as not holding evidential or regulated footage.`
            }
          : {
              level: 'critical',
              text: `${tag(rec)}No RAID: a failed disk loses the footage on it. Not permitted for evidential or regulated footage. Choose RAID 6, or untick "Evidential or regulated footage" if this system holds neither.`
            })
      }
      if (a.raid === 'raid5' && (a.arrayDisks > K.RAID5_MAX_DISKS || a.diskTB > K.RAID5_MAX_DISK_TB)) {
        out.push({
          level: 'warn',
          text: `${tag(rec)}RAID 5 is only for arrays of ${K.RAID5_MAX_DISKS} disks or fewer at ${K.RAID5_MAX_DISK_TB} TB or smaller. Rebuild risk is high here; use RAID 6.`
        })
      }
      const bays = num(rec.bays, 0)
      if (bays > 0 && a.totalDisks > bays) {
        out.push({
          level: 'critical',
          text: `${tag(rec)}Needs ${a.totalDisks} disks but the recorder has ${bays} bays. Use larger disks or add an expansion unit.`
        })
      }
      const rated = num(rec.inboundMbps, 0)
      if (rated > 0 && rec.minRecorderMbps > rated) {
        out.push({
          level: 'critical',
          text: `${tag(rec)}Cameras send ${fmt(rec.aggregateMbps, 0)} Mbps. The recorder needs at least ${fmt(rec.minRecorderMbps, 0)} Mbps rated inbound, but it is rated for ${fmt(rated, 0)} Mbps.`
        })
      }
    })
    if (headroom < K.MIN_HEADROOM) {
      out.push({
        level: 'warn',
        text: `Headroom ×${headroom.toFixed(2)} is below the ×${K.MIN_HEADROOM.toFixed(2)} minimum. Recorders begin overwriting at 90–95% full.`
      })
    }
    const pct = (x) => `${Math.round(x * 100)}%`
    if (cloud && cloud.uploadLoad !== null && cloud.cameras > 0) {
      if (cloud.uploadLoad > 1) {
        out.push({ level: 'critical', text: `Cloud cameras upload ${fmt(cloud.uploadMbps, 1)} Mbps, more than the ${fmt(cloud.uploadLimitMbps, 0)} Mbps internet upload. Footage will be dropped or delayed.` })
      } else if (cloud.uploadLoad > K.UPLINK_UTILISATION) {
        out.push({ level: 'warn', text: `Cloud uploads use ${pct(cloud.uploadLoad)} of the internet upload. Keep it at or below ${pct(K.UPLINK_UTILISATION)}; use lower bitrates or a faster connection.` })
      }
    }
    if (cloud && cloud.cameras > 0 && cloud.uploadLoad === null) {
      out.push({ level: 'info', text: `${cloud.cameras} camera${cloud.cameras === 1 ? '' : 's'} record to the cloud. Enter the internet upload speed to check the ${fmt(cloud.uploadMbps, 1)} Mbps they send.` })
    }
    ;(edge || []).forEach((e) => {
      if (e.sdGB <= 0) return
      if (e.daysFit + EPS < retention) {
        out.push({ level: 'critical', text: `${e.name}: a ${fmt(e.sdGB, 0)} GB SD card holds about ${fmt(e.daysFit, 1)} days, short of the ${retention}-day requirement. Use a ${fmt(Math.ceil((retention * e.gbPerDayPerCam * K.FS_OVERHEAD) / 64) * 64, 0)} GB card or larger, or lower the bitrate.` })
      }
    })
    if (archive && archive.enabled) {
      out.push({ level: 'info', text: `Archive tier: recorders hold ${archive.hotDays} days; the remaining ${archive.archiveDays} days need about ${fmt(archive.requiredTB, 1)} TB usable on the archive (NAS or cloud), ${fmt(archive.rawTB, 1)} TB of footage plus overhead and headroom.` })
    }
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
    if (net && net.coax && net.coax.cameras > 0 && groups.some((g) => (byId(RESOLUTIONS, g.resolution) || {}).coax && (g.switch || num(g.poeW, 0) > 0))) {
      out.push({ level: 'info', text: 'Analog cameras connect to the DVR by coax, so their switch and PoE entries are ignored.' })
    }
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
    res.recorders.forEach((rec) => {
      const need = rec.hotDays
      if (!(need > 0) || rec.cameras === 0 || !Number.isFinite(rec.expectedRetentionDays)) return
      const onRec = archive && archive.enabled ? ` on the recorder (archive covers the rest of the ${retention} days)` : ''
      if (rec.expectedRetentionDays + EPS >= need) {
        out.push({
          level: 'ok',
          text: `${tag(rec)}Meets the ${need}-day requirement${onRec}. About ${Math.floor(rec.expectedRetentionDays)} days fit at design bitrates.`
        })
      } else {
        const short = need - rec.expectedRetentionDays
        const moreTB = (short * rec.gbPerDay * K.FS_OVERHEAD) / 1000
        out.push({
          level: 'critical',
          text: `${tag(rec)}Array holds only about ${Math.floor(rec.expectedRetentionDays)} days of footage, ${fmt(short, 0)} short of the ${need}-day requirement${onRec}. Add about ${fmt(moreTB, 1)} TB usable, or cut bitrate (codec, fps, quality) or camera count.`
        })
      }
      if (rec.array.existing && rec.expectedRetentionDays + EPS >= need && rec.spareCameras > 0) {
        out.push({
          level: 'info',
          text: `${tag(rec)}With headroom kept, about ${fmt(Math.max(0, rec.spareTB), 1)} TB is spare: room for roughly ${rec.spareCameras} more camera${rec.spareCameras === 1 ? '' : 's'} at this recorder's average.`
        })
      }
    })
    return out
  }

  function fmt(n, digits = 1) {
    if (!Number.isFinite(n)) return '—'
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  }

  function formatReport(project, groups, result) {
    const p = project || {}
    const { totals: t } = result
    const lines = []
    const many = result.recorders.length > 1
    lines.push(`CCTV storage sizing — ${p.name || 'Untitled site'}`)
    const other = calculateProject({ ...p, method: p.method === 'raw' ? 'bitrate' : 'raw' }, groups)
    const methodLabel = (id) => (byId(METHODS, id === 'raw' ? 'raw' : 'bitrate') || {}).label
    lines.push(`Estimate: ${methodLabel(p.method)}. ${methodLabel(p.method === 'raw' ? 'bitrate' : 'raw')} gives ${fmt(other.totals.requiredTB, 2)} TB for comparison.`)
    if (p.method === 'raw') {
      lines.push(`Compression ratios: ${CODECS.map((c) => `${c.label} ${compressionRatio(c.id, p.compressionRatios)}:1`).join(', ')}. Color depth 16-bit below 4K, 30-bit at 4K and above.`)
    }
    lines.push(`Method: SOP-VSS-001. Retention ${p.retentionDays} days${result.archive.enabled ? ` (${result.archive.hotDays} on recorders, ${result.archive.archiveDays} on the archive tier)` : ''}, headroom ×${num(p.headroom).toFixed(2)}, file-system overhead ×${K.FS_OVERHEAD}.`)
    lines.push('')
    lines.push('Camera groups')
    groups.forEach((g, i) => {
      const r = result.rows[i]
      const res = (byId(RESOLUTIONS, g.resolution) || {}).label || g.resolution
      const codec = (byId(CODECS, g.codec) || {}).label || g.codec
      const mode = (byId(MODES, g.mode) || {}).label || g.mode
      const nf = nightFps(g)
      const q = (byId(QUALITIES, g.quality) || byId(QUALITIES, 'medium')).label.toLowerCase()
      const where = r.target === 'cloud' ? ' → cloud' : r.target === 'edge' ? ` → SD card ${g.sdGB || '?'} GB` : many ? ` → ${(byId(result.recorders, r.recorderId) || {}).name || ''}` : ''
      lines.push(
        `- ${g.name || `Group ${i + 1}`}: ${r.qty} × ${res} ${codec} @ ${g.fps} fps${nf !== null ? ` day / ${nf} fps night` : ''}, ${q} quality, ${mode}${where}` +
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
    result.recorders.forEach((rec) => {
      const a = rec.array
      const pre = many ? `${rec.name}: ` : ''
      if (many) lines.push(`${rec.name}: ${rec.cameras} cameras, ${fmt(rec.gbPerDay, 1)} GB/day, ${fmt(rec.requiredTB, 2)} TB usable required, ${fmt(rec.aggregateMbps, 1)} Mbps in`)
      lines.push(
        `${pre}${a.existing ? 'Existing array' : 'Array'}: ${a.totalDisks} × ${a.diskTB} TB, ${a.raidLabel}` +
          ` (${a.dataDisks} data + ${a.parityDisks} ${a.raid === 'raid10' ? 'mirror' : 'parity'}` +
          `${a.spareDisks ? ` + ${a.spareDisks} hot spare` : ''})`
      )
      lines.push(`${pre}Usable: ${fmt(a.usableTB, 1)} TB (${fmt(a.usableTiB, 1)} TiB shown by the OS)`)
      lines.push(`${pre}Expected retention: ${Number.isFinite(rec.expectedRetentionDays) ? Math.floor(rec.expectedRetentionDays) : '—'} days`)
    })
    if (result.archive.enabled) {
      lines.push(`Archive tier: ${result.archive.archiveDays} days, ${fmt(result.archive.requiredTB, 2)} TB usable required (${fmt(result.archive.rawTB, 2)} TB of footage)`)
    }
    if (result.cloud.cameras > 0) {
      const c = result.cloud
      lines.push(`Cloud: ${c.cameras} cameras, ${fmt(c.gbPerDay, 1)} GB/day, ${fmt(c.retentionTB, 2)} TB for ${p.retentionDays} days (${fmt(c.monthlyGB, 0)} GB/month), uploads ${fmt(c.uploadMbps, 1)} Mbps` + (c.uploadLoad !== null ? ` (${Math.round(c.uploadLoad * 100)}% of ${fmt(c.uploadLimitMbps, 0)} Mbps)` : ''))
    }
    result.edge.forEach((e) => {
      lines.push(`Edge: ${e.name}, ${e.cameras} cameras on ${fmt(e.sdGB, 0)} GB SD cards, about ${Number.isFinite(e.daysFit) ? fmt(e.daysFit, 1) : '—'} days each`)
    })
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
      if (result.network.coax.cameras) lines.push(`- Coax to DVR (no switch): ${result.network.coax.cameras} cameras`)
    }
    lines.push('')
    lines.push('Checks')
    result.checks.forEach((c) => lines.push(`- [${c.level.toUpperCase()}] ${c.text}`))
    return lines.join('\n')
  }

  function formatCSV(groups, result) {
    // Cells that start with = + - @ or a tab/CR would run as formulas when the
    // CSV is opened in Excel or Sheets, so they are prefixed with a quote.
    const esc = (v) => {
      let s = String(v ?? '')
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
      return /[",\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const head = [
      'Group', 'Qty', 'Resolution', 'Codec', 'Quality', 'FPS', 'Night FPS', 'Scene', 'Mode', 'Hours', 'Night IR', 'Audio',
      'Bitrate Mbps', 'Peak Mbps', 'Bitrate source', 'Duty', 'GB/day/cam', 'GB/day', 'Switch', 'PoE W/cam', 'Records to', 'SD GB'
    ]
    const recName = (id) => ((result.recorders || []).find((r) => r.id === id) || {}).name || ''
    const switchName = (id) => ((result.network && result.network.switches.find((sw) => sw.id === id)) || {}).name || ''
    const rows = groups.map((g, i) => {
      const r = result.rows[i]
      return [
        g.name, r.qty, g.resolution, g.codec, g.quality || 'medium', g.fps, nightFps(g) ?? '', g.scene, g.mode,
        g.mode === 'scheduled' ? g.hours : '', g.nightIR ? 'yes' : 'no', g.audio ? 'yes' : 'no',
        r.mbps.toFixed(3), r.peakMbps.toFixed(3), r.measured ? 'measured' : 'estimate', r.duty.toFixed(3),
        r.gbPerDayPerCam.toFixed(2), r.gbPerDay.toFixed(2), r.coax ? 'coax' : switchName(g.switch), r.poeW.toFixed(1),
        r.target === 'recorder' ? recName(r.recorderId) : r.target, r.target === 'edge' ? g.sdGB : ''
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
        recorders: [{ id: 'r1', name: 'NVR', diskTB: 12, raid: 'raid6', bays: '', inboundMbps: '', arrayMode: 'design', existingDisks: '' }],
        recorderOutMbps: '',
        nightHours: 12,
        evidential: true,
        archive: { enabled: false, hotDays: '' },
        internetUploadMbps: '',
        method: 'bitrate',
        compressionRatios: { ...DEFAULT_COMPRESSION_RATIOS },
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
        { name: 'Aisles', qty: 24, resolution: '4MP', codec: 'h265', quality: 'medium', fps: 15, nightFps: '', scene: 'medium', mode: 'continuous', hours: 24, nightIR: false, audio: false, measuredMbps: '', switch: 'sw1', poeW: '', target: 'recorder', recorder: 'r1', sdGB: '', preset: '' },
        { name: 'Loading docks', qty: 6, resolution: '8MP', codec: 'h265', quality: 'medium', fps: 20, nightFps: '', scene: 'high', mode: 'continuous', hours: 24, nightIR: false, audio: false, measuredMbps: '', switch: 'sw2', poeW: '', target: 'recorder', recorder: 'r1', sdGB: '', preset: '' },
        { name: 'Offices', qty: 10, resolution: '2MP', codec: 'h265', quality: 'medium', fps: 15, nightFps: '', scene: 'low', mode: 'motion-medium', hours: 24, nightIR: false, audio: false, measuredMbps: '', switch: 'sw2', poeW: '', target: 'recorder', recorder: 'r1', sdGB: '', preset: '' }
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
      poeW: '',
      target: 'recorder',
      recorder: '',
      sdGB: '',
      preset: ''
    }
  }

  /** Fills fields added in later versions so older saved projects still load. */
  function withDefaults(project, groups) {
    const base = exampleProject().project
    const p = {
      ...base,
      name: '',
      nightHours: K.DEFAULT_NIGHT_HOURS,
      evidential: true,
      method: 'bitrate',
      liveStreams: 0,
      playbackStreams: 0,
      switches: [],
      recorders: [],
      ...(project || {})
    }
    if (!Array.isArray(p.switches)) p.switches = []
    // Older projects kept one recorder's settings as flat fields; fold them in.
    p.recorders = recordersOf(p).map((r, i) => ({ ...newRecorder(i + 1), ...r }))
    ;['diskTB', 'raid', 'recorderBays', 'recorderMbps', 'arrayMode', 'existingDisks'].forEach((k) => delete p[k])
    p.archive = { enabled: false, hotDays: '', ...(p.archive || {}) }
    if (p.internetUploadMbps === undefined) p.internetUploadMbps = ''
    p.compressionRatios = { ...DEFAULT_COMPRESSION_RATIOS, ...(p.compressionRatios || {}) }
    const ids = new Set(p.switches.map((sw) => sw.id))
    const gs = (groups || []).map((g, i) => {
      const merged = { ...newGroup(i + 1), ...g }
      if (merged.switch && !ids.has(merged.switch)) merged.switch = ''
      if (!byId(TARGETS, merged.target)) merged.target = 'recorder'
      if (!byId(p.recorders, merged.recorder)) merged.recorder = p.recorders[0].id
      return merged
    })
    return { project: p, groups: gs }
  }

  return {
    BASE_BITRATE,
    RESOLUTIONS,
    METHODS,
    DEFAULT_COMPRESSION_RATIOS,
    CODECS,
    QUALITIES,
    SCENES,
    MODES,
    RAID_LEVELS,
    DISK_SIZES_TB,
    LIVE_STREAM_TYPES,
    TARGETS,
    PRESETS,
    CONSTANTS: K,
    estimateBitrate,
    colorDepth,
    compressionRatio,
    rawCompressedMbps,
    bitrates,
    nightFps,
    groupBitrate,
    dutyCycle,
    estimatePoE,
    isCoax,
    calculateGroup,
    calculateNetwork,
    calculateViewing,
    withDefaults,
    newRecorder,
    recordersOf,
    applyPreset,
    hotDaysOf,
    planArray,
    calculateProject,
    formatReport,
    formatCSV,
    exampleProject,
    newGroup,
    fmt
  }
})
