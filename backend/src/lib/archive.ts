/**
 * Menetrend- és futásarchívum (MySQL).
 *
 * A GTFS feed mindig csak a következő pár hetet ismeri: ami kifut belőle, azt
 * semmi nem őrzi meg, ezért egy múltbeli napra utólag nem lehet megmondani,
 * milyen menetrend volt érvényes. Ez a modul minden feed-frissítéskor elrakja
 * az érvényességi tartomány összes napjának menetrendjét, és VÉGLEGESEN tárolja
 * a menet–jármű hozzárendeléseket is.
 *
 * Ha nincs adatbázis, minden művelet csendben kimarad — a gateway attól még
 * teljes értékűen működik, csak nem tud visszanézni a múltba.
 */
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { query, isReady } from '../db/pool.ts'
import type { DaySchedule } from './timetable.ts'

const ymdToSql = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
const sqlToYmd = (d: string) => d.slice(0, 10).replace(/-/g, '')

let ready: boolean | null = null
let readyCheckedAt = 0
const READY_TTL_MS = 60_000

/** Elérhető-e az adatbázis. Az eredményt percig megjegyezzük, hogy egy leállt
 *  MySQL ne lassítsa minden kérésnél a menetrendet. */
export async function archiveReady(): Promise<boolean> {
  if (ready !== null && Date.now() - readyCheckedAt < READY_TTL_MS) return ready
  readyCheckedAt = Date.now()
  ready = await isReady()
  return ready
}

// ── Napi menetrend ───────────────────────────────────────────────────────────

/** A kicsomagolt napok memóriacache-e: egy blob visszaolvasása ~20 ms. */
const dayCache = new Map<string, DaySchedule>()
const DAY_CACHE_MAX = 12

function cacheDay(ymd: string, day: DaySchedule) {
  if (dayCache.size >= DAY_CACHE_MAX) dayCache.delete(dayCache.keys().next().value as string)
  dayCache.set(ymd, day)
}

export type SaveResult = 'saved' | 'unchanged' | 'past' | 'skipped'

/**
 * Egy nap menetrendjének elrakása.
 *
 * A napi menetrend napról napra szinte azonos, ezért TARTALOM-HASH szerint
 * deduplikálunk: minden hétköznap ugyanarra a blobra mutat.
 *
 * MÚLTBELI napot soha nem írunk felül: a múlt menetrendje az, ami akkor
 * érvényes volt, nem az, amit egy későbbi feed mond róla.
 */
export async function saveDaySchedule(day: DaySchedule, todayYmd: string): Promise<SaveResult> {
  if (!(await archiveReady())) return 'skipped'

  const json = JSON.stringify({ routes: day.routes, tables: day.tables })
  const payload = gzipSync(json, { level: 9 })
  const hash = createHash('sha1').update(payload).digest('hex')
  const sqlDate = ymdToSql(day.date)

  const existing = await query<{ blob_hash: string }>(
    'SELECT blob_hash FROM sched_day WHERE service_date = ?', [sqlDate],
  )
  if (existing.length) {
    if (day.date < todayYmd) return 'past'
    if (existing[0].blob_hash === hash) return 'unchanged'
  }

  await query(
    'INSERT IGNORE INTO sched_blob (blob_hash, bytes, payload, created_at) VALUES (?,?,?,NOW())',
    [hash, payload.length, payload],
  )
  await query(
    `INSERT INTO sched_day (service_date, feed_version, n_routes, n_trips, blob_hash, captured_at)
     VALUES (?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE feed_version=VALUES(feed_version), n_routes=VALUES(n_routes),
       n_trips=VALUES(n_trips), blob_hash=VALUES(blob_hash), captured_at=VALUES(captured_at)`,
    [sqlDate, day.feedVersion, day.routes.length, Object.values(day.tables).reduce((n, t) => n + t.trips.length, 0), hash],
  )
  dayCache.delete(day.date)
  return 'saved'
}

/** Egy archivált nap menetrendje, vagy `null` ha nincs elrakva. */
export async function loadDaySchedule(ymd: string): Promise<DaySchedule | null> {
  const cached = dayCache.get(ymd)
  if (cached) return cached
  if (!(await archiveReady())) return null

  const rows = await query<{ feed_version: string; payload: Buffer }>(
    `SELECT d.feed_version, b.payload FROM sched_day d
     JOIN sched_blob b ON b.blob_hash = d.blob_hash
     WHERE d.service_date = ?`, [ymdToSql(ymd)],
  )
  if (!rows.length) return null
  try {
    const parsed = JSON.parse(gunzipSync(rows[0].payload).toString('utf8')) as Omit<DaySchedule, 'date' | 'feedVersion'>
    const day: DaySchedule = { date: ymd, feedVersion: rows[0].feed_version, ...parsed }
    cacheDay(ymd, day)
    return day
  } catch {
    return null
  }
}

/**
 * Melyik naphoz melyik feed-verzió van elrakva. Ha a verzió egyezik az
 * aktuálisan betöltött feeddel, a nap menetrendjét fölösleges újraépíteni —
 * enélkül az óránkénti ellenőrzés minden alkalommal legyártaná mind a
 * tizenöt napot.
 */
export async function storedFeedVersions(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!(await archiveReady())) return out
  const rows = await query<{ service_date: string; feed_version: string }>(
    'SELECT service_date, feed_version FROM sched_day',
  )
  for (const r of rows) out.set(sqlToYmd(r.service_date), r.feed_version)
  return out
}

/** Meddig ér vissza az archívum. A naptár alsó határa ebből jön. */
export async function archiveRange(): Promise<{ from: string; to: string; days: number } | null> {
  if (!(await archiveReady())) return null
  const rows = await query<{ mn: string | null; mx: string | null; n: number }>(
    'SELECT MIN(service_date) mn, MAX(service_date) mx, COUNT(*) n FROM sched_day',
  )
  const r = rows[0]
  if (!r?.mn || !r.mx) return null
  return { from: sqlToYmd(r.mn), to: sqlToYmd(r.mx), days: Number(r.n) }
}

// ── Menet–jármű napló ────────────────────────────────────────────────────────

export type Sighting = { tripId: string; vehicleId: string; firstSeen: number; lastSeen: number; samples: number }

/** Észlelések kiírása. Az `samples` összeadódik, a `last_seen` előre lép. */
export async function saveSightings(ymd: string, rows: Sighting[]): Promise<boolean> {
  if (!rows.length) return true
  if (!(await archiveReady())) return false
  const sqlDate = ymdToSql(ymd)
  const values = rows.map((r) => [sqlDate, r.tripId, r.vehicleId, r.firstSeen, r.lastSeen, r.samples])
  const placeholders = values.map(() => '(?,?,?,?,?,?)').join(',')
  await query(
    `INSERT INTO trip_vehicle_log (service_date, trip_id, vehicle_id, first_seen, last_seen, samples)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       first_seen = LEAST(first_seen, VALUES(first_seen)),
       last_seen  = GREATEST(last_seen, VALUES(last_seen)),
       samples    = samples + VALUES(samples)`,
    values.flat(),
  )
  return true
}

export type RunRecord = {
  vehicleId: string | null
  samples: number
  firstSeen: number | null
  lastSeen: number | null
  /** + = késett, − = sietett (indulás / érkezés). A statisztikai workerből. */
  startDelaySec: number | null
  endDelaySec: number | null
  actualStart: number | null
  actualEnd: number | null
  status: string | null
  stopsSeen: number | null
  stopsTotal: number | null
}

/**
 * Egy nap tényleges futásai menetenként: melyik jármű vitte és milyen
 * késéssel. A jármű a gateway naplójából jön (mindig megvan), a késés a
 * statisztikai worker `trip_run` táblájából (csak ha a worker fut).
 */
export async function dayRuns(ymd: string): Promise<Map<string, RunRecord>> {
  const out = new Map<string, RunRecord>()
  if (!(await archiveReady())) return out
  const sqlDate = ymdToSql(ymd)

  // 1) Gateway-napló: menetenként a legtöbbször észlelt jármű nyer.
  const log = await query<{ trip_id: string; vehicle_id: string; first_seen: number; last_seen: number; samples: number }>(
    `SELECT trip_id, vehicle_id, first_seen, last_seen, samples
     FROM trip_vehicle_log WHERE service_date = ? AND samples >= 2
     ORDER BY trip_id, samples DESC`, [sqlDate],
  )
  for (const r of log) {
    if (out.has(r.trip_id)) continue
    out.set(r.trip_id, {
      vehicleId: r.vehicle_id,
      samples: Number(r.samples),
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      startDelaySec: null, endDelaySec: null, actualStart: null, actualEnd: null,
      status: null, stopsSeen: null, stopsTotal: null,
    })
  }

  // 2) Statisztikai worker: tényleges indulás/érkezés és eltérés.
  const runs = await query<{
    trip_id: string; vehicle_id: string; start_delay_s: number | null; end_delay_s: number | null
    actual_start: number | null; actual_end: number | null; status: string; stops_seen: number; stops_total: number
  }>(
    `SELECT tr.gtfs_trip_id trip_id, dv.vehicle_id, tr.start_delay_s, tr.end_delay_s,
            tr.actual_start, tr.actual_end, tr.status, tr.stops_seen, tr.stops_total
     FROM trip_run tr JOIN dim_vehicle dv ON dv.vehicle_key = tr.vehicle_key
     WHERE tr.service_date = ? AND tr.gtfs_trip_id IS NOT NULL
     ORDER BY tr.gtfs_trip_id, tr.stops_seen DESC`, [sqlDate],
  )
  const seen = new Set<string>()
  for (const r of runs) {
    if (seen.has(r.trip_id)) continue
    seen.add(r.trip_id)
    const prev = out.get(r.trip_id)
    out.set(r.trip_id, {
      vehicleId: prev?.vehicleId ?? r.vehicle_id,
      samples: prev?.samples ?? 0,
      firstSeen: prev?.firstSeen ?? null,
      lastSeen: prev?.lastSeen ?? null,
      startDelaySec: r.start_delay_s == null ? null : Number(r.start_delay_s),
      endDelaySec: r.end_delay_s == null ? null : Number(r.end_delay_s),
      actualStart: r.actual_start == null ? null : Number(r.actual_start),
      actualEnd: r.actual_end == null ? null : Number(r.actual_end),
      status: r.status,
      stopsSeen: Number(r.stops_seen),
      stopsTotal: Number(r.stops_total),
    })
  }

  return out
}

// ── Kihúzott menetek napló ───────────────────────────────────────────────────

/**
 * Egy mintavétel eredménye: ami épp kihúzva látszik, azt a mai (vagy a
 * megadott) napra véglegesen elrakjuk. `ON DUPLICATE KEY` miatt biztonságos
 * ugyanazt a menetet többször is beküldeni egy napon belül.
 */
export async function saveCancelledTrips(ymd: string, tripIds: string[], nowTs: number): Promise<boolean> {
  if (!tripIds.length) return true
  if (!(await archiveReady())) return false
  const sqlDate = ymdToSql(ymd)
  const values = tripIds.map((id) => [sqlDate, id, nowTs, nowTs])
  const placeholders = values.map(() => '(?,?,?,?,1)').join(',')
  await query(
    `INSERT INTO cancelled_trip_log (service_date, trip_id, first_seen, last_seen, samples)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       last_seen = GREATEST(last_seen, VALUES(last_seen)),
       samples = samples + 1`,
    values.flat(),
  )
  return true
}

/** Az adott napon (visszamenőleg is) kihúzottnak látott menetek trip_id-jei. */
export async function dayCancelledTripIds(ymd: string): Promise<string[]> {
  if (!(await archiveReady())) return []
  const rows = await query<{ trip_id: string }>(
    `SELECT trip_id FROM cancelled_trip_log WHERE service_date = ? ORDER BY trip_id`,
    [ymdToSql(ymd)],
  )
  return rows.map((r) => r.trip_id)
}
