/**
 * v3 közlekedési végpontok a Volánhoz és a vasúthoz (és mindenhez, ami közös):
 * keresés, állomás, viszonylat-tábla (A → B), vonat vonatszám szerint, zavarok,
 * és az adatforrások állapota.
 */
import {
  ALL_MODES,
  findTrains,
  isMvkId,
  modeOfRoute,
  nowUnix,
  operatorLabel,
  parseModes,
  relationBoard,
  searchKey,
  secToHm,
  stopAllowed,
  trainParts,
  type Feed,
  type TransitMode,
} from "@mvk/core";
import { sql } from "@mvk/db";
import { modesOf, requireAdmin, type Ctx } from "./compat.ts";
import { HttpError, sendJson, type Router } from "./router.ts";

const SEARCH_LIMIT = 30;

type StopHit = {
  id: string;
  name: string;
  mode: "mvk" | "coach" | "rail";
  station: boolean;
  platforms: number;
  lat: number;
  lon: number;
  routes: { short: string; color: string; text: string; mode: TransitMode }[];
};

const stopFeed = (id: string): StopHit["mode"] => (isMvkId(id) ? "mvk" : id.startsWith("1:") ? "rail" : "coach");

/** Egy megálló / állomás vonalai (a táblán melyik járatok állnak meg). */
function routesAt(feed: Feed, id: string, limit = 8): StopHit["routes"] {
  const seen = new Map<string, StopHit["routes"][number]>();
  for (const sid of feed.stopsOf(id)) {
    for (const { trip } of feed.stopSched.get(sid) ?? []) {
      const t = feed.trips.get(trip);
      const r = t ? feed.routes.get(t.routeId) : undefined;
      if (!r || seen.has(r.id)) continue;
      seen.set(r.id, { short: r.short, color: r.color, text: r.text, mode: modeOfRoute(r.id, r.type) });
      if (seen.size >= limit * 3) break;
    }
  }
  // vasútnál a kategóriák (Sz, IC…) ismétlődnek: kategóriánként egy
  const uniq = new Map<string, StopHit["routes"][number]>();
  for (const r of seen.values()) if (!uniq.has(`${r.mode}|${r.short}`)) uniq.set(`${r.mode}|${r.short}`, r);
  return [...uniq.values()].slice(0, limit);
}

export function registerTransit(r: Router, ctx: Ctx) {
  const { engine, feeds } = ctx;
  const today = () => feeds.cachedDay(engine.today);
  const extras = (modes?: ReadonlySet<TransitMode>) => {
    const ex = ctx.insights.extras(nowUnix(), modes, true);
    return { cancelled: ex.cancelled, platform: ex.platform, notices: ex.notices, modes };
  };

  /**
   * Megálló- és állomáskeresés minden feedben (ékezet nélkül is). Az állomás
   * (vasútállomás, autóbusz-állomás) egy találat, a vágányai nem külön.
   */
  r.get("/engine/transit/search", (req, res) => {
    const q = searchKey(req.query.get("q") ?? "");
    if (q.length < 2) throw new HttpError(400, "legalább 2 karakter kell (?q=)");
    const modes = parseModes(req.query.get("modes"), ALL_MODES);
    const feed = today()?.feed;
    if (!feed) throw new HttpError(503, "nincs menetrend");
    const hits: (StopHit & { score: number })[] = [];
    const words = q.split(" ");
    for (const s of feed.stops.values()) {
      // a vágány / kocsiállás az állomásán keresztül található meg
      if (s.parent && feed.stops.has(s.parent)) continue;
      if (!stopAllowed(s.id, modes)) continue;
      const kids = feed.stopsOf(s.id);
      if (!kids.some((k) => (feed.stopSched.get(k)?.length ?? 0) > 0)) continue;
      const key = searchKey(s.name);
      const bare = key.replace(/^miskolc /, "");
      if (!words.every((w) => key.includes(w))) continue;
      const score = (bare.startsWith(q) || key.startsWith(q) ? 0 : 2) + (s.station ? 0 : 1) + (isMvkId(s.id) ? 0.5 : 0);
      hits.push({
        id: s.id,
        name: s.name,
        mode: stopFeed(s.id),
        station: Boolean(s.station),
        platforms: s.station ? kids.length : 0,
        lat: s.lat,
        lon: s.lon,
        routes: routesAt(feed, s.id),
        score,
      });
    }
    hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "hu"));
    // vonatszám is lehet a keresés („5139”)
    const trains = /^\d{2,6}$/.test(q) && modes.has("rail") ? trainSummaries(ctx, q) : [];
    sendJson(req, res, 200, { q, stops: hits.slice(0, SEARCH_LIMIT).map(({ score: _s, ...h }) => h), trains }, { "cache-control": "public, max-age=60" });
  });

  /** Egy megálló vagy állomás: vágányok, a megálló vonalai, a módjai. */
  r.get("/engine/transit/stop", (req, res) => {
    const id = (req.query.get("id") ?? "").trim();
    const feed = today()?.feed;
    const s = feed?.stops.get(id);
    if (!feed || !s) throw new HttpError(404, "ismeretlen megálló");
    const children = feed.stationChildren.get(id) ?? [];
    sendJson(req, res, 200, {
      id,
      name: s.name,
      code: s.code,
      lat: s.lat,
      lon: s.lon,
      station: Boolean(s.station),
      parent: s.parent ?? null,
      mode: stopFeed(id),
      platforms: children.map((c) => ({ id: c, platform: feed.stops.get(c)?.platform ?? null })),
      routes: routesAt(feed, id, 30),
    });
  });

  /** Viszonylat-tábla: A-ból B-be közvetlenül (pl. Miskolc-Tiszai → Füzesabony). */
  r.get("/engine/transit/relation", (req, res) => {
    const from = (req.query.get("from") ?? "").trim();
    const to = (req.query.get("to") ?? "").trim();
    if (!from || !to || from === to) throw new HttpError(400, "?from= és ?to= kell (két különböző megálló)");
    const limit = Math.min(30, Math.max(1, Number(req.query.get("limit") ?? 8) || 8));
    const { modes } = modesOf(req);
    const now = nowUnix();
    for (const id of [from, to]) ctx.regionalRt.touch(id);
    const board = relationBoard(from, to, limit, engine.snapshot, feeds.arrivalDays(now), now, extras(req.query.has("modes") ? modes : undefined));
    sendJson(req, res, 200, board, { "cache-control": "no-store" });
  });

  /** Egy vonat vonatszám szerint: a ma (vagy ha már elment, holnap) közlekedő példány megállónként. */
  r.get("/engine/transit/train", (req, res) => {
    const no = (req.query.get("no") ?? "").trim();
    if (!/^\d{1,6}$/.test(no)) throw new HttpError(400, "érvénytelen ?no= (vonatszám)");
    sendJson(req, res, 200, trainDetail(ctx, no), { "cache-control": "no-store" });
  });

  /** A Volán és a vasút hivatalos zavarai (késésok, kocsiösszeállítás, pótlóbusz, Telebusz). */
  r.get("/engine/transit/alerts", (req, res) => {
    const modes = parseModes(req.query.get("modes"), ALL_MODES);
    const feed = today()?.feed;
    const list = ctx.regionalRt.alerts
      .filter((a) => modes.has(a.feed === "1" ? "rail" : "coach"))
      .filter((a) => !a.trips.length || a.trips.some((t) => feed?.trips.has(t)) || a.stops.some((s) => feed?.stops.has(s)))
      .map((a) => ({
        ...a,
        trains: a.trips
          .map((t) => feed?.trips.get(t))
          .filter((t) => t?.shortName)
          .map((t) => ({ tripId: t!.id, no: trainParts(t!.shortName).no, name: t!.shortName, headsign: t!.headsign })),
      }));
    sendJson(req, res, 200, { at: ctx.regionalRt.alertsAt ? new Date(ctx.regionalRt.alertsAt).toISOString() : null, alerts: list });
  });

  /** Az adatforrások állapota (rendszer-hub): MVK ↔ MÁV+ átváltás, árnyék-összevetés, regionális menetrend. */
  r.get("/system/sources", async (req, res) => {
    requireAdmin(req);
    const history = await sql(
      `SELECT service_date::text AS date, source, polls_ok, polls_fail, vehicles_max, lag_p50_s, lag_p95_s, coverage, fallback_s
         FROM source_health WHERE service_date >= CURRENT_DATE - 14 ORDER BY service_date DESC, source`,
    ).catch(() => []);
    sendJson(req, res, 200, {
      mvk: { ...engine.sources.status(), poll: engine.poll },
      snapshot: { source: engine.snapshot.source ?? null, rtError: engine.snapshot.rtError, vehicles: engine.snapshot.vehicles.length, regionalAt: engine.snapshot.regionalAt || null },
      shadow: engine.shadowStats(),
      regional: { feeds: ctx.regionalFeeds.status(), builds: ctx.regionalFeeds.builds, realtime: ctx.regionalRt.status() },
      history,
    }, { "cache-control": "no-store" });
  });

  /** A regionális menetrend újraépítése (rendszer-hub). */
  r.post("/system/regional-build", (req, res) => {
    requireAdmin(req);
    void ctx.regionalFeeds.ensureAhead(true);
    sendJson(req, res, 202, { ok: true, started: true });
  });
}

type TrainStop = {
  id: string;
  name: string;
  platform: string | null;
  schedArr: string;
  schedDep: string;
  arrUnix: number;
  depUnix: number;
  delaySec: number | null;
  passed: boolean;
};

/** A vonatszám mai / holnapi menetei röviden (a keresésnek). */
function trainSummaries(ctx: Ctx, no: string) {
  const now = nowUnix();
  const days = ctx.feeds.arrivalDays(now);
  return findTrains(days, no)
    .filter((m) => m.lastArrUnix >= now - 1800)
    .slice(0, 3)
    .map((m) => {
      const f = days[m.dayIndex].day.feed;
      const t = f.trips.get(m.tripId)!;
      const st = f.tripStops.get(m.tripId)!;
      return {
        tripId: m.tripId,
        no,
        name: t.shortName ?? no,
        headsign: t.headsign,
        from: f.stops.get(st[0].stopId)?.name ?? "",
        departure: secToHm(st[0].dep),
        today: m.dayIndex === 0,
      };
    });
}

function trainDetail(ctx: Ctx, no: string) {
  const { engine, feeds } = ctx;
  const now = nowUnix();
  const days = feeds.arrivalDays(now);
  const matches = findTrains(days, no);
  // a most futó, különben a következő, különben a mai utolsó
  const pick = matches.find((m) => m.firstDepUnix <= now && m.lastArrUnix + 600 >= now) ?? matches.find((m) => m.firstDepUnix > now) ?? matches[matches.length - 1] ?? null;
  if (!pick) return { no, found: false, trips: [] as unknown[] };
  const dc = days[pick.dayIndex];
  const f = dc.day.feed;
  const t = f.trips.get(pick.tripId)!;
  const r = f.routes.get(t.routeId);
  const isToday = pick.dayIndex === 0;
  const veh = isToday ? (engine.snapshot.vehicles.find((v) => v.tripId === t.id) ?? null) : null;
  const decoded = veh ? (engine.snapshot.decoded.find((v) => v.id === veh.id) ?? null) : null;
  const run = isToday ? (engine.todayRuns.get(t.id) ?? null) : null;
  const stops: TrainStop[] = (f.tripStops.get(t.id) ?? []).map((x, i) => {
    const p = isToday ? engine.snapshot.predByStop.get(x.stopId)?.get(t.id) : undefined;
    const s = f.stops.get(x.stopId);
    const delay = p?.delay ?? (run?.lastStopIdx != null && i > run.lastStopIdx ? run.lastDelayS : null);
    const depUnix = p?.unix ?? dc.midnightUnix + x.dep + (delay ?? 0);
    return {
      id: x.stopId,
      name: s?.name ?? x.stopId,
      platform: (isToday ? ctx.regionalRt.platform(t.id, x.stopId) : null) ?? s?.platform ?? null,
      schedArr: secToHm(x.arr),
      schedDep: secToHm(x.dep),
      arrUnix: dc.midnightUnix + x.arr + (delay ?? 0),
      depUnix,
      delaySec: delay,
      passed: run?.lastStopIdx != null ? i <= run.lastStopIdx : depUnix < now - 60,
    };
  });
  const tp = trainParts(t.shortName);
  return {
    no,
    found: true,
    tripId: t.id,
    date: dc.day.iso,
    today: isToday,
    name: t.shortName ?? no,
    trainName: tp.name,
    category: r?.short ?? null,
    route: r ? { key: r.key, short: r.short, long: r.long, color: r.color, text: r.text, mode: modeOfRoute(r.id, r.type), operator: operatorLabel(r.agencyName) } : null,
    headsign: t.headsign,
    stops,
    vehicle: decoded,
    run,
    liveDelaySec: run?.status === "running" ? engine.matcher.liveDelay(t.id, now) : null,
    officialDelaySec: decoded?.delaySec ?? null,
    notices: isToday ? ctx.regionalRt.noticeList(t.id) : [],
    cancelled: isToday && ctx.regionalRt.cancelled.has(t.id),
    others: matches.filter((m) => m !== pick).map((m) => ({ tripId: m.tripId, date: days[m.dayIndex].day.iso, departureUnix: m.firstDepUnix })),
  };
}
