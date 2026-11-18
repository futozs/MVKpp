/**
 * Élő flotta-rangsor (Figyelő → Flotta): az összes úton lévő MVK-jármű a
 * mostani késésével, hogy hol jár és hol szedte fel a késést; mellé a
 * villamosvonal és a buszhálózat gerincének állapota.
 *
 * A megálló-eseményekből menetenként a késés útja épül (a visszajátszott mai
 * napból is), a járatok mozgását pedig minden körben nézzük: a hosszan egy
 * helyben álló villamos a leállás jele.
 */
import {
  BUS,
  busState,
  delayPickup,
  isMvkId,
  jamCorridors,
  localMidnightUnix,
  medianOf,
  nowUnix,
  tramState,
  type DelayPoint,
  type BoardSnapshot,
  type BoardVehicle,
  type ServiceDay,
  type StopEventOut,
} from "@mvk/core";
import type { Engine } from "./engine.ts";
import type { TrafficMonitor } from "./traffic.ts";

/** GTFS route_type: villamos (az MVK-nál 900) */
const TRAM_ROUTE_TYPE = "900";
/** villamospótló buszok vonalai (VP, 1VP) */
const REPLACEMENT_ROUTE = /^\d*VP$/;
/** a jel legfeljebb ennyi idős lehet, hogy a jármű „úton lévőnek” számítson (mp) */
const LIVE_PING_S = 180;
/** ennél régebbi jelnél nem tudjuk, áll-e a jármű (mp) */
const STALL_SIGNAL_S = 90;
/** ennyit kell haladnia, hogy ne álljon (m) */
const MOVED_M = 30;
/** ennyi késés vagy sietés alatt a jármű „időben” van (mp) */
const ON_TIME_S = 60;
const CACHE_S = 10;

type TramPlan = { iso: string; tram: [number, number][]; replacement: boolean };

export class FleetBoard {
  private engine: Engine;
  private traffic: TrafficMonitor;
  /** menet → a megállóinál mért késések */
  private trail = new Map<string, DelayPoint[]>();
  /** jármű → hol tartott, és mióta nem mozdult */
  private still = new Map<string, { tripId: string; alongM: number; since: number }>();
  private plan: TramPlan | null = null;
  private cache: { at: number; value: BoardSnapshot } | null = null;

  constructor(engine: Engine, traffic: TrafficMonitor) {
    this.engine = engine;
    this.traffic = traffic;
    engine.on("stopEvent", (e) => this.onStopEvent(e));
    engine.on("tick", () => this.trackMotion(nowUnix()));
  }

  private onStopEvent(e: StopEventOut) {
    // a becsült beérkezés nem mérés; a regionális járművek nem a flotta részei
    if (e.src === "final" || !isMvkId(e.vehicleId)) return;
    const list = this.trail.get(e.runKey) ?? [];
    const i = list.findIndex((p) => p.idx === e.stopIdx);
    const point = { idx: e.stopIdx, stopId: e.stopId, delayS: e.delayS };
    if (i >= 0) list[i] = point;
    else list.push(point);
    this.trail.set(e.runKey, list);
  }

  private trackMotion(now: number) {
    // a lezárult menetek késés-nyomai nem kellenek tovább
    if (this.trail.size > 400) {
      const running = new Set([...this.engine.todayRuns.values()].filter((r) => r.status === "running").map((r) => r.runKey));
      for (const k of this.trail.keys()) if (!running.has(k)) this.trail.delete(k);
    }
    for (const run of this.engine.todayRuns.values()) {
      if (run.status !== "running" || !isMvkId(run.vehicleId)) continue;
      const m = this.engine.matcher.motion(run.vehicleId);
      const prev = this.still.get(run.vehicleId);
      // A kiinduló megállóban várakozás és a jel nélküli idő nem elakadás.
      if (!m || m.tripId !== run.tripId || now - m.ts > STALL_SIGNAL_S) {
        this.still.delete(run.vehicleId);
        continue;
      }
      if (!prev || prev.tripId !== m.tripId || Math.abs(m.alongM - prev.alongM) > MOVED_M) {
        this.still.set(run.vehicleId, { tripId: m.tripId, alongM: m.alongM, since: m.ts });
      }
    }
  }

  snapshot(now = nowUnix()): BoardSnapshot {
    if (this.cache && now - this.cache.at < CACHE_S) return this.cache.value;
    const value = this.compute(now);
    this.cache = { at: now, value };
    return value;
  }

  /** a mai menetrend villamosmenetei (indulás, érkezés) és hogy van-e pótlóbusz-menet */
  private tramPlan(day: ServiceDay): TramPlan {
    if (this.plan?.iso === day.iso) return this.plan;
    const tram: [number, number][] = [];
    let replacement = false;
    for (const t of day.feed.trips.values()) {
      if (!isMvkId(t.id) || !day.services.has(t.serviceId)) continue;
      const route = day.feed.routes.get(t.routeId);
      if (route && REPLACEMENT_ROUTE.test(route.short)) replacement = true;
      if (route?.type !== TRAM_ROUTE_TYPE) continue;
      const st = day.feed.tripStops.get(t.id);
      if (st?.length) tram.push([st[0].dep, st[st.length - 1].arr]);
    }
    this.plan = { iso: day.iso, tram, replacement };
    return this.plan;
  }

  private compute(now: number): BoardSnapshot {
    const day = this.engine.feeds.cachedDay(this.engine.today);
    const decoded = new Map(this.engine.snapshot.decoded.map((v) => [v.id, v]));
    const jams = this.traffic.congestedLinks(now);
    const vehicles: BoardVehicle[] = [];

    for (const run of this.engine.todayRuns.values()) {
      if (run.status !== "running" || !isMvkId(run.vehicleId) || now - run.lastTs > LIVE_PING_S) continue;
      const v = decoded.get(run.vehicleId);
      // menetrendből becsült helyzet: nincs mért késése
      if (!v || v.estimated) continue;
      const feed = this.engine.feeds.cachedDay(run.serviceDate)?.feed;
      const route = feed?.routes.get(run.routeId);
      const along = feed?.tripStopsAlong(run.tripId);
      const name = (id: string) => feed?.stops.get(id)?.name ?? id;
      const delayS = this.engine.matcher.liveDelay(run.tripId, now) ?? run.lastDelayS;
      if (delayS == null) continue;

      const m = this.engine.matcher.motion(run.vehicleId);
      const motion = m && m.tripId === run.tripId ? m : null;
      const toIdx = motion && along ? along.findIndex((s, i) => i > (run.lastStopIdx ?? -1) && s.stopId === motion.toStopId) : -1;
      const p = delayPickup(this.trail.get(run.runKey) ?? [], motion && toIdx >= 0 ? { toStopId: motion.toStopId, toIdx, delayS } : null);
      const pickedJam = Boolean(
        p && along?.slice(p.fromIdx, p.toIdx + 1).some((s, i, a) => i > 0 && jams.has(`${a[i - 1].stopId}|${s.stopId}`)),
      );
      const st = this.still.get(run.vehicleId);
      const stallS = st && st.tripId === run.tripId && now - st.since >= 60 ? now - st.since : null;

      vehicles.push({
        vehicleId: run.vehicleId,
        label: v.label || run.vehicleId,
        plate: v.plate ?? null,
        route: run.routeShort,
        color: route?.color ?? v.routeColor,
        text: route?.text ?? v.routeText,
        mode: route?.type === TRAM_ROUTE_TYPE ? "tram" : "bus",
        replacement: REPLACEMENT_ROUTE.test(run.routeShort),
        tripId: run.tripId,
        headsign: run.headsign,
        delayS,
        startDelayS: run.startDelayS,
        at: motion ? { from: motion.fromStopId ? name(motion.fromStopId) : null, to: name(motion.toStopId), stopped: motion.stopped } : null,
        stopsDone: run.lastStopIdx != null ? run.lastStopIdx + 1 : 0,
        stopsTotal: run.stopsTotal,
        pickup: p ? { from: name(p.fromStopId), to: name(p.toStopId), fromIdx: p.fromIdx, toIdx: p.toIdx, gainS: p.gainS, ongoing: p.ongoing, jam: pickedJam } : null,
        stallS,
      });
    }
    vehicles.sort((a, b) => b.delayS - a.delayS);

    // ── villamos ──
    const trams = vehicles.filter((v) => v.mode === "tram");
    const replacementRunning = vehicles.filter((v) => v.replacement).length;
    const plan = day ? this.tramPlan(day) : null;
    const nowS = now - localMidnightUnix(this.engine.today);
    const scheduled = plan ? plan.tram.filter(([dep, arr]) => dep <= nowS && nowS <= arr).length : 0;
    const tramMedian = medianOf(trams.map((v) => v.delayS));
    const stalled = trams
      .filter((v) => (v.stallS ?? 0) >= 120)
      .map((v) => ({ vehicleId: v.vehicleId, route: v.route, at: v.at?.from ?? v.at?.to ?? v.headsign, stallS: v.stallS ?? 0 }))
      .sort((a, b) => b.stallS - a.stallS);

    // ── busz ──
    const buses = vehicles.filter((v) => v.mode === "bus");
    const late = buses.filter((v) => v.delayS >= BUS.LATE_S).length;
    const segments = this.traffic.snapshot(now).segments;
    const backbone = segments.filter((s) => s.routes.length >= BUS.BACKBONE_ROUTES);
    const corridors = jamCorridors(backbone.map((s) => ({ fromId: s.fromId, toId: s.toId, from: s.from, to: s.to, routes: s.routes, excessS: s.excessS, level: s.level })));

    return {
      at: now,
      vehicles,
      tram: {
        state: tramState({ scheduled, running: trams.length, stalledS: stalled.map((s) => s.stallS), replacementRunning, medianDelayS: tramMedian }),
        scheduled,
        running: trams.length,
        replacementRunning,
        replacementPlanned: plan?.replacement ?? false,
        medianDelayS: tramMedian,
        stalled,
      },
      bus: {
        state: busState({ running: buses.length, late, backbone: corridors }),
        running: buses.length,
        late,
        early: buses.filter((v) => v.delayS <= -ON_TIME_S).length,
        medianDelayS: medianOf(buses.map((v) => v.delayS)),
        corridors: corridors.slice(0, 6),
        otherJams: segments.length - backbone.length,
      },
    };
  }
}
