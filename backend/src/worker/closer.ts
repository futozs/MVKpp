import type { Pool } from "mysql2/promise";
import {
  serviceNow,
  trips,
  tripStopsAlong,
  patternHash,
  routes,
  activeServices,
  localMidnightUnix,
} from "../lib/gtfs.ts";
import { keys } from "../db/dims.ts";

const SILENT_MIN = 10;
const COMPLETE_PCT = 80;

export type CloseResult = { closed: number; ghosts: number };

type RunAgg = {
  run_id: number;
  stops_total: number;
  n: number;
  a0: number | null;
  a1: number | null;
  dwell: number | null;
  first_delay: number | null;
  last_delay: number | null;
};

export async function closeRuns(pool: Pool): Promise<CloseResult> {
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
    [SILENT_MIN],
  );
  const runs = cand as {
    run_id: number;
    service_date: string;
    stops_total: number;
    sched_end_s: number;
  }[];
  if (!runs.length) return { closed: 0, ghosts: 0 };

  const ids = runs.map((r) => r.run_id);
  const ph = ids.map(() => "?").join(",");

  const [evAgg] = await pool.query(
    `SELECT run_id, COUNT(*) AS n, MIN(arr_ts) AS a0,
            MAX(COALESCE(dep_ts, arr_ts)) AS a1, SUM(dwell_s) AS dwell,
            CAST(SUBSTRING_INDEX(GROUP_CONCAT(delay_s ORDER BY stop_seq), ',', 1) AS SIGNED) AS first_delay,
            CAST(SUBSTRING_INDEX(GROUP_CONCAT(delay_s ORDER BY stop_seq DESC), ',', 1) AS SIGNED) AS last_delay
       FROM stop_event WHERE run_id IN (${ph}) GROUP BY run_id`,
    ids,
  );
  const byRun = new Map<number, RunAgg>();
  for (const r of evAgg as RunAgg[]) byRun.set(r.run_id, r);

  const [pingAgg] = await pool.query(
    `SELECT run_id, MAX(along_m) - MIN(along_m) AS dist_m, MAX(speed_dms) AS max_dms,
            MAX(feed_ts) - MIN(feed_ts) AS span_s,
            SUM(speed_dms > 10) AS moving_n, COUNT(*) AS n
       FROM veh_ping WHERE run_id IN (${ph}) GROUP BY run_id`,
    ids,
  );
  type PA = {
    run_id: number;
    dist_m: number | null;
    max_dms: number | null;
    span_s: number;
    moving_n: number;
    n: number;
  };
  const byPing = new Map<number, PA>();
  for (const r of pingAgg as PA[]) byPing.set(r.run_id, r);

  let closed = 0;
  for (const r of runs) {
    const e = byRun.get(r.run_id);
    const p = byPing.get(r.run_id);
    const seen = e?.n ?? 0;
    const quality = r.stops_total
      ? Math.min(100, Math.round((seen * 100) / r.stops_total))
      : 0;
    const status =
      seen === 0 ? "aborted" : quality >= COMPLETE_PCT ? "complete" : "partial";
    const movingS =
      p && p.n > 0 ? Math.round((p.span_s * p.moving_n) / p.n) : null;

    await pool.query(
      `UPDATE trip_run SET
         actual_start = ?, actual_end = ?, start_delay_s = ?, end_delay_s = ?,
         dist_m = ?, moving_s = ?, dwell_s = ?, max_speed_dms = ?,
         stops_seen = ?, quality = ?, status = ?, updated_at = NOW()
       WHERE run_id = ? AND service_date = ?`,
      [
        e?.a0 ?? null,
        e?.a1 ?? null,
        e?.first_delay ?? null,
        e?.last_delay ?? null,
        p?.dist_m != null && p.dist_m >= 0 ? p.dist_m : null,
        movingS,
        e?.dwell ?? null,
        p?.max_dms ?? null,
        Math.min(seen, 255),
        quality,
        status,
        r.run_id,
        r.service_date,
      ],
    );
    closed++;
  }

  return { closed, ghosts: 0 };
}

export async function markGhosts(pool: Pool, isoDate: string): Promise<number> {
  const ymd = isoDate.replace(/-/g, "");
  const active = activeServices(ymd);
  if (!active.size) return 0;

  const [cov] = await pool.query(
    `SELECT MIN(feed_ts) AS t0, MAX(feed_ts) AS t1 FROM veh_ping WHERE service_date = ?`,
    [isoDate],
  );
  const c = (cov as { t0: number | null; t1: number | null }[])[0];
  if (!c?.t0 || !c?.t1) return 0;

  const midnight = localMidnightUnix(isoDate);
  const coverFrom = c.t0 - midnight + 300;
  const coverTo = c.t1 - midnight - 300;
  if (coverTo <= coverFrom) return 0;

  const [ran] = await pool.query(
    `SELECT pattern_key, sched_start_s FROM trip_run WHERE service_date = ? AND status <> 'ghost'`,
    [isoDate],
  );
  const done = new Set(
    (ran as { pattern_key: number; sched_start_s: number }[]).map(
      (r) => `${r.pattern_key}|${r.sched_start_s}`,
    ),
  );

  const rows: unknown[][] = [];
  for (const [tripId, t] of trips) {
    if (!active.has(t.serviceId)) continue;
    const along = tripStopsAlong(tripId);
    if (!along || along.length < 2) continue;
    const h = patternHash(tripId);
    const patternKey = h ? keys.pattern.get(h) : undefined;
    const routeKey = keys.route.get(routes.get(t.routeId)?.short || t.routeId);
    if (!patternKey || !routeKey) continue;

    const schedStart = along[0].dep;
    if (schedStart < coverFrom || schedStart > coverTo) continue;
    if (done.has(`${patternKey}|${schedStart}`)) continue;

    rows.push([
      isoDate,
      0,
      routeKey,
      Number(t.dir) || 0,
      patternKey,
      schedStart,
      along[along.length - 1].dep,
      Math.min(along.length, 255),
      "ghost",
      tripId,
    ]);
  }
  if (!rows.length) return 0;

  for (let i = 0; i < rows.length; i += 500) {
    await pool.query(
      `INSERT IGNORE INTO trip_run
         (service_date, vehicle_key, route_key, direction, pattern_key,
          sched_start_s, sched_end_s, stops_total, status, gtfs_trip_id, updated_at)
       VALUES ${rows
         .slice(i, i + 500)
         .map(() => "(?,?,?,?,?,?,?,?,?,?,NOW())")
         .join(",")}`,
      rows.slice(i, i + 500).flat(),
    );
  }
  return rows.length;
}

export function yesterdayIso(): string {
  const t = serviceNow();
  const d = new Date(localMidnightUnix(t.isoDate) * 1000 - 43200_000);
  return serviceNow(Math.floor(d.getTime() / 1000)).isoDate;
}
