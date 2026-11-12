/**
 * Utólag rögzített utazás (Utazásaim → „Utazás hozzáadása”, „Tovább utaztam”):
 * egy naptári nap vonalai és menetei a menetrendből, és hogy melyik buszon
 * futottak (ha a rendszer látta), valamint a végállomásról továbbinduló menetek.
 */
import { calendarRoutes, calendarTrips, isPlausibleIso, loopTermini, nextLegChoices, serviceClock, shiftIso, type PastTrip } from "@mvk/core";
import { sql } from "@mvk/db";
import { HttpError, sendJson, type Router } from "./router.ts";
import type { Ctx } from "./compat.ts";

/** ennyi napra visszamenőleg lehet utazást hozzáadni */
const MAX_BACK_DAYS = 14;
const ROUTE_RE = /^[\w-]{1,8}$/;
const VEHICLE_RE = /^[\w:.-]{1,40}$/;

type RunInfo = { vehicleId: string; actualStart: number | null; actualEnd: number | null; status: string };

/** A kért naptári nap ("YYYY-MM-DD"): legfeljebb két hete, és nem a jövőben. */
function calendarIsoOf(v: string | null): string {
  const cal = serviceClock().calendarIso;
  const iso = (v ?? "").trim() || cal;
  if (!isPlausibleIso(iso, cal, MAX_BACK_DAYS) || iso > cal) throw new HttpError(400, `érvénytelen dátum (legfeljebb ${MAX_BACK_DAYS} napra visszamenőleg)`);
  return iso;
}

export function registerRideLog(r: Router, ctx: Ctx) {
  const { engine, feeds } = ctx;

  /** Melyik buszon futottak a menetek (a ma élőben, a korábbiak az adatbázisból). */
  async function runsOf(trips: readonly Pick<PastTrip, "tripId" | "serviceDate">[]): Promise<Map<string, RunInfo>> {
    const out = new Map<string, RunInfo>();
    const byDate = new Map<string, string[]>();
    for (const t of trips) {
      const live = t.serviceDate === engine.today ? engine.todayRuns.get(t.tripId) : undefined;
      if (live) out.set(`${t.serviceDate}|${t.tripId}`, { vehicleId: live.vehicleId, actualStart: live.actualStart ?? null, actualEnd: live.actualEnd ?? null, status: live.status });
      else byDate.set(t.serviceDate, [...(byDate.get(t.serviceDate) ?? []), t.tripId]);
    }
    for (const [date, ids] of byDate) {
      const rows = await sql<{ trip_id: string; vehicle_id: string; status: string; a0: number | null; a1: number | null }>(
        `SELECT DISTINCT ON (trip_id) trip_id, vehicle_id, status,
                extract(epoch FROM actual_start)::int AS a0, extract(epoch FROM actual_end)::int AS a1
           FROM trip_run WHERE service_date = $1 AND trip_id = ANY($2::text[]) ORDER BY trip_id, stops_seen DESC`,
        [date, ids],
      );
      for (const x of rows) out.set(`${date}|${x.trip_id}`, { vehicleId: x.vehicle_id, actualStart: x.a0, actualEnd: x.a1, status: x.status });
    }
    return out;
  }

  const withRuns = async <T extends PastTrip>(list: T[]) => {
    const runs = await runsOf(list);
    return list.map((t) => ({ ...t, run: runs.get(`${t.serviceDate}|${t.tripId}`) ?? null }));
  };

  /** A naptári nap két szolgáltatási napja: az övé, és az előző (annak éjfél utáni menetei). */
  const daysOf = async (iso: string) => {
    const [day, prev] = await Promise.all([feeds.serviceDay(iso), feeds.serviceDay(shiftIso(iso, -1))]);
    if (!day && !prev) throw new HttpError(404, "erre a napra nincs menetrend");
    return { day, prev };
  };

  /**
   * A vonalak, amelyeken körbe lehet utazni (fordulóhurkos végállomás), és a
   * hurkok megállói — az Utazásaim ezek útjainál kínálja a körbeutazás hozzáadását.
   */
  r.get("/engine/ridelog/loops", (req, res) => {
    const day = feeds.cachedDay(engine.today);
    if (!day) throw new HttpError(503, "még nincs betöltve a mai menetrend");
    const termini = [...loopTermini(day.feed).values()];
    const routes = [...new Set(termini.flatMap((t) => t.routes))].sort((a, b) => a.localeCompare(b, "hu", { numeric: true }));
    sendJson(req, res, 200, { routes, termini }, { "cache-control": "public, max-age=3600" });
  });

  /** ?date=YYYY-MM-DD (naptári nap): az MVK vonalai, amelyeken aznap indult menet. */
  r.get("/engine/ridelog/routes", async (req, res) => {
    const iso = calendarIsoOf(req.query.get("date"));
    const { day, prev } = await daysOf(iso);
    sendJson(req, res, 200, { date: iso, routes: calendarRoutes(day, prev) }, { "cache-control": "public, max-age=600" });
  });

  /** ?date=YYYY-MM-DD&route=36: a vonal aznap induló menetei, a buszukkal (ha ismert). */
  r.get("/engine/ridelog/trips", async (req, res) => {
    const iso = calendarIsoOf(req.query.get("date"));
    const route = (req.query.get("route") ?? "").trim();
    if (!ROUTE_RE.test(route)) throw new HttpError(400, "hiányzó vagy érvénytelen ?route=");
    const { day, prev } = await daysOf(iso);
    const trips = await withRuns(calendarTrips(day, prev, route));
    sendJson(req, res, 200, { date: iso, route, trips }, { "cache-control": "no-store" });
  });

  /**
   * ?date=<szolgáltatási nap>&trip=…&vehicle=…: körbeutazás utólag — a menet
   * végállomásáról továbbinduló menetek; ha a busz ismert, az ő menete elöl.
   */
  r.get("/engine/ridelog/next", async (req, res) => {
    const date = (req.query.get("date") ?? "").trim();
    const tripId = (req.query.get("trip") ?? "").trim();
    const vehicleId = (req.query.get("vehicle") ?? "").trim();
    if (!isPlausibleIso(date, engine.today, MAX_BACK_DAYS + 1) || date > engine.today) throw new HttpError(400, "érvénytelen ?date=");
    if (!tripId || tripId.length > 80) throw new HttpError(400, "hiányzó ?trip=");
    if (vehicleId && !VEHICLE_RE.test(vehicleId)) throw new HttpError(400, "érvénytelen ?vehicle=");
    const day = await feeds.serviceDay(date);
    if (!day?.feed.tripStops.has(tripId)) throw new HttpError(404, "ismeretlen menet");
    const choices = (await withRuns(nextLegChoices(day, tripId))).map((c) => ({ ...c, sameVehicle: Boolean(vehicleId && c.run?.vehicleId === vehicleId) }));
    // A busz saját folytatása elöl, utána a többi indulás sorrendben.
    choices.sort((a, b) => Number(b.sameVehicle) - Number(a.sameVehicle) || a.depTs - b.depTs);
    sendJson(req, res, 200, { date, tripId, vehicleId: vehicleId || null, choices }, { "cache-control": "no-store" });
  });
}
