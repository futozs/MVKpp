import { Hono } from "hono";
import { query, isReady, getLastError } from "../db/pool.ts";
import {
  stops,
  trips,
  tripStops,
  activeServices,
  budapestOffsetSec,
} from "../lib/gtfs.ts";
import { PROFILE_WINDOW_DAYS } from "../worker/roller.ts";

export const stats = new Hono();

const LIVE_WINDOW_MIN = 20;
const LOW_CONFIDENCE_N = 20;

stats.use("*", async (c, next) => {
  if (!(await isReady())) {
    return c.json(
      { error: "Az adatraktár nem érhető el", detail: getLastError() },
      503,
    );
  }
  await next();
});

const iso = (d: Date) => d.toISOString().slice(0, 10);
const defDate = () => iso(new Date(Date.now() - 86400_000));
const defToday = () => iso(new Date(Date.now() - 3 * 3600_000));

stats.get("/health", async (c) => {
  const [health] = await query<Record<string, number | string>>(
    `SELECT * FROM feed_health ORDER BY service_date DESC LIMIT 1`,
  );
  const jobs = await query(
    `SELECT job, started_at, ended_at, ok, rows_out, note FROM job_run
      ORDER BY job_id DESC LIMIT 12`,
  );
  const [counts] = await query<Record<string, number>>(
    `SELECT (SELECT COUNT(*) FROM veh_ping) AS pings,
            (SELECT COUNT(*) FROM trip_run) AS runs,
            (SELECT COUNT(*) FROM stop_event) AS events,
            (SELECT COUNT(*) FROM segment_run) AS segments,
            (SELECT COUNT(*) FROM agg_segment_profile) AS profiles,
            (SELECT COUNT(*) FROM dim_vehicle) AS vehicles`,
  );
  return c.json({ today: health ?? null, counts, jobs });
});

stats.get("/vehicles", async (c) => {
  const rows = await query(
    `SELECT v.vehicle_id, v.kind, v.last_seen,
             COALESCE(SUM(a.runs), 0) AS runs,
             COUNT(DISTINCT a.service_date) AS days,
             MAX(a.service_date) AS last_date,
             ROUND(COALESCE(SUM(a.dist_m), 0) / 1000) AS dist_km
        FROM dim_vehicle v
        LEFT JOIN agg_vehicle_day a ON a.vehicle_key = v.vehicle_key
       GROUP BY v.vehicle_key, v.vehicle_id, v.kind, v.last_seen
       ORDER BY v.last_seen DESC`,
  );
  return c.json({ vehicles: rows });
});

stats.get("/vehicle/:id", async (c) => {
  const id = c.req.param("id");
  const date = c.req.query("date") ?? defDate();

  const [day] = await query<Record<string, number>>(
    `SELECT a.* FROM agg_vehicle_day a JOIN dim_vehicle v ON v.vehicle_key = a.vehicle_key
      WHERE v.vehicle_id = ? AND a.service_date = ?`,
    [id, date],
  );
  const runs = await query(
    `SELECT r.run_id, r.sched_start_s, r.sched_end_s, r.actual_start, r.actual_end,
            r.start_delay_s, r.end_delay_s, r.dist_m, r.stops_seen, r.stops_total,
            r.quality, r.status, d.route_short, d.color, p.headsign, r.direction
       FROM trip_run r
       JOIN dim_vehicle v ON v.vehicle_key = r.vehicle_key
       JOIN dim_route d ON d.route_key = r.route_key
       LEFT JOIN dim_pattern p ON p.pattern_key = r.pattern_key
      WHERE v.vehicle_id = ? AND r.service_date = ?
      ORDER BY r.sched_start_s`,
    [id, date],
  );
  return c.json({ vehicleId: id, date, summary: day ?? null, runs });
});

stats.get("/vehicle/:id/track", async (c) => {
  const id = c.req.param("id");
  const date = c.req.query("date") ?? defDate();
  const every = Math.max(1, Number(c.req.query("every") ?? 3));

  const rows = await query<{
    feed_ts: number;
    lat_e7: number;
    lon_e7: number;
    speed_dms: number | null;
    run_id: number | null;
  }>(
    `SELECT p.feed_ts, p.lat_e7, p.lon_e7, p.speed_dms, p.run_id
       FROM veh_ping p JOIN dim_vehicle v ON v.vehicle_key = p.vehicle_key
      WHERE v.vehicle_id = ? AND p.service_date = ?
      ORDER BY p.feed_ts`,
    [id, date],
  );
  const track = rows
    .filter((_, i) => i % every === 0)
    .map((r) => [
      r.feed_ts,
      +(r.lat_e7 / 1e7).toFixed(6),
      +(r.lon_e7 / 1e7).toFixed(6),
      r.speed_dms,
      r.run_id,
    ]);
  return c.json({
    vehicleId: id,
    date,
    points: track.length,
    ofTotal: rows.length,
    track,
  });
});

stats.get("/vehicle/:id/routes", async (c) => {
  const id = c.req.param("id");
  const ym = c.req.query("ym");
  const rows = await query(
    `SELECT a.period_ym, d.route_short, d.color, d.kind, a.runs, a.share_pct,
            a.dist_km, a.service_s, a.days_active, a.avg_delay_s
       FROM agg_vehicle_route a
       JOIN dim_vehicle v ON v.vehicle_key = a.vehicle_key
       JOIN dim_route d ON d.route_key = a.route_key
      WHERE v.vehicle_id = ? ${ym ? "AND a.period_ym = ?" : ""}
      ORDER BY a.period_ym DESC, a.runs DESC`,
    ym ? [id, ym] : [id],
  );
  return c.json({ vehicleId: id, routes: rows });
});

const PREDICT_MONTHS = 6;

// Élő, "on-demand" jóslat: nem tárolt előrejelzés, hanem a lekérdezés
// pillanatában számolt statisztikai becslés (nem valódi gépi tanulás) a
// jármű korábbi hónapjainak agg_vehicle_route futásgyakorisága alapján —
// melyik vonalra a legvalószínűbb, hogy legközelebb beosztják.
stats.get("/vehicle/:id/predict-route", async (c) => {
  const id = c.req.param("id");
  const now = new Date();
  const thisYm = now.getFullYear() * 100 + (now.getMonth() + 1);
  const months: number[] = [];
  let y = Math.floor(thisYm / 100);
  let m = thisYm % 100;
  for (let i = 0; i < PREDICT_MONTHS; i++) {
    months.push(y * 100 + m);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const ph = months.map(() => "?").join(",");

  const rows = await query<{
    route_short: string;
    color: string | null;
    runs: number;
    avg_delay_s: number | null;
  }>(
    `SELECT d.route_short, d.color, SUM(a.runs) AS runs,
            ROUND(SUM(a.avg_delay_s * a.runs) / NULLIF(SUM(a.runs), 0)) AS avg_delay_s
       FROM agg_vehicle_route a
       JOIN dim_vehicle v ON v.vehicle_key = a.vehicle_key
       JOIN dim_route d ON d.route_key = a.route_key
      WHERE v.vehicle_id = ? AND a.period_ym IN (${ph})
      GROUP BY d.route_short, d.color
      ORDER BY runs DESC
      LIMIT 5`,
    [id, ...months],
  );
  const total = rows.reduce((s, r) => s + Number(r.runs), 0);
  const candidates = rows.map((r) => ({
    routeShort: r.route_short,
    color: r.color,
    probabilityPct: total ? Math.round((100 * Number(r.runs)) / total) : 0,
    avgDelaySec: r.avg_delay_s != null ? Number(r.avg_delay_s) : null,
  }));
  return c.json({ vehicleId: id, samples: total, candidates });
});

// Az előre naplózott jóslatok (lásd routePrediction.ts) utólagos pontossága:
// hányszor volt igaza a korábbi hónapok gyakorisága alapján épített
// becslésnek a ténylegesen kiadott menethez képest.
stats.get("/predictions/accuracy", async (c) => {
  const to = c.req.query("to") ?? defToday();
  const from =
    c.req.query("from") ?? iso(new Date(Date.parse(to) - 59 * 86400_000));

  const [overall] = await query<{ n: number; correct: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(correct), 0) AS correct
       FROM vehicle_route_prediction
      WHERE service_date BETWEEN ? AND ?`,
    [from, to],
  );

  const daily = await query<{
    service_date: string;
    n: number;
    correct: number;
  }>(
    `SELECT service_date, COUNT(*) AS n, COALESCE(SUM(correct), 0) AS correct
       FROM vehicle_route_prediction
      WHERE service_date BETWEEN ? AND ?
      GROUP BY service_date
      ORDER BY service_date`,
    [from, to],
  );

  const byVehicle = await query<{
    vehicle_id: string;
    n: number;
    correct: number;
  }>(
    `SELECT v.vehicle_id, COUNT(*) AS n, COALESCE(SUM(p.correct), 0) AS correct
       FROM vehicle_route_prediction p
       JOIN dim_vehicle v ON v.vehicle_key = p.vehicle_key
      WHERE p.service_date BETWEEN ? AND ?
      GROUP BY v.vehicle_id
      HAVING n >= 3
      ORDER BY n DESC
      LIMIT 30`,
    [from, to],
  );

  return c.json({
    from,
    to,
    total: overall?.n ?? 0,
    correct: overall?.correct ?? 0,
    accuracyPct: overall?.n
      ? Math.round((100 * overall.correct) / overall.n)
      : null,
    daily,
    byVehicle,
  });
});

const INCIDENT_KINDS = [
  "mid_trip_stop",
  "stuck",
  "no_signal",
  "early_end",
  "absence",
] as const;

stats.get("/incidents", async (c) => {
  const to = c.req.query("to") ?? defToday();
  const from =
    c.req.query("from") ?? iso(new Date(Date.parse(to) - 29 * 86400_000));
  const kind = c.req.query("kind");
  const minConf = Number(c.req.query("minConfidence") ?? 50);

  const rows = await query(
    `SELECT i.incident_id, i.kind, i.service_date, i.started_ts, i.ended_ts,
            i.duration_s, i.progress_pct, i.severity, i.confidence, i.peers_stuck,
            i.absent_days, i.resolution, i.note, i.lat_e7, i.lon_e7,
            v.vehicle_id, v.kind AS vehicle_kind, d.route_short, d.color
       FROM vehicle_incident i
       JOIN dim_vehicle v ON v.vehicle_key = i.vehicle_key
       LEFT JOIN dim_route d ON d.route_key = i.route_key
      WHERE i.service_date BETWEEN ? AND ? AND i.confidence >= ?
        ${kind && (INCIDENT_KINDS as readonly string[]).includes(kind) ? "AND i.kind = ?" : ""}
      ORDER BY i.started_ts DESC
      LIMIT 300`,
    kind && (INCIDENT_KINDS as readonly string[]).includes(kind)
      ? [from, to, minConf, kind]
      : [from, to, minConf],
  );
  return c.json({ from, to, minConfidence: minConf, incidents: rows });
});

stats.get("/incidents/summary", async (c) => {
  const to = c.req.query("to") ?? defToday();
  const from =
    c.req.query("from") ?? iso(new Date(Date.parse(to) - 89 * 86400_000));
  const minConf = Number(c.req.query("minConfidence") ?? 50);

  const fleet = await query(
    `SELECT v.vehicle_id, v.kind AS vehicle_kind,
            COALESCE(p.days_active, 0) AS days_active,
            COALESCE(p.runs, 0) AS runs,
            COALESCE(p.service_h, 0) AS service_h,
            COALESCE(i.n, 0) AS incidents,
            COALESCE(i.mid_trip, 0) AS mid_trip,
            COALESCE(i.stuck, 0) AS stuck,
            COALESCE(i.no_signal, 0) AS no_signal,
            COALESCE(i.absences, 0) AS absences,
            COALESCE(i.absent_days, 0) AS absent_days,
            open_abs.started_ts AS absent_since,
            ROUND(COALESCE(i.n, 0) / GREATEST(COALESCE(p.service_h, 0), 1), 3) AS per_hour
       FROM dim_vehicle v
       LEFT JOIN (
         SELECT vehicle_key, COUNT(*) AS days_active, SUM(runs) AS runs,
                ROUND(SUM(service_s) / 3600, 1) AS service_h
           FROM vehicle_presence
          WHERE service_date BETWEEN ? AND ? AND active = 1
          GROUP BY vehicle_key
       ) p ON p.vehicle_key = v.vehicle_key
       LEFT JOIN (
         SELECT vehicle_key, COUNT(*) AS n,
                SUM(kind = 'mid_trip_stop') AS mid_trip,
                SUM(kind = 'stuck') AS stuck,
                SUM(kind = 'no_signal') AS no_signal,
                SUM(kind = 'absence') AS absences,
                COALESCE(SUM(absent_days), 0) AS absent_days
           FROM vehicle_incident
          WHERE service_date BETWEEN ? AND ? AND confidence >= ?
          GROUP BY vehicle_key
       ) i ON i.vehicle_key = v.vehicle_key
       LEFT JOIN (
         SELECT vehicle_key, MAX(started_ts) AS started_ts
           FROM vehicle_incident
          WHERE kind = 'absence' AND ended_ts IS NULL
          GROUP BY vehicle_key
       ) open_abs ON open_abs.vehicle_key = v.vehicle_key
      WHERE COALESCE(p.days_active, 0) > 0 OR COALESCE(i.n, 0) > 0
      ORDER BY per_hour DESC, incidents DESC
      LIMIT 200`,
    [from, to, from, to, minConf],
  );

  const byKind = await query(
    `SELECT kind, COUNT(*) AS n, ROUND(AVG(confidence)) AS avg_conf,
            ROUND(AVG(duration_s)) AS avg_duration_s
       FROM vehicle_incident
      WHERE service_date BETWEEN ? AND ? AND confidence >= ?
      GROUP BY kind`,
    [from, to, minConf],
  );

  const daily = await query(
    `SELECT service_date, COUNT(*) AS n
       FROM vehicle_incident
      WHERE service_date BETWEEN ? AND ? AND confidence >= ?
      GROUP BY service_date ORDER BY service_date`,
    [from, to, minConf],
  );

  const repairs = await query(
    `SELECT v.vehicle_id, i.absent_days, i.service_date, i.ended_ts
       FROM vehicle_incident i JOIN dim_vehicle v ON v.vehicle_key = i.vehicle_key
      WHERE i.kind = 'absence' AND i.ended_ts IS NOT NULL
        AND i.service_date BETWEEN ? AND ?
      ORDER BY i.ended_ts DESC LIMIT 60`,
    [from, to],
  );

  return c.json({ from, to, fleet, byKind, daily, repairs });
});

stats.get("/vehicle/:id/incidents", async (c) => {
  const id = c.req.param("id");
  const rows = await query(
    `SELECT i.incident_id, i.kind, i.service_date, i.started_ts, i.ended_ts,
            i.duration_s, i.progress_pct, i.severity, i.confidence, i.peers_stuck,
            i.absent_days, i.resolution, i.note, d.route_short, d.color
       FROM vehicle_incident i
       JOIN dim_vehicle v ON v.vehicle_key = i.vehicle_key
       LEFT JOIN dim_route d ON d.route_key = i.route_key
      WHERE v.vehicle_id = ?
      ORDER BY i.started_ts DESC LIMIT 100`,
    [id],
  );
  const [presence] = await query<Record<string, number | string | null>>(
    `SELECT COUNT(*) AS days_active, SUM(runs) AS runs,
            ROUND(SUM(service_s) / 3600, 1) AS service_h,
            MIN(service_date) AS first_day, MAX(service_date) AS last_day
       FROM vehicle_presence p
       JOIN dim_vehicle v ON v.vehicle_key = p.vehicle_key
      WHERE v.vehicle_id = ? AND p.active = 1`,
    [id],
  );
  return c.json({ vehicleId: id, presence: presence ?? null, incidents: rows });
});

stats.get("/route/:short", async (c) => {
  const short = c.req.param("short");
  const to = c.req.query("to") ?? defDate();
  const from =
    c.req.query("from") ?? iso(new Date(Date.parse(to) - 29 * 86400_000));
  const rows = await query(
    `SELECT a.service_date, a.direction, a.runs, a.ghost_runs, a.events_n,
            a.otp_pct, a.early_pct, a.late_pct, a.avg_delay_s,
            a.p50_delay_s, a.p85_delay_s, a.p95_delay_s, a.bunching_n
       FROM agg_route_day a JOIN dim_route d ON d.route_key = a.route_key
      WHERE d.route_short = ? AND a.service_date BETWEEN ? AND ?
      ORDER BY a.service_date, a.direction`,
    [short, from, to],
  );
  return c.json({ route: short, from, to, days: rows });
});

stats.get("/stop/:id", async (c) => {
  const id = c.req.param("id");
  const to = c.req.query("to") ?? defDate();
  const from =
    c.req.query("from") ?? iso(new Date(Date.parse(to) - 6 * 86400_000));
  const rows = await query(
    `SELECT a.service_date, a.hour, a.events_n, a.otp_pct, a.avg_delay_s,
            a.p85_delay_s, a.avg_dwell_s, a.avg_headway_s
       FROM agg_stop_hour a JOIN dim_stop s ON s.stop_key = a.stop_key
      WHERE s.gtfs_stop_id = ? AND a.service_date BETWEEN ? AND ?
      ORDER BY a.service_date, a.hour`,
    [id, from, to],
  );
  return c.json({
    stop: id,
    name: stops.get(id)?.name ?? null,
    from,
    to,
    hours: rows,
  });
});

function sameNameStopIds(stopId: string): string[] {
  const name = stops.get(stopId)?.name;
  if (!name) return [stopId];
  const group = [...stops.values()]
    .filter((s) => s.name === name)
    .map((s) => s.id);
  return [stopId, ...group.filter((id) => id !== stopId)];
}
type PathStop = { stopId: string; schedGap: number };

function findPath(
  fromId: string,
  toId: string,
  targetSecOfDay: number,
  activeServiceIds: Set<string> | null,
): { chain: PathStop[]; via: string; schedDep: number } | null {
  let best: {
    chain: PathStop[];
    via: string;
    schedDep: number;
    hops: number;
    gap: number;
  } | null = null;

  for (const [tripId, t] of trips) {
    if (activeServiceIds && !activeServiceIds.has(t.serviceId)) continue;
    const seq = tripStops.get(tripId);
    if (!seq) continue;
    const a = seq.findIndex((x) => x.stopId === fromId);
    if (a < 0) continue;
    const b = seq.findIndex((x, i) => i > a && x.stopId === toId);
    if (b < 0) continue;

    const hops = b - a;
    const gap = Math.abs(seq[a].dep - targetSecOfDay);
    if (best && (hops > best.hops || (hops === best.hops && gap >= best.gap)))
      continue;

    const chain: PathStop[] = [];
    for (let i = a; i < b; i++) {
      chain.push({
        stopId: seq[i].stopId,
        schedGap: seq[i + 1].dep - seq[i].dep,
      });
    }
    chain.push({ stopId: seq[b].stopId, schedGap: 0 });
    best = { chain, via: tripId, schedDep: seq[a].dep, hops, gap };
  }
  return best
    ? { chain: best.chain, via: best.via, schedDep: best.schedDep }
    : null;
}

const LIVE_FALLBACK_MIN_N = 3;
const LIVE_FALLBACK_BUCKET_RADIUS = 8; // ±8 × 15 perc = ±2 óra

/**
 * Ha egy szakaszhoz még nincs éjszakai rollup-profilja (agg_segment_profile),
 * a nyers mérésekből (segment_run) számolunk azonnal — így friss, alig
 * néhány órás gyűjtés is használható, nem kell megvárni a hajnali job-ot.
 */
async function liveSegmentPercentiles(
  segKey: number,
  daytype: number,
  school: number,
  bucket: number,
): Promise<{ p50: number; p85: number; n: number } | null> {
  const [row] = await query<{
    n: number;
    p50_s: number | null;
    p85_s: number | null;
  }>(
    `SELECT COUNT(*) AS n,
            MAX(CASE WHEN rn = GREATEST(1, CEIL(cnt * 0.50)) THEN travel_s END) AS p50_s,
            MAX(CASE WHEN rn = GREATEST(1, CEIL(cnt * 0.85)) THEN travel_s END) AS p85_s
       FROM (
         SELECT travel_s,
                ROW_NUMBER() OVER (ORDER BY travel_s) AS rn,
                COUNT(*)     OVER ()                  AS cnt
           FROM segment_run
          WHERE segment_key = ?
            AND daytype = ? AND school = ?
            AND service_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND LEAST(ABS(tod_bucket - ?), 96 - ABS(tod_bucket - ?)) <= ?
       ) x`,
    [
      segKey,
      daytype,
      school,
      PROFILE_WINDOW_DAYS,
      bucket,
      bucket,
      LIVE_FALLBACK_BUCKET_RADIUS,
    ],
  );
  if (!row || row.n < LIVE_FALLBACK_MIN_N || row.p50_s == null) return null;
  return { p50: row.p50_s, p85: row.p85_s ?? row.p50_s, n: row.n };
}

stats.get("/segment", async (c) => {
  const fromId = (c.req.query("from") ?? "").trim();
  const toId = (c.req.query("to") ?? "").trim();
  if (!fromId || !toId)
    return c.json({ error: "hiányzó ?from= és ?to= megálló" }, 400);
  if (!stops.has(fromId) || !stops.has(toId))
    return c.json({ error: "ismeretlen megálló" }, 404);

  const atParam = c.req.query("at");
  const atUnix = atParam
    ? Math.floor(Date.parse(atParam) / 1000)
    : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(atUnix))
    return c.json({ error: "érvénytelen ?at= időpont" }, 400);

  const date = iso(new Date(atUnix * 1000));
  const startLocal = atUnix + budapestOffsetSec(new Date(atUnix * 1000));
  const targetSecOfDay = ((startLocal % 86400) + 86400) % 86400;

  const ymd = date.replace(/-/g, "");
  const active = activeServices(ymd);

  const fromGroup = sameNameStopIds(fromId);
  const toGroup = sameNameStopIds(toId);

  const searchAll = (svc: Set<string> | null) => {
    let best: ReturnType<typeof findPath> = null;
    for (const f of fromGroup) {
      for (const t of toGroup) {
        if (f === t) continue;
        const p = findPath(f, t, targetSecOfDay, svc);
        if (p && (!best || p.chain.length < best.chain.length)) best = p;
      }
    }
    return best;
  };

  let scheduleExact = active.size > 0;
  let path = scheduleExact ? searchAll(active) : null;
  if (!path) {
    scheduleExact = false;
    path = searchAll(null);
  }
  if (!path)
    return c.json({ error: "nincs közvetlen járat a két megálló között" }, 404);
  const [cal] = await query<{ daytype: number; school: number }>(
    `SELECT daytype, school FROM dim_calendar WHERE service_date = ?`,
    [date],
  );
  if (!cal) return c.json({ error: "a naptár nem fedi ezt a napot" }, 400);

  const ids = path.chain.map((x) => x.stopId);
  const keyRows = await query<{ gtfs_stop_id: string; stop_key: number }>(
    `SELECT gtfs_stop_id, stop_key FROM dim_stop WHERE gtfs_stop_id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  const skey = new Map(keyRows.map((r) => [r.gtfs_stop_id, r.stop_key]));

  const pairs: {
    segKey: number | null;
    from: string;
    to: string;
    schedGap: number;
  }[] = [];
  for (let i = 0; i < path.chain.length - 1; i++) {
    pairs.push({
      segKey: null,
      from: path.chain[i].stopId,
      to: path.chain[i + 1].stopId,
      schedGap: path.chain[i].schedGap,
    });
  }
  const segLookup = await query<{
    segment_key: number;
    from_stop_key: number;
    to_stop_key: number;
  }>(
    `SELECT segment_key, from_stop_key, to_stop_key FROM dim_segment
      WHERE from_stop_key IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  const byPair = new Map(
    segLookup.map((r) => [
      `${r.from_stop_key}>${r.to_stop_key}`,
      r.segment_key,
    ]),
  );
  for (const p of pairs) {
    const a = skey.get(p.from);
    const b = skey.get(p.to);
    p.segKey = a && b ? (byPair.get(`${a}>${b}`) ?? null) : null;
  }

  const segKeys = pairs
    .map((p) => p.segKey)
    .filter((k): k is number => k != null);
  const profiles = segKeys.length
    ? await query<{
        segment_key: number;
        tod_bucket: number;
        n: number;
        p50_s: number;
        p85_s: number;
        mean_s: number;
        sd_s: number;
      }>(
        `SELECT segment_key, tod_bucket, n, p50_s, p85_s, mean_s, sd_s
           FROM agg_segment_profile
          WHERE segment_key IN (${segKeys.map(() => "?").join(",")})
            AND daytype = ? AND school = ?`,
        [...segKeys, cal.daytype, cal.school],
      )
    : [];

  const profByKey = new Map<number, typeof profiles>();
  for (const p of profiles) {
    let a = profByKey.get(p.segment_key);
    if (!a) profByKey.set(p.segment_key, (a = []));
    a.push(p);
  }

  let cursor = 0;
  let schedTotal = 0;
  let p50Total = 0;
  let excessSq = 0;
  let minSamples = Infinity;
  let measured = 0;

  const legs: {
    from: string;
    to: string;
    schedS: number;
    p50S: number;
    p85S: number;
    samples: number;
    source: string;
  }[] = [];

  // Láncolt szakaszok: a következő szakasz indulási időpontja (és így a
  // időablaka) a megelőző szakaszok tényleges idejétől függ, ezért ez
  // sorban fut, nem párhuzamosan.
  for (const p of pairs) {
    const bucket = Math.floor(
      ((((startLocal + cursor) % 86400) + 86400) % 86400) / 900,
    );
    schedTotal += p.schedGap;

    const cands = p.segKey != null ? (profByKey.get(p.segKey) ?? []) : [];
    let hit = cands.find((x) => x.tod_bucket === bucket);
    if (!hit && cands.length) {
      hit = [...cands].sort((a, b) => {
        const da = Math.min(
          Math.abs(a.tod_bucket - bucket),
          96 - Math.abs(a.tod_bucket - bucket),
        );
        const db = Math.min(
          Math.abs(b.tod_bucket - bucket),
          96 - Math.abs(b.tod_bucket - bucket),
        );
        return da - db;
      })[0];
    }

    let p50 = hit?.p50_s;
    let p85 = hit?.p85_s;
    let samples = hit?.n ?? 0;
    let source: string;

    if (hit) {
      source = hit.tod_bucket === bucket ? "profil" : "profil-közelítő";
    } else if (p.segKey != null) {
      const live = await liveSegmentPercentiles(
        p.segKey,
        cal.daytype,
        cal.school,
        bucket,
      );
      if (live) {
        p50 = live.p50;
        p85 = live.p85;
        samples = live.n;
        source = "élő mérés";
      } else {
        source = "menetrend";
      }
    } else {
      source = "menetrend";
    }

    const p50Final = p50 ?? p.schedGap;
    const p85Final = p85 ?? p.schedGap;
    if (source !== "menetrend") {
      measured++;
      minSamples = Math.min(minSamples, samples);
    }
    p50Total += p50Final;
    excessSq += Math.max(0, p85Final - p50Final) ** 2;
    cursor += p50Final;

    legs.push({
      from: stops.get(p.from)?.name ?? p.from,
      to: stops.get(p.to)?.name ?? p.to,
      schedS: p.schedGap,
      p50S: p50Final,
      p85S: p85Final,
      samples,
      source,
    });
  }

  const p85Total = p50Total + Math.sqrt(excessSq);

  const [live] = segKeys.length
    ? await query<{ ratio: number | null; n: number }>(
        `SELECT SUM(r.travel_s) / NULLIF(SUM(p.p50_s), 0) AS ratio, COUNT(*) AS n
           FROM segment_run r
           JOIN agg_segment_profile p
             ON p.segment_key = r.segment_key AND p.daytype = r.daytype
            AND p.school = r.school AND p.tod_bucket = r.tod_bucket
          WHERE r.segment_key IN (${segKeys.map(() => "?").join(",")})
            AND r.dep_ts >= ?`,
        [...segKeys, Math.floor(Date.now() / 1000) - LIVE_WINDOW_MIN * 60],
      )
    : [{ ratio: null, n: 0 }];

  const liveRatio = live?.ratio && live.n >= 3 ? Number(live.ratio) : null;
  const isNow = Math.abs(atUnix - Math.floor(Date.now() / 1000)) < 1800;
  const applied =
    liveRatio && isNow ? Math.max(0.7, Math.min(2.0, liveRatio)) : null;

  const samples = minSamples === Infinity ? 0 : minSamples;
  const result = {
    from: stops.get(fromId)?.name,
    to: stops.get(toId)?.name,
    at: new Date(atUnix * 1000).toISOString(),
    daytype: cal.daytype,
    school: cal.school === 1,
    via: path.via,
    scheduleExact,
    stopsBetween: pairs.length,
    schedS: schedTotal,
    p50S: Math.round(applied ? p50Total * applied : p50Total),
    p85S: Math.round(applied ? p85Total * applied : p85Total),
    rawP50S: Math.round(p50Total),
    liveFactor: applied,
    liveSamples: live?.n ?? 0,
    samples,
    coverage: pairs.length ? Math.round((measured * 100) / pairs.length) : 0,
    confidence:
      samples >= LOW_CONFIDENCE_N && measured === pairs.length
        ? "magas"
        : samples > 0
          ? "alacsony"
          : "nincs adat",
    legs,
  };

  const fk = skey.get(fromId);
  const tk = skey.get(toId);
  if (fk && tk) {
    await query(
      `INSERT INTO prediction_log
         (made_at, from_stop_key, to_stop_key, target_ts, method, pred_p50_s, pred_p85_s, samples)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        Math.floor(Date.now() / 1000),
        fk,
        tk,
        atUnix,
        applied ? "profil+élő" : "profil",
        result.p50S,
        result.p85S,
        samples,
      ],
    ).catch(() => undefined);
  }

  return c.json(result);
});

stats.get("/network/slow", async (c) => {
  const bucketFrom = Number(c.req.query("from") ?? 28);
  const bucketTo = Number(c.req.query("to") ?? 36);
  const rows = await query(
    `SELECT sf.name AS from_name, st.name AS to_name,
            sf.lat_e7 AS from_lat, sf.lon_e7 AS from_lon,
            st.lat_e7 AS to_lat, st.lon_e7 AS to_lon,
            g.dist_m, SUM(p.n) AS n,
            ROUND(AVG(p.p50_s)) AS p50_s, ROUND(AVG(p.sched_s)) AS sched_s,
            ROUND(AVG(p.p50_s) - AVG(p.sched_s)) AS excess_s
       FROM agg_segment_profile p
       JOIN dim_segment g ON g.segment_key = p.segment_key
       JOIN dim_stop sf ON sf.stop_key = g.from_stop_key
       JOIN dim_stop st ON st.stop_key = g.to_stop_key
      WHERE p.tod_bucket BETWEEN ? AND ? AND p.daytype = 0 AND p.n >= 3
      GROUP BY p.segment_key, sf.name, st.name, sf.lat_e7, sf.lon_e7, st.lat_e7, st.lon_e7, g.dist_m
      ORDER BY excess_s DESC LIMIT 60`,
    [bucketFrom, bucketTo],
  );
  return c.json({ bucketFrom, bucketTo, segments: rows });
});
