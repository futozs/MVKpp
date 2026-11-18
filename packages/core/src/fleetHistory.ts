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

/** egy vonal görbéje a napon, lépésenként: úton lévő, 5+ és 10+ percet késő menetek, és a legnagyobb késés */
export type RouteLane = { route: string; tram: boolean; n: number[]; late: number[]; severe: number[]; maxS: (number | null)[] };

/** Vonalanként a nap görbéje (a menetek megálló-eseményeiből, lépésenként). */
export function routeLanes(runs: { route: string; tram: boolean; events: RunEvent[] }[], from: number, to: number, step = DAY_STEP_S): RouteLane[] {
  const n = Math.max(0, Math.ceil((to - from) / step));
  const lanes = new Map<string, RouteLane>();
  for (const r of runs) {
    if (!r.events.length) continue;
    let lane = lanes.get(r.route);
    if (!lane) {
      lane = { route: r.route, tram: r.tram, n: new Array(n).fill(0), late: new Array(n).fill(0), severe: new Array(n).fill(0), maxS: new Array(n).fill(null) };
      lanes.set(r.route, lane);
    }
    const lateS = r.tram ? TRAM.LATE_S : BUS.LATE_S;
    const first = Math.max(0, Math.ceil((r.events[0].ts - from) / step));
    const last = Math.min(n - 1, Math.floor((r.events[r.events.length - 1].ts - from) / step));
    for (let i = first; i <= last; i++) {
      const s = runStateAt(r.events, from + i * step);
      if (!s) continue;
      lane.n[i]++;
      if (s.delayS >= lateS) lane.late[i]++;
      if (s.delayS >= TRAM.SEVERE_S) lane.severe[i]++;
      lane.maxS[i] = Math.max(lane.maxS[i] ?? -Infinity, s.delayS);
    }
  }
  return [...lanes.values()];
}

/** Az egész flotta görbéje a vonalak görbéiből (villamos és busz külön). */
export function bucketsFromLanes(lanes: RouteLane[], from: number, count: number, step = DAY_STEP_S): DayBucket[] {
  const out: DayBucket[] = Array.from({ length: count }, (_, i) => ({ t: from + i * step, bus: 0, busLate: 0, tram: 0, tramLate: 0, tramSevere: 0, tramMaxS: null, busMaxS: null }));
  for (const l of lanes) {
    for (let i = 0; i < count; i++) {
      if (!l.n[i]) continue;
      const b = out[i];
      const max = l.maxS[i] ?? -Infinity;
      if (l.tram) {
        b.tram += l.n[i];
        b.tramLate += l.late[i];
        b.tramSevere += l.severe[i];
        b.tramMaxS = Math.max(b.tramMaxS ?? -Infinity, max);
      } else {
        b.bus += l.n[i];
        b.busLate += l.late[i];
        b.busMaxS = Math.max(b.busMaxS ?? -Infinity, max);
      }
    }
  }
  return out;
}

/** A nap késésgörbéje lépésenként: hány jármű volt úton, és hány késett. */
export function dayBuckets(runs: { tram: boolean; route?: string; events: RunEvent[] }[], from: number, to: number, step = DAY_STEP_S): DayBucket[] {
  const lanes = routeLanes(
    runs.map((r) => ({ ...r, route: r.route ?? (r.tram ? "villamos" : "busz") })),
    from,
    to,
    step,
  );
  return bucketsFromLanes(lanes, from, Math.max(0, Math.ceil((to - from) / step)), step);
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
export type FleetDay = {
  date: string;
  from: number;
  to: number;
  step: number;
  buckets: DayBucket[];
  breakdowns: Breakdown[];
  /** a kért vonalak görbéje (csak ha a kérés megnevezett vonalakat) */
  lanes?: RouteLane[];
};

/** egy menet csúcsa (rekordokhoz): a legnagyobb késése vagy sietése, hol és mikor */
export type RecordRun = {
  date: string;
  tripId: string;
  vehicleId: string;
  route: string;
  /** a vonal színe és szövegszíne (hex, # nélkül) */
  color: string;
  text: string;
  headsign: string;
  tram: boolean;
  delayS: number;
  ts: number;
  stop: string;
  startDelayS: number | null;
};

export type RouteTally = { route: string; color: string; text: string; tram: boolean; runs: number; late5: number; late10: number; maxS: number };

/** egy nap rekordjai: a legkésőbb és a legkorábban járó menetek (busz és villamos külön, és vonalanként is), és vonalanként a számok */
export type DayRecords = {
  date: string;
  runs: number;
  late5: number;
  late10: number;
  late: RecordRun[];
  early: RecordRun[];
  routes: RouteTally[];
  /** vonalanként a nap legnagyobb késései és sietései (a vonalra szűrt rekordokhoz) */
  byRoute: Record<string, { late: RecordRun[]; early: RecordRun[] }>;
};

/** egy menet a napi összesítéshez: a csúcskésése és a legnagyobb sietése */
export type RunPeak = Omit<RecordRun, "delayS" | "ts" | "stop"> & { hiS: number; hiTs: number; hiStop: string; loS: number; loTs: number; loStop: string };

export const RECORDS = {
  /** naponta, típusonként ennyi menetet tartunk meg a rangsorokhoz */
  KEEP: 25,
  LATE5_S: 5 * 60,
  LATE10_S: 10 * 60,
  /** ennél kevesebb menetű vonal arányát nem rangsoroljuk */
  MIN_ROUTE_RUNS: 10,
  /** vonalanként naponta ennyi késés- és sietés-rekordot tartunk meg */
  PER_ROUTE: 6,
} as const;

const asRecord = (p: RunPeak, which: "hi" | "lo"): RecordRun => ({
  date: p.date,
  tripId: p.tripId,
  vehicleId: p.vehicleId,
  route: p.route,
  color: p.color,
  text: p.text,
  headsign: p.headsign,
  tram: p.tram,
  startDelayS: p.startDelayS,
  delayS: which === "hi" ? p.hiS : p.loS,
  ts: which === "hi" ? p.hiTs : p.loTs,
  stop: which === "hi" ? p.hiStop : p.loStop,
});

/** A nap rekordjai a menetek csúcsaiból. */
export function dayRecords(date: string, peaks: RunPeak[]): DayRecords {
  const top = (list: RunPeak[], which: "hi" | "lo") =>
    [...list]
      .sort((a, b) => (which === "hi" ? b.hiS - a.hiS : a.loS - b.loS))
      .slice(0, RECORDS.KEEP)
      .map((p) => asRecord(p, which));
  const trams = peaks.filter((p) => p.tram);
  const buses = peaks.filter((p) => !p.tram);
  const byRoute: DayRecords["byRoute"] = {};
  for (const route of new Set(peaks.map((p) => p.route))) {
    const own = peaks.filter((p) => p.route === route);
    byRoute[route] = { late: top(own, "hi").slice(0, RECORDS.PER_ROUTE), early: top(own, "lo").slice(0, RECORDS.PER_ROUTE) };
  }
  const routes = new Map<string, RouteTally>();
  for (const p of peaks) {
    const r = routes.get(p.route) ?? { route: p.route, color: p.color, text: p.text, tram: p.tram, runs: 0, late5: 0, late10: 0, maxS: -Infinity };
    r.runs++;
    if (p.hiS >= RECORDS.LATE5_S) r.late5++;
    if (p.hiS >= RECORDS.LATE10_S) r.late10++;
    r.maxS = Math.max(r.maxS, p.hiS);
    routes.set(p.route, r);
  }
  return {
    date,
    runs: peaks.length,
    late5: peaks.filter((p) => p.hiS >= RECORDS.LATE5_S).length,
    late10: peaks.filter((p) => p.hiS >= RECORDS.LATE10_S).length,
    late: [...top(buses, "hi"), ...top(trams, "hi")],
    early: [...top(buses, "lo"), ...top(trams, "lo")],
    routes: [...routes.values()],
    byRoute,
  };
}

export type RecordQuery = {
  mode: "all" | "bus" | "tram";
  kind: "late" | "early";
  limit: number;
  /** csak ezek a vonalak (üres: mind) */
  routes?: string[];
};

export type RecordsResult = {
  days: number;
  runs: number;
  late5: number;
  late10: number;
  items: RecordRun[];
  /** a legrosszabb vonalak: a menetek mekkora része késett 5+ percet */
  routes: RouteTally[];
};

/** Több nap rekordjainak összefésülése egy időszakra. */
export function mergeRecords(days: DayRecords[], q: RecordQuery): RecordsResult {
  const only = q.routes?.length ? new Set(q.routes) : null;
  const want = (tram: boolean, route: string) => (q.mode === "all" || (q.mode === "tram") === tram) && (!only || only.has(route));
  const items = days
    .flatMap((d) => (only ? [...only].flatMap((r) => d.byRoute[r]?.[q.kind] ?? []) : q.kind === "late" ? d.late : d.early))
    .filter((r) => want(r.tram, r.route))
    .sort((a, b) => (q.kind === "late" ? b.delayS - a.delayS : a.delayS - b.delayS))
    .slice(0, q.limit);
  const routes = new Map<string, RouteTally>();
  for (const r of days.flatMap((d) => d.routes)) {
    if (!want(r.tram, r.route)) continue;
    const t = routes.get(r.route) ?? { ...r, runs: 0, late5: 0, late10: 0, maxS: -Infinity };
    t.runs += r.runs;
    t.late5 += r.late5;
    t.late10 += r.late10;
    t.maxS = Math.max(t.maxS, r.maxS);
    routes.set(r.route, t);
  }
  const tallies = [...routes.values()];
  const sum = (k: "runs" | "late5" | "late10") => tallies.reduce((n, r) => n + r[k], 0);
  return {
    days: days.length,
    runs: sum("runs"),
    late5: sum("late5"),
    late10: sum("late10"),
    items,
    routes: tallies
      // a kiválasztott vonalak akkor is látszanak, ha kevés menetük volt
      .filter((r) => only || r.runs >= RECORDS.MIN_ROUTE_RUNS)
      .sort((a, b) => b.late5 / b.runs - a.late5 / a.runs || b.maxS - a.maxS)
      .slice(0, 10),
  };
}
