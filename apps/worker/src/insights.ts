/**
 * Menetenkénti előrejelzések a megállótáblákhoz, az értesítésekhez és a tervezőhöz:
 *  - késve induló / valószínűleg kimaradó menet: a busza még az előző menetén van
 *    (az MVK által kiosztott, vagy a rendszám-jóslás szerinti busz), és az
 *    várhatóan a mi indulásunk után ér be;
 *  - még el sem indult menet várható késése a megállóknál (a képlet a kezdő késéssel);
 *  - dugó a busz előtt a célmegállóig (az élő forgalmi rétegből).
 * Egy helyen számoljuk, hogy a tábla, a push és a tervező ugyanazt mondja.
 */
import {
  arrivalsForStop,
  fastDistM,
  isMvkId,
  mergedBoard,
  MVK_MODES,
  onlyMvk,
  stopTwinsOf,
  type StopMerge,
  type TransitMode,
  localMidnightUnix,
  nowUnix,
  spreadOf,
  startRiskOf,
  trafficAhead,
  transferChance,
  type ArrivalExtras,
  type StartRisk,
  type StopAlong,
} from "@mvk/core";
import type { Engine } from "./engine.ts";
import type { DelayForecaster } from "./forecast.ts";
import type { VehiclePredictor } from "./predict.ts";
import type { TrafficMonitor } from "./traffic.ts";

/** ennyivel az indulás előtt kezdünk jósolni (mp) */
const LOOKAHEAD_S = 45 * 60;
/** a jóslatok ennyi ideig érvényesek (mp) */
const CACHE_S = 15;
/** ennél kisebb dugót nem jelzünk a megállótáblán (mp) */
const TRAFFIC_MIN_S = 60;

export type TrafficAheadInfo = { excessS: number; level: number; fromName: string; toName: string };

export type TransferLeg = { fromTrip: string; alightStopId: string; toTrip: string; boardStopId: string; walkS: number };

export type TransferOutlook = {
  /** 0..1: eléred-e a második buszt */
  chance: number;
  /** az első busz várható érkezése az átszálló megállóba (unix) */
  arriveUnix: number;
  /** a második busz várható indulása (unix) */
  departUnix: number;
  /** várható tartalék a séta után (mp; negatív: hiányzik) */
  marginS: number;
};

type Cached<T> = { at: number; value: T };

export class TripInsights {
  private risk = new Map<string, Cached<StartRisk | null>>();
  private planned = new Map<string, Cached<Map<string, { delayS: number; upperS: number }> | null>>();
  private engine: Engine;
  private forecaster: DelayForecaster;
  private predictor: VehiclePredictor;
  private traffic: TrafficMonitor;

  constructor(engine: Engine, forecaster: DelayForecaster, predictor: VehiclePredictor, traffic: TrafficMonitor) {
    this.engine = engine;
    this.forecaster = forecaster;
    this.predictor = predictor;
    this.traffic = traffic;
  }

  private stopsOf(tripId: string): StopAlong[] | null {
    return this.engine.feeds.cachedDay(this.engine.today)?.feed.tripStopsAlong(tripId) ?? null;
  }

  private notStarted(tripId: string): boolean {
    const run = this.engine.todayRuns.get(tripId);
    return !run || (run.status === "running" && run.actualStart == null && run.stopsSeen <= 1);
  }

  /** Késve indul / kimarad-e a menet, mert a busza még az előző menetén van. */
  startRisk(tripId: string, now = nowUnix()): StartRisk | null {
    const hit = this.risk.get(tripId);
    if (hit && now - hit.at < CACHE_S) return hit.value;
    const value = this.computeRisk(tripId, now);
    this.risk.set(tripId, { at: now, value });
    if (this.risk.size > 3000) this.risk.clear();
    return value;
  }

  private computeRisk(tripId: string, now: number): StartRisk | null {
    if (this.engine.cancelled.ids.has(tripId) || !this.notStarted(tripId)) return null;
    const stops = this.stopsOf(tripId);
    if (!stops?.length) return null;
    const midnight = localMidnightUnix(this.engine.today);
    const schedStart = midnight + stops[0].dep;
    if (schedStart - now > LOOKAHEAD_S || now - schedStart > 20 * 60) return null;

    // Melyik busz viszi: amit az MVK már kiosztott rá, különben a jóslás.
    const assigned = this.engine.snapshot.vehicles.find((v) => v.tripId === tripId)?.id ?? null;
    const guess = assigned ? null : this.predictor.predict(tripId);
    const vehicleId = assigned ?? (guess && guess.confidence >= 0.5 ? guess.id : null);
    if (!vehicleId) return null;

    // Min van most: az illesztő a még be nem fejezett előző menetet adja (ha az újat már kiosztották is).
    const m = this.engine.matcher.motion(vehicleId);
    if (!m || m.tripId === tripId) return null;
    const prevStops = this.engine.feeds.cachedDay(this.engine.today)?.feed.tripStopsAlong(m.tripId);
    const prev = this.forecaster.forTrip(m.tripId, now);
    if (!prevStops?.length || !prev?.stops.length) return null;
    const last = prev.stops[prev.stops.length - 1];
    const prevEnd = midnight + last.schedS + last.delayS;

    const feed = this.engine.feeds.cachedDay(this.engine.today)?.feed;
    const a = feed?.stops.get(prevStops[prevStops.length - 1].stopId);
    const b = feed?.stops.get(stops[0].stopId);
    const deadheadM = a && b ? fastDistM(a.lat, a.lon, b.lat, b.lon) : 0;
    const prevRoute = feed ? (feed.routes.get(feed.trips.get(m.tripId)?.routeId ?? "")?.short ?? null) : null;
    // fordulóhurkon nem tipp: ugyanaz a busz fordul vissza
    return startRiskOf({ vehicleId, schedStartUnix: schedStart, prevEndUnix: prevEnd, deadheadM, prevRoute, predicted: !assigned && guess?.method !== "loop" });
  }

  /**
   * Várható és 85%-os késés egy megállónál: élő menetnél a modell/képlet, még el
   * nem indultnál (45 percen belül) a képlet a várható kezdő késéssel.
   */
  forecast(tripId: string, stopId: string, now = nowUnix()): { delayS: number; upperS: number } | null {
    const live = this.forecaster.forStop(tripId, stopId, now);
    if (live) return live;
    if (!this.notStarted(tripId)) return null;
    const hit = this.planned.get(tripId);
    let byStop = hit && now - hit.at < CACHE_S ? hit.value : undefined;
    if (byStop === undefined) {
      byStop = null;
      const stops = this.stopsOf(tripId);
      const start = stops?.length ? localMidnightUnix(this.engine.today) + stops[0].dep : null;
      if (start != null && start - now <= LOOKAHEAD_S && now - start <= 20 * 60) {
        const f = this.forecaster.plannedFor(tripId, this.startRisk(tripId, now)?.expectedDelayS ?? 0);
        if (f) byStop = new Map(f.stops.map((s) => [s.stopId, { delayS: s.delayS, upperS: s.upperS }]));
      }
      this.planned.set(tripId, { at: now, value: byStop });
      if (this.planned.size > 3000) this.planned.clear();
    }
    return byStop?.get(stopId) ?? null;
  }

  /** Dugó a busz előtt a célmegállóig (csak úton lévő busznál). */
  trafficAhead(tripId: string, stopId: string, now = nowUnix()): TrafficAheadInfo | null {
    const v = this.engine.snapshot.vehicles.find((x) => x.tripId === tripId);
    const m = v ? this.engine.matcher.motion(v.id) : null;
    if (!m || m.tripId !== tripId) return null;
    const stops = this.stopsOf(tripId);
    if (!stops) return null;
    const target = stops.findIndex((s, i) => s.stopId === stopId && s.alongM >= m.alongM - 5 && i > 0);
    const from = stops.findIndex((s) => s.stopId === (m.fromStopId ?? m.toStopId));
    if (target < 0 || from < 0 || from >= target) return null;
    const pairs: [string, string][] = [];
    for (let i = from; i < target; i++) pairs.push([stops[i].stopId, stops[i + 1].stopId]);
    const ahead = trafficAhead(pairs, this.traffic.congestedLinks(now));
    if (!ahead || ahead.excessS < TRAFFIC_MIN_S) return null;
    const feed = this.engine.feeds.cachedDay(this.engine.today)?.feed;
    const name = (id: string) => feed?.stops.get(id)?.name ?? id;
    return { excessS: ahead.excessS, level: ahead.worst.level, fromName: name(ahead.worst.from), toName: name(ahead.worst.to) };
  }

  /** Egy menet menetrendi ideje egy megállónál (érkezés vagy indulás, unix). */
  private schedAt(tripId: string, stopId: string, which: "arr" | "dep"): number | null {
    const s = this.stopsOf(tripId)?.find((x) => x.stopId === stopId);
    return s ? localMidnightUnix(this.engine.today) + (which === "arr" ? s.arr : s.dep) : null;
  }

  /**
   * Átszállás esélye a mostani tudásunk szerint: az első busz várható/rossz
   * esetbeli érkezése és a második várható indulása, a séta idejével.
   * `fallback`: ha egyik menetre sincs élő vagy közeli becslés (a tervező történeti adata).
   */
  transferOutlook(t: TransferLeg, now = nowUnix(), fallback?: { arrDelayS?: number | null; arrUpperS?: number | null; depDelayS?: number | null }): TransferOutlook | null {
    const arrSched = this.schedAt(t.fromTrip, t.alightStopId, "arr");
    const depSched = this.schedAt(t.toTrip, t.boardStopId, "dep");
    if (arrSched == null || depSched == null) return null;
    const a = this.forecast(t.fromTrip, t.alightStopId, now);
    const d = this.forecast(t.toTrip, t.boardStopId, now);
    const arrMed = arrSched + (a?.delayS ?? fallback?.arrDelayS ?? 0);
    const arrUp = a ? arrSched + a.upperS : fallback?.arrUpperS != null ? arrSched + fallback.arrUpperS : null;
    // A csatlakozó menet első megállójánál nincs útközbeni becslés: ha a busza még az előző
    // menetén jár, a késve indulás jóslata adja az indulást (különben hamis „veszélyben” lenne).
    const risk = d ? null : this.startRisk(t.toTrip, now);
    const depMed = depSched + (d?.delayS ?? risk?.expectedDelayS ?? fallback?.depDelayS ?? 0);
    const depUp = d ? depSched + d.upperS : null;
    const chance = transferChance(spreadOf(arrMed, arrUp), spreadOf(depMed, depUp), t.walkS);
    return { chance: Math.round(chance * 100) / 100, arriveUnix: Math.round(arrMed), departUnix: Math.round(depMed), marginS: Math.round(depMed - arrMed - t.walkS) };
  }

  /** Ha lekésed: az első olyan indulás ugyanazzal a vonallal a megállóból, amit biztosan elérsz. */
  nextDeparture(boardStopId: string, routeShort: string, readyUnix: number, now = nowUnix()): { tripId: string; time: string; departUnix: number } | null {
    const list = this.arrivals(boardStopId, 30, now).arrivals;
    for (const x of list) {
      if (x.route !== routeShort || x.cancelled) continue;
      const at = (x.schedUnix ?? now + x.etaMin * 60) + (x.forecastDelaySec ?? x.startRisk?.expectedDelayS ?? x.delaySec ?? 0);
      if (at >= readyUnix + 60) return { tripId: x.tripId, time: x.time, departUnix: Math.round(at) };
    }
    return null;
  }

  /** A megállótáblák közös kiegészítői (WS, v2 kompatibilis végpontok, push). */
  /**
   * A megállótábla kiegészítői. `modes`: csak ezek a közlekedési módok (a v2 alapból
   * csak MVK); `rich`: az MVK-sorok is kapják a v3-mezőket (mód, vonal-kulcs).
   */
  extras(now = nowUnix(), modes?: ReadonlySet<TransitMode>, rich = false): ArrivalExtras {
    const rt = this.engine.regional;
    const cancelled = rt?.cancelled.size ? new Set([...this.engine.cancelled.ids, ...rt.cancelled]) : this.engine.cancelled.ids;
    return {
      measuredDelay: (t) => this.engine.matcher.liveDelay(t, now),
      forecast: (t, s) => this.forecast(t, s, now),
      predictedVehicle: (t) => this.predictor.predict(t),
      cancelled,
      startRisk: (t) => this.startRisk(t, now),
      trafficAhead: (t, s) => this.trafficAhead(t, s, now),
      modes,
      rich,
      ...(rt ? { platform: (t: string, s: string) => rt.platform(t, s), notices: (t: string) => rt.noticesOf(t) } : {}),
    };
  }

  /**
   * Egy megálló táblája a közös kiegészítőkkel. `merge`: közös megállónál (MVK-oszlop és a
   * mellette álló Volán-megálló) egy táblán mindkettő indulásai, vagy csak az egyiké.
   */
  arrivals(stopId: string, limit: number, now = nowUnix(), modes: ReadonlySet<TransitMode> = new Set(MVK_MODES), rich = false, merge: StopMerge = "off") {
    const feed = merge === "off" ? null : this.engine.feeds.cachedDay(this.engine.today)?.feed;
    const board = feed ? mergedBoard(stopTwinsOf(feed), stopId, merge, modes) : null;
    const use = board?.modes ?? modes;
    for (const id of board?.stopIds ?? [stopId]) if (!isMvkId(id) || !onlyMvk(use)) this.engine.regional?.touch(id);
    const extras = this.extras(now, use, rich);
    return arrivalsForStop(stopId, limit, this.engine.snapshot, this.engine.feeds.arrivalDays(now), now, board ? { ...extras, boardStops: board.stopIds } : extras);
  }
}
