/**
 * A flotta-rangsor visszanézése: a megálló-eseményekből (és a GPS-pontokból)
 * bármely múltbeli pillanat állapota, a nap késésgörbéje, és az összeomlások
 * (a villamosvonalé és a buszhálózaté) időszakai. Csak tiszta számolás; az
 * adatbázisból a worker tölti.
 */
import { BUS, TRAM, tramCollapsed, type DelayPoint } from "./fleet.ts";
import { haversineKm } from "./geo.ts";

export type RunEvent = { idx: number; stopId: string; ts: number; depTs: number | null; delayS: number; isLast: boolean };

export type RunAt = {
  delayS: number;
  /** az utolsó elhagyott (vagy most kiszolgált) megálló indexe */
  lastIdx: number;
  /** a következő megálló felé ennyit tett meg (0–1); 0: a megállóban áll */
  frac: number;
  startDelayS: number | null;
  /** a késés megállónként t-ig */
  trail: DelayPoint[];
  /** az utolsó esemény óta eltelt idő (mp) */
  sinceEventS: number;
};

/** ennyi esemény nélküli idő után a menet már nem követhető (mp) */
const LOST_AFTER_S = 20 * 60;

/**
 * A menet állapota a t pillanatban: hol tart és mennyit késik. Két megálló
 * között a késést az indulás és a következő érkezés között egyenletesen
 * vezetjük át, így az elakadás alatt felgyűlt késés is látszik (a következő
 * esemény már tudja). null: t-ben még nem indult el, vagy már beért.
 */
export function runStateAt(events: RunEvent[], t: number): RunAt | null {
  let prev: RunEvent | null = null;
  let next: RunEvent | null = null;
  for (const e of events) {
    if (e.ts <= t) prev = e;
    else if (!next) next = e;
  }
  if (!prev || (prev.isLast && !next)) return null;
  const trail = events.filter((e) => e.ts <= t).map((e) => ({ idx: e.idx, stopId: e.stopId, delayS: e.delayS }));
  const startDelayS = events.find((e) => e.idx === 0 && e.ts <= t)?.delayS ?? null;
  const dep = prev.depTs ?? prev.ts;
  const base = { startDelayS, trail, sinceEventS: t - prev.ts };
  if (!next) {
    if (t - dep > LOST_AFTER_S) return null;
    return { ...base, delayS: prev.delayS, lastIdx: prev.idx, frac: 0 };
  }
  if (t <= dep || next.ts <= dep) return { ...base, delayS: prev.delayS, lastIdx: prev.idx, frac: 0 };
  const f = Math.min(1, (t - dep) / (next.ts - dep));
  const pos = prev.idx + (next.idx - prev.idx) * f;
  const lastIdx = Math.min(next.idx - 1, Math.floor(pos));
  return { ...base, delayS: Math.round(prev.delayS + (next.delayS - prev.delayS) * f), lastIdx, frac: pos - lastIdx };
}

/** mióta van a jármű egy kis körzetben a t pillanatig (mp), a GPS-pontjaiból; az araszolás is állás */
export function stillFor(pings: { ts: number; lat: number; lon: number }[], t: number, radiusM = 120): number | null {
  let i = pings.length - 1;
  while (i >= 0 && pings[i].ts > t) i--;
  if (i < 0 || t - pings[i].ts > 90) return null;
  const here = pings[i];
  let since = here.ts;
  for (let j = i; j >= 0 && haversineKm(here.lat, here.lon, pings[j].lat, pings[j].lon) * 1000 <= radiusM; j--) since = pings[j].ts;
  return t - since >= 60 ? t - since : null;
}

export type DayBucket = {
  t: number;
  bus: number;
  /** 5+ percet késő buszok */
  busLate: number;
  tram: number;
  tramLate: number;
  /** 10+ percet késő villamosok */
  tramSevere: number;
  tramMaxS: number | null;
  busMaxS: number | null;
};

export const DAY_STEP_S = 5 * 60;

/** A nap késésgörbéje lépésenként: hány jármű volt úton, és hány késett. */
export function dayBuckets(runs: { tram: boolean; events: RunEvent[] }[], from: number, to: number, step = DAY_STEP_S): DayBucket[] {
  const n = Math.max(0, Math.ceil((to - from) / step));
  const out: DayBucket[] = Array.from({ length: n }, (_, i) => ({ t: from + i * step, bus: 0, busLate: 0, tram: 0, tramLate: 0, tramSevere: 0, tramMaxS: null, busMaxS: null }));
  for (const r of runs) {
    if (!r.events.length) continue;
    const first = Math.max(0, Math.ceil((r.events[0].ts - from) / step));
    const last = Math.min(n - 1, Math.floor((r.events[r.events.length - 1].ts - from) / step));
    for (let i = first; i <= last; i++) {
      const s = runStateAt(r.events, out[i].t);
      if (!s) continue;
      const b = out[i];
      if (r.tram) {
        b.tram++;
        if (s.delayS >= TRAM.LATE_S) b.tramLate++;
        if (s.delayS >= TRAM.SEVERE_S) b.tramSevere++;
        b.tramMaxS = Math.max(b.tramMaxS ?? -Infinity, s.delayS);
      } else {
        b.bus++;
        if (s.delayS >= BUS.LATE_S) b.busLate++;
        b.busMaxS = Math.max(b.busMaxS ?? -Infinity, s.delayS);
      }
    }
  }
  return out;
}

export type Breakdown = {
  kind: "tram" | "bus";
  start: number;
  end: number;
  /** a legrosszabb pillanat: ide érdemes ugrani */
  peak: number;
  /** villamosnál a 10+ percet késők, busznál az 5+ percet késők száma a csúcson */
  vehicles: number;
  maxDelayS: number | null;
};

/** ennyi lépésnyi szünet még ugyanaz az összeomlás */
const MERGE_GAP = 2;

/**
 * Az összeomlások időszakai a görbéből: a villamosvonal, ha egyszerre sok
 * villamos késik nagyon; a buszhálózat, ha a buszok nagy része késik.
 */
export function breakdowns(buckets: DayBucket[]): Breakdown[] {
  const out: Breakdown[] = [];
  if (!buckets.length) return out;
  const step = buckets.length > 1 ? buckets[1].t - buckets[0].t : DAY_STEP_S;
  const scan = (kind: Breakdown["kind"], hit: (b: DayBucket) => boolean, score: (b: DayBucket) => number, max: (b: DayBucket) => number | null) => {
    let cur: { from: number; to: number; peak: DayBucket } | null = null;
    const flush = () => {
      if (!cur) return;
      out.push({ kind, start: buckets[cur.from].t, end: buckets[cur.to].t + step, peak: cur.peak.t, vehicles: score(cur.peak), maxDelayS: max(cur.peak) });
      cur = null;
    };
    buckets.forEach((b, i) => {
      if (!hit(b)) {
        if (cur && i - cur.to > MERGE_GAP) flush();
        return;
      }
      if (!cur) cur = { from: i, to: i, peak: b };
      cur.to = i;
      if (score(b) > score(cur.peak) || (score(b) === score(cur.peak) && (max(b) ?? 0) > (max(cur.peak) ?? 0))) cur.peak = b;
    });
    flush();
  };
  scan("tram", (b) => tramCollapsed(b.tramSevere, b.tramLate, b.tram), (b) => b.tramSevere, (b) => b.tramMaxS);
  scan("bus", (b) => b.bus >= BUS.MIN_FLEET && b.busLate >= b.bus * BUS.COLLAPSE_SHARE, (b) => b.busLate, (b) => b.busMaxS);
  return out.sort((a, b) => a.start - b.start);
}

/** a nap késésgörbéje és összeomlásai (a worker `/engine/fleet/day` válasza) */
export type FleetDay = { date: string; from: number; to: number; step: number; buckets: DayBucket[]; breakdowns: Breakdown[] };
