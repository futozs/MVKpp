/**
 * /stats/*  a v2-vel válaszformátumra kompatibilis statisztikai API, az
 * új (javított) adatokra építve. Minden szám mögött valódi esemény van:
 * a késés a megálló-eseményekből, a percentilisek a Timescale-aggregátumból.
 */
import { budapestOffsetSec, dayInfo, serviceClock, shiftIso } from "@mvk/core";
import { sql, sqlOne } from "@mvk/db";
import { ApiError, body, cached, dispatch, intParam, isoDate, json, route, scopeOf, scopeSql, type Route } from "./http.ts";

const today = () => serviceClock().iso;
const yesterday = () => shiftIso(today(), -1);

/**
 * Az idővonalon a szolgáltatási nap határai (3:00 → másnap 3:00) helyi időben.
 * A helyi falióra-időt váltjuk át (nem az éjfélhez adunk órákat), így az
 * óraátállítás napján is pontosan 3:00 a határ.
 */
const dayStart = (p: string) => `((${p}::date + time '03:00') AT TIME ZONE 'Europe/Budapest')`;
const dayEnd = (p: string) => `((${p}::date + 1 + time '03:00') AT TIME ZONE 'Europe/Budapest')`;

const routes: Route[] = [
  route("GET", "/stats/health", async () => {
    const h = await sqlOne(`SELECT service_date::text, polls_ok, polls_fail, pings_kept, 0 AS pings_dup, vehicles_max FROM feed_health ORDER BY service_date DESC LIMIT 1`);
    const counts = await cached("health-counts", 60_000, async () => {
      const r = await sqlOne<Record<string, number>>(
        `SELECT approximate_row_count('veh_ping')::bigint AS pings, (SELECT count(*) FROM trip_run) AS runs,
                approximate_row_count('stop_event')::bigint AS events, approximate_row_count('segment_run')::bigint AS segments,
                (SELECT count(*) FROM segment_daily) AS profiles, (SELECT count(*) FROM vehicle) AS vehicles`,
      );
      return r!;
    });
    const jobs = await sql(`SELECT job, last_ok_at AS started_at, last_ok_at AS ended_at, (last_error IS NULL)::int AS ok, 0 AS rows_out, last_error AS note FROM job_state ORDER BY job`);
    return json({ today: h, counts, jobs });
  }),

  route("GET", "/stats/vehicles", async (_req, _p, url) => {
    // ?modes= nélkül csak az MVK flottája (a v2 alapválasza); vele a Volán-buszok és a vonatok is
    const sc = scopeOf(url);
    return json({
      vehicles: await cached(`vehicles:${sc.key}`, 5 * 60_000, () =>
        sql(
          `SELECT v.vehicle_id, coalesce(v.kind, CASE WHEN v.vehicle_id LIKE '1:%' THEN 'RAIL' WHEN v.vehicle_id LIKE '%:%' THEN 'COACH' ELSE 'BUS' END) AS kind, v.last_seen, coalesce(a.runs, 0)::int AS runs, coalesce(a.days, 0)::int AS days,
                  a.last_date, round(coalesce(a.dist, 0) / 1000.0)::int AS dist_km
             FROM vehicle v LEFT JOIN (
               SELECT vehicle_id, count(*) AS runs, count(DISTINCT service_date) AS days, max(service_date)::text AS last_date, sum(dist_m) AS dist
                 FROM trip_run WHERE status <> 'aborted' GROUP BY vehicle_id) a USING (vehicle_id)
            WHERE ${scopeSql(sc, "v.vehicle_id")}
            ORDER BY v.last_seen DESC`,
        ),
      ),
    });
  }),

  /**
   * Egy jármű napja. ÚJ: `days`  azok a napok, amelyeken a jármű ténylegesen
   * közlekedett, így a dátumléptető üres napot nem kínál fel.
   */
  route("GET", "/stats/vehicle/:id", async (_req, p, url) => {
    const id = p.id;
    const days = (await sql<{ d: string }>(`SELECT DISTINCT service_date::text AS d FROM trip_run WHERE vehicle_id = $1 AND status <> 'aborted' ORDER BY d DESC LIMIT 500`, [id])).map((x) => x.d);
    const date = isoDate(url.searchParams.get("date")) ?? days[0] ?? yesterday();
    const runs = await sql(
      `SELECT r.run_id, r.sched_start_s, r.sched_end_s, extract(epoch FROM r.actual_start)::int AS actual_start, extract(epoch FROM r.actual_end)::int AS actual_end,
              r.start_delay_s, r.end_delay_s, r.dist_m, r.stops_seen, r.stops_total,
              round(100.0 * r.stops_seen / greatest(r.stops_total, 1))::int AS quality, r.status, r.route_short, ro.color, r.headsign, r.direction,
              r.trip_id, r.last_delay_s, r.source
         FROM trip_run r LEFT JOIN route ro USING (route_short)
        WHERE r.vehicle_id = $1 AND r.service_date = $2 ORDER BY r.sched_start_s`,
      [id, date],
    );
    const summary = runs.length
      ? await sqlOne(
          `WITH r AS (SELECT * FROM trip_run WHERE vehicle_id = $1 AND service_date = $2 AND status <> 'aborted'),
                e AS (SELECT delay_s, dwell_s FROM stop_event WHERE vehicle_id = $1 AND service_date = $2 AND src <> 3),
                p AS (SELECT min(ts) AS t0, max(ts) AS t1 FROM veh_ping WHERE vehicle_id = $1 AND ts >= ${dayStart("$2")} AND ts < ${dayEnd("$2")})
           SELECT (SELECT count(*) FROM r)::int AS runs, (SELECT count(DISTINCT route_short) FROM r)::int AS routes_n,
                  coalesce((SELECT sum(dist_m) FROM r), 0)::int AS dist_m,
                  coalesce((SELECT sum(extract(epoch FROM actual_end - actual_start)) FROM r WHERE actual_end > actual_start), 0)::int AS service_s,
                  NULL::int AS moving_s, coalesce((SELECT sum(dwell_s) FROM e), 0)::int AS dwell_s,
                  (SELECT round(max(max_speed) * 10) FROM r)::int AS max_speed_dms,
                  (SELECT round(avg(delay_s)) FROM e)::int AS avg_delay_s,
                  (SELECT percentile_disc(0.85) WITHIN GROUP (ORDER BY delay_s) FROM e) AS p85_delay_s,
                  extract(epoch FROM (SELECT t0 FROM p))::int AS first_ts, extract(epoch FROM (SELECT t1 FROM p))::int AS last_ts,
                  NULL::int AS depot_lat_e7, NULL::int AS depot_lon_e7,
                  (SELECT count(*) FROM r WHERE status = 'partial')::int AS gaps_n`,
          [id, date],
        )
      : null;
    return json({ vehicleId: id, date, summary, runs, days });
  }),

  route("GET", "/stats/vehicle/:id/track", async (_req, p, url) => {
    const date = isoDate(url.searchParams.get("date")) ?? yesterday();
    const every = intParam(url.searchParams.get("every"), 3, 1, 60);
    const rows = await sql<{ ts: number; lat: number; lon: number; sp: number | null; tr: string | null }>(
      `SELECT extract(epoch FROM ts)::int AS ts, lat, lon, round(speed * 10)::int AS sp, trip_id AS tr
         FROM veh_ping WHERE vehicle_id = $1 AND ts >= ${dayStart("$2")} AND ts < ${dayEnd("$2")}
        ORDER BY ts`,
      [p.id, date],
    );
    const track = rows.filter((_, i) => i % every === 0).map((r) => [r.ts, +r.lat.toFixed(6), +r.lon.toFixed(6), r.sp, r.tr ? 1 : null]);
    return json({ vehicleId: p.id, date, points: track.length, ofTotal: rows.length, track });
  }),

  route("GET", "/stats/vehicle/:id/routes", async (_req, p, url) => {
    const ym = url.searchParams.get("ym");
    const rows = await sql(
      `WITH m AS (
         SELECT to_char(service_date, 'YYYYMM')::int AS period_ym, route_short, count(*) AS runs, sum(dist_m) AS dist,
                sum(extract(epoch FROM actual_end - actual_start)) FILTER (WHERE actual_end > actual_start) AS service_s,
                count(DISTINCT service_date) AS days_active, avg(start_delay_s) AS avg_delay_s
           FROM trip_run WHERE vehicle_id = $1 AND status <> 'aborted' GROUP BY 1, 2)
       SELECT m.period_ym, m.route_short, ro.color, coalesce(ro.kind, 'BUS') AS kind, m.runs::int,
              least(100, round(100.0 * m.runs / sum(m.runs) OVER (PARTITION BY m.period_ym)))::int AS share_pct,
              round(coalesce(m.dist, 0) / 1000.0)::int AS dist_km, coalesce(m.service_s, 0)::int AS service_s, m.days_active::int,
              round(m.avg_delay_s)::int AS avg_delay_s
         FROM m LEFT JOIN route ro USING (route_short)
        ${ym ? "WHERE m.period_ym = $2" : ""}
        ORDER BY m.period_ym DESC, m.runs DESC`,
      ym ? [p.id, Number(ym)] : [p.id],
    );
    return json({ vehicleId: p.id, routes: rows });
  }),

  route("GET", "/stats/vehicle/:id/predict-route", async (_req, p) => {
    const rows = await sql<{ route_short: string; color: string | null; runs: number; avg_delay_s: number | null }>(
      `SELECT r.route_short, ro.color, count(*)::int AS runs, round(avg(r.start_delay_s))::int AS avg_delay_s
         FROM trip_run r LEFT JOIN route ro USING (route_short)
        WHERE r.vehicle_id = $1 AND r.service_date >= CURRENT_DATE - 180 AND r.status <> 'aborted'
        GROUP BY 1, 2 ORDER BY runs DESC LIMIT 5`,
      [p.id],
    );
    const total = rows.reduce((a, r) => a + r.runs, 0);
    return json({
      vehicleId: p.id,
      samples: total,
      candidates: rows.map((r) => ({ routeShort: r.route_short, color: r.color, probabilityPct: total ? Math.round((100 * r.runs) / total) : 0, avgDelaySec: r.avg_delay_s })),
    });
  }),

  route("GET", "/stats/predictions/accuracy", async (_req, _p, url) => {
    const to = isoDate(url.searchParams.get("to")) ?? today();
    const from = isoDate(url.searchParams.get("from")) ?? shiftIso(to, -59);
    const sc = scopeSql(scopeOf(url), "trip_id");
    const overall = await sqlOne<{ n: number; correct: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE correct)::int AS correct FROM vehicle_prediction WHERE correct IS NOT NULL AND service_date BETWEEN $1 AND $2 AND ${sc}`,
      [from, to],
    );
    const daily = await sql(
      `SELECT service_date::text, count(*)::int AS n, count(*) FILTER (WHERE correct)::int AS correct FROM vehicle_prediction
        WHERE correct IS NOT NULL AND service_date BETWEEN $1 AND $2 AND ${sc} GROUP BY 1 ORDER BY 1`,
      [from, to],
    );
    const byVehicle = await sql(
      `SELECT actual_vehicle AS vehicle_id, count(*)::int AS n, count(*) FILTER (WHERE correct)::int AS correct FROM vehicle_prediction
        WHERE correct IS NOT NULL AND service_date BETWEEN $1 AND $2 AND ${sc} GROUP BY 1 HAVING count(*) >= 3 ORDER BY n DESC LIMIT 30`,
      [from, to],
    );
    return json({ from, to, total: overall?.n ?? 0, correct: overall?.correct ?? 0, accuracyPct: overall?.n ? Math.round((100 * overall.correct) / overall.n) : null, daily, byVehicle });
  }),

  // A v2-kompatibilis üzemzavar-lista csak a régi típusneveket használja
  // (az iOS app szigorú enummal dekódolhat): a meghibásodás → mid_trip_stop.
  route("GET", "/stats/incidents", async (_req, _p, url) => {
    const to = isoDate(url.searchParams.get("to")) ?? today();
    const from = isoDate(url.searchParams.get("from")) ?? shiftIso(to, -29);
    const minConf = intParam(url.searchParams.get("minConfidence"), 50, 0, 100);
    const kind = url.searchParams.get("kind");
    if (kind && kind !== "mid_trip_stop") return json({ from, to, minConfidence: minConf, incidents: [] });
    return json({ from, to, minConfidence: minConf, incidents: await legacyIncidents(from, to, minConf, null) });
  }),

  route("GET", "/stats/incidents/summary", async (_req, _p, url) => {
    const to = isoDate(url.searchParams.get("to")) ?? today();
    const from = isoDate(url.searchParams.get("from")) ?? shiftIso(to, -89);
    const minConf = intParam(url.searchParams.get("minConfidence"), 50, 0, 100);
    const fleet = await sql(
      `WITH p AS (SELECT vehicle_id, count(DISTINCT service_date) AS days_active, count(*) AS runs,
                         round((sum(extract(epoch FROM actual_end - actual_start)) FILTER (WHERE actual_end > actual_start) / 3600.0)::numeric, 1) AS service_h
                    FROM trip_run WHERE service_date BETWEEN $1 AND $2 AND status <> 'aborted' AND vehicle_id NOT LIKE '%:%' GROUP BY 1),
            i AS (SELECT vehicle_id, count(*) AS n FROM incident WHERE kind = 'breakdown' AND service_date BETWEEN $1 AND $2 AND confidence >= $3 GROUP BY 1)
       SELECT p.vehicle_id, coalesce(v.kind, 'BUS') AS vehicle_kind, p.days_active::int, p.runs::int, coalesce(p.service_h, 0)::float8 AS service_h,
              coalesce(i.n, 0)::int AS incidents, coalesce(i.n, 0)::int AS mid_trip, 0 AS stuck, 0 AS no_signal, 0 AS absences, 0 AS absent_days,
              NULL::int AS absent_since, round(coalesce(i.n, 0) / greatest(coalesce(p.service_h, 0), 1), 3)::float8 AS per_hour
         FROM p LEFT JOIN i USING (vehicle_id) LEFT JOIN vehicle v USING (vehicle_id)
        ORDER BY per_hour DESC, incidents DESC LIMIT 200`,
      [from, to, minConf],
    );
    const byKind = await sql(
      `SELECT 'mid_trip_stop' AS kind, count(*)::int AS n, round(avg(confidence))::int AS avg_conf,
              round(avg(extract(epoch FROM ended_at - started_at)))::int AS avg_duration_s
         FROM incident WHERE kind = 'breakdown' AND service_date BETWEEN $1 AND $2 AND confidence >= $3`,
      [from, to, minConf],
    );
    const daily = await sql(
      `SELECT service_date::text, count(*)::int AS n FROM incident WHERE kind = 'breakdown' AND service_date BETWEEN $1 AND $2 AND confidence >= $3 GROUP BY 1 ORDER BY 1`,
      [from, to, minConf],
    );
    return json({ from, to, fleet, byKind: byKind.filter((x) => (x as { n: number }).n > 0), daily, repairs: [] });
  }),

  route("GET", "/stats/vehicle/:id/incidents", async (_req, p) => {
    const presence = await sqlOne(
      `SELECT count(DISTINCT service_date)::int AS days_active, count(*)::int AS runs,
              round((sum(extract(epoch FROM actual_end - actual_start)) FILTER (WHERE actual_end > actual_start) / 3600.0)::numeric, 1)::float8 AS service_h,
              min(service_date)::text AS first_day, max(service_date)::text AS last_day
         FROM trip_run WHERE vehicle_id = $1 AND status <> 'aborted'`,
      [p.id],
    );
    return json({ vehicleId: p.id, presence, incidents: await legacyIncidents("2000-01-01", "2100-01-01", 0, p.id) });
  }),

  route("GET", "/stats/route/:short", async (_req, p, url) => {
    const to = isoDate(url.searchParams.get("to")) ?? yesterday();
    const from = isoDate(url.searchParams.get("from")) ?? shiftIso(to, -29);
    const days = await cached(`route:${p.short}:${from}:${to}`, to >= today() ? 60_000 : 600_000, () =>
      sql(
        `WITH runs AS (
           SELECT service_date, direction, count(*) FILTER (WHERE status <> 'aborted')::int AS runs FROM trip_run
            WHERE route_short = $1 AND service_date BETWEEN $2 AND $3 GROUP BY 1, 2),
         missed AS (
           SELECT service_date, count(*)::int AS n FROM incident WHERE route_short = $1 AND kind IN ('missed', 'cancelled') AND service_date BETWEEN $2 AND $3 GROUP BY 1),
         d AS (
           SELECT service_date, sum(n)::int AS n, sum(n_ontime)::float8 AS ontime, sum(n_early)::float8 AS early, sum(n_late)::float8 AS late,
                  sum(avg_delay_s * n) / nullif(sum(n), 0) AS avg_d, rollup(delay_pct) AS pct
             FROM stop_event_hourly WHERE route_short = $1 AND service_date BETWEEN $2 AND $3 GROUP BY 1),
         b AS (
           SELECT service_date, count(*) FILTER (WHERE headway_s < 120)::int AS bn FROM stop_event
            WHERE route_short = $1 AND service_date BETWEEN $2 AND $3 AND headway_s IS NOT NULL GROUP BY 1)
         SELECT runs.service_date::text, runs.direction, runs.runs, coalesce(missed.n, 0) AS ghost_runs, coalesce(d.n, 0) AS events_n,
                round(100 * d.ontime / nullif(d.n, 0))::int AS otp_pct, round(100 * d.early / nullif(d.n, 0))::int AS early_pct,
                round(100 * d.late / nullif(d.n, 0))::int AS late_pct, round(d.avg_d)::int AS avg_delay_s,
                round(approx_percentile(0.5, d.pct))::int AS p50_delay_s, round(approx_percentile(0.85, d.pct))::int AS p85_delay_s,
                round(approx_percentile(0.95, d.pct))::int AS p95_delay_s, coalesce(b.bn, 0) AS bunching_n
           FROM runs LEFT JOIN d USING (service_date) LEFT JOIN missed USING (service_date) LEFT JOIN b USING (service_date)
          ORDER BY 1, 2`,
        [p.short, from, to],
      ),
    );
    return json({ route: p.short, from, to, days });
  }),

  route("GET", "/stats/stop/:id", async (_req, p, url) => {
    const to = isoDate(url.searchParams.get("to")) ?? yesterday();
    const from = isoDate(url.searchParams.get("from")) ?? shiftIso(to, -6);
    // a regionális állomás (Tiszai pu., Búza téri autóbusz-állomás) a vágányaival / kocsiállásaival együtt
    const stopMatch = p.id.includes(":") ? `(stop_id = $1 OR stop_id IN (SELECT stop_id FROM stop WHERE parent_station = $1))` : `stop_id = $1`;
    const hours = await cached(`stop:${p.id}:${from}:${to}`, to >= today() ? 60_000 : 600_000, () =>
      sql(
        `SELECT service_date::text,
                floor(extract(epoch FROM bucket - (service_date::timestamp AT TIME ZONE 'Europe/Budapest')) / 3600)::int AS hour,
                sum(n)::int AS events_n, round(100.0 * sum(n_ontime) / nullif(sum(n), 0))::int AS otp_pct,
                round(sum(avg_delay_s * n) / nullif(sum(n), 0))::int AS avg_delay_s,
                round(approx_percentile(0.85, rollup(delay_pct)))::int AS p85_delay_s,
                round(sum(avg_dwell_s * n) / nullif(sum(n) FILTER (WHERE avg_dwell_s IS NOT NULL), 0))::int AS avg_dwell_s,
                round(avg(avg_headway_s))::int AS avg_headway_s
           FROM stop_event_hourly WHERE ${stopMatch} AND service_date BETWEEN $2 AND $3
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [p.id, from, to],
      ),
    );
    const name = (await sqlOne<{ name: string }>(`SELECT name FROM stop WHERE stop_id = $1`, [p.id]))?.name ?? null;
    return json({ stop: p.id, name, from, to, hours });
  }),

  route("GET", "/stats/network/slow", async (_req, _p, url) => {
    const bf = Math.max(0, Math.min(95, Number(url.searchParams.get("from") ?? 28) || 0));
    const bt = Math.max(bf, Math.min(95, Number(url.searchParams.get("to") ?? 36) || 0));
    const daytype = intParam(url.searchParams.get("daytype"), 0, 0, 2);
    const sc = scopeOf(url);
    const segments = await cached(`slow:${bf}:${bt}:${daytype}:${sc.key}`, 10 * 60_000, () =>
      sql(
        `WITH s AS (
           SELECT from_stop, to_stop, sum(n)::int AS n, approx_percentile(0.5, rollup(travel_pct)) AS p50,
                  sum(avg_sched_s * n) / nullif(sum(n), 0) AS sched
             FROM segment_daily
            WHERE bucket >= now() - interval '60 days' AND tod_bucket BETWEEN $1 AND $2 AND daytype = $3
              AND ${scopeSql(sc, "from_stop")} AND ${scopeSql(sc, "to_stop")}
            GROUP BY 1, 2 HAVING sum(n) >= 5)
         SELECT sf.name AS from_name, st.name AS to_name,
                round(sf.lat * 1e7)::int AS from_lat, round(sf.lon * 1e7)::int AS from_lon,
                round(st.lat * 1e7)::int AS to_lat, round(st.lon * 1e7)::int AS to_lon,
                round(ST_Distance(sf.geom, st.geom))::int AS dist_m, s.n, round(s.p50)::int AS p50_s,
                round(s.sched)::int AS sched_s, round(s.p50 - s.sched)::int AS excess_s
           FROM s JOIN stop sf ON sf.stop_id = s.from_stop JOIN stop st ON st.stop_id = s.to_stop
          ORDER BY excess_s DESC NULLS LAST LIMIT 60`,
        [bf, bt, daytype],
      ),
    );
    return json({ bucketFrom: bf, bucketTo: bt, segments });
  }),

  route("POST", "/stats/route-delays", async (req) => {
    const b = await body<{ at?: string; legs?: { routeShort?: string; stopId?: string }[] }>(req);
    const atUnix = b?.at ? Math.floor(Date.parse(b.at) / 1000) : Math.floor(Date.now() / 1000);
    const legs = b?.legs ?? [];
    if (!Number.isFinite(atUnix) || !Array.isArray(legs) || !legs.length) throw new ApiError(400, "hiányzó ?at= vagy legs[]");
    if (legs.length > 20) throw new ApiError(400, "legfeljebb 20 leg egyszerre");
    const results = await Promise.all(legs.map((l) => (l.routeShort && l.stopId ? routeStopDelay(l.routeShort, l.stopId, atUnix) : { avgDelaySec: null, samples: 0 })));
    return json({ results });
  }),

  route("GET", "/stats/segment", async (_req, _p, url) => {
    // Az útvonaltervező v3-ban a motorba költözött (/engine/plan); ez a
    // végpont a v2-kliensek kedvéért egy megállópárra ad becslést.
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const at = url.searchParams.get("at");
    const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8090";
    const r = await fetch(`${workerUrl}/engine/segment?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${at ? `&at=${encodeURIComponent(at)}` : ""}`);
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json; charset=utf-8" } });
  }),
];

async function legacyIncidents(from: string, to: string, minConf: number, vehicleId: string | null) {
  return sql(
    `SELECT i.id AS incident_id, 'mid_trip_stop' AS kind, i.service_date::text, extract(epoch FROM i.started_at)::int AS started_ts,
            extract(epoch FROM i.ended_at)::int AS ended_ts, extract(epoch FROM i.ended_at - i.started_at)::int AS duration_s,
            (i.evidence->>'progressPct')::int AS progress_pct, CASE WHEN i.confidence >= 75 THEN 4 ELSE 3 END AS severity, i.confidence,
            0 AS peers_stuck, NULL::int AS absent_days, CASE WHEN i.ended_at IS NULL THEN 'nem tért vissza' ELSE 'aznap folytatta' END AS resolution,
            i.detail AS note, round(i.lat * 1e7)::int AS lat_e7, round(i.lon * 1e7)::int AS lon_e7, i.vehicle_id,
            coalesce(v.kind, 'BUS') AS vehicle_kind, i.route_short, ro.color
       FROM incident i LEFT JOIN vehicle v USING (vehicle_id) LEFT JOIN route ro USING (route_short)
      WHERE i.kind = 'breakdown' AND i.service_date BETWEEN $1 AND $2 AND i.confidence >= $3 AND ($4::text IS NULL OR i.vehicle_id = $4)
      ORDER BY i.started_at DESC LIMIT 300`,
    [from, to, minConf, vehicleId],
  );
}

/** Átlagos késés egy vonalon egy megállóban az adott napszak körül (a tervező késés-jelzéséhez). */
async function routeStopDelay(routeShort: string, stopId: string, atUnix: number) {
  const iso = serviceClock(atUnix).iso;
  const info = dayInfo(iso);
  const local = atUnix + budapestOffsetSec(atUnix);
  const hour = Math.floor((((local % 86400) + 86400) % 86400) / 3600);
  const stripped = stopId.replace(/^\d+:/, "");
  return cached(`rsd:${routeShort}:${stripped}:${info.daytype}:${info.school}:${hour}`, 30 * 60_000, async () => {
    const r = await sqlOne<{ n: number; avg: number | null }>(
      `SELECT sum(h.n)::int AS n, sum(h.avg_delay_s * h.n) / nullif(sum(h.n), 0) AS avg
         FROM stop_event_hourly h JOIN calendar_day c USING (service_date)
        WHERE h.route_short = $1 AND h.stop_id = $2 AND c.daytype = $3 AND h.service_date >= CURRENT_DATE - 120
          AND abs(extract(hour FROM h.bucket AT TIME ZONE 'Europe/Budapest') - $4) <= 1`,
      [routeShort, stripped, info.daytype, hour],
    );
    return { avgDelaySec: r?.avg != null && r.n >= 3 ? Math.round(r.avg) : null, samples: r?.n ?? 0 };
  });
}

export const handleStats = (req: Request) => dispatch(routes, req);
