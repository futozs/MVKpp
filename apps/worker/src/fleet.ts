/**
 * Flotta-rangsor: az összes úton lévő MVK-jármű a
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

/** egy jármű az összerakáshoz: élőben a motorból, visszanézéskor az adatbázisból */
export type FleetInput = {
  vehicleId: string;
  label: string;
  plate: string | null;
  routeId: string;
  routeShort: string;
  tripId: string;
  headsign: string;
  delayS: number;
  startDelayS: number | null;
  lastStopIdx: number | null;
  stopsTotal: number;
  /** a késés megállónként eddig */
  trail: DelayPoint[];
  /** hol tart a menet mentén: az utolsó és a következő megálló indexe, és köztük a tört rész; null: még a kiinduló megállóban */
  at: { fromIdx: number | null; toIdx: number; frac: number; stopped: boolean } | null;
  stallS: number | null;
  color: string;
  text: string;
};

/** torlódó szakasz (élőben a forgalomfigyelőből, visszanézéskor a menetidőkből) */
export type FleetSegment = { fromId: string; toId: string; from: string; to: string; routes: string[]; excessS: number; level: number };

export class FleetBoard {
  private engine: Engine;
  private traffic: TrafficMonitor;
  /** menet → a megállóinál mért késések */
  private trail = new Map<string, DelayPoint[]>();
  /** jármű → a menete mentén az utóbbi percek helyzetei (idő, méter) */
  private track = new Map<string, { tripId: string; samples: [number, number][] }>();
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

  private compute(now: number): BoardSnapshot {
    const day = this.engine.feeds.cachedDay(this.engine.today);
    const decoded = new Map(this.engine.snapshot.decoded.map((v) => [v.id, v]));
    const inputs: FleetInput[] = [];
    for (const run of this.engine.todayRuns.values()) {
      if (run.status !== "running" || !isMvkId(run.vehicleId) || now - run.lastTs > LIVE_PING_S) continue;
      const v = decoded.get(run.vehicleId);
      // menetrendből becsült helyzet: nincs mért késése
      if (!v || v.estimated) continue;
      const delayS = this.engine.matcher.liveDelay(run.tripId, now) ?? run.lastDelayS;
      if (delayS == null) continue;
      const m = this.engine.matcher.motion(run.vehicleId);
      const motion = m && m.tripId === run.tripId ? m : null;
      const along = day?.feed.tripStopsAlong(run.tripId);
      const toIdx = motion && along ? along.findIndex((s, i) => i > (run.lastStopIdx ?? -1) && s.stopId === motion.toStopId) : -1;
      const span = motion ? motion.toAlongM - motion.fromAlongM : 0;
      inputs.push({
        vehicleId: run.vehicleId,
        label: v.label || run.vehicleId,
        plate: v.plate ?? null,
        routeId: run.routeId,
        routeShort: run.routeShort,
        tripId: run.tripId,
        headsign: run.headsign,
        delayS,
        startDelayS: run.startDelayS,
        lastStopIdx: run.lastStopIdx,
        stopsTotal: run.stopsTotal,
        trail: this.trail.get(run.runKey) ?? [],
        at:
          motion && toIdx >= 0
            ? { fromIdx: toIdx > 0 ? toIdx - 1 : null, toIdx, frac: span > 0 ? (motion.alongM - motion.fromAlongM) / span : 0, stopped: motion.stopped }
            : null,
        stallS: this.stallOf(run.vehicleId, run.tripId, now),
        color: v.routeColor,
        text: v.routeText,
      });
    }
    return assembleBoard(now, day, inputs, this.traffic.snapshot(now).segments);
  }
}

const plans = new Map<string, TramPlan>();

/** a nap villamosmenetei (indulás, érkezés), pótlóbusz-menetei, és a villamosvonal irányonként */
function tramPlan(day: ServiceDay): TramPlan {
  const hit = plans.get(day.iso);
  if (hit) return hit;
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
  const plan = { iso: day.iso, tram, replacement, lines };
  // a visszanézés sok napot érinthet: csak a legutóbbiakat tartjuk meg
  if (plans.size >= 8) plans.delete(plans.keys().next().value ?? "");
  plans.set(day.iso, plan);
  return plan;
}

/** villamos-e a vonal (a nap menetrendje szerint) */
export function isTramRoute(day: ServiceDay | null, routeId: string): boolean {
  return day?.feed.routes.get(routeId)?.type === TRAM_ROUTE_TYPE;
}

/** A késő villamosok közös baj-szakasza, a legjobban késő menete mentén. */
function troubleOf(day: ServiceDay | null, late: BoardVehicle[]): BoardSnapshot["tram"]["trouble"] {
  const stopsOf = (v: BoardVehicle) => day?.feed.tripStopsAlong(v.tripId)?.map((s) => s.stopId) ?? [];
  const withPickup = late.filter((v) => v.pickup);
  if (withPickup.length < 2) return null;
  const ref = stopsOf(withPickup[0]);
  const span = troubleSpan(
    ref,
    withPickup.map((v) => (v.pickup ? stopsOf(v).slice(v.pickup.fromIdx, v.pickup.toIdx + 1) : [])),
  );
  if (!span) return null;
  const name = (id: string | undefined) => (id ? (day?.feed.stops.get(id)?.name ?? id) : "");
  return { from: name(ref[span.fromIdx]), to: name(ref[span.toIdx]), toward: name(ref[ref.length - 1]), vehicles: span.vehicles };
}

/**
 * A rangsor és a hálózati állapot összerakása a járművekből, egy pillanatra
 * (`at`). Az élő nézet és a visszanézés is ezt használja, így ugyanazt mutatják.
 */
export function assembleBoard(at: number, day: ServiceDay | null, inputs: FleetInput[], segments: FleetSegment[]): BoardSnapshot {
  const jams = new Set(segments.map((s) => `${s.fromId}|${s.toId}`));
  const vehicles: BoardVehicle[] = [];
  const onLine: TramOnLine[] = [];

  for (const x of inputs) {
    const route = day?.feed.routes.get(x.routeId);
    const along = day?.feed.tripStopsAlong(x.tripId);
    const name = (id: string) => day?.feed.stops.get(id)?.name ?? id;
    const stopId = (i: number | null) => (i != null ? along?.[i]?.stopId : undefined);
    const toStop = x.at ? stopId(x.at.toIdx) : undefined;
    const fromStop = x.at ? stopId(x.at.fromIdx) : undefined;
    const p = delayPickup(x.trail, x.at && toStop ? { toStopId: toStop, toIdx: x.at.toIdx, delayS: x.delayS } : null);
    const pickedJam = Boolean(p && along?.slice(p.fromIdx, p.toIdx + 1).some((s, i, a) => i > 0 && jams.has(`${a[i - 1].stopId}|${s.stopId}`)));
    const tram = route?.type === TRAM_ROUTE_TYPE;
    if (tram && x.at && toStop) {
      onLine.push({
        vehicleId: x.vehicleId,
        route: x.routeShort,
        delayS: x.delayS,
        stallS: x.stallS,
        fromStopId: fromStop ?? null,
        toStopId: toStop,
        frac: x.at.frac,
        losingS: p?.ongoing ? p.gainS : null,
      });
    }
    vehicles.push({
      vehicleId: x.vehicleId,
      label: x.label,
      plate: x.plate,
      route: x.routeShort,
      color: route?.color ?? x.color,
      text: route?.text ?? x.text,
      mode: tram ? "tram" : "bus",
      replacement: REPLACEMENT_ROUTE.test(x.routeShort),
      tripId: x.tripId,
      headsign: x.headsign,
      delayS: x.delayS,
      startDelayS: x.startDelayS,
      at: x.at && toStop ? { from: fromStop ? name(fromStop) : null, to: name(toStop), stopped: x.at.stopped } : null,
      stopsDone: x.lastStopIdx != null ? x.lastStopIdx + 1 : 0,
      stopsTotal: x.stopsTotal,
      pickup: p ? { from: name(p.fromStopId), to: name(p.toStopId), fromIdx: p.fromIdx, toIdx: p.toIdx, gainS: p.gainS, ongoing: p.ongoing, jam: pickedJam } : null,
      stallS: x.stallS,
    });
  }
  vehicles.sort((a, b) => b.delayS - a.delayS);

  // ── villamos ──
  const trams = vehicles.filter((v) => v.mode === "tram");
  const replacementRunning = vehicles.filter((v) => v.replacement).length;
  const plan = day ? tramPlan(day) : null;
  const nowS = day ? at - localMidnightUnix(day.iso) : 0;
  const scheduled = plan ? plan.tram.filter(([dep, arr]) => dep <= nowS && nowS <= arr).length : 0;
  const analysis = analyzeTramLines(plan?.lines ?? [], onLine);
  const stalled = trams
    .filter((v) => (v.stallS ?? 0) >= 120)
    .map((v) => ({ vehicleId: v.vehicleId, route: v.route, at: v.at?.from ?? v.at?.to ?? v.headsign, stallS: v.stallS ?? 0 }))
    .sort((a, b) => b.stallS - a.stallS);

  // ── busz ──
  const buses = vehicles.filter((v) => v.mode === "bus");
  const late = buses.filter((v) => v.delayS >= BUS.LATE_S).length;
  const backbone = segments.filter((s) => s.routes.length >= BUS.BACKBONE_ROUTES);
  const corridors = jamCorridors(backbone);

  return {
    at,
    vehicles,
    tram: {
      state: tramState({ scheduled, delaysS: trams.map((v) => v.delayS), stalledS: stalled.map((s) => s.stallS), replacementRunning, line: analysis.verdict.kind }),
      scheduled,
      running: trams.length,
      replacementRunning,
      replacementPlanned: Boolean(plan?.replacement.some(([dep, arr]) => dep - PLAN_SLACK_S <= nowS && nowS <= arr + PLAN_SLACK_S)),
      medianDelayS: medianOf(trams.map((v) => v.delayS)),
      severe: trams.filter((v) => v.delayS >= TRAM.SEVERE_S).length,
      late: trams.filter((v) => v.delayS >= TRAM.LATE_S).length,
      maxDelayS: trams.length ? trams[0].delayS : null,
      trouble: troubleOf(day, trams.filter((v) => v.delayS >= TRAM.LATE_S)),
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
