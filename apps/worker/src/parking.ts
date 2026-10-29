/**
 * Parkoló: a flotta élő helyzete — ki áll melyik végállomáson, ki van a
 * kocsiszínben, ki jár menetben. A döntés a core `computeParking`-ja; itt
 * csak a bemenetét gyűjtjük: a járművek utolsó jele, a flotta múltja az
 * adatbázisból, a végállomások a menetrendből, a tippek az előrejelzőből.
 */
import {
  computeParking,
  dayInfo,
  localMidnightUnix,
  nowUnix,
  shiftIso,
  type Feed,
  type FleetKind,
  type FleetVehicle,
  type LiveSeen,
  type ParkingSnapshot,
  type Place,
  type ServiceDay,
  type TripEnds,
  type TripTip,
} from "@mvk/core";
import { sql } from "@mvk/db";
import type { Engine } from "./engine.ts";
import { errMsg, log } from "./log.ts";
import type { VehiclePredictor } from "./predict.ts";

const FLEET_TTL_MS = 10 * 60_000;
const SNAPSHOT_TTL_S = 10;
const TIPS_TTL_S = 60;
/** ennyi órán belül induló menetekre gyűjtünk tippet */
const TIP_HORIZON_S = 6 * 3600;
/** a flotta: aki az elmúlt ennyi napban menetet vitt */
const ACTIVE_DAYS = 28;
const HISTORY_DAYS = 56;
const RECENT_DAYS = 14;
const BUS_DEPOT_PREFIX = "Szondi György utca";
const TRAM_ROUTE_TYPE = "900";

type Places = {
  feedHash: string;
  iso: string;
  terminals: Place[];
  ends: Map<string, TripEnds>;
  busDepot: Place | null;
  tramRoutes: Set<string>;
};

type FleetRow = {
  id: string;
  kind: string | null;
  last_date: string;
  dt_days: number;
  dt_total: number;
  usual_out_s: number | null;
  recent: string[] | null;
};

export class Parking {
  private engine: Engine;
  private predictor: VehiclePredictor;
  private seen = new Map<string, LiveSeen>();
  private fleet: FleetVehicle[] = [];
  private fleetKey = "";
  private fleetAt = 0;
  private fleetLoading: Promise<void> | null = null;
  private places: Places | null = null;
  private tips: { at: number; byVehicle: Map<string, TripTip> } = { at: 0, byVehicle: new Map() };
  private cache: { at: number; data: ParkingSnapshot } | null = null;

  constructor(engine: Engine, predictor: VehiclePredictor) {
    this.engine = engine;
    this.predictor = predictor;
    engine.on("tick", () => this.track());
  }

  /** Indításkor: a mai utolsó jelek az adatbázisból (a már nem élő járműveké is) és a flotta. */
  async init(): Promise<void> {
    const now = nowUnix();
    const rows = await sql<{ id: string; ts: number; lat: number; lon: number; speed: number | null; route_short: string | null }>(
      `SELECT DISTINCT ON (vehicle_id) vehicle_id AS id, extract(epoch FROM ts)::int AS ts, lat, lon, speed, route_short
         FROM veh_ping WHERE ts BETWEEN to_timestamp($1) - interval '18 hours' AND to_timestamp($1)
        ORDER BY vehicle_id, ts DESC`,
      [now],
    );
    for (const r of rows) this.seen.set(r.id, { ts: r.ts, lat: r.lat, lon: r.lon, speed: r.speed, route: r.route_short });
    // A villamosvonalak ismerete kell a flotta típusához (busz/villamos).
    const day = this.engine.feeds.cachedDay(this.engine.today);
    if (day) this.placesFor(day, this.engine.today);
    await this.refreshFleet();
    log.info("parking", `${this.fleet.length} jármű a flottában, ${rows.length} utolsó jel betöltve`);
  }

  /** Pollonként: az élő járművek utolsó jele (a helyük és hogy mennek-e). */
  private track() {
    const feed = this.engine.feeds.cachedDay(this.engine.today)?.feed;
    for (const v of this.engine.snapshot.vehicles) {
      const ts = this.engine.lastTs.get(v.id);
      if (!ts) continue;
      const route = feed?.routes.get(v.routeId)?.short ?? null;
      this.seen.set(v.id, { ts, lat: v.lat, lon: v.lon, speed: v.speed, route });
    }
  }

  /** A pillanatnyi parkoló (10 mp-ig gyorsítótárazva). */
  snapshot(): ParkingSnapshot | null {
    const now = nowUnix();
    if (this.cache && now - this.cache.at < SNAPSHOT_TTL_S) return this.cache.data;
    const iso = this.engine.today;
    const day = this.engine.feeds.cachedDay(iso);
    if (!day) return null;
    if (Date.now() - this.fleetAt > FLEET_TTL_MS || this.fleetKey !== iso) void this.refreshFleet();
    const places = this.placesFor(day, iso);
    const tips = this.tipsFor(day, iso, now);
    const data = computeParking({
      now,
      serviceDate: iso,
      midnight: localMidnightUnix(iso),
      fleet: this.fleet,
      runs: this.engine.todayRuns.values(),
      seen: this.seen,
      tripEnds: (tripId) => places.ends.get(tripId) ?? endsOf(day.feed, tripId),
      terminals: places.terminals,
      busDepot: places.busDepot,
      isDepotStop: (kind, name) => kind === "bus" && name.startsWith(BUS_DEPOT_PREFIX),
      isTramRoute: (route) => places.tramRoutes.has(route),
      tipFor: (id) => tips.get(id) ?? null,
    });
    this.cache = { at: now, data };
    return data;
  }

  /** Végállomások, a buszkocsiszín helye és a villamosvonalak — feed-verziónként egyszer. */
  private placesFor(day: ServiceDay, iso: string): Places {
    const feed = day.feed;
    if (this.places && this.places.feedHash === feed.hash && this.places.iso === iso) return this.places;
    const ends = new Map<string, TripEnds>();
    const byName = new Map<string, { lat: number; lon: number; n: number }>();
    const add = (p: Place) => {
      const x = byName.get(p.name) ?? { lat: 0, lon: 0, n: 0 };
      x.lat += p.lat;
      x.lon += p.lon;
      x.n++;
      byName.set(p.name, x);
    };
    for (const t of feed.trips.values()) {
      if (!day.services.has(t.serviceId)) continue;
      const e = endsOf(feed, t.id);
      if (!e) continue;
      ends.set(t.id, e);
      add(e.first);
      add(e.last);
    }
    const avg = (name: string, x: { lat: number; lon: number; n: number }): Place => ({ name, lat: x.lat / x.n, lon: x.lon / x.n });
    const terminals = [...byName].filter(([name]) => !name.startsWith(BUS_DEPOT_PREFIX)).map(([name, x]) => avg(name, x));
    const depotStops = [...feed.stops.values()].filter((s) => s.name.startsWith(BUS_DEPOT_PREFIX));
    const busDepot = depotStops.length
      ? avg(BUS_DEPOT_PREFIX, depotStops.reduce((a, s) => ({ lat: a.lat + s.lat, lon: a.lon + s.lon, n: a.n + 1 }), { lat: 0, lon: 0, n: 0 }))
      : null;
    const tramRoutes = new Set([...feed.routes.values()].filter((r) => r.type === TRAM_ROUTE_TYPE).map((r) => r.short));
    this.places = { feedHash: feed.hash, iso, terminals, ends, busDepot, tramRoutes };
    return this.places;
  }

  /** Járművenként a legkorábbi menet, amit az előrejelző neki szán (percenként frissítve). */
  private tipsFor(day: ServiceDay, iso: string, now: number): Map<string, TripTip> {
    if (now - this.tips.at < TIPS_TTL_S) return this.tips.byVehicle;
    const nowS = now - localMidnightUnix(iso);
    const byVehicle = new Map<string, TripTip>();
    for (const t of day.feed.trips.values()) {
      if (!day.services.has(t.serviceId) || this.engine.todayRuns.has(t.id)) continue;
      const startS = day.feed.tripStops.get(t.id)?.[0]?.dep;
      if (startS == null || startS < nowS - 300 || startS > nowS + TIP_HORIZON_S) continue;
      const g = this.predictor.predict(t.id);
      if (!g || g.method === "matched") continue;
      const prev = byVehicle.get(g.id);
      if (prev && prev.startS <= startS) continue;
      const route = day.feed.routes.get(t.routeId)?.short ?? t.routeId;
      byVehicle.set(g.id, { tripId: t.id, route, startS, confidence: g.confidence, certain: false });
    }
    this.tips = { at: now, byVehicle };
    return byVehicle;
  }

  private refreshFleet(): Promise<void> {
    if (this.fleetLoading) return this.fleetLoading;
    const iso = this.engine.today;
    this.fleetLoading = loadFleet(iso, (r) => this.places?.tramRoutes.has(r) ?? false)
      .then((fleet) => {
        this.fleet = fleet;
        this.fleetKey = iso;
        this.fleetAt = Date.now();
        this.cache = null;
      })
      .catch((e) => log.warn("parking", "flotta betöltése sikertelen", errMsg(e)))
      .finally(() => (this.fleetLoading = null));
    return this.fleetLoading;
  }
}

function endsOf(feed: Feed, tripId: string): TripEnds | null {
  const st = feed.tripStops.get(tripId);
  if (!st?.length) return null;
  const a = feed.stops.get(st[0].stopId);
  const b = feed.stops.get(st[st.length - 1].stopId);
  if (!a || !b) return null;
  return { first: { name: a.name, lat: a.lat, lon: a.lon }, last: { name: b.name, lat: b.lat, lon: b.lon } };
}

/** A flotta múltja (a mai nap nélkül): utolsó kiállás, sorozat, szokásos kiállás, kedvenc vonalak. */
async function loadFleet(iso: string, isTramRoute: (route: string) => boolean): Promise<FleetVehicle[]> {
  const daytype = dayInfo(iso).daytype;
  const rows = await sql<FleetRow>(
    `WITH days AS (
       SELECT r.vehicle_id, r.service_date, min(r.sched_start_s) AS first_s
         FROM trip_run r
        WHERE r.service_date >= $1::date - $3::int AND r.service_date < $1::date AND r.status <> 'aborted'
        GROUP BY 1, 2),
     dt AS (
       SELECT c.service_date FROM calendar_day c
        WHERE c.daytype = $2 AND c.service_date >= $1::date - $3::int AND c.service_date < $1::date
          AND EXISTS (SELECT 1 FROM trip_run x WHERE x.service_date = c.service_date))
     SELECT d.vehicle_id AS id, v.kind, max(d.service_date)::text AS last_date,
            count(*) FILTER (WHERE d.service_date IN (SELECT service_date FROM dt))::int AS dt_days,
            (SELECT count(*) FROM dt)::int AS dt_total,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY d.first_s) FILTER (WHERE d.service_date IN (SELECT service_date FROM dt)) AS usual_out_s,
            array_agg(d.service_date::text ORDER BY d.service_date) FILTER (WHERE d.service_date >= $1::date - $4::int) AS recent
       FROM days d LEFT JOIN vehicle v USING (vehicle_id)
      GROUP BY d.vehicle_id, v.kind
     HAVING max(d.service_date) >= $1::date - $5::int`,
    [iso, daytype, HISTORY_DAYS, RECENT_DAYS, ACTIVE_DAYS],
  );
  const routeRows = await sql<{ id: string; r: string; n: number }>(
    `SELECT vehicle_id AS id, route_short AS r, count(*)::int AS n FROM trip_run
      WHERE service_date >= $1::date - $2::int AND service_date < $1::date AND status <> 'aborted'
      GROUP BY 1, 2`,
    [iso, ACTIVE_DAYS],
  );
  const routes = new Map<string, { r: string; n: number }[]>();
  for (const x of routeRows) routes.set(x.id, [...(routes.get(x.id) ?? []), { r: x.r, n: x.n }]);

  const days = Array.from({ length: RECENT_DAYS }, (_, i) => shiftIso(iso, i - RECENT_DAYS));
  return rows.map((r) => {
    const active = new Set(r.recent ?? []);
    let streak = 0;
    for (let i = days.length - 1; i >= 0 && active.has(days[i]); i--) streak++;
    const top = (routes.get(r.id) ?? []).sort((a, b) => b.n - a.n).slice(0, 3).map((x) => x.r);
    const kind: FleetKind = r.kind === "TRAM" || (r.kind !== "BUS" && top.some(isTramRoute)) ? "tram" : "bus";
    return {
      id: r.id,
      kind,
      lastDate: r.last_date,
      streakDays: streak,
      outShare: r.dt_total ? r.dt_days / r.dt_total : null,
      usualOutS: r.usual_out_s,
      recent: days.map((d) => (active.has(d) ? "1" : "0")).join(""),
      topRoutes: top,
    };
  });
}
