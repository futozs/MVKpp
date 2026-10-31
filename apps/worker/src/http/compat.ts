/**
 * A v2 API végpontjai, válaszformátumra kompatibilisen — az iOS app ezeket
 * hívja. Új mezők jöhetnek hozzá (a dekóderek figyelmen kívül hagyják),
 * meglévő mező nem tűnik el és nem változik a típusa.
 */
import { cacheStatus, cached } from "@mvk/cache";
import {
  arrivalsForStop,
  type DecodedVehicle,
  type Feed,
  isMvkId,
  isPlausibleIso,
  modeOfRoute,
  nowUnix,
  onlyMvk,
  operatorLabel,
  parseModes,
  parseStopMerge,
  progressOnTrip,
  secToHm,
  serviceClock,
  stopAllowed,
  stopTwinsOf,
  type TransitMode,
  tripStopRows,
  type ServiceDay,
} from "@mvk/core";
import { sql } from "@mvk/db";
import { safeEqual, verifyAgentRequest } from "@mvk/db/crypto";
import { config } from "../config.ts";
import type { Engine } from "../engine.ts";
import type { FeedManager } from "../feeds.ts";
import { mvkFetch } from "../mvk.ts";
import type { DelayForecaster } from "../forecast.ts";
import type { TripInsights } from "../insights.ts";
import type { MotionPredictor } from "../motion/live.ts";
import type { NewsSource } from "../news.ts";
import type { TrafficMonitor } from "../traffic.ts";
import type { Parking } from "../parking.ts";
import type { VehiclePredictor } from "../predict.ts";
import type { RegionalFeeds } from "../regional/feeds.ts";
import type { RegionalRealtime } from "../regional/realtime.ts";
import { archiveRange, routeIndexFor, tableFor } from "../schedule.ts";
import { currentJwt, ingestToken, lastRenewInfo, renewToken, tokenRejectedRecently, tokenStatus } from "../token.ts";
import { errMsg, log } from "../log.ts";
import { HttpError, sendJson, type Req, type Router } from "./router.ts";
import type { ServerResponse } from "node:http";

export type Ctx = {
  engine: Engine;
  feeds: FeedManager;
  predictor: VehiclePredictor;
  parking: Parking;
  forecaster: DelayForecaster;
  traffic: TrafficMonitor;
  insights: TripInsights;
  motion: MotionPredictor;
  news: NewsSource;
  regionalFeeds: RegionalFeeds;
  regionalRt: RegionalRealtime;
  startedAt: number;
  hubStats: () => unknown;
};

/**
 * `?modes=tram,bus,coach,rail` — a v2-végpontok opcionális paramétere. Nélküle a
 * válasz pontosan az, ami eddig (csak MVK: az iOS app ezt kapja); vele a Volán
 * és a vasút is jön, ugyanabban az alakban, néhány új mezővel.
 */
/** A v3-ban jött többletmezők (MÁV+): a v2-válaszban nincsenek (az iOS app a régi alakot olvassa). */
const V3_VEHICLE_KEYS = ["mode", "routeKey", "plate", "trainNo", "trainName", "delaySec", "estimated", "source"] as const;

function v2Vehicle(v: DecodedVehicle): DecodedVehicle {
  if (!V3_VEHICLE_KEYS.some((k) => k in v)) return v;
  const out = { ...v };
  for (const k of V3_VEHICLE_KEYS) delete out[k];
  return out;
}

export function modesOf(req: Req): { modes: Set<TransitMode>; rich: boolean } {
  const raw = req.query.get("modes");
  return { modes: parseModes(raw), rich: raw != null && raw !== "" };
}

/** Egy jármű módja (a natív MVK-jármű nem hordozza, a vonalából derül ki). */
export function vehicleMode(v: DecodedVehicle, feed: Feed | null | undefined): TransitMode {
  return v.mode ?? modeOfRoute(v.routeId, feed?.routes.get(v.routeId)?.type ?? "");
}

const ymdRe = /^\d{8}$/;
const isoOfYmd = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

export function isAdmin(req: Req): boolean {
  if (!config.adminKey) return false;
  const h = String(req.headers["x-admin-key"] ?? "") || String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return h.length > 0 && safeEqual(h, config.adminKey);
}

/** Rossz admin-kulccsal próbálkozók: címenként 10 percben legfeljebb 20 hiba, utána 429. */
const adminFails = new Map<string, { n: number; reset: number }>();
const ADMIN_FAIL_LIMIT = 20;

export function requireAdmin(req: Req) {
  const now = Date.now();
  const f = adminFails.get(req.ip);
  if (f && now < f.reset && f.n >= ADMIN_FAIL_LIMIT) throw new HttpError(429, "túl sok hibás admin-kulcs — próbáld később");
  if (isAdmin(req)) return;
  if (!f || now > f.reset) adminFails.set(req.ip, { n: 1, reset: now + 10 * 60_000 });
  else f.n++;
  if (adminFails.size > 10_000) adminFails.delete(adminFails.keys().next().value as string);
  throw new HttpError(401, "admin kulcs szükséges (X-Admin-Key)");
}

function dateParam(req: Req, fallbackYmd: string): string {
  const ymd = (req.query.get("date") || fallbackYmd).trim();
  if (!ymdRe.test(ymd)) throw new HttpError(400, "érvénytelen ?date= (YYYYMMDD kell)");
  if (!isPlausibleIso(isoOfYmd(ymd), serviceClock().iso)) throw new HttpError(400, "érvénytelen vagy túl távoli ?date=");
  return ymd;
}

export function registerCompat(r: Router, ctx: Ctx) {
  const { engine, feeds, predictor } = ctx;
  const today = () => engine.feeds.cachedDay(engine.today);
  /** a mai összefésült feed (MVK + regionális), ha még nincs, az MVK legfrissebbje */
  const catalogFeed = () => today()?.feed ?? feeds.latest();
  /**
   * A mai napba bekerült-e már a Volán és a vasút (a kompozit feed verziója „MVK+R…”).
   * Induláskor a regionális menetrend percekig épül: addig a katalógus csak MVK-s.
   */
  const regionalState = (): "off" | "pending" | "ready" => {
    if (!ctx.regionalFeeds.enabled) return "off";
    return today()?.feed.version.includes("+") ? "ready" : "pending";
  };
  /** A katalógus (megállók, vonalak) gyorsítótárazható-e: a félkész (még csak MVK-s) nem. */
  const catalogCache = (modes: Set<TransitMode>) =>
    (modes.has("coach") || modes.has("rail")) && regionalState() === "pending" ? "no-store" : "public, max-age=300";
  const vehiclesFor = (req: Req) => {
    const { modes, rich } = modesOf(req);
    const feed = catalogFeed();
    // ?modes= nélkül a v2-alak: tartalék üzemben se kerüljenek bele a MÁV+ többletmezői
    // (a menetrendből becsült, nem GPS-es helyzet sem: a v2 csak mért pozíciót ad)
    if (!rich) return engine.snapshot.decoded.filter((v) => isMvkId(v.id) && !v.estimated).map(v2Vehicle);
    if (onlyMvk(modes) && modes.has("tram") && modes.has("bus")) return engine.snapshot.decoded.filter((v) => isMvkId(v.id));
    return engine.snapshot.decoded.filter((v) => modes.has(vehicleMode(v, feed)));
  };

  // ── élő adatok ────────────────────────────────────────────────────────
  r.get("/live/positions", (req, res) => {
    const s = engine.snapshot;
    if (!s.fetchedAt) throw new HttpError(502, s.rtError ?? "get-positions nem elérhető");
    sendJson(req, res, 200, { header: s.header, vehicles: vehiclesFor(req), ...(modesOf(req).rich ? { source: s.source ?? null, regionalAt: s.regionalAt || null } : {}) }, { "cache-control": "no-store" });
  });

  r.get("/live/updates", (req, res) => {
    const s = engine.snapshot;
    sendJson(req, res, 200, { header: { timestamp: s.updatesHeaderTs }, count: s.updatesCount });
  });

  r.get("/live/vehicle", (req, res) => {
    const q = (req.query.get("id") || "").trim().toLowerCase();
    if (!q) throw new HttpError(400, "hiányzó ?id=");
    // A rendszámra is keres (a Volán-buszok azonosítója `hkir:hkir_LWA387`, a rendszám `LWA387`).
    const all = vehiclesFor(req).filter((v) => v.lat != null);
    const keys = (v: DecodedVehicle) => [v.id.toLowerCase(), (v.plate ?? "").toLowerCase(), (v.trainNo ?? "").toLowerCase()].filter(Boolean);
    const exact = all.filter((v) => keys(v).includes(q));
    const hits = exact.length ? exact : all.filter((v) => keys(v).some((k) => k.includes(q)));
    sendJson(req, res, 200, { query: q, inService: hits.length > 0, count: hits.length, vehicles: hits });
  });

  r.get("/live/arrivals", (req, res) => {
    const stop = req.query.get("stop");
    if (!stop) throw new HttpError(400, "hiányzó ?stop=SP...");
    const { modes, rich } = modesOf(req);
    // egy állomás (pl. Tiszai pu.) táblája hosszabb lehet
    const limit = Math.min(rich ? 30 : 20, Math.max(1, Number(req.query.get("limit") ?? 10) || 10));
    // v3: közös megállók (MVK-oszlop + a mellette álló Volán-megálló) egy táblán; a v2 alapból „off”
    const merge = rich ? parseStopMerge(req.query.get("merge")) : "off";
    sendJson(req, res, 200, ctx.insights.arrivals(stop, limit, nowUnix(), modes, rich, merge), { "cache-control": "no-store" });
  });

  r.get("/live/multi-arrivals", (req, res) => {
    const list = (req.query.get("stops") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
    if (!list.length) throw new HttpError(400, "hiányzó ?stops=SP1,SP2");
    const limit = Math.min(10, Math.max(1, Number(req.query.get("limit") ?? 5) || 5));
    const now = nowUnix();
    const days = feeds.arrivalDays(now);
    const { modes, rich } = modesOf(req);
    const merge = rich ? parseStopMerge(req.query.get("merge")) : "off";
    if (merge !== "off") {
      sendJson(req, res, 200, { results: list.map((id) => ctx.insights.arrivals(id, limit, now, modes, rich, merge)) });
      return;
    }
    const ex = ctx.insights.extras(now, modes, rich);
    for (const id of list) if (!isMvkId(id) || !onlyMvk(modes)) ctx.regionalRt.touch(id);
    sendJson(req, res, 200, { results: list.map((id) => arrivalsForStop(id, limit, engine.snapshot, days, now, ex)) });
  });

  r.get("/live/trip-progress", (req, res) => {
    const tripId = (req.query.get("trip") || "").trim();
    const vq = (req.query.get("vehicle") || "").trim().toLowerCase();
    if (!tripId) throw new HttpError(400, "hiányzó ?trip=");
    const day = today();
    const feed = day?.feed;
    const stops = feed ? tripStopRows(feed, tripId) : null;
    if (!feed || !stops?.length) throw new HttpError(404, "Ismeretlen menet");
    const v = engine.snapshot.vehicles.find((x) => x.tripId === tripId) ?? (vq ? engine.snapshot.vehicles.find((x) => x.id.toLowerCase() === vq) : undefined);
    const run = engine.todayRuns.get(tripId) ?? null;
    if (!v) {
      sendJson(req, res, 200, { tripId, live: false, stops, segmentIndex: null, progress: null, scheduleDeviationSec: null, run });
      return;
    }
    const prog = progressOnTrip(feed, tripId, v, serviceClock().secOfDay);
    if (!prog) throw new HttpError(404, "Ismeretlen menet");
    sendJson(req, res, 200, {
      tripId,
      live: true,
      vehicle: { id: v.id, lat: v.lat, lon: v.lon, speed: v.speed },
      ...prog,
      measuredDelaySec: engine.matcher.liveDelay(tripId, nowUnix()),
      run,
    });
  });

  r.get("/live/trip-path", (req, res) => {
    const trip = req.query.get("trip") || "";
    const vehId = (req.query.get("vehicle") || "").trim();
    if (!trip && !vehId) throw new HttpError(400, "hiányzó ?trip= vagy ?vehicle=");
    const active = engine.snapshot.vehicles;
    let veh = vehId ? (active.find((v) => v.id === vehId) ?? null) : null;
    if (!veh && trip) veh = active.find((v) => v.tripId === trip) ?? null;
    const tripId = veh?.tripId || trip;
    const feed = today()?.feed;
    const tr = feed?.trips.get(tripId);
    const rt = tr ? feed!.routes.get(tr.routeId) : undefined;
    const shape = tr?.shapeId ? (feed!.shapes.get(tr.shapeId)?.points ?? []) : [];
    const prog = veh && feed ? progressOnTrip(feed, tripId, veh, serviceClock().secOfDay) : null;
    // a regionális járműhöz a mód, a rendszám, a vonatszám és a MÁV által közölt késés is
    // (az MVK-é változatlan, a v2-alak)
    const full = veh && !isMvkId(veh.id) ? engine.snapshot.decoded.find((d) => d.id === veh!.id) : undefined;
    const vehicle =
      veh && full
        ? {
            ...veh,
            mode: full.mode,
            ...(full.plate ? { plate: full.plate } : {}),
            ...(full.trainNo ? { trainNo: full.trainNo } : {}),
            ...(full.trainName ? { trainName: full.trainName } : {}),
            ...(full.delaySec != null ? { delaySec: full.delaySec } : {}),
          }
        : veh;
    sendJson(req, res, 200, {
      trip: tripId,
      route: rt?.short || tr?.routeId || "",
      color: rt?.color || "2f6df6",
      text: rt?.text || "FFFFFF",
      headsign: tr?.headsign || "",
      shape,
      vehicle,
      nextStop: prog?.nextStop ?? null,
      scheduleDeviationSec: prog?.scheduleDeviationSec ?? null,
      measuredDelaySec: tripId ? engine.matcher.liveDelay(tripId, nowUnix()) : null,
    });
  });

  r.get("/live/cancelled", async (req, res) => {
    const todayYmd = engine.today.replace(/-/g, "");
    const ymd = dateParam(req, todayYmd);
    const iso = isoOfYmd(ymd);
    const day = await feeds.serviceDay(iso);
    const rowOf = (id: string) => cancelledRow(day, id);
    const sortRows = (rows: ReturnType<typeof rowOf>[]) =>
      rows.sort((a, b) => (a.departureSec ?? Infinity) - (b.departureSec ?? Infinity) || a.tripId.localeCompare(b.tripId));
    const { modes } = modesOf(req);
    // a regionális (Volán, vasút) törlések csak kérésre — a v2 alapválasza az MVK-é
    const keep = (id: string) => (isMvkId(id) ? modes.has("bus") || modes.has("tram") : modes.has(id.startsWith("1:") ? "rail" : "coach"));
    if (ymd !== todayYmd) {
      const ids = (await sql<{ trip_id: string }>(`SELECT trip_id FROM cancelled_trip WHERE service_date = $1 ORDER BY trip_id`, [iso])).map((x) => x.trip_id).filter(keep);
      sendJson(req, res, 200, { date: ymd, count: ids.length, stale: false, archived: true, fetchedAt: null, tripIds: ids, trips: sortRows(ids.map(rowOf)) });
      return;
    }
    const c = engine.cancelled;
    if (!c.at && c.error && onlyMvk(modes)) throw new HttpError(502, c.error);
    const ids = [...new Set([...c.ids, ...ctx.regionalRt.cancelled])].filter(keep);
    sendJson(req, res, 200, {
      date: ymd,
      count: ids.length,
      stale: c.stale,
      archived: false,
      fetchedAt: c.at ? new Date(c.at).toISOString() : null,
      tripIds: ids,
      trips: sortRows(ids.map(rowOf)),
    });
  });

  r.get("/live/debug", (req, res) => {
    const stopId = req.query.get("stop") || "";
    const feed = today()?.feed;
    const s = feed?.stops.get(stopId);
    const preds = engine.snapshot.predByStop.get(stopId);
    sendJson(req, res, 200, {
      stopId,
      stopName: s?.name,
      stopCode: s?.code,
      updates: { totalStopsWithPredictions: engine.snapshot.predByStop.size, thisStopMatches: preds?.size ?? 0, matches: [...(preds ?? new Map()).entries()].slice(0, 10) },
      vehicles: { total: engine.snapshot.vehicles.length },
      rtError: engine.snapshot.rtError,
    });
  });

  // ── GTFS ──────────────────────────────────────────────────────────────
  r.get("/gtfs/stops.json", (req, res) => {
    const { modes, rich } = modesOf(req);
    if (!rich) {
      const feed = feeds.latest();
      if (!feed) throw new HttpError(503, "nincs menetrend");
      sendJson(req, res, 200, [...feed.stops.values()].map((s) => [s.id, s.code, s.name, s.lat, s.lon]), { "cache-control": "public, max-age=300" });
      return;
    }
    // v3: [id, kód, név, lat, lon, mód, szülő-állomás, állomás-e (1/0), közös megálló] — a Volán és a vasút is.
    // A közös megálló: a Volán-megálló melyik MVK-oszloppal áll egy helyen (összevont nézetben az mutatja).
    const feed = catalogFeed();
    if (!feed) throw new HttpError(503, "nincs menetrend");
    const modeOfStop = (id: string): TransitMode | "mvk" => (isMvkId(id) ? "mvk" : id.startsWith("1:") ? "rail" : "coach");
    const twins = stopTwinsOf(feed);
    const out = [...feed.stops.values()]
      .filter((s) => stopAllowed(s.id, modes) && (s.station || (feed.stopSched.get(s.id)?.length ?? 0) > 0))
      .map((s) => [s.id, s.code, s.name, s.lat, s.lon, modeOfStop(s.id), s.parent ?? "", s.station ? 1 : 0, twins.toMvk.get(s.id) ?? ""]);
    sendJson(req, res, 200, out, { "cache-control": catalogCache(modes) });
  });

  r.get("/gtfs/routes.json", (req, res) => {
    const { modes, rich } = modesOf(req);
    const feed = rich ? catalogFeed() : feeds.latest();
    if (!feed) throw new HttpError(503, "nincs menetrend");
    const routes = [...feed.routes.values()].filter((x) => !rich || modes.has(modeOfRoute(x.id, x.type)));
    // v3 (?modes=): + [mód, kulcs, üzemeltető]
    sendJson(
      req,
      res,
      200,
      routes.map((x) => (rich ? [x.id, x.short, x.long, x.type, x.color, x.text, modeOfRoute(x.id, x.type), x.key, operatorLabel(x.agencyName) ?? ""] : [x.id, x.short, x.long, x.type, x.color, x.text])),
      { "cache-control": rich ? catalogCache(modes) : "public, max-age=300" },
    );
  });

  /**
   * Egy nyomvonal pontjai és a pontokig mért hossz (m) — a térkép ezen viszi
   * tovább a buszt két GPS-jel között. A hossz ugyanabból a vetítésből jön,
   * mint az illesztőé, így a worker `along` értékei közvetlenül használhatók.
   */
  r.get("/gtfs/shape", (req, res) => {
    const id = (req.query.get("id") ?? "").trim();
    if (!id) throw new HttpError(400, "hiányzó ?id=");
    const shape = feeds.cachedDay(engine.today)?.feed.shapes.get(id) ?? feeds.latest()?.shapes.get(id);
    if (!shape) throw new HttpError(404, "ismeretlen nyomvonal");
    const pts = shape.points.map(([lat, lon]) => [Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6]);
    const cum = Array.from(shape.cum, (c) => Math.round(c * 10) / 10);
    sendJson(req, res, 200, { id, pts, cum }, { "cache-control": "public, max-age=3600" });
  });

  r.get("/gtfs/route-geo", (req, res) => {
    const want = (req.query.get("route") || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 16);
    if (!want.length) throw new HttpError(400, "hiányzó ?route=");
    // a regionális vonal (előtagos azonosító) a mai összefésült feedben van
    const feed = want.some((x) => !isMvkId(x)) ? catalogFeed() : feeds.latest();
    if (!feed) throw new HttpError(503, "nincs menetrend");
    const out = want
      .map((name) => {
        const rt = feed.routes.get(name) ?? [...feed.routes.values()].find((x) => x.short.toLowerCase() === name.toLowerCase());
        if (!rt) return null;
        const geo = [...(feed.routeShapeIds.get(rt.id) ?? [])].map((id) => feed.shapes.get(id)?.points ?? []).filter((a) => a.length);
        return { id: rt.id, short: rt.short, long: rt.long, type: rt.type, color: rt.color, text: rt.text, shapes: geo, stops: [...(feed.routeStops.get(rt.id) ?? [])] };
      })
      .filter(Boolean);
    sendJson(req, res, 200, { routes: out }, { "cache-control": "public, max-age=300" });
  });

  r.get("/gtfs/meta.json", async (req, res) => {
    const feed = feeds.latest();
    const range = feed?.serviceRange() ?? null;
    const t = today();
    sendJson(req, res, 200, {
      feedVersion: feed?.version ?? "",
      stops: feed?.stops.size ?? 0,
      routes: feed?.routes.size ?? 0,
      trips: feed?.trips.size ?? 0,
      serviceRange: range,
      archiveRange: await archiveRange(),
      today: t ? { feedVersion: t.feed.version, fallback: t.fallback } : null,
      // a Volán és a vasút a mai katalógusban: „pending” amíg épül (a web addig újrakéri)
      regional: regionalState(),
    });
  });

  // A menetrend a feed-verzióhoz kötve gyorsítótárazható: új GTFS → új kulcs.
  const feedTag = () => feeds.latest()?.hash.slice(0, 12) ?? "none";
  const ttFor = (ymd: string) => (ymd === engine.today.replace(/-/g, "") ? 600 : 3600);

  r.get("/gtfs/timetable/routes", async (req, res) => {
    const ymd = dateParam(req, engine.today.replace(/-/g, ""));
    const { modes, rich } = modesOf(req);
    const mk = rich ? [...modes].sort().join(",") : "mvk";
    const idx = await cached(`tt-routes:${ymd}:${feedTag()}:${mk}`, ttFor(ymd), () => routeIndexFor(feeds, isoOfYmd(ymd), rich ? modes : null));
    if (!idx) {
      sendJson(req, res, 200, { date: ymd, routes: [], note: "Erre a napra nincs elrakva menetrend." });
      return;
    }
    sendJson(req, res, 200, { date: ymd, archived: idx.archived, routes: idx.routes, fallback: idx.fallback ?? null });
  });

  r.get("/gtfs/timetable", async (req, res) => {
    const ymd = dateParam(req, engine.today.replace(/-/g, ""));
    const routeId = (req.query.get("route") || "").trim();
    const dir = (req.query.get("dir") || "").trim();
    const t = await cached(`tt:${ymd}:${routeId}:${dir}:${feedTag()}`, ttFor(ymd), () => tableFor(feeds, isoOfYmd(ymd), routeId, dir));
    if (!t) throw new HttpError(404, "Erre a napra nincs elrakva menetrend.");
    if ("error" in t) throw new HttpError(404, String(t.error));
    sendJson(req, res, 200, t);
  });

  r.get("/gtfs/trip-journal", async (req, res) => {
    const todayYmd = engine.today.replace(/-/g, "");
    const ymd = dateParam(req, todayYmd);
    const out: Record<string, unknown> = {};
    const { modes, rich } = modesOf(req);
    const keepTrip = (id: string) => (isMvkId(id) ? !rich || modes.has("bus") || modes.has("tram") : rich && modes.has(id.startsWith("1:") ? "rail" : "coach"));
    if (ymd === todayYmd) {
      const now = nowUnix();
      for (const [tripId, run] of engine.todayRuns) if (keepTrip(tripId)) out[tripId] = journalRecord(run, engine.matcher.liveDelay(tripId, now));
      sendJson(req, res, 200, { date: ymd, count: Object.keys(out).length, source: "live", trips: out }, { "cache-control": "no-store" });
      return;
    }
    const rows = await cached(`journal:${ymd}`, ymd < todayYmd ? 6 * 3600 : 300, () => sql(
      `SELECT DISTINCT ON (trip_id) trip_id, vehicle_id, stops_seen, stops_total, status, start_delay_s, end_delay_s, last_delay_s,
              extract(epoch FROM opened_at)::int AS opened, extract(epoch FROM last_seen_at)::int AS last_seen,
              extract(epoch FROM actual_start)::int AS a0, extract(epoch FROM actual_end)::int AS a1
         FROM trip_run WHERE service_date = $1 ORDER BY trip_id, stops_seen DESC`,
      [isoOfYmd(ymd)],
    ));
    for (const x of rows as Record<string, any>[]) {
      if (!keepTrip(x.trip_id)) continue;
      out[x.trip_id] = {
        vehicleId: x.vehicle_id,
        samples: x.stops_seen,
        firstSeen: x.opened,
        lastSeen: x.last_seen,
        startDelaySec: x.start_delay_s,
        endDelaySec: x.end_delay_s,
        actualStart: x.a0,
        actualEnd: x.a1,
        status: x.status,
        stopsSeen: x.stops_seen,
        stopsTotal: x.stops_total,
        lastDelaySec: x.last_delay_s,
      };
    }
    sendJson(req, res, 200, { date: ymd, count: Object.keys(out).length, source: "db", trips: out });
  });

  r.get("/weather", (req, res) => {
    if (!engine.weather) throw new HttpError(502, "időjárás nem elérhető");
    sendJson(req, res, 200, engine.weather.data, { "cache-control": "public, max-age=120" });
  });

  // ── állapot ───────────────────────────────────────────────────────────
  r.get("/_health", (req, res) => {
    const st = tokenStatus();
    sendJson(req, res, 200, {
      jwt: { present: st.present, exp: st.exp, expiresInSec: st.expiresInSec, expired: st.expired, installationId: st.installationId },
      autoRenew: true,
      lastRenew: lastRenewInfo(),
      tokenRejected: tokenRejectedRecently(),
      gtfs: { feedVersion: feeds.latest()?.version ?? "", stops: feeds.latest()?.stops.size ?? 0 },
      installationIdKnown: Boolean(st.installationId),
      poll: { ...engine.poll, rtError: engine.snapshot.rtError },
      // v3: az MVK-adat forrása (tartalékban a MÁV+) és a regionális adat
      source: engine.sources.status(),
      regional: { feeds: ctx.regionalFeeds.status(), realtime: ctx.regionalRt.status(), shadow: engine.shadowStats() },
    });
  });

  r.get("/system/info", (req, res) => {
    const mem = process.memoryUsage();
    const feed = feeds.latest();
    sendJson(req, res, 200, {
      uptimeSec: Math.floor(process.uptime()),
      nodeVersion: process.version,
      memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), heapTotalMb: Math.round(mem.heapTotal / 1048576) },
      gtfs: { ...feeds.status(), feedVersion: feed?.version ?? "", stops: feed?.stops.size ?? 0, routes: feed?.routes.size ?? 0, trips: feed?.trips.size ?? 0, shapes: feed?.shapes.size ?? 0 },
      jwt: tokenStatus(),
      installationId: tokenStatus().installationId ?? null,
      journal: { enabled: true, day: engine.today.replace(/-/g, ""), tripsSeen: engine.todayRuns.size, pendingWrites: engine.persister.pending() },
      persist: engine.persister.stats,
      poll: engine.poll,
      predictor: predictor.status(),
      hub: ctx.hubStats(),
      cache: cacheStatus(),
    });
  });

  r.get("/system/cache", (req, res) => {
    const s = engine.snapshot;
    sendJson(req, res, 200, {
      ttlMs: config.pollMs,
      feeds: [{ path: "/api/v1/gtfs/get-positions", ageMs: s.fetchedAt ? Date.now() - s.fetchedAt : null, status: s.fetchedAt ? 200 : 0, bytes: 0, inflight: false }],
      vehicles: { ageMs: s.fetchedAt ? Date.now() - s.fetchedAt : null, count: s.vehicles.length },
      weather: engine.weather ? { ageMs: Date.now() - engine.weather.at } : null,
      shared: cacheStatus(),
    });
  });

  // ── token (védett) ────────────────────────────────────────────────────
  r.get("/_jwt", (req, res) => {
    requireAdmin(req);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(currentJwt() || "(nincs)");
  });
  r.get("/_export", (req, res) => {
    requireAdmin(req);
    const st = tokenStatus();
    sendJson(req, res, 200, { jwt: currentJwt(), installationId: st.installationId, status: st, exportedAt: new Date().toISOString() });
  });
  r.post("/_ingest", async (req, res) => {
    const body = req.body?.toString("utf8").trim() ?? "";
    const signed = verifyAgentRequest(config.agentSecret, header(req, "x-agent-ts"), header(req, "x-agent-signature"), body);
    if (!signed) requireAdmin(req);
    let tok = body;
    let inst = "";
    if (body.startsWith("{")) {
      try {
        const j = JSON.parse(body);
        tok = String(j.jwt ?? j.token ?? "").trim();
        inst = String(j.installationId ?? j["installation-id"] ?? "").trim();
      } catch {
        tok = "";
      }
    }
    const r2 = await ingestToken(tok, signed ? "agent" : "manual", header(req, "x-agent-id") ?? null, inst || null);
    if (!r2.ok) throw new HttpError(400, r2.error);
    sendJson(req, res, 200, { ok: true, jwt: r2.status, installationIdSaved: Boolean(r2.status.installationId) });
  });
  r.post("/_renew", async (req, res) => {
    requireAdmin(req);
    const result = await renewToken("kézi");
    sendJson(req, res, result?.ok ? 200 : 502, { triggered: true, result, jwt: tokenStatus() });
  });
  r.post("/system/reload-gtfs", async (req, res) => {
    requireAdmin(req);
    const result = await feeds.refresh();
    const f = feeds.latest();
    sendJson(req, res, 200, { ok: true, result, feedVersion: f?.version, stops: f?.stops.size, routes: f?.routes.size, trips: f?.trips.size });
  });
  r.post("/system/restart", (req, res) => {
    requireAdmin(req);
    setTimeout(() => process.exit(0), 200);
    sendJson(req, res, 200, { ok: true, managed: true, message: "A worker újraindul (a Docker visszaindítja)." });
  });
  r.post("/system/refresh-app-token", (req, res) => {
    sendJson(req, res, 409, { ok: false, error: "A token frissítését a macOS token-agent végzi (apps/token-agent), nem a szerver." });
  });

  // ── macOS token-agent ─────────────────────────────────────────────────
  r.post("/agent/token", async (req, res) => {
    const body = req.body?.toString("utf8") ?? "";
    if (!verifyAgentRequest(config.agentSecret, header(req, "x-agent-ts"), header(req, "x-agent-signature"), body)) throw new HttpError(401, "érvénytelen aláírás");
    const j = JSON.parse(body) as { jwt?: string; installationId?: string; agentId?: string; info?: unknown };
    const agentId = String(j.agentId ?? header(req, "x-agent-id") ?? "agent");
    await heartbeat(agentId, j.info);
    const r2 = await ingestToken(String(j.jwt ?? ""), "agent", agentId, j.installationId ?? null);
    if (!r2.ok) throw new HttpError(400, r2.error);
    sendJson(req, res, 200, { ok: true, status: r2.status });
  });
  r.post("/agent/status", async (req, res) => {
    const body = req.body?.toString("utf8") ?? "";
    if (!verifyAgentRequest(config.agentSecret, header(req, "x-agent-ts"), header(req, "x-agent-signature"), body)) throw new HttpError(401, "érvénytelen aláírás");
    const j = body ? (JSON.parse(body) as { agentId?: string; info?: unknown }) : {};
    const agentId = String(j.agentId ?? "agent");
    await heartbeat(agentId, j.info);
    const st = tokenStatus();
    // A rendszer-hubból kért parancs (app-újraindítás, token küldése) — az új agent végrehajtja, a régi figyelmen kívül hagyja.
    const command = await pickAgentCommand(agentId);
    // Az agent ebből dönti el, kell-e újraindítania az MVK appot.
    sendJson(req, res, 200, {
      present: st.present,
      expiresInSec: st.expiresInSec ?? null,
      rejected: tokenRejectedRecently(),
      wantFresh: !st.present || (st.expiresInSec ?? 0) < 3.5 * 3600 || tokenRejectedRecently(),
      command,
      nextCheckSec: AGENT_POLL_SEC,
    });
  });
  r.post("/agent/ack", async (req, res) => {
    const body = req.body?.toString("utf8") ?? "";
    if (!verifyAgentRequest(config.agentSecret, header(req, "x-agent-ts"), header(req, "x-agent-signature"), body)) throw new HttpError(401, "érvénytelen aláírás");
    const j = JSON.parse(body) as { id?: number; ok?: boolean; note?: string };
    if (!Number.isInteger(j.id)) throw new HttpError(400, "hiányzó parancs-azonosító");
    await sql(`UPDATE agent_command SET done_at = now(), ok = $2, note = $3 WHERE id = $1 AND done_at IS NULL`, [j.id, Boolean(j.ok), String(j.note ?? "").slice(0, 500)]);
    log.info("agent", `parancs #${j.id} ${j.ok ? "kész" : "sikertelen"}${j.note ? `: ${String(j.note).slice(0, 120)}` : ""}`);
    sendJson(req, res, 200, { ok: true });
  });

  // ── MVK proxy (szűkítve) ──────────────────────────────────────────────
  r.get("/MVK_mobilapp/GTFS/MVK_GTFS.zip", async (req, res) => {
    const zip = await feeds.latestZip();
    if (!zip) throw new HttpError(404, "nincs tárolt GTFS");
    res.writeHead(200, { "content-type": "application/zip", "content-length": String(zip.length), "cache-control": "public, max-age=900" });
    res.end(zip);
  });
  r.all("/api/*", async (req, res) => proxyMvk(req, res));
}

function header(req: Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** az agent ennyi másodperc múlva jelentkezzen újra (a hubból kért parancs így fél percen belül célba ér) */
const AGENT_POLL_SEC = 30;
/** ennél régebbi, fel nem vett parancsot már nem adunk ki (a hub „lejárt”-nak mutatja) */
const AGENT_COMMAND_TTL = "30 minutes";

async function pickAgentCommand(agentId: string): Promise<{ id: number; kind: string } | null> {
  const rows = await sql<{ id: number; kind: string }>(
    `UPDATE agent_command SET picked_at = now(), picked_by = $1
      WHERE id = (SELECT id FROM agent_command
                   WHERE picked_at IS NULL AND (agent_id IS NULL OR agent_id = $1) AND created_at > now() - interval '${AGENT_COMMAND_TTL}'
                   ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind`,
    [agentId.slice(0, 64)],
  ).catch((e) => {
    log.warn("agent", "a parancssor nem olvasható", errMsg(e));
    return [];
  });
  if (rows[0]) log.info("agent", `parancs #${rows[0].id} (${rows[0].kind}) → ${agentId}`);
  return rows[0] ?? null;
}

async function heartbeat(agentId: string, info: unknown) {
  await sql(
    `INSERT INTO agent_heartbeat (agent_id, last_seen_at, info) VALUES ($1, now(), $2)
     ON CONFLICT (agent_id) DO UPDATE SET last_seen_at = now(), info = EXCLUDED.info`,
    [agentId.slice(0, 64), JSON.stringify(info ?? {})],
  );
}

export function journalRecord(run: import("@mvk/core").RunOut, liveDelay: number | null) {
  return {
    vehicleId: run.vehicleId,
    samples: run.stopsSeen,
    firstSeen: run.openedTs,
    lastSeen: run.lastTs,
    startDelaySec: run.startDelayS,
    endDelaySec: run.endDelayS,
    actualStart: run.actualStart,
    actualEnd: run.actualEnd,
    status: run.status,
    stopsSeen: run.stopsSeen,
    stopsTotal: run.stopsTotal,
    lastDelaySec: run.lastDelayS,
    liveDelaySec: run.status === "running" ? liveDelay : null,
    lastStopIdx: run.lastStopIdx,
  };
}

function cancelledRow(day: ServiceDay | null, tripId: string) {
  const feed = day?.feed;
  const t = feed?.trips.get(tripId);
  const rt = t ? feed!.routes.get(t.routeId) : undefined;
  const st = t ? feed!.tripStops.get(tripId) : undefined;
  const first = st?.[0] ?? null;
  const last = st?.[st.length - 1] ?? null;
  return {
    tripId,
    known: Boolean(t),
    routeId: t?.routeId ?? "",
    routeShort: rt?.short ?? "",
    routeColor: rt?.color ?? "888888",
    routeText: rt?.text ?? "FFFFFF",
    dir: t?.dir ?? "",
    headsign: t?.headsign ?? "",
    departure: first ? secToHm(first.dep) : null,
    departureSec: first?.dep ?? null,
    arrival: last ? secToHm(last.dep) : null,
    originName: first ? (feed!.stops.get(first.stopId)?.name ?? first.stopId) : null,
    destinationName: last ? (feed!.stops.get(last.stopId)?.name ?? last.stopId) : null,
  };
}

// Az MVK API csak olvasó, utas-oldali végpontjai mehetnek át — a régi
// gateway nyitott proxyja bárkinek a tokenünkkel hívhatott bármit.
const PROXY_ALLOW: [method: string, re: RegExp][] = [
  ["POST", /^\/api\/v1\/route\/plan$/],
  ["GET", /^\/api\/v1\/geocode\/(search|reverse)$/],
  ["GET", /^\/api\/v1\/gbfs\/[\w./-]+$/],
  ["GET", /^\/api\/v1\/news\/[\w/-]+$/],
  ["GET", /^\/api\/v1\/weather\/(latest|alerts)$/],
  ["GET", /^\/api\/v1\/parameter\/list$/],
  ["GET", /^\/api\/v1\/statistics\/[\w/-]+$/],
  ["GET", /^\/api\/v1\/gtfs\/(get-positions|get-updates|list-cancelled-trips)$/],
];
const rate = new Map<string, { n: number; reset: number }>();

async function proxyMvk(req: Req, res: ServerResponse) {
  const method = req.method ?? "GET";
  if (!PROXY_ALLOW.some(([m, re]) => m === method && re.test(req.path))) throw new HttpError(403, "ez az MVK-végpont nem érhető el a proxyn");
  const now = Date.now();
  // A lejárt keretek kitakarítása, hogy a sok különböző címtől a Map ne nőjön a végtelenségig.
  if (rate.size > 5000) for (const [ip, x] of rate) if (now > x.reset) rate.delete(ip);
  const b = rate.get(req.ip) ?? { n: 0, reset: now + 60_000 };
  if (now > b.reset) Object.assign(b, { n: 0, reset: now + 60_000 });
  b.n++;
  rate.set(req.ip, b);
  if (b.n > 120) throw new HttpError(429, "túl sok kérés");
  const qs = req.query.toString();
  const r = await mvkFetch(req.path + (qs ? `?${qs}` : ""), {
    method,
    body: method === "POST" ? req.body : undefined,
    contentType: method === "POST" ? String(req.headers["content-type"] ?? "application/json") : undefined,
    accept: String(req.headers.accept ?? "application/json"),
    timeoutMs: 20_000,
  });
  res.writeHead(r.status, { "content-type": r.contentType ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(r.buf);
}
