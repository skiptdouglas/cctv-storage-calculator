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

  // Camera presets. `vendor: 'Generic'` entries are vendor-neutral planning
  // values. Vendor entries carry spec-sheet resolution, max frame rate, IR and
  // max PoE draw; the bitrate is still estimated unless the user enters the
  // figure the camera reports. Editable here; the UI groups them by vendor.
  const PRESETS = [
    { id: 'dome2', vendor: 'Generic', label: 'Dome 2 MP, H.265, IR', resolution: '2MP', codec: 'h265', fps: 15, nightIR: true, poeW: 6 },
    { id: 'dome4', vendor: 'Generic', label: 'Dome 4 MP, H.265, IR', resolution: '4MP', codec: 'h265', fps: 15, nightIR: true, poeW: 7 },
    { id: 'bullet4', vendor: 'Generic', label: 'Bullet 4 MP, H.265, long IR', resolution: '4MP', codec: 'h265', fps: 15, nightIR: true, poeW: 9 },
    { id: 'bullet8', vendor: 'Generic', label: 'Bullet 8 MP (4K), H.265, IR', resolution: '8MP', codec: 'h265', fps: 15, nightIR: true, poeW: 11 },
    { id: 'turret5', vendor: 'Generic', label: 'Turret 5 MP, Smart H.265+, IR', resolution: '5MP', codec: 'smart', fps: 15, nightIR: true, poeW: 7 },
    { id: 'lpr', vendor: 'Generic', label: 'LPR / ANPR 2 MP, 30 fps', resolution: '2MP', codec: 'h264', fps: 30, nightIR: true, poeW: 12, scene: 'high' },
    { id: 'ptz2', vendor: 'Generic', label: 'PTZ 2 MP 25×, H.265 (PoE+)', resolution: '2MP', codec: 'h265', fps: 25, nightIR: true, poeW: 25, scene: 'high' },
    { id: 'ptz4', vendor: 'Generic', label: 'PTZ 4 MP 32×, IR, heater (PoE++)', resolution: '4MP', codec: 'h265', fps: 25, nightIR: true, poeW: 60, scene: 'high' },
    { id: 'fisheye12', vendor: 'Generic', label: 'Fisheye 12 MP, H.265', resolution: '12MP', codec: 'h265', fps: 15, nightIR: false, poeW: 9 },
    { id: 'multi4x5', vendor: 'Generic', label: 'Multi-sensor 4 × 5 MP (one sensor per camera row)', resolution: '5MP', codec: 'h265', fps: 15, nightIR: true, poeW: 6, note: 'Enter 4 cameras per unit.' },
    { id: 'tvi2', vendor: 'Generic', label: 'HD-TVI / AHD 2 MP over coax', resolution: '2MP', codec: 'h265', fps: 15, nightIR: true, poeW: '', coax: true },
    { id: 'analog960', vendor: 'Generic', label: 'Analog 960H over coax', resolution: '960H', codec: 'h264', fps: 15, nightIR: true, poeW: '' },
    { id: 'indoor2', vendor: 'Generic', label: 'Indoor cube 2 MP, no IR', resolution: '2MP', codec: 'h265', fps: 10, nightIR: false, poeW: 4, scene: 'low' },
    // Ubiquiti UniFi Protect (checked against techspecs.ui.com and the
    // dl.ui.com datasheets, October 2026). `unverified` marks a field the
    // spec sheet does not state. Protect records H.264
    // ("Standard") or H.265 ("Enhanced") per camera; presets assume Enhanced.
    // Protect sets bitrate from a quality level, so read the camera's actual
    // bitrate in its settings and enter it as Measured for a final design.
    { id: 'uvc-g4-bullet', vendor: 'UniFi', model: 'UVC-G4-Bullet', label: 'G4 Bullet · 4 MP 24 fps · 4 W', resolution: '4MP', codec: 'h265', fps: 24, nightIR: true, poeW: 4 },
    { id: 'uvc-g4-dome', vendor: 'UniFi', model: 'UVC-G4-Dome', label: 'G4 Dome · 4 MP 24 fps · 5 W', resolution: '4MP', codec: 'h265', fps: 24, nightIR: true, poeW: 5 },
    { id: 'uvc-g4-pro', vendor: 'UniFi', model: 'UVC-G4-Pro', label: 'G4 Pro · 4K 50 fps · 12.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.5, note: 'Camera max is 50 fps; preset uses 30.' },
    { id: 'uvc-g4-ptz', vendor: 'UniFi', model: 'UVC-G4-PTZ', label: 'G4 PTZ · 4K 24 fps 22× · 42.9 W (PoE++)', resolution: '8MP', codec: 'h265', fps: 24, nightIR: true, poeW: 42.9, scene: 'high' },
    { id: 'uvc-g4-doorbell-pro', vendor: 'UniFi', model: 'UVC-G4-Doorbell-Pro', label: 'G4 Doorbell Pro · 2 MP 30 fps · 10 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, scene: 'high', note: 'Powered from 16–24 V AC or USB-C; PoE needs the UACC-Adapter-DBPOE.' },
    { id: 'uvc-g5-bullet', vendor: 'UniFi', model: 'UVC-G5-Bullet', label: 'G5 Bullet · 4 MP 30 fps · 4 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 4 },
    { id: 'uvc-g5-dome', vendor: 'UniFi', model: 'UVC-G5-Dome', label: 'G5 Dome · 4 MP 30 fps · 5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5 },
    { id: 'uvc-g5-flex', vendor: 'UniFi', model: 'UVC-G5-Flex', label: 'G5 Flex · 4 MP 30 fps · 4 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 4 },
    { id: 'uvc-g5-turret-ultra', vendor: 'UniFi', model: 'UVC-G5-Turret-Ultra', label: 'G5 Turret Ultra · 4 MP 30 fps · 4 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 4 },
    { id: 'uvc-g5-dome-ultra', vendor: 'UniFi', model: 'UVC-G5-Dome-Ultra', label: 'G5 Dome Ultra · 4 MP 30 fps · 4.2 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 4.2 },
    { id: 'uvc-g5-pro', vendor: 'UniFi', model: 'UVC-G5-Pro', label: 'G5 Pro · 4K 30 fps · 10 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, note: '12.95 W with the Enhancer accessory.' },
    { id: 'uvc-g5-ptz', vendor: 'UniFi', model: 'UVC-G5-PTZ', label: 'G5 PTZ · 4 MP 30 fps · 14 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 14, scene: 'high' },
    { id: 'uvc-g6-bullet', vendor: 'UniFi', model: 'UVC-G6-Bullet', label: 'G6 Bullet · 4K 30 fps · 9.9 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.9 },
    { id: 'uvc-g6-turret', vendor: 'UniFi', model: 'UVC-G6-Turret', label: 'G6 Turret · 4K 30 fps · 12.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.5 },
    { id: 'uvc-g6-dome', vendor: 'UniFi', model: 'UVC-G6-Dome', label: 'G6 Dome · 4K 30 fps · 9.25 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.25 },
    { id: 'uvc-g6-pro-dome', vendor: 'UniFi', model: 'UVC-G6-Pro-Dome', label: 'G6 Pro Dome · 4K 30 fps · 15 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 15 },
    { id: 'uvc-g6-ptz', vendor: 'UniFi', model: 'UVC-G6-PTZ', label: 'G6 PTZ · 4K 30 fps dual lens · 24.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.5, scene: 'high', note: 'Wide and tele 8 MP sensors, 10× hybrid zoom.' },
    { id: 'uvc-ai-pro', vendor: 'UniFi', model: 'UVC-AI-Pro', label: 'AI Pro · 4K 30 fps · 11 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11, note: '22 W with the Enhancer accessory.' },
    { id: 'uvc-ai-turret', vendor: 'UniFi', model: 'UVC-AI-Turret', label: 'AI Turret · 4K 30 fps · 20 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 20 },
    { id: 'uvc-ai-dome', vendor: 'UniFi', model: 'UVC-AI-Dome', label: 'AI Dome · 4K 30 fps · 10 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10 },
    { id: 'uvc-ai-lpr', vendor: 'UniFi', model: 'UVC-AI-LPR', label: 'AI LPR · 4K 30 fps 3× · 25.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5, scene: 'high' },
    { id: 'uvc-ai-ptz-precision', vendor: 'UniFi', model: 'UVC-AI-PTZ-Precision', label: 'AI PTZ Precision · 4K 30 fps 31× · 51 W (PoE++)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 51, scene: 'high' },
    { id: 'uvc-ai-360', vendor: 'UniFi', model: 'UVC-AI-360', label: 'AI 360 · 4 MP 1920×1920 30 fps · 8.64 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.64 },
    { id: 'uvc-ai-theta', vendor: 'UniFi', model: 'UVC-AI-Theta', label: 'AI Theta · 8 MP 24 fps · 12.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: false, poeW: 12.5, note: 'With the 360 lens: 6 MP at 20 fps.', unverified: 'IR' },
    { id: 'uvc-ai-theta-pro', vendor: 'UniFi', model: 'UVC-AI-Theta-Pro', label: 'AI Theta Pro · 4 MP 2160×2160 24 fps · 12.5 W', resolution: '4MP', codec: 'h265', fps: 24, nightIR: false, poeW: 12.5, unverified: 'IR' },
    // Milesight: current NDAA datasheets on resource.milesight.com (linked from
    // milesight.com/support/download/datasheet), checked October 2026.
    // Power is the datasheet maximum with IR on, PoE where both are given.
    // Cameras support H.265+ (smart); presets assume plain H.265. Where a
    // camera runs faster than 30 fps the preset uses 30 and the note says so.
    // Some ids predate the datasheet check and no longer match the model code;
    // they are kept so saved projects still find their preset. Rows are kept
    // together by `family`, which splits the dropdown.
    // Domes
    { id: 'ms-c2975', vendor: 'Milesight', family: 'Domes', model: 'MS-C2975-PD', label: 'AI Weather-proof Mini Dome · 2 MP 30 fps · 5.1 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.1, note: 'R variant: up to 60 fps.' },
    { id: 'ms-c5375', vendor: 'Milesight', family: 'Domes', model: 'MS-C5375-PD', label: 'AI Weather-proof Mini Dome · 5 MP 30 fps · 5.8 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.8 },
    { id: 'ms-c8175', vendor: 'Milesight', family: 'Domes', model: 'MS-C8175-PD', label: 'AI Weather-proof Mini Dome · 4K 30 fps · 6.6 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.6 },
    { id: 'ms-c2973', vendor: 'Milesight', family: 'Domes', model: 'MS-C2973-PD', label: 'AI Vandal-proof Mini Dome · 2 MP 30 fps · 4.7 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 4.7, note: 'R variant: up to 60 fps.' },
    { id: 'ms-c5373', vendor: 'Milesight', family: 'Domes', model: 'MS-C5373-PD', label: 'AI Vandal-proof Mini Dome · 5 MP 30 fps · 6 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6 },
    { id: 'ms-c8173', vendor: 'Milesight', family: 'Domes', model: 'MS-C8173-PD', label: 'AI Vandal-proof Mini Dome · 4K 30 fps · 6.1 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.1 },
    { id: 'ms-c2976', vendor: 'Milesight', family: 'Domes', model: 'MS-C2975-FPD', label: 'AI Motorized Dome · 2 MP 30 fps · 6.4 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.4, note: 'R variant: up to 60 fps.' },
    { id: 'ms-c5375-f', vendor: 'Milesight', family: 'Domes', model: 'MS-C5375-FPD', label: 'AI Motorized Dome · 5 MP 30 fps · 6.5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.5 },
    { id: 'ms-c8175-f', vendor: 'Milesight', family: 'Domes', model: 'MS-C8175-FPD', label: 'AI Motorized Dome · 4K 30 fps · 8.4 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.4 },
    { id: 'ms-c2972', vendor: 'Milesight', family: 'Domes', model: 'MS-C2972-RFPE', label: 'AI Motorized Pro Dome · 2 MP 30 fps · 8.5 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.5, note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c5372', vendor: 'Milesight', family: 'Domes', model: 'MS-C5372-FPE', label: 'AI Motorized Pro Dome · 5 MP 30 fps · 6.8 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.8 },
    { id: 'ms-c8172', vendor: 'Milesight', family: 'Domes', model: 'MS-C8172-FPE', label: 'AI Motorized Pro Dome · 4K 30 fps · 8.1 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.1 },
    { id: 'ms-c4575-fpd', vendor: 'Milesight', family: 'Domes', model: 'MS-C4575-FPD', label: 'AI Motorized Dome · 4 MP 30 fps · 6.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.5, note: '2688×1520.' },
    { id: 'ms-c4573-pd', vendor: 'Milesight', family: 'Domes', model: 'MS-C4573-PD', label: 'AI Vandal-proof Mini Dome · 4 MP 30 fps · 6 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6, note: '2688×1520.' },
    { id: 'ms-c4575-pd', vendor: 'Milesight', family: 'Domes', model: 'MS-C4575-PD', label: 'AI Weather-proof Mini Dome · 4 MP 30 fps · 5.8 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.8, note: '2688×1520.' },
    { id: 'ms-c2983-pd', vendor: 'Milesight', family: 'Domes', model: 'MS-C2983-PD', label: 'AI IR Mini Dome · 2 MP 30 fps · 4.6 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 4.6, note: 'R variant: up to 60 fps.' },
    { id: 'ms-c4583-pd', vendor: 'Milesight', family: 'Domes', model: 'MS-C4583-PD', label: 'AI IR Mini Dome · 4 MP 30 fps · 5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5, note: '2688×1520.' },
    { id: 'ms-c5383-pd', vendor: 'Milesight', family: 'Domes', model: 'MS-C5383-PD', label: 'AI IR Mini Dome · 5 MP 30 fps · 5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5 },
    { id: 'ms-c8183-pd', vendor: 'Milesight', family: 'Domes', model: 'MS-C8183-PD', label: 'AI IR Mini Dome · 4K 30 fps · 5.4 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.4 },
    { id: 'ms-c4472-rfpe', vendor: 'Milesight', family: 'Domes', model: 'MS-C4472-RFPE', label: 'AI Motorized Pro Dome · 4 MP 30 fps · 7.6 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.6, note: '2688×1520. Up to 60 fps.' },
    { id: 'ms-c6772-fpe', vendor: 'Milesight', family: 'Domes', model: 'MS-C6772-FPE', label: 'AI Motorized Pro Dome · 6 MP 30 fps · 7 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7, note: '3200×1800.' },
    { id: 'ms-c8272-fpe', vendor: 'Milesight', family: 'Domes', model: 'MS-C8272-FPE', label: 'AI Motorized Pro Dome · 4K 30 fps · 8 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8 },
    { id: 'ms-cq4472-hpg1', vendor: 'Milesight', family: 'Domes', model: 'MS-CQ4472-HPG1', label: 'AI TrueColor Pro Dome · 4 MP 30 fps · 7.72 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.72, note: '2688×1520.' },
    { id: 'ms-cq5472-hpg1', vendor: 'Milesight', family: 'Domes', model: 'MS-CQ5472-HPG1', label: 'AI TrueColor Pro Dome · 5 MP 30 fps · 8 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8, note: '2960×1664.' },
    { id: 'ms-cq8172-hpg1', vendor: 'Milesight', family: 'Domes', model: 'MS-CQ8172-HPG1', label: 'AI TrueColor Pro Dome · 4K 30 fps · 8.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.5 },
    { id: 'ms-cq8272-hpg1', vendor: 'Milesight', family: 'Domes', model: 'MS-CQ8272-HPG1', label: 'AI TrueColor Pro Dome · 4K 30 fps · 9.6 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.6 },
    { id: 'ms-cq4431-hypg1', vendor: 'Milesight', family: 'Domes', model: 'MS-CQ4431-HYPG1', label: 'AI TrueColor Turret · 4 MP 30 fps · 9.62 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.62, note: '2688×1520.' },
    { id: 'ms-cq5431-hypg1', vendor: 'Milesight', family: 'Domes', model: 'MS-CQ5431-HYPG1', label: 'AI TrueColor Turret · 5 MP 30 fps · 10 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, note: '2960×1664.' },
    { id: 'ms-cq8131-hypg1', vendor: 'Milesight', family: 'Domes', model: 'MS-CQ8131-HYPG1', label: 'AI TrueColor Turret · 4K 30 fps · 11.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.5 },
    { id: 'ms-cq8231-hypg1', vendor: 'Milesight', family: 'Domes', model: 'MS-CQ8231-HYPG1', label: 'AI TrueColor Turret · 4K 30 fps · 11.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.5 },
    { id: 'ms-c5372-rfipkg1', vendor: 'Milesight', family: 'Domes', model: 'MS-C5372-RFIPKG1', label: 'OpenVision Pro Dome · 5 MP 30 fps · 10.5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.5, note: 'Up to 60 fps.' },
    { id: 'ms-c8272-rfipkg1', vendor: 'Milesight', family: 'Domes', model: 'MS-C8272-RFIPKG1', label: 'OpenVision Pro Dome · 4K 30 fps · 11 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11, note: 'Up to 60 fps.' },
    // Bullets
    { id: 'ms-c2963', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2964-PD', label: 'AI Vandal-proof Mini Bullet · 2 MP 30 fps · 5.1 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.1 },
    { id: 'ms-c5363', vendor: 'Milesight', family: 'Bullets', model: 'MS-C5364-PD', label: 'AI Vandal-proof Mini Bullet · 5 MP 30 fps · 5.4 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.4 },
    { id: 'ms-c8163', vendor: 'Milesight', family: 'Bullets', model: 'MS-C8164-PD', label: 'AI Vandal-proof Mini Bullet · 4K 30 fps · 5.8 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.8 },
    { id: 'ms-c2964', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2964-RFPE', label: 'AI Motorized Bullet · 2 MP 30 fps · 11.5 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.5, note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c5364', vendor: 'Milesight', family: 'Bullets', model: 'MS-C5364-FPE', label: 'AI Motorized Bullet · 5 MP 30 fps · 11 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11 },
    { id: 'ms-c8164', vendor: 'Milesight', family: 'Bullets', model: 'MS-C8164-FPE', label: 'AI Motorized Bullet · 4K 30 fps · 13 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 13 },
    { id: 'ms-c2966', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2966-RFPE', label: 'AI Motorized Pro Bullet Plus · 2 MP 30 fps · 16.1 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.1, note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c5366', vendor: 'Milesight', family: 'Bullets', model: 'MS-C5366-FPE', label: 'AI Motorized Pro Bullet Plus · 5 MP 30 fps · 11 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11 },
    { id: 'ms-c8166', vendor: 'Milesight', family: 'Bullets', model: 'MS-C8166-FPE', label: 'AI Motorized Pro Bullet Plus · 4K 30 fps · 12.1 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.1 },
    { id: 'ms-c2966-x12ropc', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2966-X12ROPC', label: 'AIoT Pro Bullet Plus 12× · 2 MP 30 fps · 15 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 15, note: 'Up to 60 fps (100 fps on T series).' },
    { id: 'ms-c2964-upd', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2964-UPD', label: 'AI Color+ Vandal-proof Mini Bullet · 2 MP 30 fps · 5 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 5, note: 'R variant: up to 60 fps. White-light illumination, no IR.' },
    { id: 'ms-c5364-upd', vendor: 'Milesight', family: 'Bullets', model: 'MS-C5364-UPD', label: 'AI Color+ Vandal-proof Mini Bullet · 5 MP 30 fps · 5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: false, poeW: 5, note: 'White-light illumination, no IR.' },
    { id: 'ms-c8164-upd', vendor: 'Milesight', family: 'Bullets', model: 'MS-C8164-UPD', label: 'AI Color+ Vandal-proof Mini Bullet · 4K 30 fps · 6 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: false, poeW: 6, note: 'White-light illumination, no IR.' },
    { id: 'ms-c2964-fpd', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2964-FPD', label: 'AI Motorized Bullet · 2 MP 30 fps · 7 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7 },
    { id: 'ms-c4564-pd', vendor: 'Milesight', family: 'Bullets', model: 'MS-C4564-PD', label: 'AI Vandal-proof Mini Bullet · 4 MP 30 fps · 5.4 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.4, note: '2688×1520.' },
    { id: 'ms-c2963-rpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2963-RPE', label: 'AI Weather-proof Mini Bullet · 2 MP 30 fps · 9 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9, note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c5363-pe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C5363-PE', label: 'AI Weather-proof Mini Bullet · 5 MP 30 fps · 9 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9 },
    { id: 'ms-c8163-pe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C8163-PE', label: 'AI Weather-proof Mini Bullet · 4K 30 fps · 10.2 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.2 },
    { id: 'ms-c2963-pd', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2963-PD', label: 'AI Weather-proof Mini Bullet · 2 MP 30 fps · 9 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9 },
    { id: 'ms-c2966-x12rpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2966-X12RPE', label: 'AI Pro Bullet Plus 12× · 2 MP 30 fps · 16.1 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.1, note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c4466-x4rpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C4466-X4RPE', label: 'AI Pro Bullet Plus 4× · 4 MP 30 fps · 15.6 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 15.6, note: '2688×1520. Up to 60 fps.' },
    { id: 'ms-c5366-x12pe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C5366-X12PE', label: 'AI Pro Bullet Plus 12× · 5 MP 30 fps · 15.2 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 15.2 },
    { id: 'ms-c8266-x4pe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C8266-X4PE', label: 'AI Pro Bullet Plus 4× · 4K 30 fps · 16 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16 },
    { id: 'ms-c4466-rfpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C4466-RFPE', label: 'AI Motorized Pro Bullet Plus · 4 MP 30 fps · 16.1 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.1, note: '2688×1520. Up to 60 fps. Datasheet lists 802.3af but the maximum exceeds 15.4 W: plan a PoE+ port.' },
    { id: 'ms-c6766-fpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C6766-FPE', label: 'AI Motorized Pro Bullet Plus · 6 MP 30 fps · 10.5 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.5, note: '3200×1800.' },
    { id: 'ms-c8266-fpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C8266-FPE', label: 'AI Motorized Pro Bullet Plus · 4K 30 fps · 13.7 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 13.7 },
    { id: 'ms-c2962-rfpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C2962-RFPE', label: 'AI Motorized Pro Bullet · 2 MP 30 fps · 10.6 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.6, note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c5362-fpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C5362-FPE', label: 'AI Motorized Pro Bullet · 5 MP 30 fps · 9.7 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.7 },
    { id: 'ms-c6762-fpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C6762-FPE', label: 'AI Motorized Pro Bullet · 6 MP 30 fps · 9.6 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.6, note: '3200×1800.' },
    { id: 'ms-c8162-fpe', vendor: 'Milesight', family: 'Bullets', model: 'MS-C8162-FPE', label: 'AI Motorized Pro Bullet · 4K 30 fps · 10.6 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.6 },
    { id: 'ms-cq4468-hypg1', vendor: 'Milesight', family: 'Bullets', model: 'MS-CQ4468-HYPG1', label: 'AI TrueColor Bullet · 4 MP 30 fps · 9.86 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.86, note: '2688×1520.' },
    { id: 'ms-cq5468-hypg1', vendor: 'Milesight', family: 'Bullets', model: 'MS-CQ5468-HYPG1', label: 'AI TrueColor Bullet · 5 MP 30 fps · 10 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, note: '2960×1664.' },
    { id: 'ms-cq8168-hypg1', vendor: 'Milesight', family: 'Bullets', model: 'MS-CQ8168-HYPG1', label: 'AI TrueColor Bullet · 4K 30 fps · 11.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.5 },
    { id: 'ms-cq8268-hypg1', vendor: 'Milesight', family: 'Bullets', model: 'MS-CQ8268-HYPG1', label: 'AI TrueColor Bullet · 4K 30 fps · 11.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.5 },
    { id: 'ms-c5366-rfipkg1', vendor: 'Milesight', family: 'Bullets', model: 'MS-C5366-RFIPKG1', label: 'OpenVision Pro Bullet Plus · 5 MP 30 fps · 16 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16, note: 'Up to 60 fps.' },
    { id: 'ms-c8266-rfipkg1', vendor: 'Milesight', family: 'Bullets', model: 'MS-C8266-RFIPKG1', label: 'OpenVision Pro Bullet Plus · 4K 30 fps · 17.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 17.5, note: 'Up to 60 fps.' },
    // Panoramic & multi-sensor
    { id: 'ms-c5376', vendor: 'Milesight', family: 'Panoramic & multi-sensor', model: 'MS-C5376-PE', label: 'AI 180° Panoramic Mini Dome · 4 MP 2560×1440 30 fps · 8.8 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.8, note: '5 MP sensor; streams top out at 2560×1440.' },
    { id: 'ms-c8176', vendor: 'Milesight', family: 'Panoramic & multi-sensor', model: 'MS-C8176-PE', label: 'AI 180° Panoramic Mini Dome · 4K 25 fps · 9 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 9 },
    { id: 'ms-c5365', vendor: 'Milesight', family: 'Panoramic & multi-sensor', model: 'MS-C5365-PE', label: 'AI 180° Panoramic Mini Bullet · 4 MP 2560×1440 30 fps · 7.7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.7, note: '5 MP sensor; streams top out at 2560×1440.' },
    { id: 'ms-c8165', vendor: 'Milesight', family: 'Panoramic & multi-sensor', model: 'MS-C8165-PE', label: 'AI 180° Panoramic Mini Bullet · 4K 25 fps · 8.4 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 8.4 },
    { id: 'ms-c8274', vendor: 'Milesight', family: 'Panoramic & multi-sensor', model: 'MS-C8274-PA', label: 'AI 360° Fisheye · 4K 30 fps · 8 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8, note: 'Fisheye stream 2144×2144; 25 fps on 50 Hz.' },
    { id: 'ms-c9674', vendor: 'Milesight', family: 'Panoramic & multi-sensor', model: 'MS-C9674-PA', label: 'AI 360° Fisheye · 12 MP 30 fps · 11 W', resolution: '12MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11, note: 'Fisheye stream 3000×3000; 25 fps on 50 Hz.' },
    { id: 'ms-c5321-fpe', vendor: 'Milesight', family: 'Panoramic & multi-sensor', model: 'MS-C5321-FPE', label: 'AI 4×5 MP Multi-directional · 5 MP 30 fps · 22.4 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.6, note: 'One row per sensor: enter 4 cameras per unit (22.4 W per unit, PoE+).' },
    { id: 'ms-c8477-pc', vendor: 'Milesight', family: 'Panoramic & multi-sensor', model: 'MS-C8477-PC', label: 'AI Dual-sensor 180° Panoramic · 5084×1520 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12, note: 'Two sensors stitched into one 5084×1520 stream.' },
    { id: 'ms-c8477-hpkg1', vendor: 'Milesight', family: 'Panoramic & multi-sensor', model: 'MS-C8477-HPKG1', label: 'OpenVision TrueColor Dual-sensor 180° Panoramic · 5120×1520 30 fps · 15 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 15, note: 'Two sensors stitched into one 5120×1520 stream.' },
    // PTZ & speed domes
    { id: 'ms-c5371', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C5371-X12PE', label: 'AI 12× PTZ Dome · 5 MP 30 fps · 17.3 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 17.3, scene: 'high' },
    { id: 'ms-c2961-ptz', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C2961-X12PE', label: 'AI 12× PTZ Bullet · 2 MP 30 fps · 20.2 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 20.2, scene: 'high', note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c5361-ptz', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C5361-X12PE', label: 'AI 12× PTZ Bullet · 5 MP 30 fps · 19.3 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 19.3, scene: 'high' },
    { id: 'ms-c2941-x25', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C2941-X25RPE', label: 'AI 25× Speed Dome · 2 MP 30 fps · 28.7 W (PoE++ or 24 V)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 28.7, scene: 'high', note: 'Up to 60 fps. Above PoE+ budget: use PoE++ or 24 V.' },
    { id: 'ms-c2941-x30', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C2941-X30RPE', label: 'AI 30× Speed Dome · 2 MP 30 fps · 28 W (PoE++ or 24 V)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 28, scene: 'high', note: 'Up to 60 fps. Above PoE+ budget: use PoE++ or 24 V.' },
    { id: 'ms-c2941-x42', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C2941-X42RPE', label: 'AI 42× Speed Dome · 2 MP 30 fps · 24.2 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.2, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'ms-c5341-x25', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C5341-X25PE', label: 'AI 25× Speed Dome · 5 MP 30 fps · 27.7 W (PoE++ or 24 V)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 27.7, scene: 'high', note: 'Above PoE+ budget: use PoE++ or 24 V.' },
    { id: 'ms-c5341-x30', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C5341-X30PE', label: 'AI 30× Speed Dome · 5 MP 30 fps · 25.2 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.2, scene: 'high' },
    { id: 'ms-c5341-x42', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C5341-X42PE', label: 'AI 42× Speed Dome · 5 MP 30 fps · 25.5 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5, scene: 'high' },
    { id: 'ms-c8241-x36', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C8241-X36PE', label: 'AI 36× Speed Dome · 4K 30 fps · 28.4 W (PoE++ or 24 V)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 28.4, scene: 'high', note: 'Above PoE+ budget: use PoE++ or 24 V.' },
    { id: 'ms-c2967-x12rpe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C2967-X12RPE', label: 'AI PTZ Bullet Plus 12× · 2 MP 30 fps · 25.3 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.3, scene: 'high', note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c2967-x23rpe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C2967-X23RPE', label: 'AI PTZ Bullet Plus 23× · 2 MP 30 fps · 21.7 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21.7, scene: 'high', note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c5367-x12pe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C5367-X12PE', label: 'AI PTZ Bullet Plus 12× · 5 MP 30 fps · 21.7 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21.7, scene: 'high' },
    { id: 'ms-c5367-x23pe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C5367-X23PE', label: 'AI PTZ Bullet Plus 23× · 5 MP 30 fps · 25 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25, scene: 'high' },
    { id: 'ms-c4467-x20rpe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C4467-X20RPE', label: 'AI PTZ Bullet Plus 20× · 4 MP 30 fps · 24 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24, scene: 'high', note: '2688×1520. Up to 60 fps.' },
    { id: 'ms-c8267-x20pe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C8267-X20PE', label: 'AI PTZ Bullet Plus 20× · 4K 30 fps · 25 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25, scene: 'high' },
    { id: 'ms-c2971-x12rpe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C2971-X12RPE', label: 'AI PTZ Dome 12× · 2 MP 30 fps · 17 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 17, scene: 'high', note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c2971-x23rpe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C2971-X23RPE', label: 'AI PTZ Dome 23× · 2 MP 30 fps · 19 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 19, scene: 'high', note: 'Up to 60 fps (90 fps on T series).' },
    { id: 'ms-c4471-x20rpe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C4471-X20RPE', label: 'AI PTZ Dome 20× · 4 MP 30 fps · 20.3 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 20.3, scene: 'high', note: '2688×1520. Up to 60 fps.' },
    { id: 'ms-c4441-x36rpe', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C4441-X36RPE', label: 'AI Speed Dome 36× · 4 MP 30 fps · 26.8 W (PoE++)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 26.8, scene: 'high', note: '2688×1520. Up to 60 fps. Above PoE+ budget: use PoE++.' },
    { id: 'ms-c5342-x25rpg1', vendor: 'Milesight', family: 'PTZ & speed domes', model: 'MS-C5342-X25RPG1', label: 'AI 5-inch Speed Dome 25× · 5 MP 30 fps · 21 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21, scene: 'high' },
    // Traffic & LPR
    { id: 'ms-c2966-lpr', vendor: 'Milesight', family: 'Traffic & LPR', model: 'MS-C2966-RFLPE', label: 'AI LPR Pro Bullet Plus · 2 MP 30 fps · 10.5 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.54, scene: 'high', note: 'Up to 60 fps for plate capture.' },
    { id: 'ms-ts2966', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS2966-X12TPE', label: 'AI Road Traffic Pro Bullet Plus 12× · 2 MP 30 fps · 11.4 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.4, scene: 'high', note: 'Up to 90 fps.' },
    { id: 'ms-ts4466', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS4466-X4RPE', label: 'AI Road Traffic Pro Bullet Plus 4× · 4 MP 30 fps · 13.1 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 13.1, scene: 'high', note: '2688×1520, up to 60 fps.' },
    { id: 'ms-ts5366', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS5366-X12PE', label: 'AI Road Traffic Pro Bullet Plus 12× · 5 MP 30 fps · 12.7 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.7, scene: 'high' },
    { id: 'ms-ts8266', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS8266-X4PE', label: 'AI Road Traffic Pro Bullet Plus 4× · 4K 30 fps · 12.35 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.35, scene: 'high' },
    { id: 'ms-ts4467', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS4467-X20RPE', label: 'AI Road Traffic PTZ Bullet Plus 20× · 4 MP 30 fps · 25.9 W (PoE++ or 12 V)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.9, scene: 'high', note: '2688×1520, up to 60 fps. Above PoE+ budget: use PoE++ or 12 V DC.' },
    { id: 'ms-ts5367', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS5367-X12PE', label: 'AI Road Traffic PTZ Bullet Plus 12× · 5 MP 30 fps · 21.7 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21.7, scene: 'high' },
    { id: 'ms-ts4441', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS4441-X36RPE', label: 'AI Road Traffic Speed Dome 36× · 4 MP 30 fps · 26.8 W (PoE++ or 24 V)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 26.8, scene: 'high', note: '2688×1520, up to 60 fps. Above PoE+ budget: use PoE++ or 24 V.' },
    { id: 'ms-ts4466-x4ripg1', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS4466-X4RIPG1', label: 'AI Road Traffic Pro Bullet Plus 4× · 4 MP 30 fps · 17.8 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 17.8, scene: 'high', note: '2688×1520. Up to 60 fps.' },
    { id: 'ms-ts5366-x12ripg1', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS5366-X12RIPG1', label: 'AI Road Traffic Pro Bullet Plus 12× · 5 MP 30 fps · 16.7 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.7, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'ms-ts8266-x4ripg1', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS8266-X4RIPG1', label: 'AI Road Traffic Pro Bullet Plus 4× · 4K 30 fps · 19.1 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 19.1, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'ms-ts4466-x4rivpg1', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS4466-X4RIVPG1', label: 'AI Road Traffic Radar Pro Bullet Plus 4× · 4 MP 30 fps · 21 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21, scene: 'high', note: '2688×1520. Up to 60 fps. Built-in radar.' },
    { id: 'ms-ts8266-x4rivpg1', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS8266-X4RIVPG1', label: 'AI Road Traffic Radar Pro Bullet Plus 4× · 4K 30 fps · 21.6 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21.6, scene: 'high', note: 'Up to 60 fps. Built-in radar.' },
    { id: 'ms-ts4466-rfivpg1', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS4466-RFIVPG1', label: 'AI Road Traffic Radar Motorized Pro Bullet Plus · 4 MP 30 fps · 20.4 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 20.4, scene: 'high', note: '2688×1520. Up to 60 fps. Built-in radar.' },
    { id: 'ms-ts8266-rfivpg1', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS8266-RFIVPG1', label: 'AI Road Traffic Radar Motorized Pro Bullet Plus · 4K 30 fps · 21 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21, scene: 'high', note: 'Up to 60 fps. Built-in radar.' },
    { id: 'ms-ts4466-x4rvpe', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS4466-X4RVPE', label: 'AI Road Traffic Radar Pro Bullet Plus 4× · 4 MP 30 fps · 15.6 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 15.6, scene: 'high', note: '2688×1520. Up to 60 fps. Built-in radar.' },
    { id: 'ms-ts2966-x12tvpe', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS2966-X12TVPE', label: 'AI Road Traffic Radar Pro Bullet Plus 12× · 2 MP 30 fps · 17 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 17, scene: 'high', note: 'Up to 90 fps. Built-in radar.' },
    { id: 'ms-ts5366-x12vpe', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS5366-X12VPE', label: 'AI Road Traffic Radar Pro Bullet Plus 12× · 5 MP 30 fps · 16 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16, scene: 'high', note: 'Built-in radar.' },
    { id: 'ms-ts8266-x4vpe', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS8266-X4VPE', label: 'AI Road Traffic Radar Pro Bullet Plus 4× · 4K 30 fps · 16.6 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.6, scene: 'high', note: 'Built-in radar.' },
    { id: 'ms-ts2961-x12tpe', vendor: 'Milesight', family: 'Traffic & LPR', model: 'TS2961-X12TPE', label: 'AI Road Traffic PTZ Bullet 12× · 2 MP 30 fps · 18.9 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 18.9, scene: 'high', note: 'Up to 90 fps.' },
    // Hikvision: Pro, Ultra, DeepinView, PanoVu and PTZ lines, from the datasheets
    // linked on hikvision.com product pages (assets.hikvision.com), October 2026.
    // Power is the datasheet's PoE maximum. Hikvision is on the US NDAA §889 /
    // FCC covered list; see the README.
    // Hikvision Domes
    { id: 'hik-ds-2cd2143g2-is', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2143G2-IS', label: 'Pro AcuSense Fixed Dome DS-2CD2143G2-IS · 4 MP 30 fps · 6.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.5, note: '2688×1520.' },
    { id: 'hik-ds-2cd2146g2-i', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2146G2-I', label: 'Pro AcuSense Fixed Dome DS-2CD2146G2-I · 4 MP 30 fps · 6.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.5, note: '2688×1520.' },
    { id: 'hik-ds-2cd2147g2-l-su', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2147G2-L(SU)', label: 'Pro ColorVu Fixed Dome DS-2CD2147G2-L(SU) · 4 MP 30 fps · 6.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 6.5, note: '2688×1520. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2147g3-li-s2u-y', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2147G3-LI(S2U)Y', label: 'Pro Smart Hybrid Light with ColorVu Fixed Dome DS-2CD2147G3-LI(S2U)Y · 4 MP 30 fps · 9 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9, note: '2688×1520. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd2166g2-isu', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2166G2-ISU', label: 'Pro AcuSense Fixed Dome DS-2CD2166G2-ISU · 6 MP 30 fps · 7.5 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.5, note: '3200×1800.' },
    { id: 'hik-ds-2cd2167g3-lis2uy', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2167G3-LIS2UY', label: 'Pro Smart Hybrid Light ColorVu Fixed Dome DS-2CD2167G3-LIS2UY · 6 MP 30 fps · 10.5 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.5, note: '3200×1800. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd2183g2-is', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2183G2-IS', label: 'Pro AcuSense Vandal WDR Fixed Dome DS-2CD2183G2-IS · 4K 20 fps · 7.5 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 7.5 },
    { id: 'hik-ds-2cd2186g2-i-su', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2186G2-I(SU)', label: 'Pro AcuSense DarkFighter Fixed Dome DS-2CD2186G2-I(SU) · 4K 24 fps · 7.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: true, poeW: 7.5 },
    { id: 'hik-ds-2cd2187g2-lsu', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2187G2-LSU', label: 'Pro ColorVu Fixed Dome DS-2CD2187G2-LSU · 4K 24 fps · 8.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: false, poeW: 8.5, note: 'ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2187g3-lis2uy', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2187G3-LIS2UY', label: 'Pro Smart Hybrid Light with ColorVu Fixed Mini Dome DS-2CD2187G3-LIS2UY · 4K 30 fps · 10.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.5, note: 'Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd2343g2-i-u', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2343G2-I(U)', label: 'Pro AcuSense Fixed Turret DS-2CD2343G2-I(U) · 4 MP 30 fps · 7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7, note: '2688×1520.' },
    { id: 'hik-ds-2cd2346g2-i-u', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2346G2-I(U)', label: 'Pro AcuSense DarkFighter Fixed Turret DS-2CD2346G2-I(U) · 4 MP 30 fps · 6.8 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.8, note: '2688×1520.' },
    { id: 'hik-ds-2cd2347g2-l-u', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2347G2-L(U)', label: 'Pro ColorVu Fixed Turret DS-2CD2347G2-L(U) · 4 MP 30 fps · 7.6 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 7.6, note: '2688×1520. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2347g3-li2uy', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2347G3-LI2UY', label: 'Pro Smart Hybrid Light with ColorVu Fixed Turret DS-2CD2347G3-LI2UY · 4 MP 30 fps · 11 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11, note: '2688×1520. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd2366g2-i', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2366G2-I', label: 'Pro AcuSense Fixed Turret DS-2CD2366G2-I · 6 MP 30 fps · 6.5 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.5, note: '3200×1800.' },
    { id: 'hik-ds-2cd2367g2-l', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2367G2-L', label: 'Pro ColorVu Fixed Turret DS-2CD2367G2-L · 6 MP 24 fps · 10.5 W', resolution: '6MP', codec: 'h265', fps: 24, nightIR: false, poeW: 10.5, note: '3200×1800. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2383g2-i', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2383G2-I', label: 'Pro AcuSense Fixed Turret DS-2CD2383G2-I · 4K 20 fps · 7.5 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 7.5 },
    { id: 'hik-ds-2cd2386g2-i-u', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2386G2-I(U)', label: 'Pro AcuSense DarkFighter Fixed Turret DS-2CD2386G2-I(U) · 4K 24 fps · 6.8 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: true, poeW: 6.8 },
    { id: 'hik-ds-2cd2387g2-l-u', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2387G2-L(U)', label: 'Pro ColorVu Fixed Turret DS-2CD2387G2-L(U) · 4K 24 fps · 6.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: false, poeW: 6.5, note: 'ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2387g3-li2uy', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2387G3-LI2UY', label: 'Pro Smart Hybrid Light with ColorVu Fixed Turret DS-2CD2387G3-LI2UY · 4K 30 fps · 11 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11, note: 'Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd2h86g2-izs', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD2H86G2-IZS', label: 'Pro AcuSense DarkFighter Motorized Varifocal Turret DS-2CD2H86G2-IZS · 4K 24 fps · 12.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: true, poeW: 12.5 },
    { id: 'hik-ds-2cd3143g2-i-s-u', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3143G2-I(S)U', label: 'Ultra Vandal WDR Fixed Dome DS-2CD3143G2-I(S)U · 4 MP 30 fps · 10 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, note: '2688×1520.' },
    { id: 'hik-ds-2cd3146g2-is-u', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3146G2-IS(U)', label: 'Ultra AcuSense Fixed Dome DS-2CD3146G2-IS(U) · 4 MP 30 fps · 9 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9, note: '2688×1520.' },
    { id: 'hik-ds-2cd3147g3-lisuy', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3147G3-LISUY', label: 'Ultra Dual Illumination Fixed Mini Dome DS-2CD3147G3-LISUY · 4 MP 30 fps · 11 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11, note: '2688×1520. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd3186g2-is-u-h', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3186G2-IS(U)(H)', label: 'Ultra AcuSense Fixed Dome DS-2CD3186G2-IS(U)(H) · 4K 24 fps · 9.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: true, poeW: 9.5 },
    { id: 'hik-ds-2cd3187g3-lisuy', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3187G3-LISUY', label: 'Ultra Dual Illumination Fixed Mini Dome DS-2CD3187G3-LISUY · 4K 30 fps · 11.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.5, note: 'Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd3343g2-i-s-u-b', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3343G2-I(S)U(B)', label: 'Ultra AcuSense Fixed Turret DS-2CD3343G2-I(S)U(B) · 4 MP 30 fps · 9 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9, note: '2688×1520.' },
    { id: 'hik-ds-2cd3346g2-is-u', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3346G2-IS(U)', label: 'Ultra AcuSense Fixed Turret DS-2CD3346G2-IS(U) · 4 MP 30 fps · 8.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.5, note: '2688×1520.' },
    { id: 'hik-ds-2cd3347g2-ls-u', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3347G2-LS(U)', label: 'Ultra ColorVu Fixed Turret DS-2CD3347G2-LS(U) · 4 MP 30 fps · 7.6 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 7.6, note: '2688×1520. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd3347g3-lisuy', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3347G3-LISUY', label: 'Ultra Dual Illumination Fixed Turret DS-2CD3347G3-LISUY · 4 MP 30 fps · 11 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11, note: '2688×1520. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd3386g2-is-u-h', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3386G2-IS(U)(H)', label: 'Ultra AcuSense Fixed Turret DS-2CD3386G2-IS(U)(H) · 4K 24 fps · 9.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: true, poeW: 9.5 },
    { id: 'hik-ds-2cd3387g2-lsu', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3387G2-LSU', label: 'Ultra ColorVu Fixed Turret DS-2CD3387G2-LSU · 4K 24 fps · 6.6 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: false, poeW: 6.6, note: 'ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd3387g3-lisu', vendor: 'Hikvision', family: 'Domes', model: 'DS-2CD3387G3-LISU', label: 'Ultra Dual Illumination Fixed Turret DS-2CD3387G3-LISU · 4K 30 fps · 11 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11, note: 'Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ids-2cd7146g2-iz-h-s-y-1t', vendor: 'Hikvision', family: 'Domes', model: 'iDS-2CD7146G2-IZ(H)S(Y)(1T)', label: 'DeepinView Moto Varifocal Dome iDS-2CD7146G2-IZ(H)S(Y)(1T) · 4 MP 30 fps · 16.8 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.8, note: '2688×1520. Up to 60 fps.' },
    { id: 'hik-ids-2cd7547g2-xzhs-y', vendor: 'Hikvision', family: 'Domes', model: 'iDS-2CD7547G2-XZHS(Y)', label: 'DarkFighterS DeepinView PTRZ Dome iDS-2CD7547G2-XZHS(Y) · 4 MP 30 fps · 20.5 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 20.5, note: '2688×1520. Up to 60 fps. Smart hybrid light: IR by default, white light on events.' },
    // Hikvision Bullets
    { id: 'hik-ds-2cd2043g2-i-u', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2043G2-I(U)', label: 'Pro AcuSense Fixed Bullet DS-2CD2043G2-I(U) · 4 MP 30 fps · 7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7, note: '2688×1520.' },
    { id: 'hik-ds-2cd2046g2-i-u', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2046G2-I(U)', label: 'Pro AcuSense DarkFighter Fixed Bullet DS-2CD2046G2-I(U) · 4 MP 30 fps · 7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7, note: '2688×1520.' },
    { id: 'hik-ds-2cd2047g2-l-u', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2047G2-L(U)', label: 'Pro ColorVu Fixed Mini Bullet DS-2CD2047G2-L(U) · 4 MP 30 fps · 7.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 7.5, note: '2688×1520. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2047g3-liy', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2047G3-LIY', label: 'Pro Smart Hybrid Light with ColorVu Fixed Mini Bullet DS-2CD2047G3-LIY · 4 MP 30 fps · 6.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.5, note: '2688×1520. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd2066g2-iu', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2066G2-IU', label: 'Pro AcuSense Fixed Bullet DS-2CD2066G2-IU · 6 MP 30 fps · 7.2 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.2, note: '3200×1800.' },
    { id: 'hik-ds-2cd2067g2-lu', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2067G2-LU', label: 'Pro ColorVu Fixed Mini Bullet DS-2CD2067G2-LU · 6 MP 24 fps · 7.5 W', resolution: '6MP', codec: 'h265', fps: 24, nightIR: false, poeW: 7.5, note: '3200×1800. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2083g2-i', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2083G2-I', label: 'Pro AcuSense Fixed Bullet DS-2CD2083G2-I · 4K 20 fps · 7.2 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 7.2 },
    { id: 'hik-ds-2cd2086g2-i-u', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2086G2-I(U)', label: 'Pro AcuSense DarkFighter Fixed Mini Bullet DS-2CD2086G2-I(U) · 4K 24 fps · 7.2 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: true, poeW: 7.2 },
    { id: 'hik-ds-2cd2087g2-l-u', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2087G2-L(U)', label: 'Pro ColorVu Fixed Bullet DS-2CD2087G2-L(U) · 4K 24 fps · 7.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: false, poeW: 7.5, note: 'ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2087g3-liy', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2087G3-LIY', label: 'Pro Smart Hybrid Light with ColorVu Fixed Mini Bullet DS-2CD2087G3-LIY · 4K 30 fps · 7 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7, note: 'Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd2t46g2-4iy', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2T46G2-4IY', label: 'Pro AcuSense DarkFighter Fixed Bullet DS-2CD2T46G2-4IY · 4 MP 30 fps · 12 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12, note: '2688×1520.' },
    { id: 'hik-ds-2cd2t47g2-l', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2T47G2-L', label: 'Pro ColorVu Fixed Bullet DS-2CD2T47G2-L · 4 MP 30 fps · 10.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 10.5, note: '2688×1520. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2t87g2-l', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2T87G2-L', label: 'Pro ColorVu Fixed Bullet DS-2CD2T87G2-L · 4K 24 fps · 9.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: false, poeW: 9.5, note: 'ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2t87g3-liy', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD2T87G3-LIY', label: 'Pro Smart Hybrid Light Fixed Bullet DS-2CD2T87G3-LIY · 4K 30 fps · 12.5 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.5, note: 'Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd3043g2-liu', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3043G2-LIU', label: 'Ultra AcuSense Smart Hybrid Light Fixed Bullet DS-2CD3043G2-LIU · 4 MP 30 fps · 8 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8, note: '2688×1520. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd3043g3-liuy', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3043G3-LIUY', label: 'Ultra AcuSense Smart Hybrid Light Fixed Bullet DS-2CD3043G3-LIUY · 4 MP 30 fps · 7.3 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.3, note: '2688×1520. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd3046g3-iuy', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3046G3-IUY', label: 'Ultra AcuSense Fixed Mini Bullet DS-2CD3046G3-IUY · 4 MP 30 fps · 8 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8, note: '2688×1520.' },
    { id: 'hik-ds-2cd3047g2-ls', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3047G2-LS', label: 'Ultra ColorVu Fixed Mini Bullet DS-2CD3047G2-LS · 4 MP 30 fps · 8.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 8.5, note: '2688×1520. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd3047g3-liuy', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3047G3-LIUY', label: 'Ultra Dual Illumination Fixed Mini Bullet DS-2CD3047G3-LIUY · 4 MP 30 fps · 6.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.5, note: '2688×1520. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd3086g3-liu-y', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3086G3-LIU(Y)', label: 'Ultra Dual Illumination Fixed Mini Bullet DS-2CD3086G3-LIU(Y) · 4K 30 fps · 7 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7, note: 'Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd3087g2-lsu', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3087G2-LSU', label: 'Ultra ColorVu Fixed Bullet DS-2CD3087G2-LSU · 4K 24 fps · 8.5 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: false, poeW: 8.5, note: 'ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd3087g3-liu', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3087G3-LIU', label: 'Ultra Dual Illumination Fixed Mini Bullet DS-2CD3087G3-LIU · 4K 30 fps · 7 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7, note: 'Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd3646g3t-izsuy', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3646G3T-IZSUY', label: 'Ultra AcuSense Varifocal Bullet DS-2CD3646G3T-IZSUY · 4 MP 30 fps · 18 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 18, note: '2688×1520.' },
    { id: 'hik-ds-2cd3686g2-izs', vendor: 'Hikvision', family: 'Bullets', model: 'DS-2CD3686G2-IZS', label: 'Ultra AcuSense IR Varifocal Bullet DS-2CD3686G2-IZS · 4K 24 fps · 15 W', resolution: '8MP', codec: 'h265', fps: 24, nightIR: true, poeW: 15 },
    { id: 'hik-ids-2cd7a46g2-v-xzhs-y', vendor: 'Hikvision', family: 'Bullets', model: 'IDS-2CD7A46G2/V-XZHS(Y)', label: 'DeepinViewX Moto Varifocal Bullet IDS-2CD7A46G2/V-XZHS(Y) · 4 MP 30 fps · 23.1 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 23.1, note: '2688×1520. Up to 60 fps. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ids-2cd7a86g2-v-xzhs-y', vendor: 'Hikvision', family: 'Bullets', model: 'IDS-2CD7A86G2/V-XZHS(Y)', label: 'DeepinViewX Moto Varifocal Bullet IDS-2CD7A86G2/V-XZHS(Y) · 4K 30 fps · 24.7 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.7, note: 'Up to 60 fps. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ids-2cd7a87g2-xzhs-y', vendor: 'Hikvision', family: 'Bullets', model: 'iDS-2CD7A87G2-XZHS(Y)', label: 'DarkFighterS DeepinView Moto Varifocal Bullet iDS-2CD7A87G2-XZHS(Y) · 4K 30 fps · 25 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25, note: 'Up to 60 fps. Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ids-2cd7t46g2-vx3-i-h-s-y', vendor: 'Hikvision', family: 'Bullets', model: 'iDS-2CD7T46G2/VX3-I(H)S(Y)', label: 'DeepinView Triple Fixed Lens Bullet iDS-2CD7T46G2/VX3-I(H)S(Y) · 4 MP 30 fps · 25.5 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5, note: 'Channel 1 only: add two 2 MP rows (no PoE) for channels 2 and 3. 2688×1520.' },
    // Hikvision Panoramic & multi-sensor
    { id: 'hik-ds-2cd2347g3p-lis2uy-s-l-rb', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD2347G3P-LIS2UY/S(L)(RB)', label: 'Pro Panoramic ColorVu Fixed Turret DS-2CD2347G3P-LIS2UY/S(L)(RB) · 3040×1368 24 fps · 24 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 24, nightIR: true, poeW: 24, note: 'Smart hybrid light: IR by default, white light on events.' },
    { id: 'hik-ds-2cd2387g2p-lsu-sl', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD2387G2P-LSU/SL', label: 'Pro Panoramic Fixed Turret DS-2CD2387G2P-LSU/SL · 5120×1440 20 fps · 12.5 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: false, poeW: 12.5, note: '2 sensors stitched into one 5120×1440 stream. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd2t87g2p-lsu-sl', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD2T87G2P-LSU/SL', label: 'Pro Panoramic Fixed Bullet DS-2CD2T87G2P-LSU/SL · 5120×1440 20 fps · 12.5 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: false, poeW: 12.5, note: '2 sensors stitched into one 5120×1440 stream. ColorVu: white light, no IR.' },
    { id: 'hik-ds-2cd3956g2-is-u', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD3956G2-IS(U)', label: 'Ultra AcuSense Fisheye DS-2CD3956G2-IS(U) · 2560×1920 30 fps · 7.5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.5 },
    { id: 'hik-ds-2cd6365g1-ivs', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD6365G1-IVS', label: 'DeepinView Fisheye DS-2CD6365G1-IVS · 2560×2560 30 fps · 12.5 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.5 },
    { id: 'hik-ds-2cd63c5g1-ivs', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD63C5G1-IVS', label: 'DeepinView IR Fisheye DS-2CD63C5G1-IVS · 3504×3504 30 fps · 12.5 W', resolution: '12MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.5 },
    { id: 'hik-ds-2cd6944g1-ihs-u-y', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD6944G1-IHS(U)Y', label: '180° PanoVu DS-2CD6944G1-IHS(U)Y · 4800×2688 30 fps · 25 W (PoE+)', resolution: '12MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25, note: '4 sensors stitched into one 4800×2688 stream. Up to 60 fps.' },
    { id: 'hik-ds-2cd6d54g2-izhs', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD6D54G2-IZHS', label: '4-Directional Multisensor DS-2CD6D54G2-IZHS · 5 MP 30 fps · 25 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.25, note: 'One row per sensor: enter 4 cameras per unit (25 W per unit).' },
    { id: 'hik-ds-2cd6d82g2-is', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD6D82G2-IS', label: 'Dual-Directional PanoVu DS-2CD6D82G2-IS · 4K 20 fps · 14 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 7, note: 'One row per sensor: enter 2 cameras per unit (14 W per unit).' },
    { id: 'hik-ds-2cd6w65g1-ivs', vendor: 'Hikvision', family: 'Panoramic & multi-sensor', model: 'DS-2CD6W65G1-IVS', label: 'DeepinView Fisheye DS-2CD6W65G1-IVS · 2560×2560 30 fps · 10 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10 },
    // Hikvision PTZ & speed domes
    { id: 'hik-ds-2de2a404iw-de3-s6', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE2A404IW-DE3(S6)', label: '4x IR PTZ DS-2DE2A404IW-DE3(S6) · 4 MP 30 fps · 9.2 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.2, scene: 'high' },
    { id: 'hik-ds-2de2a404iwg1-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE2A404IWG1-E', label: '4X IR Mini Outdoor AcuSense PTZ DS-2DE2A404IWG1-E · 4 MP 30 fps · 9.2 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.2, scene: 'high' },
    { id: 'hik-ds-2de3a404iw-de-s6', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE3A404IW-DE(S6)', label: '4 x IR PTZ DS-2DE3A404IW-DE(S6) · 4 MP 30 fps · 14 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 14, scene: 'high' },
    { id: 'hik-ds-2de4a225iwg-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE4A225IWG-E', label: '25X DarkFighter IR AcuSense Speed Dome DS-2DE4A225IWG-E · 2 MP 30 fps · 24 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'hik-ds-2de4a425iwg1-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE4A425IWG1-E', label: '25X DarkFighter IR AcuSense Speed Dome DS-2DE4A425IWG1-E · 4 MP 30 fps · 24 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'hik-ds-2de5425iwg-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE5425IWG-E', label: '25x IR Speed Dome DS-2DE5425IWG-E · 4 MP 30 fps · 24 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24, scene: 'high' },
    { id: 'hik-ds-2de5425iwg1-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE5425IWG1-E', label: '25X DarkFighter IR AcuSense Speed Dome DS-2DE5425IWG1-E · 4 MP 30 fps · 24 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24, scene: 'high' },
    { id: 'hik-ds-2de5432iwg1-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE5432IWG1-E', label: '32X DarkFighter IR AcuSense Speed Dome DS-2DE5432IWG1-E · 4 MP 30 fps · 24 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24, scene: 'high' },
    { id: 'hik-ds-2de7a232iwg-eb', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE7A232IWG-EB', label: '32 x IR Speed Dome DS-2DE7A232IWG-EB · 2 MP 30 fps · 42 W (Hi-PoE)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 42, scene: 'high', note: 'Up to 60 fps. Hikvision Hi-PoE or 24 V supply; a standard PoE+ port won\'t power it.' },
    { id: 'hik-ds-2de7a232iwg1-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE7A232IWG1-E', label: '32X DarkFighter IR AcuSense Speed Dome DS-2DE7A232IWG1-E · 2 MP 30 fps · 48 W (PoE++)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 48, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'hik-ds-2de7a425iwg1-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE7A425IWG1-E', label: '25X DarkFighter IR AcuSense Speed Dome DS-2DE7A425IWG1-E · 4 MP 30 fps · 48 W (PoE++)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 48, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'hik-ds-2de7a432iwg1-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE7A432IWG1-E', label: '32X DarkFighter IR AcuSense Speed Dome DS-2DE7A432IWG1-E · 4 MP 30 fps · 48 W (PoE++)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 48, scene: 'high' },
    { id: 'hik-ds-2de7a825iwg-eb', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE7A825IWG-EB', label: '25 x IR Speed Dome DS-2DE7A825IWG-EB · 4K 24 fps · 42 W (Hi-PoE)', resolution: '8MP', codec: 'h265', fps: 24, nightIR: true, poeW: 42, scene: 'high', note: 'Hikvision Hi-PoE or 24 V supply; a standard PoE+ port won\'t power it.' },
    { id: 'hik-ds-2de7a825iwg1-e', vendor: 'Hikvision', family: 'PTZ & speed domes', model: 'DS-2DE7A825IWG1-E', label: '25X DarkFighter IR AcuSense Speed Dome DS-2DE7A825IWG1-E · 4K 30 fps · 48 W (PoE++)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 48, scene: 'high' },
    // Dahua: WizSense 2/3, WizMind 5/7, panoramic and PTZ lines, from the
    // datasheets linked on dahuasecurity.com (materialfile.dahuasecurity.com),
    // October 2026. Power is the datasheet's PoE maximum with illumination on.
    // Dahua is on the US NDAA §889 / FCC covered list; see the README.
    // Dahua Domes
    { id: 'dahua-ipc-hdbw2441e-s', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW2441E-S', label: 'IR Fixed-focal Dome IPC-HDBW2441E-S · 4 MP 20 fps · 6 W', resolution: '4MP', codec: 'h265', fps: 20, nightIR: true, poeW: 6 },
    { id: 'dahua-ipc-hdbw2441r-zs', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW2441R-ZS', label: 'IR Vari-focal Dome IPC-HDBW2441R-ZS · 4 MP 20 fps · 7.6 W', resolution: '4MP', codec: 'h265', fps: 20, nightIR: true, poeW: 7.6 },
    { id: 'dahua-ipc-hdbw2449e-s-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW2449E-S-IL', label: 'Smart Dual Light Fixed-focal Dome IPC-HDBW2449E-S-IL · 4 MP 30 fps · 5.7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.7, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw2449f-as-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW2449F-AS-IL', label: 'Smart Dual Light Fixed-focal Dome IPC-HDBW2449F-AS-IL · 4 MP 20 fps · 8.5 W', resolution: '4MP', codec: 'h265', fps: 20, nightIR: true, poeW: 8.5, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw2541e-s', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW2541E-S', label: 'IR Fixed-focal Dome IPC-HDBW2541E-S · 2960×1668 20 fps · 6.1 W', resolution: '5MP', codec: 'h265', fps: 20, nightIR: true, poeW: 6.1 },
    { id: 'dahua-ipc-hdbw2649e-s-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW2649E-S-IL', label: 'Smart Dual Light Fixed-focal Dome IPC-HDBW2649E-S-IL · 3288×1850 20 fps · 6.6 W', resolution: '6MP', codec: 'h265', fps: 20, nightIR: true, poeW: 6.6, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw2841e-s', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW2841E-S', label: 'IR Fixed-focal Dome IPC-HDBW2841E-S · 4K 20 fps · 6.4 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 6.4 },
    { id: 'dahua-ipc-hdbw2841r-zs', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW2841R-ZS', label: 'IR Vari-focal Dome IPC-HDBW2841R-ZS · 4K 20 fps · 7.2 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 7.2 },
    { id: 'dahua-ipc-hdbw2849e-s-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW2849E-S-IL', label: 'Smart Dual Light Fixed-focal Dome IPC-HDBW2849E-S-IL · 4K 20 fps · 6.6 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 6.6, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdw2441t-s', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW2441T-S', label: 'IR Fixed-focal Eyeball IPC-HDW2441T-S · 4 MP 20 fps · 5.1 W', resolution: '4MP', codec: 'h265', fps: 20, nightIR: true, poeW: 5.1 },
    { id: 'dahua-ipc-hdw2449t-s-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW2449T-S-PRO', label: 'WizColor Fixed-focal Eyeball IPC-HDW2449T-S-PRO · 4 MP 20 fps · 5.5 W', resolution: '4MP', codec: 'h265', fps: 20, nightIR: false, poeW: 5.5, note: 'Full-colour: white light, no IR.' },
    { id: 'dahua-ipc-hdw2449tm-s-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW2449TM-S-IL', label: 'Smart Dual Light Fixed-focal Eyeball IPC-HDW2449TM-S-IL · 4 MP 30 fps · 5.4 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.4, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdw2541t-s', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW2541T-S', label: 'IR Fixed-focal Eyeball IPC-HDW2541T-S · 2960×1668 20 fps · 5 W', resolution: '5MP', codec: 'h265', fps: 20, nightIR: true, poeW: 5 },
    { id: 'dahua-ipc-hdw2649tm-s-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW2649TM-S-IL', label: 'Smart Dual Light Fixed-focal Eyeball IPC-HDW2649TM-S-IL · 3288×1850 20 fps · 5.4 W', resolution: '6MP', codec: 'h265', fps: 20, nightIR: true, poeW: 5.4, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdw2841t-s', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW2841T-S', label: 'IR Fixed-focal Eyeball IPC-HDW2841T-S · 4K 20 fps · 5.4 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 5.4 },
    { id: 'dahua-ipc-hdw2849tm-s-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW2849TM-S-IL', label: 'Smart Dual Light Fixed-focal Eyeball IPC-HDW2849TM-S-IL · 4K 20 fps · 5.6 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 5.6, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdw2849t-s-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW2849T-S-PRO', label: 'WizColor Fixed-focal Eyeball IPC-HDW2849T-S-PRO · 4K 20 fps · 6.4 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: false, poeW: 6.4, note: 'Full-colour: white light, no IR.' },
    { id: 'dahua-ipc-hdbw3449e-as-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW3449E-AS-IL', label: 'Smart Dual Light Fixed-focal Dome IPC-HDBW3449E-AS-IL · 4 MP 30 fps · 7.1 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.1, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw3449r1-zas-pv-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW3449R1-ZAS-PV-PRO', label: 'WizColor TiOC PRO Vari-focal Dome IPC-HDBW3449R1-ZAS-PV-PRO · 4 MP 30 fps · 16.1 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.1, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw3849e-as-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW3849E-AS-IL', label: 'Smart Dual Light Fixed-focal Dome IPC-HDBW3849E-AS-IL · 4K 30 fps · 8.2 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.2, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw3849r1-zas-pv-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW3849R1-ZAS-PV-PRO', label: 'WizColor TiOC PRO Vari-focal Dome IPC-HDBW3849R1-ZAS-PV-PRO · 4K 30 fps · 16.9 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.9, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw3649e-as-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW3649E-AS-IL', label: 'Smart Dual Light Fixed-focal Dome IPC-HDBW3649E-AS-IL · 3288×1850 30 fps · 7.5 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.5, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdw3449h-as-pv-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW3449H-AS-PV-PRO', label: 'WizColor TiOC PRO Fixed-focal Eyeball IPC-HDW3449H-AS-PV-PRO · 4 MP 30 fps · 8.7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.7, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdw3849h-as-pv-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW3849H-AS-PV-PRO', label: 'WizColor TiOC PRO Fixed-focal Eyeball IPC-HDW3849H-AS-PV-PRO · 4K 30 fps · 10 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdw3649h-as-pv-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW3649H-AS-PV-PRO', label: 'WizColor TiOC PRO Fixed-focal Eyeball IPC-HDW3649H-AS-PV-PRO · 3288×1850 30 fps · 10 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw5459e1-ze-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW5459E1-ZE-IL', label: 'Smart Dual Light Vari-focal Vandal-proof Dome IPC-HDBW5459E1-ZE-IL · 4 MP 30 fps · 22.1 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.1, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw5859e1-ze-il', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW5859E1-ZE-IL', label: 'Smart Dual Light Vari-focal Vandal-proof Dome IPC-HDBW5859E1-ZE-IL · 4K 30 fps · 22.1 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.1, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw5459r1-ase-pv-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW5459R1-ASE-PV-PRO', label: 'WizColor Fixed-focal Dome IPC-HDBW5459R1-ASE-PV-PRO · 4 MP 30 fps · 17.5 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 17.5, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw5859z-zhe-pv-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW5859Z-ZHE-PV-PRO', label: 'WizColor Vari-focal PTRZ Dome IPC-HDBW5859Z-ZHE-PV-PRO · 4K 30 fps · 24.2 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.2, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdw5459h-ase-pv-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW5459H-ASE-PV-PRO', label: 'WizColor Fixed-focal Eyeball IPC-HDW5459H-ASE-PV-PRO · 4 MP 30 fps · 24.2 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.2, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdw5859h-ze-pv-pro', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDW5859H-ZE-PV-PRO', label: 'WizColor Vari-focal Eyeball IPC-HDW5859H-ZE-PV-PRO · 4K 30 fps · 24.2 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.2, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hdbw7842e1-z-x', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW7842E1-Z-X', label: 'IR Dome IPC-HDBW7842E1-Z-X · 4K 30 fps · 25.2 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.2 },
    { id: 'dahua-ipc-hdbw7459z-z-pv-x', vendor: 'Dahua', family: 'Domes', model: 'IPC-HDBW7459Z-Z-PV-X', label: 'Smart Dual Light PTRZ Dome IPC-HDBW7459Z-Z-PV-X · 4 MP 30 fps · 23.8 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 23.8, note: 'Smart dual light: IR by default, white light on events.' },
    // Dahua Bullets
    { id: 'dahua-ipc-hfw2441s-s', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2441S-S', label: 'IR Fixed-focal Bullet IPC-HFW2441S-S · 4 MP 20 fps · 5.1 W', resolution: '4MP', codec: 'h265', fps: 20, nightIR: true, poeW: 5.1 },
    { id: 'dahua-ipc-hfw2441t-as', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2441T-AS', label: 'IR Fixed-focal Bullet IPC-HFW2441T-AS · 4 MP 20 fps · 8.3 W', resolution: '4MP', codec: 'h265', fps: 20, nightIR: true, poeW: 8.3 },
    { id: 'dahua-ipc-hfw2449s-s-il', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2449S-S-IL', label: 'Smart Dual Light Fixed-focal Bullet IPC-HFW2449S-S-IL · 4 MP 30 fps · 5.4 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.4, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw2449tl-s-pv', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2449TL-S-PV', label: 'Smart Dual Light Active Deterrence Fixed-focal Bullet IPC-HFW2449TL-S-PV · 4 MP 20 fps · 13.6 W', resolution: '4MP', codec: 'h265', fps: 20, nightIR: true, poeW: 13.6, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw2541t-as', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2541T-AS', label: 'IR Fixed-focal Bullet IPC-HFW2541T-AS · 2960×1668 20 fps · 8.8 W', resolution: '5MP', codec: 'h265', fps: 20, nightIR: true, poeW: 8.8 },
    { id: 'dahua-ipc-hfw2649s-s-il', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2649S-S-IL', label: 'Smart Dual Light Fixed-focal Bullet IPC-HFW2649S-S-IL · 3288×1850 20 fps · 5.4 W', resolution: '6MP', codec: 'h265', fps: 20, nightIR: true, poeW: 5.4, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw2841t-zs', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2841T-ZS', label: 'IR Vari-focal Bullet IPC-HFW2841T-ZS · 4K 20 fps · 9.6 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 9.6 },
    { id: 'dahua-ipc-hfw2849t-as-il', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2849T-AS-IL', label: 'Smart Dual Light Fixed-focal Bullet IPC-HFW2849T-AS-IL · 4K 20 fps · 7.3 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 7.3, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw2849tl-s-pro', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2849TL-S-PRO', label: 'WizColor Fixed-focal Bullet IPC-HFW2849TL-S-PRO · 4K 20 fps · 7.4 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: false, poeW: 7.4, note: 'Full-colour: white light, no IR.' },
    { id: 'dahua-ipc-hfw2449m-s-b-pro', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW2449M-S-B-PRO', label: 'WizColor Fixed-focal Bullet IPC-HFW2449M-S-B-PRO · 4 MP 20 fps · 6.3 W', resolution: '4MP', codec: 'h265', fps: 20, nightIR: false, poeW: 6.3, note: 'Full-colour: white light, no IR.' },
    { id: 'dahua-ipc-hfw3449e-as-il', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW3449E-AS-IL', label: 'Smart Dual Light Fixed-focal Bullet IPC-HFW3449E-AS-IL · 4 MP 30 fps · 9.7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.7, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw3449t1-as-pv-pro', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW3449T1-AS-PV-PRO', label: 'WizColor TiOC PRO Fixed-focal Bullet IPC-HFW3449T1-AS-PV-PRO · 4 MP 30 fps · 14.3 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 14.3, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw3849e-as-il', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW3849E-AS-IL', label: 'Smart Dual Light Fixed-focal Bullet IPC-HFW3849E-AS-IL · 4K 30 fps · 10 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw3849t1-as-pv-pro', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW3849T1-AS-PV-PRO', label: 'WizColor TiOC PRO Fixed-focal Bullet IPC-HFW3849T1-AS-PV-PRO · 4K 30 fps · 15.1 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 15.1, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw3649t1-zas-pv-pro', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW3649T1-ZAS-PV-PRO', label: 'WizColor TiOC PRO Vari-focal Bullet IPC-HFW3649T1-ZAS-PV-PRO · 3288×1850 30 fps · 18.2 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 18.2, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw5459e1-ze-il', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW5459E1-ZE-IL', label: 'Smart Dual Light Vari-focal Bullet IPC-HFW5459E1-ZE-IL · 4 MP 30 fps · 22.1 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.1, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw5859e1-ze-il', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW5859E1-ZE-IL', label: 'Smart Dual Light Vari-focal Bullet IPC-HFW5859E1-ZE-IL · 4K 30 fps · 22.1 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.1, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw5459t1-ase-pv-pro', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW5459T1-ASE-PV-PRO', label: 'WizColor Fixed-focal Bullet IPC-HFW5459T1-ASE-PV-PRO · 4 MP 30 fps · 24.2 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.2, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw5859z-zhe-pv-pro', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW5859Z-ZHE-PV-PRO', label: 'WizColor Vari-focal Bullet IPC-HFW5859Z-ZHE-PV-PRO · 4K 30 fps · 24.2 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.2, note: 'Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-hfw7442h-z-x', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW7442H-Z-X', label: 'IR Bullet IPC-HFW7442H-Z-X · 4 MP 30 fps · 24.3 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.3, note: 'Up to 60 fps.' },
    { id: 'dahua-ipc-hfw7842h-z-x', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW7842H-Z-X', label: 'IR Bullet IPC-HFW7842H-Z-X · 4K 30 fps · 24.3 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 24.3 },
    { id: 'dahua-ipc-hfw7859z1-z-pv-x', vendor: 'Dahua', family: 'Bullets', model: 'IPC-HFW7859Z1-Z-PV-X', label: 'Smart Dual Light Bullet IPC-HFW7859Z1-Z-PV-X · 4K 30 fps · 21.8 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21.8, note: 'Smart dual light: IR by default, white light on events.' },
    // Dahua Panoramic & multi-sensor
    { id: 'dahua-ipc-ebw5641-as', vendor: 'Dahua', family: 'Panoramic & multi-sensor', model: 'IPC-EBW5641-AS', label: 'IR Fisheye IPC-EBW5641-AS · 2560×2560 30 fps · 9.7 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.7 },
    { id: 'dahua-ipc-ebw8842-as', vendor: 'Dahua', family: 'Panoramic & multi-sensor', model: 'IPC-EBW8842-AS', label: 'IR Fisheye IPC-EBW8842-AS · 3280×2480 30 fps · 13.9 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 13.9 },
    { id: 'dahua-ipc-pfw3859s-a180-as-pv', vendor: 'Dahua', family: 'Panoramic & multi-sensor', model: 'IPC-PFW3859S-A180-AS-PV', label: '2x4MP TiOC Duo Splicing Fixed-focal Bullet IPC-PFW3859S-A180-AS-PV · 4320×1944 20 fps · 16.1 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 16.1, note: '2 sensors stitched into one 4320×1944 stream. Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-pdw3859-a180-as-pv', vendor: 'Dahua', family: 'Panoramic & multi-sensor', model: 'IPC-PDW3859-A180-AS-PV', label: '2x4MP TiOC Duo Splicing Fixed-focal Eyeball IPC-PDW3859-A180-AS-PV · 4320×1944 20 fps · 14.8 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 14.8, note: '2 sensors stitched into one 4320×1944 stream. Smart dual light: IR by default, white light on events.' },
    { id: 'dahua-ipc-pfw5849-a180-e2-aste', vendor: 'Dahua', family: 'Panoramic & multi-sensor', model: 'IPC-PFW5849-A180-E2-ASTE', label: 'Full-color Duo Splicing IPC-PFW5849-A180-E2-ASTE · 4096×1800 25 fps · 13.8 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: false, poeW: 13.8, note: '2 sensors stitched into one 4096×1800 stream.' },
    { id: 'dahua-ipc-pfw81642-a180', vendor: 'Dahua', family: 'Panoramic & multi-sensor', model: 'IPC-PFW81642-A180', label: 'Multi-Sensor Panoramic Bullet IPC-PFW81642-A180 · 5520×2700 30 fps · 24.2 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.05, note: '4 sensors stitched into 5520×2700; sized per sensor: enter 4 cameras per unit (24.2 W per unit).' },
    { id: 'dahua-ipc-pfw83242-a180-s2', vendor: 'Dahua', family: 'Panoramic & multi-sensor', model: 'IPC-PFW83242-A180-S2', label: 'WizMind Multi-Sensor Panoramic Bullet IPC-PFW83242-A180-S2 · 8192×3840 30 fps · 25 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.25, note: '4 sensors stitched into 8192×3840; sized per sensor: enter 4 cameras per unit (25 W per unit).' },
    { id: 'dahua-ipc-pdbw82041-b360-s2', vendor: 'Dahua', family: 'Panoramic & multi-sensor', model: 'IPC-PDBW82041-B360-S2', label: '4-Directional Panoramic Dome IPC-PDBW82041-B360-S2 · 5 MP 30 fps · 24.7 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.17, note: 'One row per sensor: enter 4 cameras per unit (24.7 W per unit).' },
    // Dahua PTZ & speed domes
    { id: 'dahua-sd3d416nb-gny', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD3D416NB-GNY', label: '16x IR PTZ SD3D416NB-GNY · 4 MP 30 fps · 18 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 18, scene: 'high' },
    { id: 'dahua-sd4d425mb-hnr', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD4D425MB-HNR', label: '25x Smart Dual Light PTZ SD4D425MB-HNR · 4 MP 30 fps · 23 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 23, scene: 'high' },
    { id: 'dahua-sd4d825mb-hnr', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD4D825MB-HNR', label: '25x Smart Dual Light PTZ SD4D825MB-HNR · 4K 30 fps · 23 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 23, scene: 'high' },
    { id: 'dahua-sd4a425db-hny', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD4A425DB-HNY', label: '25x Starlight IR PTZ SD4A425DB-HNY · 4 MP 30 fps · 21.5 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21.5, scene: 'high' },
    { id: 'dahua-sd4e425mb-hnr-a-pv1', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD4E425MB-HNR-A-PV1', label: '25x Starlight TiOC PTZ SD4E425MB-HNR-A-PV1 · 4 MP 30 fps · 16 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16, scene: 'high' },
    { id: 'dahua-sd4e825mb-hnr-a-pv1', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD4E825MB-HNR-A-PV1', label: '25x Starlight Smart Dual Illumination PTZ SD4E825MB-HNR-A-PV1 · 4K 30 fps · 20.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 20.5, scene: 'high' },
    { id: 'dahua-sd5a425mb-hnr', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD5A425MB-HNR', label: '25× Starlight IR PTZ SD5A425MB-HNR · 4 MP 30 fps · 21 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21, scene: 'high' },
    { id: 'dahua-sd5a825ma-hnr', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD5A825MA-HNR', label: '25x IR PTZ SD5A825MA-HNR · 4K 30 fps · 25 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25, scene: 'high' },
    { id: 'dahua-sd5a445mb-hnr', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD5A445MB-HNR', label: '45x IR PTZ SD5A445MB-HNR · 4 MP 30 fps · 22 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22, scene: 'high' },
    { id: 'dahua-sd6e425mb-hnr-a-pv1', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD6E425MB-HNR-A-PV1', label: '25x Smart Dual Illumination Active Deterrence PTZ SD6E425MB-HNR-A-PV1 · 4 MP 30 fps · 19 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 19, scene: 'high' },
    { id: 'dahua-sd6e825ma-hnr-a-pv1', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD6E825MA-HNR-A-PV1', label: '25x Smart Dual Illumination Active Deterrence PTZ SD6E825MA-HNR-A-PV1 · 4K 30 fps · 21 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21, scene: 'high' },
    { id: 'dahua-sd50432gb-hnr', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD50432GB-HNR', label: '32x Starlight PTZ SD50432GB-HNR · 4 MP 30 fps · 16 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 16, scene: 'high' },
    { id: 'dahua-sd49425db-hny', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD49425DB-HNY', label: '25x Starlight IR PTZ SD49425DB-HNY · 4 MP 30 fps · 21 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 21, scene: 'high' },
    { id: 'dahua-sd8a440fa-hnt', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD8A440FA-HNT', label: '40× Starlight IR PTZ for Traffic SD8A440FA-HNT · 4 MP 30 fps · 33 W (Hi-PoE)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 33, scene: 'high', note: 'Needs Dahua Hi-PoE or the camera\'s own power supply; a standard PoE+ port won\'t power it.' },
    { id: 'dahua-sd7a440fa-hnf', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD7A440FA-HNF', label: '40X IR High-Speed PTZ SD7A440FA-HNF · 4 MP 30 fps · 33 W (PoE++)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 33, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'dahua-sd6al445gb-hnv', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD6AL445GB-HNV', label: '45x Starlight Laser PTZ SD6AL445GB-HNV · 4 MP 30 fps · 45 W (Hi-PoE)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 45, scene: 'high', note: 'Needs Dahua Hi-PoE or the camera\'s own power supply; a standard PoE+ port won\'t power it.' },
    { id: 'dahua-sdt4e425-4f-gb-a-pv1-s2', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SDT4E425-4F-GB-A-PV1-S2', label: '4+4MP 25x Smart Dual Illumination Active Deterrence X-Spans PTZ SDT4E425-4F-GB-A-PV1-S2 · 4 MP 30 fps · 25 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.5, scene: 'high', note: 'Overview and detail channels: enter 2 cameras per unit (25 W per unit).' },
    { id: 'dahua-sd8c448pa-hnf', vendor: 'Dahua', family: 'PTZ & speed domes', model: 'SD8C448PA-HNF', label: '48x Starlight IR PTZ SD8C448PA-HNF · 4 MP 30 fps · 33 W (Hi-PoE)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 33, scene: 'high', note: 'Up to 60 fps. Needs Dahua Hi-PoE or the camera\'s own power supply; a standard PoE+ port won\'t power it.' },
    // Axis: M, P and Q lines, from the datasheets linked on axis.com product
    // pages, October 2026. Power is the datasheet maximum, which Axis gives as
    // the PoE class limit; typical draw is far lower. Presets assume H.265;
    // Axis Zipstream is the smart codec.
    // Axis Domes
    { id: 'axis-m3085-v', vendor: 'Axis', family: 'Domes', model: 'AXIS M3085-V', label: 'AXIS M3085-V Dome Camera · 2 MP 30 fps · 4.2 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 4.2 },
    { id: 'axis-m3086-v', vendor: 'Axis', family: 'Domes', model: 'AXIS M3086-V', label: 'AXIS M3086-V Dome Camera · 4 MP 30 fps · 4.2 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 4.2 },
    { id: 'axis-m3088-v', vendor: 'Axis', family: 'Domes', model: 'AXIS M3088-V', label: 'AXIS M3088-V Dome Camera · 4K 15 fps · 4.2 W', resolution: '8MP', codec: 'h265', fps: 15, nightIR: false, poeW: 4.2 },
    { id: 'axis-m3125-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS M3125-LVE', label: 'AXIS M3125-LVE Dome Camera · 2 MP 30 fps · 10.5 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.5, note: 'Up to 60 fps.' },
    { id: 'axis-m3126-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS M3126-LVE', label: 'AXIS M3126-LVE Dome Camera · 4 MP 30 fps · 10.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.5 },
    { id: 'axis-m3128-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS M3128-LVE', label: 'AXIS M3128-LVE Dome Camera · 4K 15 fps · 10.5 W', resolution: '8MP', codec: 'h265', fps: 15, nightIR: true, poeW: 10.5 },
    { id: 'axis-m3215-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS M3215-LVE', label: 'AXIS M3215-LVE Dome Camera · 2 MP 30 fps · 10.4 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.4 },
    { id: 'axis-m3216-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS M3216-LVE', label: 'AXIS M3216-LVE Dome Camera · 4 MP 30 fps · 10.8 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.8 },
    { id: 'axis-m4215-lv', vendor: 'Axis', family: 'Domes', model: 'AXIS M4215-LV', label: 'AXIS M4215-LV Dome Camera · 2 MP 30 fps · 9.5 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.5 },
    { id: 'axis-m4216-lv', vendor: 'Axis', family: 'Domes', model: 'AXIS M4216-LV', label: 'AXIS M4216-LV Dome Camera · 2304×1728 30 fps · 9.7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.7 },
    { id: 'axis-m4218-lv', vendor: 'Axis', family: 'Domes', model: 'AXIS M4218-LV', label: 'AXIS M4218-LV Dome Camera · 4K 15 fps · 9.7 W', resolution: '8MP', codec: 'h265', fps: 15, nightIR: true, poeW: 9.7 },
    { id: 'axis-m4225-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS M4225-LVE', label: 'AXIS M4225-LVE Dome Camera · 2 MP 30 fps · 10.5 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.5 },
    { id: 'axis-m4227-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS M4227-LVE', label: 'AXIS M4227-LVE Dome Camera · 4 MP 30 fps · 12.3 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.3 },
    { id: 'axis-m4228-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS M4228-LVE', label: 'AXIS M4228-LVE Dome Camera · 4K 30 fps · 12.9 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.9 },
    { id: 'axis-p3268-slve', vendor: 'Axis', family: 'Domes', model: 'AXIS P3268-SLVE', label: 'AXIS P3268-SLVE Dome Camera · 4K 30 fps · 11.2 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.2 },
    { id: 'axis-p3275-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS P3275-LVE', label: 'AXIS P3275-LVE Dome Camera · 2 MP 30 fps · 10 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, note: 'Up to 60 fps.' },
    { id: 'axis-p3277-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS P3277-LVE', label: 'AXIS P3277-LVE Dome Camera · 5 MP 30 fps · 12.6 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.6 },
    { id: 'axis-p3278-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS P3278-LVE', label: 'AXIS P3278-LVE Dome Camera · 4K 30 fps · 12.9 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.9 },
    { id: 'axis-p3285-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS P3285-LVE', label: 'AXIS P3285-LVE Dome Camera · 2 MP 30 fps · 10 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10, note: 'Up to 60 fps.' },
    { id: 'axis-p3287-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS P3287-LVE', label: 'AXIS P3287-LVE Dome Camera · 5 MP 30 fps · 12.6 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.6 },
    { id: 'axis-p3288-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS P3288-LVE', label: 'AXIS P3288-LVE Dome Camera · 4K 30 fps · 12.9 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.9 },
    { id: 'axis-q3538-slve', vendor: 'Axis', family: 'Domes', model: 'AXIS Q3538-SLVE', label: 'AXIS Q3538-SLVE Dome Camera · 4K 30 fps · 23 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 23 },
    { id: 'axis-q3546-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS Q3546-LVE', label: 'AXIS Q3546-LVE Dome Camera · 4 MP 30 fps · 25.5 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5 },
    { id: 'axis-q3548-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS Q3548-LVE', label: 'AXIS Q3548-LVE Dome Camera · 4K 30 fps · 25.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5 },
    { id: 'axis-q3556-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS Q3556-LVE', label: 'AXIS Q3556-LVE Dome Camera · 4 MP 30 fps · 25.5 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5 },
    { id: 'axis-q3558-lve', vendor: 'Axis', family: 'Domes', model: 'AXIS Q3558-LVE', label: 'AXIS Q3558-LVE Dome Camera · 4K 30 fps · 25.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5 },
    { id: 'axis-q3626-ve', vendor: 'Axis', family: 'Domes', model: 'AXIS Q3626-VE', label: 'AXIS Q3626-VE Dome Camera · 4 MP 30 fps · 25 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 25 },
    { id: 'axis-q3628-ve', vendor: 'Axis', family: 'Domes', model: 'AXIS Q3628-VE', label: 'AXIS Q3628-VE Dome Camera · 4K 30 fps · 25 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: false, poeW: 25 },
    // Axis Bullets
    { id: 'axis-m2035-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS M2035-LE', label: 'AXIS M2035-LE Bullet Camera · 2 MP 30 fps · 12.95 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'axis-m2036-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS M2036-LE', label: 'AXIS M2036-LE Bullet Camera · 4 MP 30 fps · 12.95 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'axis-m2048-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS M2048-LE', label: 'AXIS M2048-LE Bullet Camera · 4K 15 fps · 12.95 W', resolution: '8MP', codec: 'h265', fps: 15, nightIR: true, poeW: 12.95 },
    { id: 'axis-p1475-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS P1475-LE', label: 'AXIS P1475-LE Bullet Camera · 2 MP 30 fps · 12.95 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95, note: 'Up to 60 fps.' },
    { id: 'axis-p1485-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS P1485-LE', label: 'AXIS P1485-LE Bullet Camera · 2 MP 30 fps · 12.95 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95, note: 'Up to 60 fps.' },
    { id: 'axis-p1487-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS P1487-LE', label: 'AXIS P1487-LE Bullet Camera · 5 MP 30 fps · 12.95 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'axis-p1488-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS P1488-LE', label: 'AXIS P1488-LE Bullet Camera · 4K 30 fps · 12.95 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'axis-q1800-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS Q1800-LE', label: 'AXIS Q1800-LE License Plate Camera · 2 MP 30 fps · 25.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5, scene: 'high', note: 'Licence plate camera.' },
    { id: 'axis-q1805-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS Q1805-LE', label: 'AXIS Q1805-LE Bullet Camera · 2 MP 30 fps · 51 W (PoE++)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 51 },
    { id: 'axis-q1806-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS Q1806-LE', label: 'AXIS Q1806-LE Bullet Camera · 2880×1620 30 fps · 51 W (PoE++)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 51 },
    { id: 'axis-q1808-le', vendor: 'Axis', family: 'Bullets', model: 'AXIS Q1808-LE', label: 'AXIS Q1808-LE Bullet Camera · 4K 30 fps · 51 W (PoE++)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 51, note: 'Up to 60 fps. IR plus white LED.' },
    // Axis Box & block
    { id: 'axis-m1055-l', vendor: 'Axis', family: 'Box & block', model: 'AXIS M1055-L', label: 'AXIS M1055-L Box Camera · 2 MP 30 fps · 4.3 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 4.3 },
    { id: 'axis-m1075-l-mk-ii', vendor: 'Axis', family: 'Box & block', model: 'AXIS M1075-L Mk II', label: 'AXIS M1075-L Mk II Box Camera · 2 MP 30 fps · 12.95 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'axis-m1135-e-mk-ii', vendor: 'Axis', family: 'Box & block', model: 'AXIS M1135-E Mk II', label: 'AXIS M1135-E Mk II Box Camera · 2 MP 30 fps · 7.2 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 7.2 },
    { id: 'axis-m1137-e-mk-ii', vendor: 'Axis', family: 'Box & block', model: 'AXIS M1137-E Mk II', label: 'AXIS M1137-E Mk II Box Camera · 5 MP 30 fps · 7.2 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: false, poeW: 7.2 },
    { id: 'axis-p1385-e', vendor: 'Axis', family: 'Box & block', model: 'AXIS P1385-E', label: 'AXIS P1385-E Box Camera · 2 MP 30 fps · 25.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 25.5, note: 'Up to 60 fps.' },
    { id: 'axis-p1387-le', vendor: 'Axis', family: 'Box & block', model: 'AXIS P1387-LE', label: 'AXIS P1387-LE Box Camera · 5 MP 30 fps · 25.5 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5 },
    { id: 'axis-p1388-le', vendor: 'Axis', family: 'Box & block', model: 'AXIS P1388-LE', label: 'AXIS P1388-LE Box Camera · 4K 30 fps · 25.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5 },
    { id: 'axis-p1518-le', vendor: 'Axis', family: 'Box & block', model: 'AXIS P1518-LE', label: 'AXIS P1518-LE Box Camera · 4K 30 fps · 25.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5, note: 'Dual-sensor: this row is the 4K sensor; add a 2 MP row (no PoE) for the second sensor.' },
    { id: 'axis-q1656-le', vendor: 'Axis', family: 'Box & block', model: 'AXIS Q1656-LE', label: 'AXIS Q1656-LE Box Camera · 4 MP 30 fps · 25.5 W (PoE+)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5, note: 'Up to 60 fps. IR plus white LED.' },
    { id: 'axis-q1715', vendor: 'Axis', family: 'Box & block', model: 'AXIS Q1715', label: 'AXIS Q1715 Block Camera · 2 MP 30 fps · 14.2 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 14.2, note: 'Up to 60 fps.' },
    { id: 'axis-q1728-le', vendor: 'Axis', family: 'Box & block', model: 'AXIS Q1728-LE', label: 'AXIS Q1728-LE Block Camera · 4K 30 fps · 25.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5 },
    // Axis Panoramic & multi-sensor
    { id: 'axis-m3077-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M3077-PLVE', label: 'AXIS M3077-PLVE Fisheye Camera · 2016×2016 30 fps · 11.9 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.9, note: 'Up to 60 fps.' },
    { id: 'axis-m4308-ple', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M4308-PLE', label: 'AXIS M4308-PLE Panoramic Camera · 2880×2880 30 fps · 15.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 15.5 },
    { id: 'axis-m4317-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M4317-PLVE', label: 'AXIS M4317-PLVE Panoramic Camera · 2160×2160 30 fps · 12.95 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95, note: 'Up to 60 fps.' },
    { id: 'axis-m4318-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M4318-PLVE', label: 'AXIS M4318-PLVE Panoramic Camera · 2992×2992 30 fps · 12.95 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'axis-m4327-p', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M4327-P', label: 'AXIS M4327-P Panoramic Camera · 2160×2160 30 fps · 5.1 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: false, poeW: 5.1, note: 'Up to 60 fps.' },
    { id: 'axis-m4328-p', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M4328-P', label: 'AXIS M4328-P Panoramic Camera · 2992×2992 30 fps · 5.1 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: false, poeW: 5.1 },
    { id: 'axis-m4337-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M4337-PLVE', label: 'AXIS M4337-PLVE Panoramic Camera · 2464×2464 30 fps · 16.7 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.7, note: 'Up to 60 fps.' },
    { id: 'axis-m4338-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M4338-PLVE', label: 'AXIS M4338-PLVE Panoramic Camera · 3536×3536 30 fps · 16.7 W (PoE+)', resolution: '12MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.7 },
    { id: 'axis-m4347-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M4347-PLVE', label: 'AXIS M4347-PLVE Panoramic Camera · 2464×2464 30 fps · 16.7 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.7, note: 'Up to 60 fps.' },
    { id: 'axis-m4348-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS M4348-PLVE', label: 'AXIS M4348-PLVE Panoramic Camera · 3536×3536 30 fps · 16.7 W (PoE+)', resolution: '12MP', codec: 'h265', fps: 30, nightIR: true, poeW: 16.7 },
    { id: 'axis-p3735-ple', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P3735-PLE', label: 'AXIS P3735-PLE Panoramic Camera · 2 MP 30 fps · 23.15 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 5.79, note: 'One row per sensor: enter 4 cameras per unit (23.15 W per unit).' },
    { id: 'axis-p3737-ple', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P3737-PLE', label: 'AXIS P3737-PLE Panoramic Camera · 5 MP 20 fps · 23.3 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 20, nightIR: true, poeW: 5.83, note: 'One row per sensor: enter 4 cameras per unit (23.3 W per unit).' },
    { id: 'axis-p3738-ple', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P3738-PLE', label: 'AXIS P3738-PLE Panoramic Camera · 4K 15 fps · 25.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 15, nightIR: true, poeW: 6.38, note: 'One row per sensor: enter 4 cameras per unit (25.5 W per unit).' },
    { id: 'axis-p3747-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P3747-PLVE', label: 'AXIS P3747-PLVE Panoramic Camera · 5 MP 20 fps · 23.7 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 20, nightIR: true, poeW: 5.92, note: 'One row per sensor: enter 4 cameras per unit (23.7 W per unit).' },
    { id: 'axis-p3748-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P3748-PLVE', label: 'AXIS P3748-PLVE Panoramic Camera · 4K 15 fps · 23.6 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 15, nightIR: true, poeW: 5.9, note: 'One row per sensor: enter 4 cameras per unit (23.6 W per unit).' },
    { id: 'axis-p3818-pve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P3818-PVE', label: 'AXIS P3818-PVE Panoramic Camera · 5120×2560 30 fps · 18 W (PoE+)', resolution: '12MP', codec: 'h265', fps: 30, nightIR: false, poeW: 18, note: '3 sensors stitched into one 5120×2560 stream.' },
    { id: 'axis-p3827-pve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P3827-PVE', label: 'AXIS P3827-PVE Panoramic Camera · 3712×1856 30 fps · 18 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: false, poeW: 18, note: '4 sensors stitched into one 3712×1856 stream.' },
    { id: 'axis-p4705-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P4705-PLVE', label: 'AXIS P4705-PLVE Panoramic Camera · 2 MP 30 fps · 17.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.75, note: 'One row per sensor: enter 2 cameras per unit (17.5 W per unit). Up to 60 fps.' },
    { id: 'axis-p4707-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P4707-PLVE', label: 'AXIS P4707-PLVE Panoramic Camera · 5 MP 30 fps · 17.5 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.75, note: 'One row per sensor: enter 2 cameras per unit (17.5 W per unit).' },
    { id: 'axis-p4708-plve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS P4708-PLVE', label: 'AXIS P4708-PLVE Panoramic Camera · 4K 30 fps · 18.8 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.4, note: 'One row per sensor: enter 2 cameras per unit (18.8 W per unit).' },
    { id: 'axis-q3839-pve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS Q3839-PVE', label: 'AXIS Q3839-PVE Panoramic Camera · 7552×3776 30 fps · 19.1 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: false, poeW: 4.78, note: '4 sensors stitched into 7552×3776; sized per sensor: enter 4 cameras per unit (19.1 W per unit).' },
    { id: 'axis-q4809-pve', vendor: 'Axis', family: 'Panoramic & multi-sensor', model: 'AXIS Q4809-PVE', label: 'AXIS Q4809-PVE Panoramic Camera · 10240×2560 30 fps · 19.1 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: false, poeW: 4.78, note: '4 sensors stitched into 10240×2560; sized per sensor: enter 4 cameras per unit (19.1 W per unit).' },
    // Axis PTZ & speed domes
    { id: 'axis-m5075', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS M5075', label: 'AXIS M5075 PTZ Camera · 2 MP 30 fps · 9.3 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 9.3, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'axis-m5526-e', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS M5526-E', label: 'AXIS M5526-E PTZ Camera · 4 MP 30 fps · 12.95 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 12.95, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'axis-p5654-e-mk-ii', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS P5654-E Mk II', label: 'AXIS P5654-E Mk II PTZ Camera · 2 MP 30 fps · 16 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 16, scene: 'high', note: 'Up to 60 fps. Datasheet gives consumption via a PoE+ midspan.' },
    { id: 'axis-p5655-e', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS P5655-E', label: 'AXIS P5655-E PTZ Network Camera · 2 MP 30 fps · 19 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 19, scene: 'high', note: 'Up to 60 fps. Datasheet gives consumption via a PoE+ midspan.' },
    { id: 'axis-p5676-le', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS P5676-LE', label: 'AXIS P5676-LE PTZ Camera · 4 MP 30 fps · 29 W (PoE++)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 29, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'axis-q6086-e', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS Q6086-E', label: 'AXIS Q6086-E PTZ Camera · 4 MP 30 fps · 51 W (PoE++)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 51, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'axis-q6088-e', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS Q6088-E', label: 'AXIS Q6088-E PTZ Camera · 4K 30 fps · 51 W (PoE++)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: false, poeW: 51, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'axis-q6225-le', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS Q6225-LE', label: 'AXIS Q6225-LE PTZ Camera · 2 MP 30 fps · 71 W (PoE++ 90 W)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 71, scene: 'high', note: 'Up to 60 fps. Draws 71 W: needs an 802.3bt Type 4 (90 W) port or midspan.' },
    { id: 'axis-q6325-le', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS Q6325-LE', label: 'AXIS Q6325-LE PTZ Camera · 2 MP 30 fps · 51 W (PoE++)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 51, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'axis-q6355-le', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS Q6355-LE', label: 'AXIS Q6355-LE PTZ Camera · 2 MP 30 fps · 51 W (PoE++)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 51, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'axis-q6358-le', vendor: 'Axis', family: 'PTZ & speed domes', model: 'AXIS Q6358-LE', label: 'AXIS Q6358-LE PTZ Camera · 4K 30 fps · 51 W (PoE++)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 51, scene: 'high', note: 'Up to 60 fps.' },
    // Hanwha Vision (Wisenet): Q, X, P and A series, multi-directional, fisheye
    // and PTZ, from the spec tables on hanwhavision.com product pages, October
    // 2026. Power is the PoE maximum. Presets assume H.265; WiseStream is the
    // smart codec.
    // Hanwha Domes
    { id: 'hanwha-anv-l6082r', vendor: 'Hanwha', family: 'Domes', model: 'ANV-L6082R', label: 'IR Outdoor Dome ANV-L6082R · 2 MP 30 fps · 7 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7 },
    { id: 'hanwha-anv-l7082r', vendor: 'Hanwha', family: 'Domes', model: 'ANV-L7082R', label: 'IR Outdoor Vandal Dome ANV-L7082R · 4 MP 30 fps · 8 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8 },
    { id: 'hanwha-pnd-a6081rv', vendor: 'Hanwha', family: 'Domes', model: 'PND-A6081RV', label: 'AI IR Dome PND-A6081RV · 2 MP 30 fps · 19.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 19.5, note: 'Up to 120 fps with AI off, 60 fps with AI on.' },
    { id: 'hanwha-pnd-a9081rv', vendor: 'Hanwha', family: 'Domes', model: 'PND-A9081RV', label: 'AI IR Dome PND-A9081RV · 4K 30 fps · 20 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 20 },
    { id: 'hanwha-pnv-a6081r', vendor: 'Hanwha', family: 'Domes', model: 'PNV-A6081R', label: 'AI IR Vandal Dome PNV-A6081R · 2 MP 30 fps · 19.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 19.5, note: 'Up to 120 fps with AI off, 60 fps with AI on.' },
    { id: 'hanwha-pnv-a9081r', vendor: 'Hanwha', family: 'Domes', model: 'PNV-A9081R', label: 'AI IR Vandal Dome PNV-A9081R · 4K 30 fps · 20 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 20 },
    { id: 'hanwha-qnd-6012r', vendor: 'Hanwha', family: 'Domes', model: 'QND-6012R', label: 'IR Dome QND-6012R · 2 MP 30 fps · 7.4 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.4 },
    { id: 'hanwha-qnd-6082r', vendor: 'Hanwha', family: 'Domes', model: 'QND-6082R', label: 'IR Dome QND-6082R · 2 MP 30 fps · 7.7 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.7 },
    { id: 'hanwha-qnd-7012r', vendor: 'Hanwha', family: 'Domes', model: 'QND-7012R', label: 'IR Dome QND-7012R · 4 MP 30 fps · 7.9 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.9 },
    { id: 'hanwha-qnd-7082r', vendor: 'Hanwha', family: 'Domes', model: 'QND-7082R', label: 'IR Dome QND-7082R · 4 MP 30 fps · 8.6 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.6 },
    { id: 'hanwha-qnd-8010r', vendor: 'Hanwha', family: 'Domes', model: 'QND-8010R', label: 'IR Dome QND-8010R · 5 MP 30 fps · 7.5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.5 },
    { id: 'hanwha-qnd-8020r', vendor: 'Hanwha', family: 'Domes', model: 'QND-8020R', label: 'IR Dome QND-8020R · 5 MP 30 fps · 6.8 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 6.8 },
    { id: 'hanwha-qnv-6012r', vendor: 'Hanwha', family: 'Domes', model: 'QNV-6012R', label: 'IR Dome QNV-6012R · 2 MP 30 fps · 7.4 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.4 },
    { id: 'hanwha-qnv-6082r', vendor: 'Hanwha', family: 'Domes', model: 'QNV-6082R', label: 'IR Dome QNV-6082R · 2 MP 30 fps · 7.7 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.7 },
    { id: 'hanwha-qnv-7012r', vendor: 'Hanwha', family: 'Domes', model: 'QNV-7012R', label: 'IR Vandal Dome QNV-7012R · 4 MP 30 fps · 10.7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.7 },
    { id: 'hanwha-qnv-7082r', vendor: 'Hanwha', family: 'Domes', model: 'QNV-7082R', label: 'IR Vandal Dome QNV-7082R · 4 MP 30 fps · 11.4 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.4 },
    { id: 'hanwha-qnv-8010r', vendor: 'Hanwha', family: 'Domes', model: 'QNV-8010R', label: 'IR Dome QNV-8010R · 5 MP 30 fps · 7.5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.5 },
    { id: 'hanwha-qnv-8020r', vendor: 'Hanwha', family: 'Domes', model: 'QNV-8020R', label: 'IR Dome QNV-8020R · 5 MP 30 fps · 7.2 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.2 },
    { id: 'hanwha-qnv-8080r', vendor: 'Hanwha', family: 'Domes', model: 'QNV-8080R', label: 'IR Dome QNV-8080R · 5 MP 30 fps · 8.9 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 8.9 },
    { id: 'hanwha-xnd-6081rv', vendor: 'Hanwha', family: 'Domes', model: 'XND-6081RV', label: 'IR Dome XND-6081RV · 2 MP 30 fps · 12.95 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95, note: 'Up to 60 fps.' },
    { id: 'hanwha-xnd-6083rv', vendor: 'Hanwha', family: 'Domes', model: 'XND-6083RV', label: 'AI IR Dome XND-6083RV · 2 MP 30 fps · 22.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.5, note: 'Up to 120 fps with WDR off, 60 fps with WDR on.' },
    { id: 'hanwha-xnd-8082rf', vendor: 'Hanwha', family: 'Domes', model: 'XND-8082RF', label: 'IR Dome XND-8082RF · 3328×1872 30 fps · 12.95 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'hanwha-xnd-8083rv', vendor: 'Hanwha', family: 'Domes', model: 'XND-8083RV', label: 'AI IR Dome XND-8083RV · 3328×1872 30 fps · 22.5 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.5 },
    { id: 'hanwha-xnd-9083rv', vendor: 'Hanwha', family: 'Domes', model: 'XND-9083RV', label: 'AI IR Dome XND-9083RV · 4K 30 fps · 22.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.5 },
    { id: 'hanwha-xnd-a6084rv', vendor: 'Hanwha', family: 'Domes', model: 'XND-A6084RV', label: 'AI IR Dome XND-A6084RV · 2 MP 30 fps · 10.2 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.2, note: 'Up to 60 fps.' },
    { id: 'hanwha-xnd-a8084rv', vendor: 'Hanwha', family: 'Domes', model: 'XND-A8084RV', label: 'AI IR Dome XND-A8084RV · 2560×1920 30 fps · 9.4 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.4 },
    { id: 'hanwha-xnv-6081r', vendor: 'Hanwha', family: 'Domes', model: 'XNV-6081R', label: 'IR Dome XNV-6081R · 2 MP 30 fps · 12.95 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95, note: 'Up to 60 fps.' },
    { id: 'hanwha-xnv-6083r', vendor: 'Hanwha', family: 'Domes', model: 'XNV-6083R', label: 'AI IR Vandal Dome XNV-6083R · 2 MP 30 fps · 22.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.5, note: 'Up to 120 fps with WDR off, 60 fps with WDR on.' },
    { id: 'hanwha-xnv-8082r', vendor: 'Hanwha', family: 'Domes', model: 'XNV-8082R', label: 'IR Vandal Dome XNV-8082R · 3328×1872 30 fps · 12.95 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'hanwha-xnv-8083r', vendor: 'Hanwha', family: 'Domes', model: 'XNV-8083R', label: 'AI IR Vandal Dome XNV-8083R · 3328×1872 30 fps · 22.5 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.5 },
    { id: 'hanwha-xnv-9083r', vendor: 'Hanwha', family: 'Domes', model: 'XNV-9083R', label: 'AI IR Vandal Dome XNV-9083R · 4K 30 fps · 22.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.5 },
    { id: 'hanwha-xnv-a6084r', vendor: 'Hanwha', family: 'Domes', model: 'XNV-A6084R', label: 'AI IR Vandal Dome XNV-A6084R · 2 MP 30 fps · 10.2 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.2, note: 'Up to 60 fps.' },
    { id: 'hanwha-xnv-a8084r', vendor: 'Hanwha', family: 'Domes', model: 'XNV-A8084R', label: 'AI IR Vandal Dome XNV-A8084R · 2560×1920 30 fps · 9.4 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.4 },
    { id: 'hanwha-xnv-a9084r', vendor: 'Hanwha', family: 'Domes', model: 'XNV-A9084R', label: 'AI IR Vandal Dome XNV-A9084R · 4K 30 fps · 11.2 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.2 },
    // Hanwha Bullets
    { id: 'hanwha-ano-l6082r', vendor: 'Hanwha', family: 'Bullets', model: 'ANO-L6082R', label: 'IR Bullet ANO-L6082R · 2 MP 30 fps · 7 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7 },
    { id: 'hanwha-ano-l7022r', vendor: 'Hanwha', family: 'Bullets', model: 'ANO-L7022R', label: 'IR Bullet ANO-L7022R · 4 MP 30 fps · 7.5 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.5 },
    { id: 'hanwha-pno-a6081r', vendor: 'Hanwha', family: 'Bullets', model: 'PNO-A6081R', label: 'AI IR Bullet PNO-A6081R · 2 MP 30 fps · 19.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 19.5, note: 'Up to 120 fps with AI off, 60 fps with AI on.' },
    { id: 'hanwha-pno-a9081r', vendor: 'Hanwha', family: 'Bullets', model: 'PNO-A9081R', label: 'AI IR Bullet PNO-A9081R · 4K 30 fps · 20 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 20 },
    { id: 'hanwha-pno-a9311r', vendor: 'Hanwha', family: 'Bullets', model: 'PNO-A9311R', label: 'AI IR Bullet PNO-A9311R · 4K 30 fps · 25.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5 },
    { id: 'hanwha-qno-6012r', vendor: 'Hanwha', family: 'Bullets', model: 'QNO-6012R', label: 'IR Bullet QNO-6012R · 2 MP 30 fps · 7 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7 },
    { id: 'hanwha-qno-6082r', vendor: 'Hanwha', family: 'Bullets', model: 'QNO-6082R', label: 'IR Bullet QNO-6082R · 2 MP 30 fps · 7.4 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.4 },
    { id: 'hanwha-qno-7012r', vendor: 'Hanwha', family: 'Bullets', model: 'QNO-7012R', label: 'IR Bullet QNO-7012R · 4 MP 30 fps · 10.7 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.7 },
    { id: 'hanwha-qno-7082r', vendor: 'Hanwha', family: 'Bullets', model: 'QNO-7082R', label: 'IR Bullet QNO-7082R · 4 MP 30 fps · 11.4 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.4 },
    { id: 'hanwha-qno-8010r', vendor: 'Hanwha', family: 'Bullets', model: 'QNO-8010R', label: 'IR Bullet QNO-8010R · 5 MP 30 fps · 7.5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.5 },
    { id: 'hanwha-qno-8020r', vendor: 'Hanwha', family: 'Bullets', model: 'QNO-8020R', label: 'IR Bullet QNO-8020R · 5 MP 30 fps · 7.5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.5 },
    { id: 'hanwha-qno-8080r', vendor: 'Hanwha', family: 'Bullets', model: 'QNO-8080R', label: 'IR Bullet QNO-8080R · 5 MP 30 fps · 9.5 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.5 },
    { id: 'hanwha-xno-6083r', vendor: 'Hanwha', family: 'Bullets', model: 'XNO-6083R', label: 'AI IR Bullet XNO-6083R · 2 MP 30 fps · 22.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.5, note: 'Up to 120 fps with WDR off, 60 fps with WDR on.' },
    { id: 'hanwha-xno-6085r', vendor: 'Hanwha', family: 'Bullets', model: 'XNO-6085R', label: 'IR Bullet (extraLUX) XNO-6085R · 2 MP 30 fps · 12.95 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95, note: 'Up to 60 fps.' },
    { id: 'hanwha-xno-8082r', vendor: 'Hanwha', family: 'Bullets', model: 'XNO-8082R', label: 'IR Bullet XNO-8082R · 3328×1872 30 fps · 12.95 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'hanwha-xno-8083r', vendor: 'Hanwha', family: 'Bullets', model: 'XNO-8083R', label: 'AI IR Bullet XNO-8083R · 3328×1872 30 fps · 22.5 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.5 },
    { id: 'hanwha-xno-9083r', vendor: 'Hanwha', family: 'Bullets', model: 'XNO-9083R', label: 'AI IR Bullet XNO-9083R · 4K 30 fps · 22.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 22.5 },
    { id: 'hanwha-xno-a6084r', vendor: 'Hanwha', family: 'Bullets', model: 'XNO-A6084R', label: 'AI IR Bullet XNO-A6084R · 2 MP 30 fps · 10.2 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 10.2, note: 'Up to 60 fps.' },
    { id: 'hanwha-xno-a8084r', vendor: 'Hanwha', family: 'Bullets', model: 'XNO-A8084R', label: 'AI IR Bullet XNO-A8084R · 2560×1920 30 fps · 9.4 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 9.4 },
    { id: 'hanwha-xno-a9084r', vendor: 'Hanwha', family: 'Bullets', model: 'XNO-A9084R', label: 'AI IR Bullet XNO-A9084R · 4K 30 fps · 11.2 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.2 },
    // Hanwha Box & block
    { id: 'hanwha-pnb-a9001', vendor: 'Hanwha', family: 'Box & block', model: 'PNB-A9001', label: 'AI Box PNB-A9001 · 4K 30 fps · 16.5 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: false, poeW: 16.5, note: 'Lens not included.' },
    { id: 'hanwha-qnb-6002', vendor: 'Hanwha', family: 'Box & block', model: 'QNB-6002', label: 'Box QNB-6002 · 2 MP 30 fps · 6.4 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 6.4, note: 'Lens not included.' },
    { id: 'hanwha-qnb-8002', vendor: 'Hanwha', family: 'Box & block', model: 'QNB-8002', label: 'Box QNB-8002 · 5 MP 30 fps · 6.4 W', resolution: '5MP', codec: 'h265', fps: 30, nightIR: false, poeW: 6.4, note: 'Lens not included.' },
    { id: 'hanwha-xnb-6003', vendor: 'Hanwha', family: 'Box & block', model: 'XNB-6003', label: 'AI Box XNB-6003 · 2 MP 30 fps · 12.95 W', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 12.95, note: 'Up to 120 fps with WDR off, 60 fps with WDR on. Lens not included.' },
    { id: 'hanwha-xnb-8003', vendor: 'Hanwha', family: 'Box & block', model: 'XNB-8003', label: 'AI Box XNB-8003 · 3328×1872 30 fps · 12.95 W', resolution: '6MP', codec: 'h265', fps: 30, nightIR: false, poeW: 12.95, note: 'Lens not included.' },
    { id: 'hanwha-xnb-9003', vendor: 'Hanwha', family: 'Box & block', model: 'XNB-9003', label: 'AI Box XNB-9003 · 4K 30 fps · 12.95 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: false, poeW: 12.95, note: 'Lens not included.' },
    // Hanwha Panoramic & multi-sensor
    { id: 'hanwha-pnm-9031rv', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'PNM-9031RV', label: 'Panoramic PNM-9031RV · 6720×2240 20 fps · 23.5 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 20, nightIR: true, poeW: 7.83, note: '3 sensors stitched into 6720×2240; sized per sensor: enter 3 cameras per unit (23.5 W per unit).' },
    { id: 'hanwha-pnm-9084qz1', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'PNM-9084QZ1', label: '4-channel PTRZ Multi-directional PNM-9084QZ1 · 2 MP 30 fps · 33 W (PoE++)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 8.25, note: 'One row per sensor: enter 4 cameras per unit (33 W per unit). Up to 60 fps.' },
    { id: 'hanwha-pnm-9085rqz1', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'PNM-9085RQZ1', label: '4-channel IR PTRZ Multi-directional PNM-9085RQZ1 · 2560×1920 30 fps · 45 W (PoE++)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: true, poeW: 11.25, note: 'One row per sensor: enter 4 cameras per unit (45 W per unit).' },
    { id: 'hanwha-pnm-9322vqp', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'PNM-9322VQP', label: '4-channel + PTZ Multi-directional PNM-9322VQP · 5 MP 30 fps · 65 W (PoE++)', resolution: '5MP', codec: 'h265', fps: 30, nightIR: false, poeW: 13, note: '4 fixed sensors plus a 2 MP PTZ: enter 4 cameras per unit and add a 2 MP PTZ row; power is split over the 5 rows (65 W per unit).' },
    { id: 'hanwha-pnm-c12083rvd', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'PNM-C12083RVD', label: '2-channel AI Multi-directional PNM-C12083RVD · 3328×1872 15 fps · 21 W (PoE+)', resolution: '6MP', codec: 'h265', fps: 15, nightIR: true, poeW: 10.5, note: 'One row per sensor: enter 2 cameras per unit (21 W per unit).' },
    { id: 'hanwha-pnm-c16083rvq', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'PNM-C16083RVQ', label: '4-channel AI Multi-directional PNM-C16083RVQ · 2592×1520 30 fps · 30 W (PoE++)', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 7.5, note: 'One row per sensor: enter 4 cameras per unit (30 W per unit).' },
    { id: 'hanwha-pnm-c34404rqpz', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'PNM-C34404RQPZ', label: '4-channel 4K PTRZ + 40x PTZ AI PNM-C34404RQPZ · 4K 15 fps · 64 W (PoE++)', resolution: '8MP', codec: 'h265', fps: 15, nightIR: true, poeW: 12.8, note: '4 fixed sensors plus a 2 MP PTZ: enter 4 cameras per unit and add a 2 MP PTZ row; power is split over the 5 rows (64 W per unit).' },
    { id: 'hanwha-qnf-8010', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'QNF-8010', label: 'Fisheye QNF-8010 · 2048×2048 30 fps · 6.4 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: false, poeW: 6.4 },
    { id: 'hanwha-qnf-9010', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'QNF-9010', label: 'Fisheye QNF-9010 · 3008×3008 30 fps · 7.7 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: false, poeW: 7.7 },
    { id: 'hanwha-xnf-8010rv', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'XNF-8010RV', label: 'Fisheye XNF-8010RV · 2048×2048 30 fps · 12.95 W', resolution: '4MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'hanwha-xnf-9010rv', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'XNF-9010RV', label: 'IR Fisheye XNF-9010RV · 3584×2688 30 fps · 12.95 W', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 12.95 },
    { id: 'hanwha-xnf-a9014rv', vendor: 'Hanwha', family: 'Panoramic & multi-sensor', model: 'XNF-A9014RV', label: 'AI IR Fisheye XNF-A9014RV · 3584×2688 30 fps · 19.8 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 19.8 },
    // Hanwha PTZ & speed domes
    { id: 'hanwha-qnp-6230', vendor: 'Hanwha', family: 'PTZ & speed domes', model: 'QNP-6230', label: '23x PTZ QNP-6230 · 2 MP 30 fps · 20 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: false, poeW: 20, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'hanwha-qnp-6250r', vendor: 'Hanwha', family: 'PTZ & speed domes', model: 'QNP-6250R', label: '25x IR PTZ QNP-6250R · 2 MP 30 fps · 25.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'hanwha-qnp-6320r', vendor: 'Hanwha', family: 'PTZ & speed domes', model: 'QNP-6320R', label: '32x IR PTZ QNP-6320R · 2 MP 30 fps · 25.5 W (PoE+)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 25.5, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'hanwha-xnp-6400rw', vendor: 'Hanwha', family: 'PTZ & speed domes', model: 'XNP-6400RW', label: '40x IR PTZ with built-in wiper XNP-6400RW · 2 MP 30 fps · 42 W (PoE++)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 42, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'hanwha-xnp-8250r', vendor: 'Hanwha', family: 'PTZ & speed domes', model: 'XNP-8250R', label: '25x IR PTZ XNP-8250R · 3328×1872 30 fps · 40 W (PoE++)', resolution: '6MP', codec: 'h265', fps: 30, nightIR: true, poeW: 40, scene: 'high' },
    { id: 'hanwha-xnp-9250r', vendor: 'Hanwha', family: 'PTZ & speed domes', model: 'XNP-9250R', label: '25x IR PTZ XNP-9250R · 4K 30 fps · 40 W (PoE++)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 40, scene: 'high' },
    { id: 'hanwha-xnp-a6374rh', vendor: 'Hanwha', family: 'PTZ & speed domes', model: 'XNP-A6374RH', label: '37x AI IR PTZ XNP-A6374RH · 2 MP 30 fps · 51 W (PoE++)', resolution: '2MP', codec: 'h265', fps: 30, nightIR: true, poeW: 51, scene: 'high', note: 'Up to 60 fps.' },
    { id: 'hanwha-xnp-a9314r', vendor: 'Hanwha', family: 'PTZ & speed domes', model: 'XNP-A9314R', label: '31x AI IR PTZ XNP-A9314R · 4K 30 fps · 51 W (PoE++)', resolution: '8MP', codec: 'h265', fps: 30, nightIR: true, poeW: 51, scene: 'high' },
    // Reolink: current PoE cameras, from the spec tables on reolink.com product
    // pages, October 2026. Reolink gives one power limit for DC and PoE
    // (e.g. "<12W"), used here as the maximum.
    // Reolink Domes
    { id: 'reolink-cx820', vendor: 'Reolink', family: 'Domes', model: 'CX820', label: 'CX820 ColorX Dome · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: false, poeW: 12, note: 'ColorX: spotlights, no IR.' },
    { id: 'reolink-rlc-1240a', vendor: 'Reolink', family: 'Domes', model: 'RLC-1240A', label: 'RLC-1240A Dome · 4512×2512 20 fps · 12 W', resolution: '12MP', codec: 'h265', fps: 20, nightIR: true, poeW: 12, note: 'IR plus spotlights.' },
    { id: 'reolink-rlc-520a', vendor: 'Reolink', family: 'Domes', model: 'RLC-520A', label: 'RLC-520A Dome · 2560×1920 25 fps · 12 W', resolution: '5MP', codec: 'h264', fps: 25, nightIR: true, poeW: 12, note: 'H.264 only.' },
    { id: 'reolink-rlc-820a', vendor: 'Reolink', family: 'Domes', model: 'RLC-820A', label: 'RLC-820A Dome · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12 },
    { id: 'reolink-rlc-840a', vendor: 'Reolink', family: 'Domes', model: 'RLC-840A', label: 'RLC-840A Dome · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12, note: 'IR plus spotlights.' },
    { id: 'reolink-rlc-843a', vendor: 'Reolink', family: 'Domes', model: 'RLC-843A', label: 'RLC-843A Dome · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12, note: 'IR plus spotlights.' },
    // Reolink Bullets
    { id: 'reolink-cx410', vendor: 'Reolink', family: 'Bullets', model: 'CX410', label: 'CX410 ColorX Bullet · 4 MP 25 fps · 12 W', resolution: '4MP', codec: 'h264', fps: 25, nightIR: false, poeW: 12, note: 'ColorX: spotlights, no IR. H.264 only.' },
    { id: 'reolink-cx810', vendor: 'Reolink', family: 'Bullets', model: 'CX810', label: 'CX810 ColorX Bullet · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: false, poeW: 12, note: 'ColorX: spotlights, no IR.' },
    { id: 'reolink-rlc-1212a', vendor: 'Reolink', family: 'Bullets', model: 'RLC-1212A', label: 'RLC-1212A Bullet · 4512×2512 20 fps · 12 W', resolution: '12MP', codec: 'h265', fps: 20, nightIR: true, poeW: 12, note: 'IR plus spotlights.' },
    { id: 'reolink-rlc-1224a', vendor: 'Reolink', family: 'Bullets', model: 'RLC-1224A', label: 'RLC-1224A Bullet · 4512×2512 20 fps · 12 W', resolution: '12MP', codec: 'h265', fps: 20, nightIR: true, poeW: 12, note: 'IR plus spotlights.' },
    { id: 'reolink-rlc-510a', vendor: 'Reolink', family: 'Bullets', model: 'RLC-510A', label: 'RLC-510A Bullet · 2560×1920 25 fps · 12 W', resolution: '5MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12 },
    { id: 'reolink-rlc-810a', vendor: 'Reolink', family: 'Bullets', model: 'RLC-810A', label: 'RLC-810A Bullet · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12 },
    { id: 'reolink-rlc-811a', vendor: 'Reolink', family: 'Bullets', model: 'RLC-811A', label: 'RLC-811A Bullet · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12, note: 'IR plus spotlights.' },
    { id: 'reolink-rlc-833a', vendor: 'Reolink', family: 'Bullets', model: 'RLC-833A', label: 'RLC-833A Bullet · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12, note: 'IR plus spotlights.' },
    // Reolink Panoramic & multi-sensor
    { id: 'reolink-fe-p', vendor: 'Reolink', family: 'Panoramic & multi-sensor', model: 'FE-P', label: 'FE-P Fisheye · 2560×2560 25 fps · 12 W', resolution: '6MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12 },
    { id: 'reolink-omvi-3i-poe', vendor: 'Reolink', family: 'Panoramic & multi-sensor', model: 'OMVI 3i PoE', label: 'OMVI 3i PoE Multi-lens · 5120×1920 20 fps · 24 W (PoE+)', resolution: '5MP', codec: 'h265', fps: 20, nightIR: true, poeW: 8, note: 'Triple lens: enter 2 cameras per unit for the stitched 5120×1920 upper view and add a 4K row for the pan-tilt lens; power is split over the 3 rows (24 W per unit). IR plus spotlights.' },
    { id: 'reolink-duo-2v-poe', vendor: 'Reolink', family: 'Panoramic & multi-sensor', model: 'Duo 2V PoE', label: 'Duo 2V PoE Dual-lens panoramic · 5120×1552 20 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 12, note: '2 sensors stitched into one 5120×1552 stream. IR plus spotlights.' },
    { id: 'reolink-duo-3-poe', vendor: 'Reolink', family: 'Panoramic & multi-sensor', model: 'Duo 3 PoE', label: 'Duo 3 PoE Dual-lens panoramic · 7680×2160 20 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 6, note: '2 sensors stitched into 7680×2160; sized per sensor: enter 2 cameras per unit (12 W per unit). IR plus spotlights.' },
    { id: 'reolink-duo-3v-poe', vendor: 'Reolink', family: 'Panoramic & multi-sensor', model: 'Duo 3V PoE', label: 'Duo 3V PoE Dual-lens panoramic · 7680×2160 20 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 6, note: '2 sensors stitched into 7680×2160; sized per sensor: enter 2 cameras per unit (12 W per unit). IR plus spotlights.' },
    { id: 'reolink-duo-2-poe', vendor: 'Reolink', family: 'Panoramic & multi-sensor', model: 'Duo 2 PoE', label: 'Duo 2 PoE Dual-lens panoramic · 4608×1728 20 fps · 15 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 15, note: '2 sensors stitched into one 4608×1728 stream. IR plus spotlights.' },
    { id: 'reolink-omvi-2i-poe', vendor: 'Reolink', family: 'Panoramic & multi-sensor', model: 'OMVI 2i PoE', label: 'OMVI 2i PoE Multi-lens · 2880×1616 20 fps · 12 W', resolution: '5MP', codec: 'h265', fps: 20, nightIR: true, poeW: 6, note: 'One row per lens: enter 2 cameras per unit (12 W per unit). IR plus spotlights.' },
    { id: 'reolink-rlc-81ma', vendor: 'Reolink', family: 'Panoramic & multi-sensor', model: 'RLC-81MA', label: 'RLC-81MA Multi-lens · 4K 20 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 20, nightIR: true, poeW: 12, note: 'Dual lens: this row is the wide lens; add a row (no PoE) for the telephoto lens. IR plus spotlights.' },
    // Reolink PTZ & speed domes
    { id: 'reolink-e1-outdoor-se-poe', vendor: 'Reolink', family: 'PTZ & speed domes', model: 'E1 Outdoor SE PoE', label: 'E1 Outdoor SE PoE PTZ · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12, scene: 'high', note: 'IR plus spotlights.' },
    { id: 'reolink-trackmix-poe', vendor: 'Reolink', family: 'PTZ & speed domes', model: 'TrackMix PoE', label: 'TrackMix PoE PTZ · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12, scene: 'high', note: 'Dual lens: this row is the wide lens; add a row (no PoE) for the telephoto lens. IR plus spotlights.' },
    { id: 'reolink-rlc-81pa', vendor: 'Reolink', family: 'PTZ & speed domes', model: 'RLC-81PA', label: 'RLC-81PA PTZ · 4K 25 fps · 12 W', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 12, scene: 'high', note: 'IR plus spotlights.' },
    { id: 'reolink-rlc-823a', vendor: 'Reolink', family: 'PTZ & speed domes', model: 'RLC-823A', label: 'RLC-823A PTZ · 4K 25 fps · 24 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 24, scene: 'high', note: 'IR plus spotlights.' },
    { id: 'reolink-rlc-823a-16x', vendor: 'Reolink', family: 'PTZ & speed domes', model: 'RLC-823A 16X', label: 'RLC-823A 16X PTZ · 4K 25 fps · 24 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 24, scene: 'high' },
    { id: 'reolink-rlc-823s1', vendor: 'Reolink', family: 'PTZ & speed domes', model: 'RLC-823S1', label: 'RLC-823S1 PTZ · 4K 25 fps · 24 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 24, scene: 'high', note: 'IR plus spotlights.' },
    { id: 'reolink-rlc-823s2', vendor: 'Reolink', family: 'PTZ & speed domes', model: 'RLC-823S2', label: 'RLC-823S2 PTZ · 4K 25 fps · 24 W (PoE+)', resolution: '8MP', codec: 'h265', fps: 25, nightIR: true, poeW: 24, scene: 'high', note: 'IR plus spotlights.' }
  ]

  /** Preset vendors in display order, Generic first. */
  const PRESET_VENDORS = [...new Set(PRESETS.map((p) => p.vendor || 'Generic'))]
  // Dropdown groups: one per vendor, split by `family` where a preset has one.
  // Groups appear in PRESETS order, so keep each family's rows together.
  const presetGroup = (p) => (p.family ? `${p.vendor} · ${p.family}` : p.vendor || 'Generic')
  const PRESET_GROUPS = [...new Set(PRESETS.map(presetGroup))]

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
    PRESET_VENDORS,
    PRESET_GROUPS,
    presetGroup,
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
