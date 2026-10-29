/**
 * Élő forgalom (dugók) a térképhez: szakaszonként (megállótól megállóig) a
 * buszok mostani menetideje a szokásoshoz képest — a core `segmentCongestion`
 * dönti el, hol áll be az út. Az átért buszok mellett a most bent ragadtakat
 * is nézzük, így a dugó azonnal látszik.
 */
import { nowUnix, segmentCongestion, segmentPaths, TRAFFIC, type SegmentCongestion, type StopEventOut, type TrafficObs, type TrafficStuck } from "@mvk/core";
import type { Engine } from "./engine.ts";
import type { DelayForecaster } from "./forecast.ts";

/** a jel legfeljebb ennyi idős lehet, hogy a busz „most haladónak” számítson (mp) */
const LIVE_PING_S = 120;
/** a következő megállóhoz ennyire közel már a megállóban áll (nem a forgalomban) (m) */
const AT_STOP_M = 60;
const CACHE_S = 15;

export type TrafficSegment = SegmentCongestion & { from: string; to: string; routes: string[]; path: [number, number][] };

export class TrafficMonitor {
  private engine: Engine;
  private forecaster: DelayForecaster;
  /** szakasz (honnan|hova) → a legutóbbi áthaladások */
  private obs = new Map<string, TrafficObs[]>();
  /** menet → legutóbbi megálló-esemény (a bent ragadt busz innen számol) */
  private last = new Map<string, StopEventOut>();
  private cache: { at: number; value: { at: number; segments: TrafficSegment[] } } | null = null;

  constructor(engine: Engine, forecaster: DelayForecaster) {
    this.engine = engine;
    this.forecaster = forecaster;
    engine.on("stopEvent", (e) => this.onStopEvent(e));
  }

  private onStopEvent(e: StopEventOut) {
    if (e.src === "final") return; // becsült beérkezés: nem mérés
    const prev = this.last.get(e.runKey);
    // A végállomásra beállás és onnan kiállás nem forgalom (sorban állás a kocsiálláson, kivárás).
    if (prev && prev.stopIdx === e.stopIdx - 1 && prev.serviceDate === e.serviceDate && !prev.isFirst && !e.isLast) {
      const typical = this.forecaster.typicalTravel(prev.stopId, e.stopId, e.serviceDate, prev.schedDepS);
      const travel = e.arrTs - (prev.depTs ?? prev.arrTs);
      if (typical && travel > 0) {
        const k = `${prev.stopId}|${e.stopId}`;
        const list = this.obs.get(k) ?? [];
        list.push({ endTs: e.arrTs, travelS: travel, typicalS: typical });
        // csak a friss mérések kellenek
        while (list.length > 12 || (list.length && e.arrTs - list[0].endTs > TRAFFIC.WINDOW_S)) list.shift();
        this.obs.set(k, list);
      }
    }
    if (e.isLast) this.last.delete(e.runKey);
    else this.last.set(e.runKey, e);
  }

  /** A most torlódott szakaszok nyomvonallal (15 mp-ig gyorsítótárazva). */
  snapshot(now = nowUnix()): { at: number; segments: TrafficSegment[] } {
    if (this.cache && now - this.cache.at < CACHE_S) return this.cache.value;
    const value = this.compute(now);
    this.cache = { at: now, value };
    return value;
  }

  private compute(now: number) {
    const day = this.engine.feeds.cachedDay(this.engine.today);
    if (!day) return { at: now, segments: [] };
    const paths = segmentPaths(day.feed);

    // Most a szakaszon haladó buszok (az utolsó megállójuk óta mennyi ideje vannak úton).
    const stuck = new Map<string, TrafficStuck[]>();
    for (const run of this.engine.todayRuns.values()) {
      if (run.status !== "running" || now - run.lastTs > LIVE_PING_S) continue;
      const ev = this.last.get(run.runKey);
      if (!ev || ev.stopIdx !== run.lastStopIdx) continue;
      const along = this.engine.feeds.cachedDay(run.serviceDate)?.feed.tripStopsAlong(run.tripId);
      const next = along?.[ev.stopIdx + 1];
      // a végállomás felé / onnan kifelé nem mérünk (lásd fent)
      if (!next || ev.isFirst || ev.stopIdx + 1 === along!.length - 1) continue;
      // Már a következő megállóban áll (utasok, menetidő-kiegyenlítés): az nem forgalom.
      const m = this.engine.matcher.motion(run.vehicleId);
      if (m && m.tripId === run.tripId && m.toStopId === next.stopId && m.toAlongM - m.alongM <= AT_STOP_M) continue;
      const typical = this.forecaster.typicalTravel(ev.stopId, next.stopId, run.serviceDate, ev.schedDepS);
      if (!typical) continue;
      const elapsed = now - (ev.depTs ?? ev.arrTs);
      if (elapsed <= 0) continue;
      const k = `${ev.stopId}|${next.stopId}`;
      stuck.set(k, [...(stuck.get(k) ?? []), { elapsedS: elapsed, typicalS: typical }]);
    }

    const segments: TrafficSegment[] = [];
    for (const k of new Set([...this.obs.keys(), ...stuck.keys()])) {
      const c = segmentCongestion(this.obs.get(k) ?? [], stuck.get(k) ?? [], now);
      const p = c ? paths.get(k) : undefined;
      if (!c || !p) continue;
      const name = (id: string) => day.feed.stops.get(id)?.name ?? id;
      segments.push({ ...c, from: name(p.from), to: name(p.to), routes: p.routes, path: p.path });
    }
    // Régi, már nem frissülő szakaszok kitakarítása.
    for (const [k, list] of this.obs) if (!list.length || now - list[list.length - 1].endTs > TRAFFIC.WINDOW_S) this.obs.delete(k);
    for (const [k, e] of this.last) if (now - (e.depTs ?? e.arrTs) > 3 * 3600 || e.serviceDate < this.engine.today) this.last.delete(k);
    return { at: now, segments: segments.sort((a, b) => a.level - b.level) };
  }
}
