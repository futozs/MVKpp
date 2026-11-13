/**
 * Hőtérképek a Statisztikához (lezárt napokból, gyorsítótárazva):
 *  · vonal  megálló × óra: mennyit késik a busz, és hol szedi össze a késést
 *  · város  megállóközönként, óránként: mennyi időt veszít a menetrendhez képest
 */
import { mainPattern, routeDirections, segmentPaths, type ServiceDay } from "@mvk/core";
import { cached } from "@mvk/cache";
import { sql } from "@mvk/db";

const CACHE_S = 30 * 60;
/** ennél kevesebb mérésből nem színezünk (zaj) */
const MIN_N = 3;

export type HeatQuery = { days: number; daytype: number };

export function clampHeatQuery(days: unknown, daytype: unknown): HeatQuery {
  const d = Number(days);
  const t = Number(daytype);
  return {
    days: Number.isFinite(d) ? Math.max(7, Math.min(90, Math.round(d))) : 28,
    daytype: Number.isFinite(t) ? Math.max(0, Math.min(2, Math.round(t))) : 0,
  };
}

type RouteCell = { stop_id: string; h: number; n: number; p50: number; p85: number; g50: number | null };

export async function routeHeat(day: ServiceDay, route: string, dir: string | null, q: HeatQuery) {
  const directions = routeDirections(day.feed, route);
  if (!directions.length) return null;
  const d = dir && directions.some((x) => x.dir === dir) ? dir : directions[0].dir;
  const pattern = mainPattern(day.feed, route, d);
  if (!pattern) return null;
  const key = `heat:route:${day.feed.version}:${route}:${d}:${q.days}:${q.daytype}`;
  const cells = await cached(key, CACHE_S, () =>
    sql<RouteCell>(
      `WITH e AS (
         SELECT e.stop_id,
                floor(extract(epoch FROM e.ts - (e.service_date::timestamp AT TIME ZONE 'Europe/Budapest')) / 3600)::int AS h,
                e.delay_s,
                e.delay_s - lag(e.delay_s) OVER (PARTITION BY e.run_key ORDER BY e.stop_idx) AS gain
           FROM stop_event e JOIN calendar_day c USING (service_date)
          WHERE e.route_short = $1 AND e.ts >= now() - make_interval(days => $2) AND e.service_date < ((now() AT TIME ZONE 'Europe/Budapest') - interval '3 hours')::date
            AND c.daytype = $3 AND e.src <> 3 AND split_part(e.trip_id, '_', 2) = ANY($4::text[]) AND e.stop_id = ANY($5::text[]))
       SELECT stop_id, h, count(*)::int AS n,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY delay_s))::int AS p50,
              round(percentile_cont(0.85) WITHIN GROUP (ORDER BY delay_s))::int AS p85,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gain))::int AS g50
         FROM e GROUP BY 1, 2 HAVING count(*) >= $6`,
      [route, q.days, q.daytype, pattern.shapeIds, pattern.stops.map((s) => s.id), MIN_N],
    ),
  );
  const idx = new Map(pattern.stops.map((s, i) => [s.id, i]));
  const hours = cells.length ? [Math.min(...cells.map((c) => c.h)), Math.max(...cells.map((c) => c.h))] : [5, 23];
  return {
    route,
    dir: d,
    ...q,
    directions,
    stops: pattern.stops,
    hours: { from: hours[0], to: hours[1] },
    // [megálló-index, óra, mérések, medián késés, 85% késés, medián késésnövekmény]
    cells: cells.filter((c) => idx.has(c.stop_id)).map((c) => [idx.get(c.stop_id)!, c.h, c.n, c.p50, c.p85, c.g50] as const),
  };
}

type CityCell = { from_stop: string; to_stop: string; h: number; n: number; ex: number; sched: number };

export async function cityHeat(day: ServiceDay, q: HeatQuery) {
  const key = `heat:city:${q.days}:${q.daytype}`;
  const rows = await cached(key, CACHE_S, () =>
    sql<CityCell>(
      `SELECT from_stop, to_stop, (tod_bucket / 4)::int AS h, sum(n)::int AS n,
              round(approx_percentile(0.5, rollup(travel_pct)) - sum(avg_sched_s * n) / nullif(sum(n), 0))::int AS ex,
              round(sum(avg_sched_s * n) / nullif(sum(n), 0))::int AS sched
         FROM segment_daily
        -- a városi hőtérkép az MVK-é: a regionális (előtagos) megállók szakaszai nem kellenek
        WHERE from_stop NOT LIKE '%:%' AND to_stop NOT LIKE '%:%' AND bucket >= now() - make_interval(days => $1) AND bucket < ((((now() AT TIME ZONE 'Europe/Budapest') - interval '3 hours')::date)::timestamp + interval '3 hours') AT TIME ZONE 'Europe/Budapest' AND daytype = $2
        GROUP BY 1, 2, 3 HAVING sum(n) >= $3`,
      [q.days, q.daytype, MIN_N],
    ),
  );
  const paths = segmentPaths(day.feed);
  const hours = rows.length ? { from: Math.min(...rows.map((r) => r.h)), to: Math.max(...rows.map((r) => r.h)) } : { from: 5, to: 23 };
  const span = hours.to - hours.from + 1;
  const bySeg = new Map<string, { ex: (number | null)[]; n: number[]; sched: (number | null)[] }>();
  for (const r of rows) {
    const k = `${r.from_stop}|${r.to_stop}`;
    if (!paths.has(k) || r.ex == null) continue;
    let s = bySeg.get(k);
    if (!s) bySeg.set(k, (s = { ex: Array(span).fill(null), n: Array(span).fill(0), sched: Array(span).fill(null) }));
    const i = r.h - hours.from;
    s.ex[i] = r.ex;
    s.n[i] = r.n;
    s.sched[i] = r.sched;
  }
  const stopName = (id: string) => day.feed.stops.get(id)?.name ?? id;
  return {
    ...q,
    hours,
    segments: [...bySeg.entries()].map(([k, s]) => {
      const p = paths.get(k)!;
      return { from: stopName(p.from), to: stopName(p.to), routes: p.routes, m: p.lengthM, path: p.path, ex: s.ex, n: s.n, sched: s.sched };
    }),
  };
}
