# SOP: Storage Calculation for Video Surveillance (CCTV / IP Cameras)

| Field           | Value                                            |
| --------------- | ------------------------------------------------ |
| Document ID     | SOP-VSS-001                                      |
| Version         | 1.3                                              |
| Effective date  | 2026-09-28                                       |
| Owner           | Security Systems / Infrastructure Engineering    |
| Review cycle    | Annually, or when camera standards change        |

---

## 1. Purpose

Define a repeatable method for sizing recording storage (NVR, VMS server, or
SAN/NAS) for a video surveillance system so that every site meets its required
**retention period** without running out of disk, over-buying hardware, or
losing footage to overwrite.

## 2. Scope

Applies to all new installations, expansions, camera replacements, and
retention-policy changes for IP and analog/HD-over-coax surveillance systems
recording to on-premises or hosted storage. It does **not** cover cloud VSaaS
plans billed per camera (use the vendor's plan sizing instead), though step 5
may still be used to estimate upload bandwidth.

## 3. Roles and responsibilities

| Role                       | Responsibility                                                        |
| -------------------------- | --------------------------------------------------------------------- |
| Site owner / requester     | Supplies camera list, retention requirement, recording mode per zone. |
| Systems designer           | Performs the calculation, completes the worksheet (Appendix A).       |
| Reviewer (second engineer) | Independently checks inputs, math, and RAID selection.                |
| Installer / commissioning  | Measures actual bitrates after install and reports deviations (§7).   |
| Compliance / legal         | Confirms the retention period meets policy and regulation.            |

## 4. Definitions

| Term               | Meaning                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| Bitrate            | Data rate of one video stream, in megabits per second (Mbps). The single biggest driver of storage.  |
| Retention          | Number of days footage must be kept before it can be overwritten.                                    |
| Duty cycle         | Fraction of the day a camera actually records (1.0 = continuous 24/7; ~0.2–0.5 for motion-only).     |
| CBR / VBR          | Constant / variable bitrate. VBR bitrate rises with scene motion, noise, and night-time IR grain.    |
| Raw capacity       | Sum of all disk sizes as printed on the label.                                                       |
| Usable capacity    | Capacity left after RAID parity/mirroring, file-system overhead, and TB→TiB conversion.              |
| Headroom           | Spare usable capacity reserved for bitrate growth, events, and disk-failure rebuilds.                |
| TB vs TiB          | Disks are sold in decimal TB (10¹² bytes); operating systems report binary TiB (2⁴⁰ bytes). 1 TB = 0.909 TiB. |

## 5. Procedure

### Step 1 — Gather inputs

Collect the following for **every camera** (or group of identical cameras) and
record them in the worksheet (Appendix A):

1. Camera model and quantity.
2. Resolution (e.g. 2 MP / 1080p, 4 MP, 8 MP / 4K).
3. Frame rate (fps) actually configured for recording, not the camera maximum,
   and any lower night-time frame rate.
4. Codec (H.264, H.265, AV1, MJPEG, or a smart codec such as
   H.264+/H.265+/Zipstream) and the image quality setting.
5. Recording mode: continuous, motion/event, scheduled, or continuous with a
   low-rate substream plus event high-rate.
6. Hours per day recorded (24 for continuous; the schedule for business-hours).
7. Scene type: low motion (corridor, storeroom), medium (office, parking), high
   (entrances, retail floor, roads, trees/foliage), and whether night IR is used.
8. Required **retention in days** (from policy, contract, or regulation).
9. Audio recording (yes/no) — add ~0.064 Mbps per camera if yes.

> Record retention requirements from the governing policy document, not from
> memory. If no requirement exists, escalate to compliance before continuing.

### Step 2 — Determine the bitrate per camera

Use, in order of preference:

1. **Measured bitrate** from an existing installation of the same model in a
   similar scene (average over at least 24 h including night).
2. **Manufacturer's bitrate / storage calculator** for the exact model and
   settings.
3. The **planning estimates** below, only when neither of the above is
   available.

**Table 1 — Planning bitrates (Mbps), 15 fps, medium-motion scene, medium quality**

| Resolution      | H.264 | Smart H.264+ | H.265 | Smart H.265+ | AV1 | MJPEG |
| --------------- | ----- | ------------ | ----- | ------------ | --- | ----- |
| 1 MP (720p)     | 2     | 1.2          | 1     | 0.5          | 0.7 | 10    |
| 2 MP (1080p)    | 4     | 2.4          | 2     | 1            | 1.4 | 20    |
| 3 MP            | 5     | 3            | 2.5   | 1.25         | 1.75| 25    |
| 4 MP (1440p)    | 6     | 3.6          | 3     | 1.5          | 2.1 | 30    |
| 5 MP            | 8     | 4.8          | 4     | 2            | 2.8 | 40    |
| 6 MP            | 10    | 6            | 5     | 2.5          | 3.5 | 50    |
| 8 MP (4K)       | 12    | 7.2          | 6     | 3            | 4.2 | 60    |
| 12 MP (fisheye) | 16    | 9.6          | 8     | 4            | 5.6 | 80    |

Codec columns are the H.264 figure × 0.6 (Smart H.264+), × 0.5 (H.265),
× 0.25 (Smart H.265+), × 0.35 (AV1) and × 5 (MJPEG). Avoid MJPEG for recording
unless an analytics system requires it.

Some vendor calculators use a raw-pixel method instead of Table 1. Use it only
to compare results with those tools; see Appendix C.

Adjustments to Table 1:

- **Frame rate:** scale roughly linearly — multiply by `configured fps ÷ 15`
  (e.g. 30 fps ≈ ×2, 10 fps ≈ ×0.67). This slightly overestimates, which is
  the safe direction.
- **Scene motion:** low motion ×0.7, high motion ×1.5.
- **Image quality / compression setting:** low ×0.7, medium ×1.0, high ×1.4.
- **Day/night frame rates:** if cameras record at a lower frame rate at night,
  size **storage** with the hours-weighted average
  `(day bitrate × day hours + night bitrate × night hours) ÷ 24`, and size
  **throughput** (Step 5a) with the higher of the two bitrates.
- **Night / IR:** if a large share of recording is at night with IR, add 20%
  unless the camera has been measured.
- **Smart codecs:** only use a smart-codec column if the feature will be
  **enabled and verified** at commissioning; otherwise use the plain H.264 or
  H.265 column.
- **Multi-sensor cameras:** calculate each sensor/stream as a separate camera.
- **Dual recording (main + substream):** add the substream bitrate
  (typically 0.25–0.5 Mbps) if both streams are recorded.

### Step 3 — Determine the duty cycle

| Recording mode                   | Duty cycle to use                          |
| -------------------------------- | ------------------------------------------ |
| Continuous 24/7                  | 1.0                                        |
| Scheduled (e.g. 12 h/day)        | hours ÷ 24                                 |
| Motion/event — low-activity area | 0.2                                        |
| Motion/event — medium activity   | 0.35                                       |
| Motion/event — high activity     | 0.5                                        |

Motion recording duty cycles include pre/post-event buffer time. Never use a
duty cycle below 0.2 without measured evidence — false triggers (lighting
changes, rain, insects on IR) routinely push real values higher.

### Step 4 — Calculate storage per camera per day

```
GB per day = Bitrate (Mbps) × 86,400 (s/day) × Duty cycle ÷ 8 (bits→bytes) ÷ 1,000 (MB→GB)
           = Bitrate (Mbps) × Duty cycle × 10.8
```

Quick reference (continuous recording):

| Bitrate  | GB/day | TB per 30 days |
| -------- | ------ | -------------- |
| 1 Mbps   | 10.8   | 0.32           |
| 2 Mbps   | 21.6   | 0.65           |
| 4 Mbps   | 43.2   | 1.30           |
| 6 Mbps   | 64.8   | 1.94           |
| 8 Mbps   | 86.4   | 2.59           |
| 12 Mbps  | 129.6  | 3.89           |

### Step 5 — Calculate total required storage

```
Raw recording (TB) = Σ [ GB per day per camera × Quantity ] × Retention days ÷ 1,000
```

Also calculate **aggregate bitrate** (`Σ bitrate × quantity`, in Mbps). Confirm
it is within the NVR/VMS server's rated recording throughput and the network
uplink. Keep aggregate bitrate at or below **70%** of the recorder's rated
inbound bandwidth.

### Step 5a — Check network, PoE, viewing and disk throughput

Storage is only half the design. Confirm every link in the recording path can
carry the traffic. Use each camera's **full** bitrate here, even for
motion-recorded cameras, because they can all trigger at once.

1. **Switch uplinks.** For each PoE switch, add up the bitrate of the cameras
   connected to it. Keep this at or below **70%** of the switch's uplink to the
   recorder (e.g. ≤ 700 Mbps on a 1 Gbps uplink).
2. **PoE budget.** Add up the camera power draw from each datasheet: typically
   about 6 W for a fixed camera, plus about 3 W with IR on at night, 2 W more
   at 8 MP and above, and much more for PTZs or heaters. Keep the total at or
   below **80%** of the switch's PoE budget.
3. **Viewing traffic.** Estimate what the recorder sends out to viewers:
   - live view: open tiles × 0.5 Mbps on substreams, or × the average camera
     bitrate on main streams;
   - playback: sessions at once × the average camera bitrate.
   Check the total against the recorder's rated outbound throughput and, for
   remote viewers, the WAN or VPN link (keep ≤ 70%). Configure multi-camera
   live views to use substreams.
4. **Disk throughput.** Sustained disk write in MB/s = camera traffic (Mbps)
   ÷ 8; playback read = playback traffic ÷ 8. Confirm the recorder or array
   vendor rates the array for this load, including while a RAID rebuild runs.

### Step 6 — Apply overhead and headroom

```
Required usable (TB) = Raw recording × 1.05 (file system / index overhead)
                                     × 1.20 (headroom, minimum)
```

- Use **1.30 headroom** for sites expected to add cameras within 2 years, or
  where retention is a legal requirement.
- Do not reduce headroom below 1.20 — VMS software typically starts overwriting
  or alarming at 90–95% full, and VBR bitrates drift upward over time.

### Step 7 — Select disks and RAID level

Convert the required usable capacity into a disk count:

| RAID level | Usable capacity            | Min disks | Use when                                              |
| ---------- | -------------------------- | --------- | ----------------------------------------------------- |
| RAID 5     | (N − 1) × disk size        | 3         | Small arrays (≤ 6 disks, ≤ 8 TB disks) only.          |
| RAID 6     | (N − 2) × disk size        | 4         | **Default** for surveillance arrays.                  |
| RAID 10    | (N ÷ 2) × disk size        | 4         | High write throughput / very large camera counts.     |
| None/JBOD  | N × disk size              | 1         | Not permitted for evidential or regulated footage.    |

Rules:

1. Use **surveillance-rated** drives (e.g. WD Purple, Seagate SkyHawk) or
   enterprise drives rated for 24/7 write workloads.
2. Convert to binary before comparing with what the OS will show:
   `usable TiB = usable TB × 0.909`. Size against TB consistently in the
   worksheet, but tell the customer the TiB figure they will see.
3. Add **one hot spare** for arrays of 8 disks or more.
4. Confirm the chosen recorder has enough drive bays, and that the chosen disk
   size is on the recorder's compatibility list.
5. Round **up** the disk count; never round down.

### Step 8 — Document, review, and approve

1. Complete the worksheet (Appendix A) and attach the camera schedule.
2. A second engineer independently re-checks inputs, bitrates, and arithmetic.
3. Record the approved design in the project file with the reviewer's name
   and date.

## 6. Worked example

**Site:** warehouse, 30-day retention, continuous recording.

| Group | Cameras | Resolution | Codec | fps | Scene  | Bitrate (Mbps)        | Duty |
| ----- | ------- | ---------- | ----- | --- | ------ | --------------------- | ---- |
| A     | 24      | 4 MP       | H.265 | 15  | Medium | 3                     | 1.0  |
| B     | 6       | 8 MP       | H.265 | 20  | High   | 6 × (20/15) × 1.5 = 12 | 1.0  |
| C     | 10      | 2 MP       | H.265 | 15  | Low    | 2 × 0.7 = 1.4         | 0.35 (motion) |

**Step 4 — GB per camera per day** (`Bitrate × Duty × 10.8`):

- A: 3 × 1.0 × 10.8 = **32.4 GB**
- B: 12 × 1.0 × 10.8 = **129.6 GB**
- C: 1.4 × 0.35 × 10.8 = **5.29 GB**

**Step 5 — Raw recording for 30 days:**

- A: 32.4 × 24 = 777.6 GB/day
- B: 129.6 × 6 = 777.6 GB/day
- C: 5.29 × 10 = 52.9 GB/day
- Total: 1,608.1 GB/day × 30 days = **48.24 TB**
- Aggregate bitrate: (3 × 24) + (12 × 6) + (1.4 × 10) = **158 Mbps** → recorder
  must be rated for ≥ 226 Mbps inbound (158 ÷ 0.7).

**Step 5a — Network and viewing:** aisles on a 24-port switch (1 Gbps uplink,
370 W PoE), docks and offices on a 16-port switch (1 Gbps, 240 W).

- 24-port: 72 Mbps (7% of uplink), 24 × 6 W = 144 W (39% of PoE budget)
- 16-port: 86 Mbps (9%), 6 × 8 W + 10 × 6 W = 108 W (45%)
- Viewing: 4 live substreams (2 Mbps) + 1 playback at the 3.95 Mbps average
  = about 6 Mbps out of the recorder
- Disk: 158 ÷ 8 ≈ 20 MB/s sustained write

**Step 6 — Overhead and headroom:**

48.24 × 1.05 × 1.20 = **60.8 TB usable required**

**Step 7 — Disks (RAID 6, 12 TB surveillance drives):**

- Data disks needed: 60.8 ÷ 12 = 5.07 → round up to **6**
- RAID 6 adds 2 parity disks → **8 disks**
- 8 disks ⇒ add 1 hot spare → **9 disks total**, usable = 6 × 12 = 72 TB
  (≈ 65.5 TiB as shown by the OS)

**Result:** 9 × 12 TB in RAID 6 + hot spare, 72 TB usable, recorder rated for
≥ 226 Mbps. Expected retention at design bitrates ≈ 72 ÷ (1.608 × 1.05) ≈ 42
days, leaving margin above the 30-day requirement.

## 7. Verification after installation

Within **7 days** of commissioning:

1. Export each camera's actual average bitrate from the VMS/NVR over at least
   24 hours, including a night period.
2. Compare against the design bitrate. If any group exceeds design by more than
   **15%**, re-run §5 Steps 4–7 with measured values.
3. After **retention days + 7**, confirm the oldest available footage is at
   least the required retention age. Record the result in the project file.
4. If retention is not met: reduce bitrate (codec, fps, quality, smart codec),
   change recording mode, or add storage — in that order of preference, subject
   to the site owner's approval of any image-quality change.

## 8. Ongoing monitoring

- Enable VMS alerts for: disk failure, RAID degraded, storage > 90%, and
  retention below target.
- Review actual retention **quarterly** and after any camera addition or
  firmware update that changes encoding.
- Re-run this SOP whenever cameras are added, resolution/fps/codec changes, or
  the retention policy changes.

## 9. Common mistakes to avoid

- Using the camera's **maximum** fps/resolution instead of the configured values.
- Sizing only from daytime bitrate — night IR noise often raises VBR bitrate.
- Forgetting RAID parity, file-system overhead, or the TB→TiB difference.
- Counting on smart-codec savings that are never enabled on site.
- Mixing up **bits and bytes** (Mbps vs MB/s — divide by 8).
- Ignoring recorder throughput limits — enough disk but too many Mbps still
  drops frames.

## 10. Records

Keep the following in the project file for the life of the system:

- Completed worksheet (Appendix A) and camera schedule.
- Reviewer sign-off.
- Post-installation bitrate measurements and retention verification (§7).

## 11. Revision history

| Version | Date       | Author | Change          |
| ------- | ---------- | ------ | --------------- |
| 1.0     | 2026-09-28 |        | Initial release |
| 1.1     | 2026-09-28 |        | Added Step 5a: network, PoE, viewing and disk throughput |
| 1.2     | 2026-09-28 |        | Table 1 adds Smart H.264+, AV1, MJPEG; quality and day/night frame-rate adjustments |
| 1.3     | 2026-09-28 |        | Table 1 adds 1, 3 and 6 MP; Appendix C raw-pixel method |

---

## Appendix A — Storage calculation worksheet

**Project / site:** ____________________  **Designer:** ____________
**Retention required (days):** ______  **Headroom factor:** 1.20 / 1.30

| Grp | Qty | Model | Res | Codec | fps | Scene | Mode | Bitrate (Mbps) | Duty | GB/day/cam (= Mbps × Duty × 10.8) | GB/day (× Qty) |
| --- | --- | ----- | --- | ----- | --- | ----- | ---- | -------------- | ---- | --------------------------------- | -------------- |
|     |     |       |     |       |     |       |      |                |      |                                   |                |
|     |     |       |     |       |     |       |      |                |      |                                   |                |
|     |     |       |     |       |     |       |      |                |      |                                   |                |
|     |     |       |     |       |     |       |      |                |      |                                   |                |

| Line | Item                                                     | Value |
| ---- | -------------------------------------------------------- | ----- |
| 1    | Total GB/day (sum of last column)                        |       |
| 2    | Raw recording TB = Line 1 × retention days ÷ 1,000       |       |
| 3    | Required usable TB = Line 2 × 1.05 × headroom            |       |
| 4    | Aggregate bitrate (Mbps) = Σ bitrate × qty               |       |
| 5    | Minimum recorder throughput (Mbps) = Line 4 ÷ 0.7        |       |
| 6    | Disk size (TB) / RAID level                              |       |
| 7    | Data disks = ⌈Line 3 ÷ disk size⌉                        |       |
| 8    | Total disks = Line 7 + parity (+ hot spare if ≥ 8 disks) |       |
| 9    | Usable TB / TiB (× 0.909)                                |       |

**Reviewed by:** ______________  **Date:** __________

## Appendix C — Raw-pixel method (comparison only)

Some calculators estimate bitrate from uncompressed video:

```
Raw Mbps        = width × height × color depth × fps ÷ 1,000,000
Compressed Mbps = Raw Mbps ÷ compression ratio × scene × quality (+20% night IR)
```

- **Color depth:** 30 bits per pixel at 4K (3840 × 2160) and above, 16 bits
  below.
- **Default compression ratios:** MJPEG 20:1, H.264 100:1, Smart H.264+ 170:1,
  H.265 200:1, AV1 285:1, Smart H.265+ 400:1.

This method usually gives higher figures than Table 1, most of all at 4K,
where the 30-bit color depth nearly doubles the raw bitrate. Final designs are
sized with Table 1 or measured bitrates (Step 2). When a customer or another
tool quotes a raw-pixel figure, record both results and explain the difference.

## Appendix B — Spreadsheet formulas

For a spreadsheet version of the worksheet, with bitrate in column I, duty in
column J, quantity in column B, and retention days in cell `$C$1`:

```
GB/day/cam   K2:  =I2*J2*10.8
GB/day       L2:  =K2*B2
Raw TB           =SUM(L:L)*$C$1/1000
Usable TB        =RawTB*1.05*Headroom
Data disks       =ROUNDUP(UsableTB/DiskSizeTB,0)
```
