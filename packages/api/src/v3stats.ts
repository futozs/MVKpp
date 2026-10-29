/** /v3/* statisztika az új felülethez: egyértelmű, napra / napszakra szűrhető mutatók. */
import { serviceClock, shiftIso } from "@mvk/core";
import { sql, sqlOne } from "@mvk/db";
import { cached, dispatch, intParam, isoDate, json, route, type Route } from "./http.ts";

const today = () => serviceClock().iso;

const routes: Route[] = [
  /** Egy nap a hálózaton: hány menet ment, mennyi volt pontos, hol késtek a legtöbbet. */
  route("GET", "/v3/stats/day", async (_req, _p, url) => {
    const date = isoDate(url.searchParams.get("date")) ?? shiftIso(today(), -1);
    const data = await cached(`day:${date}`, date >= today() ? 60_000 : 30 * 60_000, async () => {
      const runs = await sqlOne<{ runs: number; complete: number; partial: number; vehicles: number; routes: number }>(
        `SELECT count(*) FILTER (WHERE status <> 'aborted')::int AS runs, count(*) FILTER (WHERE status = 'complete')::int AS complete,
                count(*) FILTER (WHERE status = 'partial')::int AS partial, count(DISTINCT vehicle_id)::int AS vehicles, count(DISTINCT route_short)::int AS routes
           FROM trip_run WHERE service_date = $1`,
        [date],
      );
      const sched = await sqlOne<{ n_trips: number; fallback_template: string | null }>(`SELECT n_trips, fallback_template::text FROM service_day WHERE service_date = $1`, [date]);
      const delays = await sqlOne<{ n: number; ontime: number; early: number; late: number; avg: number | null; p50: number | null; p85: number | null }>(
        `SELECT sum(n)::int AS n, round(100.0 * sum(n_ontime) / nullif(sum(n), 0))::int AS ontime, round(100.0 * sum(n_early) / nullif(sum(n), 0))::int AS early,
                round(100.0 * sum(n_late) / nullif(sum(n), 0))::int AS late, round(sum(avg_delay_s * n) / nullif(sum(n), 0))::int AS avg,
                round(approx_percentile(0.5, rollup(delay_pct)))::int AS p50, round(approx_percentile(0.85, rollup(delay_pct)))::int AS p85
           FROM stop_event_hourly WHERE service_date = $1`,
        [date],
      );
      const hourly = await sql(
        `SELECT floor(extract(epoch FROM bucket - (service_date::timestamp AT TIME ZONE 'Europe/Budapest')) / 3600)::int AS hour,
                sum(n)::int AS n, round(sum(avg_delay_s * n) / nullif(sum(n), 0))::int AS avg_delay_s,
                round(100.0 * sum(n_ontime) / nullif(sum(n), 0))::int AS otp_pct, round(approx_percentile(0.85, rollup(delay_pct)))::int AS p85_delay_s
           FROM stop_event_hourly WHERE service_date = $1 GROUP BY 1 ORDER BY 1`,
        [date],
      );
      const worst = await sql(
        `SELECT h.route_short, ro.color, ro.text_color, sum(h.n)::int AS n, round(sum(h.avg_delay_s * h.n) / nullif(sum(h.n), 0))::int AS avg_delay_s,
                round(100.0 * sum(h.n_ontime) / nullif(sum(h.n), 0))::int AS otp_pct
           FROM stop_event_hourly h LEFT JOIN route ro USING (route_short)
          WHERE h.service_date = $1 GROUP BY 1, 2, 3 HAVING sum(h.n) >= 30 ORDER BY otp_pct ASC, avg_delay_s DESC LIMIT 12`,
        [date],
      );
      const incidents = await sql<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM incident WHERE service_date = $1 AND confidence >= 50 GROUP BY 1`, [date]);
      return { date, scheduledTrips: sched?.n_trips ?? null, scheduleFallback: sched?.fallback_template ?? null, runs, delays, hourly, worst, incidents };
    });
    return json(data);
  }),

  /**
   * Napszakos hálózatkép (reggeli / esti csúcs): óránkénti késés és
   * pontosság egy időszak átlagában, naptípus szerint, + a leglassabb szakaszok.
   */
  route("GET", "/v3/stats/network", async (_req, _p, url) => {
    const daytype = intParam(url.searchParams.get("daytype"), 0, 0, 2);
    const days = intParam(url.searchParams.get("days"), 30, 7, 365);
    const fromHour = intParam(url.searchParams.get("fromHour"), 7, 0, 26);
    const toHour = Math.max(fromHour + 1, intParam(url.searchParams.get("toHour"), 9, 1, 27));
    const data = await cached(`net:${daytype}:${days}:${fromHour}:${toHour}`, 10 * 60_000, async () => {
      const hourly = await sql(
        `SELECT floor(extract(epoch FROM h.bucket - (h.service_date::timestamp AT TIME ZONE 'Europe/Budapest')) / 3600)::int AS hour,
                count(DISTINCT h.service_date)::int AS days, sum(h.n)::int AS n,
                round(sum(h.avg_delay_s * h.n) / nullif(sum(h.n), 0))::int AS avg_delay_s,
                round(100.0 * sum(h.n_ontime) / nullif(sum(h.n), 0))::int AS otp_pct,
                round(100.0 * sum(h.n_late) / nullif(sum(h.n), 0))::int AS late_pct,
                round(approx_percentile(0.85, rollup(h.delay_pct)))::int AS p85_delay_s
           FROM stop_event_hourly h JOIN calendar_day c USING (service_date)
          WHERE c.daytype = $1 AND h.service_date >= CURRENT_DATE - $2::int AND h.service_date < CURRENT_DATE
          GROUP BY 1 ORDER BY 1`,
        [daytype, days],
      );
      const slow = await sql(
        `WITH s AS (
           SELECT from_stop, to_stop, sum(n)::int AS n, approx_percentile(0.5, rollup(travel_pct)) AS p50, approx_percentile(0.85, rollup(travel_pct)) AS p85,
                  sum(avg_sched_s * n) / nullif(sum(n), 0) AS sched
             FROM segment_daily
            WHERE bucket >= now() - make_interval(days => $2) AND daytype = $1 AND tod_bucket BETWEEN $3 * 4 AND $4 * 4 - 1
            GROUP BY 1, 2 HAVING sum(n) >= 8)
         SELECT s.from_stop, s.to_stop, sf.name AS from_name, st.name AS to_name, sf.lat AS from_lat, sf.lon AS from_lon, st.lat AS to_lat, st.lon AS to_lon,
                s.n, round(s.p50)::int AS p50_s, round(s.p85)::int AS p85_s, round(s.sched)::int AS sched_s, round(s.p50 - s.sched)::int AS excess_s,
                round(100 * (s.p50 - s.sched) / nullif(s.sched, 0))::int AS excess_pct
           FROM s JOIN stop sf ON sf.stop_id = s.from_stop JOIN stop st ON st.stop_id = s.to_stop
          WHERE s.sched > 0
          ORDER BY excess_s DESC NULLS LAST LIMIT 25`,
        [daytype, days, fromHour % 24, Math.min(24, toHour)],
      );
      return { daytype, days, fromHour, toHour, hourly, slow };
    });
    return json(data);
  }),

  /** Üzemzavarok v3: hivatalos törlések + észlelések, bizonyítékkal. */
  route("GET", "/v3/incidents", async (_req, _p, url) => {
    const to = isoDate(url.searchParams.get("to")) ?? today();
    const from = isoDate(url.searchParams.get("from")) ?? shiftIso(to, -13);
    const kind = url.searchParams.get("kind");
    const minConf = intParam(url.searchParams.get("minConfidence"), 50, 0, 100);
    const rows = await sql(
      `SELECT i.id, i.service_date::text, i.kind, i.source, i.confidence, i.route_short, ro.color, ro.text_color, i.trip_id, i.vehicle_id, i.stop_id, s.name AS stop_name,
              extract(epoch FROM i.started_at)::int AS started_ts, extract(epoch FROM i.ended_at)::int AS ended_ts, i.lat, i.lon, i.title, i.detail, i.evidence
         FROM incident i LEFT JOIN route ro USING (route_short) LEFT JOIN stop s USING (stop_id)
        WHERE i.service_date BETWEEN $1 AND $2 AND i.confidence >= $3 AND ($4::text IS NULL OR i.kind = $4)
        ORDER BY i.started_at DESC LIMIT 500`,
      [from, to, minConf, kind],
    );
    const byDay = await sql(
      `SELECT service_date::text, kind, count(*)::int AS n FROM incident WHERE service_date BETWEEN $1 AND $2 AND confidence >= $3 GROUP BY 1, 2 ORDER BY 1`,
      [from, to, minConf],
    );
    return json({ from, to, incidents: rows, byDay });
  }),

  /**
   * Rendszám-jóslás pontossága: a 30 / 15 / 5 perccel az indulás előtt
   * rögzített jóslatok, ahogy a menet tényleges indulásakor kiértékeltük őket.
   */
  route("GET", "/v3/stats/predictions", async (_req, _p, url) => {
    const to = isoDate(url.searchParams.get("to")) ?? today();
    const from = isoDate(url.searchParams.get("from")) ?? shiftIso(to, -13);
    const data = await cached(`predictions:${from}:${to}`, to >= today() ? 60_000 : 30 * 60_000, () => predictionOverview(from, to));
    return json(data);
  }),

  /** Melyik napokra van adat (a dátumválasztók csak ezeket kínálják). */
  route("GET", "/v3/stats/days", async () =>
    json(await cached("days", 5 * 60_000, async () => ({ days: (await sql<{ d: string }>(`SELECT DISTINCT service_date::text AS d FROM trip_run ORDER BY 1`)).map((x) => x.d) }))),
  ),
];

export const handleV3Stats = (req: Request) => dispatch(routes, req);

/** a kiértékelt jóslatok egy időszakban; $1 = from, $2 = to */
const RESOLVED = `SELECT * FROM vehicle_prediction WHERE correct IS NOT NULL AND service_date BETWEEN $1 AND $2`;
const RECENT_TRIPS = 500;

async function predictionOverview(from: string, to: string) {
  const args = [from, to];
  const [byHorizon, pending, calibration, byMethod, signals, weights, daily, byHour, byRoute, byVehicle, trips] = await Promise.all([
    sql(
      `SELECT horizon_min AS horizon, count(*)::int AS n, count(*) FILTER (WHERE correct)::int AS hits, round(avg(confidence)::numeric, 3)::float8 AS avg_conf
         FROM (${RESOLVED}) p GROUP BY 1 ORDER BY 1 DESC`,
      args,
    ),
    sqlOne<{ n: number }>(`SELECT count(*)::int AS n FROM vehicle_prediction WHERE correct IS NULL AND service_date = $1`, [today()]),
    sql(
      `SELECT least(floor(confidence * 10), 9)::int AS bucket, count(*)::int AS n, count(*) FILTER (WHERE correct)::int AS hits,
              round(avg(confidence)::numeric, 3)::float8 AS avg_conf
         FROM (${RESOLVED}) p GROUP BY 1 ORDER BY 1`,
      args,
    ),
    sql(
      `SELECT method, count(*)::int AS n, count(*) FILTER (WHERE correct)::int AS hits, round(avg(confidence)::numeric, 3)::float8 AS avg_conf
         FROM (${RESOLVED}) p GROUP BY 1 ORDER BY n DESC`,
      args,
    ),
    // Jelzésenként: ha egyedül ez döntött volna, hányszor lett volna igaza.
    sql(
      `SELECT f.key AS signal, count(*)::int AS n, count(*) FILTER (WHERE f.value = p.actual_vehicle)::int AS hits
         FROM (${RESOLVED}) p, jsonb_each_text(p.features) f GROUP BY 1 ORDER BY n DESC`,
      args,
    ),
    sql(`SELECT signal, weight::float8 AS weight, hits, misses FROM vehicle_model_weight ORDER BY signal`),
    sql(
      `SELECT service_date::text AS date, count(*)::int AS n, count(*) FILTER (WHERE correct)::int AS hits
         FROM (${RESOLVED}) p GROUP BY 1 ORDER BY 1`,
      args,
    ),
    sql(
      `SELECT (sched_start_s / 3600)::int AS hour, count(*)::int AS n, count(*) FILTER (WHERE correct)::int AS hits
         FROM (${RESOLVED}) p GROUP BY 1 ORDER BY 1`,
      args,
    ),
    sql(
      `SELECT p.route_short, ro.color, ro.text_color, count(*)::int AS n, count(*) FILTER (WHERE p.correct)::int AS hits
         FROM (${RESOLVED}) p LEFT JOIN route ro USING (route_short) GROUP BY 1, 2, 3 ORDER BY n DESC`,
      args,
    ),
    // Rendszámonként: hányszor vitte a jósolt menetet, ebből hányat találtunk
    // el, és hányszor jelöltük tévesen egy más által vitt menetre.
    sql(
      `WITH p AS (${RESOLVED})
       SELECT vehicle_id, sum(carried)::int AS n, sum(hit)::int AS hits, sum(wrong_pick)::int AS wrong_picks
         FROM (SELECT actual_vehicle AS vehicle_id, 1 AS carried, correct::int AS hit, 0 AS wrong_pick FROM p
               UNION ALL
               SELECT predicted_vehicle, 0, 0, 1 FROM p WHERE NOT correct) x
        GROUP BY 1 ORDER BY n DESC, vehicle_id`,
      args,
    ),
    sql(
      `SELECT p.service_date::text AS date, p.trip_id, p.route_short, ro.color, ro.text_color, p.sched_start_s,
              max(p.actual_vehicle) AS actual, max(r.headsign) AS headsign,
              jsonb_agg(jsonb_build_object('h', p.horizon_min, 'v', p.predicted_vehicle, 'ok', p.correct, 'c', p.confidence, 'm', p.method)
                        ORDER BY p.horizon_min DESC) AS guesses
         FROM (${RESOLVED}) p
         LEFT JOIN route ro USING (route_short)
         LEFT JOIN trip_run r ON r.service_date = p.service_date AND r.trip_id = p.trip_id AND r.vehicle_id = p.actual_vehicle
        GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1 DESC, 6 DESC LIMIT ${RECENT_TRIPS}`,
      args,
    ),
  ]);
  return { from, to, pendingToday: pending?.n ?? 0, byHorizon, calibration, byMethod, signals, weights, daily, byHour, byRoute, byVehicle, trips };
}
