/** v3 motor-végpontok: menet-részletek, idővonal (múltbeli helyzetek), élő zavarok. */
import { endsAtLoop, isPlausibleIso, localMidnightUnix, nowUnix, secToHm, terminusKind, tripStopRows } from "@mvk/core";
import { cached } from "@mvk/cache";
import { sql } from "@mvk/db";
import { HttpError, sendJson, type Router } from "./router.ts";
import type { Ctx } from "./compat.ts";
import { plan, segmentEstimate } from "../planner.ts";
import { disruptions, liveMissing } from "../disruptions.ts";
import { cityHeat, clampHeatQuery, routeHeat } from "../heat.ts";
import { latestReport } from "../ml/store.ts";

/** ennél régebbi időpont adatai már nem változnak → hosszan gyorsítótárazható */
const SETTLED_S = 600;
const DAY_S = 86_400;

const isoOf = (v: string | null, fallback: string) => {
  const s = (v ?? "").trim();
  if (!s) return fallback;
  const iso = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
  if (!isPlausibleIso(iso, fallback)) throw new HttpError(400, "érvénytelen dátum");
  return iso;
};

export function registerV3(r: Router, ctx: Ctx) {
  const { engine, feeds, predictor, parking } = ctx;

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
      /** a végállomás fordulóhurok: ülve maradva a következő menettel körbe lehet utazni */
      loopEnd: day ? endsAtLoop(day.feed, tripId) : false,
      stops: (stops ?? []).map((s, i) => ({ ...s, schedTime: secToHm(s.dep), schedTs: midnight + s.dep, idx: i })),
      run: live ?? runs[0] ?? null,
      liveDelaySec: live?.status === "running" ? engine.matcher.liveDelay(tripId, nowUnix()) : null,
      forecast: iso === engine.today ? (req.query.get("forecast") === "formula" ? ctx.forecaster.formulaFor(tripId) : ctx.forecaster.forTrip(tripId)) : null,
      events,
      cancelled: iso === engine.today ? engine.cancelled.ids.has(tripId) : Boolean((await sql(`SELECT 1 FROM cancelled_trip WHERE service_date = $1 AND trip_id = $2`, [iso, tripId]))[0]),
      predictedVehicle: iso === engine.today && !live ? predictor.predict(tripId) : null,
    });
  });

  /** Idővonal: minden jármű helyzete egy múltbeli pillanatban. */
  r.get("/engine/history/at", async (req, res) => {
    const raw = req.query.get("t");
    const at = raw ? Number(raw) : NaN;
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
      // szolgáltatási napok (budapesti idő − 3 óra), nem az adatbázis UTC-dátumai: hajnalban se nyíljon egy még el nem kezdett nap
      const pings = await sql<{ mn: string | null; mx: string | null }>(
        `SELECT ((min(ts) AT TIME ZONE 'Europe/Budapest') - interval '3 hours')::date::text AS mn,
                ((max(ts) AT TIME ZONE 'Europe/Budapest') - interval '3 hours')::date::text AS mx FROM veh_ping`,
      );
      return { runs, gps: pings[0] ?? null };
    });
    sendJson(req, res, 200, data);
  });

  /** Élő zavarok a fejléc-jelvényhez: hivatalos törlések + most valószínűleg kimaradó menetek. */
  r.get("/engine/incidents/live", (req, res) => {
    const day = feeds.cachedDay(engine.today);
    const cancelled = [...engine.cancelled.ids];
    const missing = day
      ? liveMissing(engine, day, nowUnix()).map((m) => ({ tripId: m.tripId, route: m.route, time: secToHm(m.depS), headsign: m.headsign, lateMin: m.lateMin }))
      : [];
    sendJson(req, res, 200, { date: engine.today, cancelled: cancelled.length, cancelledTripIds: cancelled, missing, count: cancelled.length + missing.length });
  });

  /**
   * A mai zavarok összesítve (Menetrend → Mai zavarok): törölt, most kimaradó és
   * korábban el nem indult menetek, pótló indulással. ?near=SP1,SP2 — a kliens
   * közelében lévő megállók: az ott megálló menetek ott mikor jöttek volna.
   */
  r.get("/engine/disruptions", (req, res) => {
    const day = feeds.cachedDay(engine.today);
    if (!day) throw new HttpError(503, "még nincs betöltve a mai menetrend");
    const near = (req.query.get("near") ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => /^[\w:.-]{1,32}$/.test(x))
      .slice(0, 8);
    sendJson(req, res, 200, disruptions(engine, predictor, day, near, ctx.insights), { "cache-control": "no-store" });
  });

  /**
   * Körbeutazás: a menet végállomásán hogyan folytatja a busz — melyik menettel,
   * mikor, és ugyanabból a megállóból indul-e (fordulóhurok). Az élő jármű
   * menete az elsődleges forrás (az MVK percekkel korábban kiosztja), utána a
   * forda-terv.
   */
  r.get("/engine/continuation", (req, res) => {
    const tripId = (req.query.get("trip") ?? "").trim();
    const vehicleId = (req.query.get("vehicle") ?? "").trim();
    if (!tripId || !vehicleId) throw new HttpError(400, "hiányzó ?trip= és ?vehicle=");
    const day = feeds.cachedDay(engine.today);
    if (!day) throw new HttpError(503, "még nincs betöltve a mai menetrend");
    const feed = day.feed;
    const st = feed.tripStops.get(tripId);
    if (!st?.length) throw new HttpError(404, "ismeretlen menet");
    const midnight = localMidnightUnix(engine.today);
    const end = st[st.length - 1];
    const endStop = feed.stops.get(end.stopId);
    const run = engine.todayRuns.get(tripId);
    const own = run?.vehicleId === vehicleId ? run : undefined;

    const candidates: { tripId: string; source: "live" | "plan" }[] = [];
    const live = engine.snapshot.vehicles.find((v) => v.id === vehicleId);
    if (live?.tripId && live.tripId !== tripId) candidates.push({ tripId: live.tripId, source: "live" });
    for (const sl of predictor.planSnapshot()?.byVehicle.get(vehicleId) ?? []) {
      if (sl.tripId !== tripId && sl.startS >= end.arr - 300) {
        candidates.push({ tripId: sl.tripId, source: "plan" });
        break;
      }
    }
    let next = null;
    for (const c of candidates) {
      const t = feed.trips.get(c.tripId);
      const nst = feed.tripStops.get(c.tripId);
      if (!t || !nst?.length || nst[0].dep < end.arr - 300) continue;
      const route = feed.routes.get(t.routeId);
      const first = feed.stops.get(nst[0].stopId);
      const nrun = engine.todayRuns.get(c.tripId);
      const mine = nrun?.vehicleId === vehicleId ? nrun : undefined;
      next = {
        tripId: t.id,
        route: route?.short ?? t.routeId,
        color: route?.color ?? "1FB574",
        text: route?.text ?? "FFFFFF",
        headsign: t.headsign,
        firstStopId: nst[0].stopId,
        firstStopName: first?.name ?? nst[0].stopId,
        depS: nst[0].dep,
        depTs: midnight + nst[0].dep,
        depTime: secToHm(nst[0].dep),
        kind: terminusKind(feed, end.stopId, nst[0].stopId),
        source: c.source,
        cancelled: engine.cancelled.ids.has(t.id),
        departed: mine?.actualStart != null,
        departedAt: mine?.actualStart ?? null,
        startDelayS: mine?.startDelayS ?? null,
      };
      break;
    }
    sendJson(
      req,
      res,
      200,
      {
        tripId,
        vehicleId,
        terminus: { stopId: end.stopId, name: endStop?.name ?? end.stopId, idx: st.length - 1 },
        loop: endsAtLoop(feed, tripId),
        arrivedAt: own?.actualEnd ?? null,
        /** a busz most (a fordulás közbeni leszállás-felismeréshez) */
        vehicle: live?.lat != null && live.lon != null ? { lat: live.lat, lon: live.lon } : null,
        next,
      },
      { "cache-control": "no-store" },
    );
  });

  /** Vonal-hőtérkép: megálló × óra — késés és késésnövekmény (lezárt napokból). */
  r.get("/engine/heat/route", async (req, res) => {
    const route = (req.query.get("route") ?? "").trim();
    if (!/^[\w-]{1,8}$/.test(route)) throw new HttpError(400, "hiányzó vagy érvénytelen ?route=");
    const day = feeds.cachedDay(engine.today);
    if (!day) throw new HttpError(503, "még nincs betöltve a mai menetrend");
    const data = await routeHeat(day, route, req.query.get("dir"), clampHeatQuery(req.query.get("days") ?? 28, req.query.get("daytype") ?? 0));
    if (!data) throw new HttpError(404, "ismeretlen vonal");
    sendJson(req, res, 200, data, { "cache-control": "public, max-age=600" });
  });

  /** Városi hőtérkép: megállóközönként, óránként mennyi időt veszít a busz a menetrendhez képest. */
  r.get("/engine/heat/city", async (req, res) => {
    const day = feeds.cachedDay(engine.today);
    if (!day) throw new HttpError(503, "még nincs betöltve a mai menetrend");
    const data = await cityHeat(day, clampHeatQuery(req.query.get("days") ?? 28, req.query.get("daytype") ?? 0));
    sendJson(req, res, 200, data, { "cache-control": "public, max-age=600" });
  });

  r.get("/engine/predict/status", (req, res) => sendJson(req, res, 200, predictor.status()));

  /** Élő forgalom: a most torlódott szakaszok (a buszok menetidejéből), nyomvonallal. */
  r.get("/engine/traffic/live", (req, res) => sendJson(req, res, 200, ctx.traffic.snapshot(), { "cache-control": "no-store" }));

  /** A késés-modell állapota: az utolsó tanítás visszamérése, és mi becsül most. */
  r.get("/engine/ml/status", async (req, res) => {
    const last = await latestReport();
    sendJson(req, res, 200, { inUse: ctx.forecaster.modelInfo(), lastTraining: last }, { "cache-control": "no-store" });
  });

  /**
   * Forda-tábla: buszonként a mai menetek (lefutott / futó) és a forda-terv
   * szerinti következők. Idők a szolgáltatási nap kezdetétől, másodpercben.
   */
  r.get("/engine/blocks", (req, res) => {
    const iso = engine.today;
    const day = feeds.cachedDay(iso);
    if (!day) throw new HttpError(503, "még nincs betöltve a mai menetrend");
    const midnight = localMidnightUnix(iso);
    const rel = (unix: number | null) => (unix == null ? null : unix - midnight);
    const tram = (routeId: string) => day.feed.routes.get(routeId)?.type === "900";
    type Row = { id: string; kind: "bus" | "tram"; runs: unknown[]; plan: unknown[]; first: number };
    const rows = new Map<string, Row>();
    const row = (id: string, routeId: string | null) => {
      let r = rows.get(id);
      if (!r) rows.set(id, (r = { id, kind: routeId && tram(routeId) ? "tram" : "bus", runs: [], plan: [], first: Infinity }));
      return r;
    };
    for (const run of engine.todayRuns.values()) {
      const r = row(run.vehicleId, run.routeId);
      r.first = Math.min(r.first, run.schedStartS);
      r.runs.push({
        t: run.tripId,
        r: run.routeShort,
        h: run.headsign,
        s: run.schedStartS,
        e: run.schedEndS,
        as: rel(run.actualStart),
        ae: rel(run.actualEnd ?? (run.status === "running" ? null : run.lastTs)),
        st: run.status,
        d: run.status === "running" ? run.lastDelayS : (run.endDelayS ?? run.lastDelayS),
      });
    }
    const plan = predictor.planSnapshot();
    for (const [vehicleId, slots] of plan?.byVehicle ?? []) {
      for (const sl of slots) {
        const trip = day.feed.trips.get(sl.tripId);
        const r = row(vehicleId, trip?.routeId ?? null);
        r.first = Math.min(r.first, sl.startS);
        r.plan.push({ t: sl.tripId, r: sl.route, h: trip?.headsign ?? "", s: sl.startS, e: sl.endS, c: plan?.byTrip.get(sl.tripId)?.confidence ?? null });
      }
    }
    const vehicles = [...rows.values()].sort((a, b) => a.first - b.first || a.id.localeCompare(b.id, "hu", { numeric: true })).map(({ first: _f, ...r }) => r);
    sendJson(req, res, 200, { date: iso, midnight, now: nowUnix() - midnight, vehicles }, { "cache-control": "no-store" });
  });

  /** Parkoló: ki áll melyik végállomáson, ki van a kocsiszínben (élőben a `parking` WebSocket-témán is). */
  r.get("/engine/parking", (req, res) => {
    const snap = parking.snapshot();
    if (!snap) throw new HttpError(503, "még nincs betöltve a mai menetrend");
    sendJson(req, res, 200, snap, { "cache-control": "no-store" });
  });

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
    const rawLimit = Number(req.query.get("limit") ?? 4);
    const limit = Number.isInteger(rawLimit) ? rawLimit : 4;
    const run = () => plan(engine, { from, to, at, arriveBy, limit }, ctx.insights);
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
