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
  analyzeTramLines,
  BUS,
  TRAM,
  busState,
  delayPickup,
  isMvkId,
  jamCorridors,
  localMidnightUnix,
  medianOf,
  nowUnix,
  tramState,
  troubleSpan,
  type DelayPoint,
  type BoardSnapshot,
  type BoardVehicle,
  type ServiceDay,
  type StopEventOut,
  type TramLineDef,
  type TramOnLine,
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
/** ennél kisebb körzetben araszolva is áll: a sorban álló villamos 10–20 métereket lép (m) */
const STILL_RADIUS_M = 120;
/** a mozgás-előzmény ennyi ideig marad meg (mp) */
const TRACK_S = 20 * 60;
/** a pótlóbusz-menet ennyivel a menetrendi ideje előtt / után is „tervezett” (mp) */
const PLAN_SLACK_S = 15 * 60;
/** ennyi késés vagy sietés alatt a jármű „időben” van (mp) */
const ON_TIME_S = 60;
const CACHE_S = 10;

type TramPlan = { iso: string; tram: [number, number][]; replacement: [number, number][]; lines: TramLineDef[] };

export class FleetBoard {
  private engine: Engine;
  private traffic: TrafficMonitor;
  /** menet → a megállóinál mért késések */
  private trail = new Map<string, DelayPoint[]>();
  /** jármű → a menete mentén az utóbbi percek helyzetei (idő, méter) */
  private track = new Map<string, { tripId: string; samples: [number, number][] }>();
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
      // A kiinduló megállóban várakozás és a jel nélküli idő nem elakadás.
      if (!m || m.tripId !== run.tripId || now - m.ts > STALL_SIGNAL_S) {
        this.track.delete(run.vehicleId);
        continue;
      }
      const t = this.track.get(run.vehicleId);
      const cur = t && t.tripId === m.tripId ? t : { tripId: m.tripId, samples: [] };
      const last = cur.samples[cur.samples.length - 1];
      if (!last || m.ts > last[0]) cur.samples.push([m.ts, m.alongM]);
      while (cur.samples.length && now - cur.samples[0][0] > TRACK_S) cur.samples.shift();
      this.track.set(run.vehicleId, cur);
    }
  }

  /** mióta van a jármű egy kis körzeten belül (mp); az araszolás is állásnak számít */
  private stallOf(vehicleId: string, tripId: string, now: number): number | null {
    const t = this.track.get(vehicleId);
    if (!t || t.tripId !== tripId || !t.samples.length) return null;
    const here = t.samples[t.samples.length - 1][1];
    let since = t.samples[t.samples.length - 1][0];
    for (let i = t.samples.length - 1; i >= 0 && Math.abs(t.samples[i][1] - here) <= STILL_RADIUS_M; i--) since = t.samples[i][0];
    return now - since >= 60 ? now - since : null;
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
    const replacement: [number, number][] = [];
    /** irányonként a leghosszabb villamosmenet megállói: a közös vonal (az 1A és a 2 ennek része) */
    const longest = new Map<string, string[]>();
    for (const t of day.feed.trips.values()) {
      if (!isMvkId(t.id) || !day.services.has(t.serviceId)) continue;
      const route = day.feed.routes.get(t.routeId);
      const st = day.feed.tripStops.get(t.id);
      if (!st?.length) continue;
      if (route && REPLACEMENT_ROUTE.test(route.short)) replacement.push([st[0].dep, st[st.length - 1].arr]);
      else if (route?.type === TRAM_ROUTE_TYPE) {
        tram.push([st[0].dep, st[st.length - 1].arr]);
        if (st.length > (longest.get(t.dir)?.length ?? 0)) longest.set(t.dir, st.map((x) => x.stopId));
      }
    }
    const name = (id: string) => day.feed.stops.get(id)?.name ?? id;
    const lines = [...longest.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([, ids]) => ({ toward: name(ids[ids.length - 1]), stops: ids.map((id) => ({ id, name: name(id) })) }));
    this.plan = { iso: day.iso, tram, replacement, lines };
    return this.plan;
  }

  /** A késő villamosok közös baj-szakasza, a legjobban késő menete mentén. */
  private troubleOf(late: BoardVehicle[]): BoardSnapshot["tram"]["trouble"] {
    const stopsOf = (v: BoardVehicle) => this.engine.feeds.cachedDay(this.engine.today)?.feed.tripStopsAlong(v.tripId)?.map((s) => s.stopId) ?? [];
    const withPickup = late.filter((v) => v.pickup);
    if (withPickup.length < 2) return null;
    const ref = stopsOf(withPickup[0]);
    const span = troubleSpan(
      ref,
      withPickup.map((v) => (v.pickup ? stopsOf(v).slice(v.pickup.fromIdx, v.pickup.toIdx + 1) : [])),
    );
    if (!span) return null;
    const feed = this.engine.feeds.cachedDay(this.engine.today)?.feed;
    const name = (id: string | undefined) => (id ? (feed?.stops.get(id)?.name ?? id) : "");
    return { from: name(ref[span.fromIdx]), to: name(ref[span.toIdx]), toward: name(ref[ref.length - 1]), vehicles: span.vehicles };
  }

  private compute(now: number): BoardSnapshot {
    const day = this.engine.feeds.cachedDay(this.engine.today);
    const decoded = new Map(this.engine.snapshot.decoded.map((v) => [v.id, v]));
    const jams = this.traffic.congestedLinks(now);
    const vehicles: BoardVehicle[] = [];
    const onLine: TramOnLine[] = [];

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
      const stallS = this.stallOf(run.vehicleId, run.tripId, now);
      if (route?.type === TRAM_ROUTE_TYPE && motion) {
        const span = motion.toAlongM - motion.fromAlongM;
        onLine.push({
          vehicleId: run.vehicleId,
          route: run.routeShort,
          delayS,
          stallS,
          fromStopId: motion.fromStopId,
          toStopId: motion.toStopId,
          frac: span > 0 ? (motion.alongM - motion.fromAlongM) / span : 0,
          losingS: p?.ongoing ? p.gainS : null,
        });
      }

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
    const trouble = this.troubleOf(trams.filter((v) => v.delayS >= TRAM.LATE_S));
    const analysis = analyzeTramLines(plan?.lines ?? [], onLine);
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
        state: tramState({ scheduled, delaysS: trams.map((v) => v.delayS), stalledS: stalled.map((s) => s.stallS), replacementRunning, line: analysis.verdict.kind }),
        scheduled,
        running: trams.length,
        replacementRunning,
        replacementPlanned: Boolean(plan?.replacement.some(([dep, arr]) => dep - PLAN_SLACK_S <= nowS && nowS <= arr + PLAN_SLACK_S)),
        medianDelayS: tramMedian,
        severe: trams.filter((v) => v.delayS >= TRAM.SEVERE_S).length,
        late: trams.filter((v) => v.delayS >= TRAM.LATE_S).length,
        maxDelayS: trams.length ? trams[0].delayS : null,
        trouble,
        analysis,
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
