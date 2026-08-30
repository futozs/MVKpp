/**
 * Closer — menetek lezárása és összegzése.
 *
 * A matcher folyamatosan írja a megálló-eseményeket, de a menet összesített
 * mutatóit (tényleges indulás/érkezés, megtett út, tartózkodás, lefedettség)
 * csak akkor érdemes véglegesíteni, amikor a menet már véget ért. Így a
 * számítás egyszer fut le teljes adaton, nem részlegesen minden körben.
 */
import type { Pool } from 'mysql2/promise'
import { serviceNow, trips, tripStopsAlong, patternHash, routes, activeServices, localMidnightUnix } from '../lib/gtfs.ts'
import { keys } from '../db/dims.ts'

/** Ennyi néma perc után tekintjük a menetet befejezettnek. */
const SILENT_MIN = 10
/** Ekkora megállólefedettség fölött „teljes" a menet. */
const COMPLETE_PCT = 80

export type CloseResult = { closed: number; ghosts: number }

type RunAgg = {
  run_id: number
  stops_total: number
  n: number
  a0: number | null
  a1: number | null
  dwell: number | null
  first_delay: number | null
  last_delay: number | null
}

export async function closeRuns(pool: Pool): Promise<CloseResult> {
  // Lezárandó menetek: azok, amikhez SILENT_MIN perce nem érkezett új pont.
  //
  // A `trip_run.updated_at` erre nem alkalmas: a matcher menet-gyorsítótára
  // miatt az csak a menet létrehozásakor frissül, tehát 10 perc után minden
  // menet lezárhatónak látszana — a még javában futók is. Az egyetlen
  // megbízható jel az, hogy jön-e még pont ehhez a menethez; ezt az
  // `ix_run (run_id, feed_ts)` index olcsón megválaszolja.
  const [cand] = await pool.query(
    `SELECT r.run_id, r.service_date, r.stops_total, r.sched_end_s
       FROM trip_run r
      WHERE r.status = 'running'
        AND r.service_date >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)
        AND NOT EXISTS (
              SELECT 1 FROM veh_ping p
               WHERE p.run_id = r.run_id
                 AND p.feed_ts > UNIX_TIMESTAMP() - ? * 60
            )
      LIMIT 500`,
    [SILENT_MIN]
  )
  const runs = cand as { run_id: number; service_date: string; stops_total: number; sched_end_s: number }[]
  if (!runs.length) return { closed: 0, ghosts: 0 }

  const ids = runs.map((r) => r.run_id)
  const ph = ids.map(() => '?').join(',')

  // Megálló-események összegzése menetenként. A GROUP_CONCAT + SUBSTRING_INDEX
  // páros adja az első és utolsó megálló késését sorrend szerint — 17 megállónál
  // ez bőven a GROUP_CONCAT hosszkorlátja alatt marad.
  const [evAgg] = await pool.query(
    `SELECT run_id, COUNT(*) AS n, MIN(arr_ts) AS a0,
            MAX(COALESCE(dep_ts, arr_ts)) AS a1, SUM(dwell_s) AS dwell,
            CAST(SUBSTRING_INDEX(GROUP_CONCAT(delay_s ORDER BY stop_seq), ',', 1) AS SIGNED) AS first_delay,
            CAST(SUBSTRING_INDEX(GROUP_CONCAT(delay_s ORDER BY stop_seq DESC), ',', 1) AS SIGNED) AS last_delay
       FROM stop_event WHERE run_id IN (${ph}) GROUP BY run_id`,
    ids
  )
  const byRun = new Map<number, RunAgg>()
  for (const r of evAgg as RunAgg[]) byRun.set(r.run_id, r)

  // Megtett út és sebesség a nyers pontokból.
  const [pingAgg] = await pool.query(
    `SELECT run_id, MAX(along_m) - MIN(along_m) AS dist_m, MAX(speed_dms) AS max_dms,
            MAX(feed_ts) - MIN(feed_ts) AS span_s,
            SUM(speed_dms > 10) AS moving_n, COUNT(*) AS n
       FROM veh_ping WHERE run_id IN (${ph}) GROUP BY run_id`,
    ids
  )
  type PA = { run_id: number; dist_m: number | null; max_dms: number | null; span_s: number; moving_n: number; n: number }
  const byPing = new Map<number, PA>()
  for (const r of pingAgg as PA[]) byPing.set(r.run_id, r)

  let closed = 0
  for (const r of runs) {
    const e = byRun.get(r.run_id)
    const p = byPing.get(r.run_id)
    const seen = e?.n ?? 0
    const quality = r.stops_total ? Math.min(100, Math.round((seen * 100) / r.stops_total)) : 0
    // Nulla megálló-eseménnyel a menet nem teljesült — a jármű vagy nem indult
    // el, vagy végig a vonalon kívül volt.
    const status = seen === 0 ? 'aborted' : quality >= COMPLETE_PCT ? 'complete' : 'partial'
    // A mozgásban töltött időt a mozgó pontok arányából becsüljük, mert a
    // pontok között nincs folytonos sebességgörbe.
    const movingS = p && p.n > 0 ? Math.round((p.span_s * p.moving_n) / p.n) : null

    await pool.query(
      `UPDATE trip_run SET
         actual_start = ?, actual_end = ?, start_delay_s = ?, end_delay_s = ?,
         dist_m = ?, moving_s = ?, dwell_s = ?, max_speed_dms = ?,
         stops_seen = ?, quality = ?, status = ?, updated_at = NOW()
       WHERE run_id = ? AND service_date = ?`,
      [
        e?.a0 ?? null, e?.a1 ?? null, e?.first_delay ?? null, e?.last_delay ?? null,
        p?.dist_m != null && p.dist_m >= 0 ? p.dist_m : null,
        movingS, e?.dwell ?? null, p?.max_dms ?? null,
        Math.min(seen, 255), quality, status, r.run_id, r.service_date,
      ]
    )
    closed++
  }

  return { closed, ghosts: 0 }
}

/**
 * Szellemmenetek: a menetrendben szereplő, de soha egyetlen jármű által sem
 * teljesített indulások. Külön mutatónak számítanak — sehol máshol nem
 * látható, hány járat esik ki egy nap.
 */
export async function markGhosts(pool: Pool, isoDate: string): Promise<number> {
  const ymd = isoDate.replace(/-/g, '')
  const active = activeServices(ymd)
  if (!active.size) return 0

  // Kiesett járatnak CSAK azt szabad nevezni, ami olyan időszakban lett volna
  // esedékes, amikor ténylegesen gyűjtöttünk adatot. Enélkül minden menet, ami
  // a worker elindítása előtt közlekedett, hamisan kiesettnek látszana — és
  // pont ez a mutató lenne az egyik legértékesebb, ha megbízható.
  const [cov] = await pool.query(
    `SELECT MIN(feed_ts) AS t0, MAX(feed_ts) AS t1 FROM veh_ping WHERE service_date = ?`,
    [isoDate]
  )
  const c = (cov as { t0: number | null; t1: number | null }[])[0]
  if (!c?.t0 || !c?.t1) return 0

  const midnight = localMidnightUnix(isoDate)
  // 5 perc ráhagyás mindkét szélen: a lefedettség határán induló menetet nem
  // láttuk volna teljesen, tehát nem ítélhetjük meg.
  const coverFrom = c.t0 - midnight + 300
  const coverTo = c.t1 - midnight - 300
  if (coverTo <= coverFrom) return 0

  // Mi FUTOTT ténylegesen aznap.
  const [ran] = await pool.query(
    `SELECT pattern_key, sched_start_s FROM trip_run WHERE service_date = ? AND status <> 'ghost'`,
    [isoDate]
  )
  const done = new Set(
    (ran as { pattern_key: number; sched_start_s: number }[]).map((r) => `${r.pattern_key}|${r.sched_start_s}`)
  )

  // Mi lett volna menetrend szerint.
  const rows: unknown[][] = []
  for (const [tripId, t] of trips) {
    if (!active.has(t.serviceId)) continue
    const along = tripStopsAlong(tripId)
    if (!along || along.length < 2) continue
    const h = patternHash(tripId)
    const patternKey = h ? keys.pattern.get(h) : undefined
    const routeKey = keys.route.get(routes.get(t.routeId)?.short || t.routeId)
    if (!patternKey || !routeKey) continue

    const schedStart = along[0].dep
    if (schedStart < coverFrom || schedStart > coverTo) continue
    if (done.has(`${patternKey}|${schedStart}`)) continue

    rows.push([
      isoDate, 0, routeKey, Number(t.dir) || 0, patternKey,
      schedStart, along[along.length - 1].dep, Math.min(along.length, 255), 'ghost', tripId,
    ])
  }
  if (!rows.length) return 0

  // A `vehicle_key = 0` jelöli, hogy nem volt hozzárendelt jármű. Az egyedi
  // kulcs (nap, jármű, minta, indulás) miatt ez ütközésmentesen egyedi.
  for (let i = 0; i < rows.length; i += 500) {
    await pool.query(
      `INSERT IGNORE INTO trip_run
         (service_date, vehicle_key, route_key, direction, pattern_key,
          sched_start_s, sched_end_s, stops_total, status, gtfs_trip_id, updated_at)
       VALUES ${rows.slice(i, i + 500).map(() => '(?,?,?,?,?,?,?,?,?,?,NOW())').join(',')}`,
      rows.slice(i, i + 500).flat()
    )
  }
  return rows.length
}

/** Az előző üzemi nap ISO dátuma — a nappali összegzések ezen futnak. */
export function yesterdayIso(): string {
  const t = serviceNow()
  const d = new Date(localMidnightUnix(t.isoDate) * 1000 - 43200_000)
  return serviceNow(Math.floor(d.getTime() / 1000)).isoDate
}
