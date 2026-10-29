/** v3 motor-végpontok: menet-részletek, idővonal (múltbeli helyzetek), élő zavarok. */
import { localMidnightUnix, nowUnix, secToHm, tripStopRows } from "@mvk/core";
import { cached } from "@mvk/cache";
import { sql } from "@mvk/db";
import { HttpError, sendJson, type Router } from "./router.ts";
import type { Ctx } from "./compat.ts";
import { plan, segmentEstimate } from "../planner.ts";

/** ennél régebbi időpont adatai már nem változnak → hosszan gyorsítótárazható */
const SETTLED_S = 600;
const DAY_S = 86_400;

const isoOf = (v: string | null, fallback: string) => {
  const s = (v ?? "").trim();
  if (!s) return fallback;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new HttpError(400, "érvénytelen dátum");
};

export function registerV3(r: Router, ctx: Ctx) {
  const { engine, feeds, predictor } = ctx;

  /**
   * Egy menet megállónként: menetrend + tény (érkezés, indulás, késés).
   * A mai napon az élő illesztő eseményei is benne vannak — nincs többé
   * órás várakozás az „indult” időpontra.
   */
  r.get("/engine/trip", async (req, res) => {
    const tripId = (req.query.get("trip") ?? "").trim();
    if (!tripId) throw new HttpError(400, "hiányzó ?trip=");
    const iso = isoOf(req.query.get("date"), engine.today);
    const day = await feeds.serviceDay(iso);
    const stops = day ? tripStopRows(day.feed, tripId) : null;
    const runs = await sql(
      `SELECT run_key, vehicle_id, status, stops_seen, stops_total, start_delay_s, end_delay_s, last_delay_s, last_stop_idx,
              extract(epoch FROM actual_start)::int AS actual_start, extract(epoch FROM actual_end)::int AS actual_end, source
         FROM trip_run WHERE service_date = $1 AND trip_id = $2 ORDER BY stops_seen DESC`,
      [iso, tripId],
    );
    const live = iso === engine.today ? engine.todayRuns.get(tripId) : undefined;
    const runKey = live?.runKey ?? (runs[0] as { run_key?: string } | undefined)?.run_key ?? null;
    const events = runKey
      ? await sql(
          `SELECT stop_idx, stop_id, extract(epoch FROM ts)::int AS arr, extract(epoch FROM dep_ts)::int AS dep, delay_s, dwell_s, src
             FROM stop_event WHERE run_key = $1 ORDER BY stop_idx`,
          [runKey],
        )
      : [];
    const midnight = localMidnightUnix(iso);
    sendJson(req, res, 200, {
      date: iso,
      tripId,
      known: Boolean(stops),
      stops: (stops ?? []).map((s, i) => ({ ...s, schedTime: secToHm(s.dep), schedTs: midnight + s.dep, idx: i })),
      run: live ?? runs[0] ?? null,
      liveDelaySec: live?.status === "running" ? engine.matcher.liveDelay(tripId, nowUnix()) : null,
      events,
      cancelled: iso === engine.today ? engine.cancelled.ids.has(tripId) : Boolean((await sql(`SELECT 1 FROM cancelled_trip WHERE service_date = $1 AND trip_id = $2`, [iso, tripId]))[0]),
      predictedVehicle: iso === engine.today && !live ? predictor.predict(tripId) : null,
    });
  });

  /** Idővonal: minden jármű helyzete egy múltbeli pillanatban. */
  r.get("/engine/history/at", async (req, res) => {
    const at = Number(req.query.get("t"));
    if (!Number.isFinite(at)) throw new HttpError(400, "hiányzó ?t= (unix mp)");
    const load = () =>
      sql(
        `SELECT DISTINCT ON (vehicle_id) vehicle_id AS id, extract(epoch FROM ts)::int AS ts, lat, lon, bearing, speed, trip_id, route_short
           FROM veh_ping WHERE ts BETWEEN to_timestamp($1) - interval '3 minutes' AND to_timestamp($1)
          ORDER BY vehicle_id, ts DESC`,
        [at],
      );
    const settled = at < nowUnix() - SETTLED_S;
    const rows = settled ? await cached(`hist-at:${at}`, DAY_S, load) : await load();
    sendJson(req, res, 200, { t: at, vehicles: rows }, { "cache-control": settled ? "public, max-age=86400" : "no-store" });
  });

  /**
   * Idővonal-lejátszáshoz: az összes pont egy legfeljebb 2 órás ablakban,
   * járművenként tömörítve; a lezárult ablakok gyorsítótárból jönnek.
   */
  r.get("/engine/history/frames", async (req, res) => {
    const from = Number(req.query.get("from"));
    const to = Number(req.query.get("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new HttpError(400, "?from= és ?to= (unix mp) kell");
    if (to - from > 2 * 3600) throw new HttpError(400, "legfeljebb 2 órás ablak kérhető");
    const route = req.query.get("route");
    const settled = to < nowUnix() - SETTLED_S;
    const build = () => historyFrames(from, to, route);
    const vehicles = settled ? await cached(`frames:${from}:${to}:${route ?? ""}`, 7 * DAY_S, build) : await build();
    sendJson(req, res, 200, { from, to, vehicles }, { "cache-control": settled ? "public, max-age=86400" : "no-store" });
  });

  /** Mely napokra van GPS-történet (az idővonal napválasztójához). */
  r.get("/engine/history/days", async (req, res) => {
    const data = await cached("hist-days", 300, async () => {
      const runs = await sql<{ d: string; n: number }>(
        `SELECT service_date::text AS d, count(*)::int AS n FROM trip_run WHERE service_date >= CURRENT_DATE - 400 GROUP BY 1 ORDER BY 1`,
      );
      const pings = await sql<{ mn: string | null; mx: string | null }>(`SELECT min(ts)::date::text AS mn, max(ts)::date::text AS mx FROM veh_ping`);
      return { runs, gps: pings[0] ?? null };
    });
    sendJson(req, res, 200, data);
  });

  /** Élő zavarok a fejléc-jelvényhez: hivatalos törlések + most valószínűleg kimaradó menetek. */
  r.get("/engine/incidents/live", (req, res) => {
    const day = feeds.cachedDay(engine.today);
    const now = nowUnix();
    const midnight = localMidnightUnix(engine.today);
    const cancelled = [...engine.cancelled.ids];
    const missing: { tripId: string; route: string; time: string; headsign: string; lateMin: number }[] = [];
    if (day && engine.poll.lastOkAt && Date.now() - engine.poll.lastOkAt < 120_000) {
      const started = new Map<string, number>();
      for (const run of engine.todayRuns.values()) started.set(run.routeShort, (started.get(run.routeShort) ?? 0) + 1);
      for (const t of day.feed.trips.values()) {
        if (!day.services.has(t.serviceId) || engine.todayRuns.has(t.id) || engine.cancelled.ids.has(t.id)) continue;
        const st = day.feed.tripStops.get(t.id);
        if (!st?.length) continue;
        const late = now - (midnight + st[0].dep);
        if (late < 15 * 60 || late > 90 * 60) continue;
        const route = day.feed.routes.get(t.routeId)?.short ?? t.routeId;
        if ((started.get(route) ?? 0) < 3) continue; // ezen a vonalon ma alig látunk járművet → nem gyanakszunk
        missing.push({ tripId: t.id, route, time: secToHm(st[0].dep), headsign: t.headsign, lateMin: Math.round(late / 60) });
      }
    }
    sendJson(req, res, 200, { date: engine.today, cancelled: cancelled.length, cancelledTripIds: cancelled, missing, count: cancelled.length + missing.length });
  });

  r.get("/engine/predict/status", (req, res) => sendJson(req, res, 200, predictor.status()));

  /**
   * Útvonaltervezés: ?from=stop:SP85 | lat,lon  &to=…  &at=ISO-időpont | unix  &arriveBy=1
   * Múltbeli időpontra a tényleges menetek adataival válaszol.
   */
  r.get("/engine/plan", async (req, res) => {
    const from = (req.query.get("from") ?? "").trim();
    const to = (req.query.get("to") ?? "").trim();
    if (!from || !to) throw new HttpError(400, "hiányzó ?from= és ?to=");
    const atRaw = req.query.get("at");
    const at = !atRaw ? nowUnix() : /^\d+$/.test(atRaw) ? Number(atRaw) : Math.floor(Date.parse(atRaw) / 1000);
    if (!Number.isFinite(at)) throw new HttpError(400, "érvénytelen ?at=");
    const arriveBy = req.query.get("arriveBy") === "1";
    const limit = Number(req.query.get("limit") ?? 4);
    const run = () => plan(engine, { from, to, at, arriveBy, limit });
    // A múltbeli tervezés (tényadatokból) már nem változik — a pár órán belüli
    // még kaphat késve beérő adatot, ezért az csak röviden él; az élő mindig friss.
    const age = nowUnix() - at;
    const key = `plan:${from}:${to}:${at}:${arriveBy ? 1 : 0}:${limit}`;
    const result = age > SETTLED_S ? await cached(key, age > 6 * 3600 ? DAY_S : 120, run) : await run();
    if ("error" in result) throw new HttpError(404, String(result.error));
    sendJson(req, res, 200, result, { "cache-control": result.mode === "past" ? "public, max-age=3600" : "no-store" });
  });

  r.get("/engine/segment", async (req, res) => {
    const from = (req.query.get("from") ?? "").trim();
    const to = (req.query.get("to") ?? "").trim();
    const atRaw = req.query.get("at");
    const at = atRaw ? Math.floor(Date.parse(atRaw) / 1000) : nowUnix();
    if (!from || !to || !Number.isFinite(at)) throw new HttpError(400, "hiányzó ?from= és ?to=");
    const est = await cached(`segment:${from}:${to}:${Math.floor(at / 300)}`, 120, () => segmentEstimate(engine, from, to, at));
    if (!est) throw new HttpError(404, "nincs közvetlen járat a két megálló között");
    sendJson(req, res, 200, est);
  });
}

/**
 * Idővonal-lejátszáshoz: az összes pont egy legfeljebb 2 órás ablakban,
 * járművenként tömörítve ([ts, lat, lon, bearing, vonalindex]).
 */
async function historyFrames(from: number, to: number, route: string | null) {
  const rows = await sql<{ id: string; ts: number; lat: number; lon: number; bearing: number | null; route_short: string | null; trip_id: string | null }>(
    `SELECT vehicle_id AS id, extract(epoch FROM ts)::int AS ts, round(lat::numeric, 6)::float8 AS lat, round(lon::numeric, 6)::float8 AS lon,
            bearing, route_short, trip_id
       FROM veh_ping WHERE ts BETWEEN to_timestamp($1) AND to_timestamp($2) ${route ? "AND route_short = $3" : ""}
      ORDER BY vehicle_id, ts`,
    route ? [from, to, route] : [from, to],
  );
  // Pontonként a vonal is (indexelve a jármű `routes` listájába): egy ablakon
  // belül a busz vonalat válthat, és az ikonnak mindig az aktuálisat kell mutatnia.
  const byVehicle: Record<string, { route: string | null; trip: string | null; routes: string[]; p: [number, number, number, number | null, number][] }> = {};
  for (const x of rows) {
    const v = (byVehicle[x.id] ??= { route: x.route_short, trip: x.trip_id, routes: [], p: [] });
    let ri = -1;
    if (x.route_short) {
      v.route = x.route_short;
      ri = v.routes.indexOf(x.route_short);
      if (ri < 0) ri = v.routes.push(x.route_short) - 1;
    }
    if (x.trip_id) v.trip = x.trip_id;
    v.p.push([x.ts, x.lat, x.lon, x.bearing, ri]);
  }
  return byVehicle;
}
