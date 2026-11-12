/**
 * Utazásaim statisztika: a naplózott utak összesítése.
 *
 * Egy „út” (journey) egy vagy több menet: körbeutazásnál a buszon ülve
 * maradva megtett menetek együtt. A késés két része külön számít:
 *  · a megállóban a késő buszra várva töltött idő (a felszálláskori késés),
 *  · a buszon a menetrendhez képest plusz eltöltött idő: az út leszállási és
 *    felszállási késésének különbsége (amennyivel tovább tartott az út).
 */

export interface StatRide {
  id: string;
  route: string;
  color: string;
  text: string;
  vehicleId: string;
  boardedAt: number;
  alightedAt: number | null;
  fromStopId: string | null;
  fromStopName: string | null;
  toStopId: string | null;
  toStopName: string | null;
  stops: number | null;
  distanceM: number | null;
  delayAtBoardS: number | null;
  delayAtAlightS: number | null;
}

/** Pontosnak számít, ha ±1 percen belül jött a busz. */
export const ON_TIME_S = 60;
const TZ = "Europe/Budapest";

export type JourneyDelay = {
  /** felszálláskor ennyit késett a busz */
  boardS: number | null;
  /** leszálláskor ennyit késett */
  alightS: number | null;
  /** ennyivel tartott tovább az út a menetrendnél (≥ 0) */
  extraS: number | null;
};

/** Egy út (menetei sorrendben) késése. */
export function journeyDelay(legs: readonly StatRide[]): JourneyDelay {
  const first = legs[0];
  const last = legs[legs.length - 1];
  const boardS = first?.delayAtBoardS ?? null;
  const alightS = last?.delayAtAlightS ?? null;
  return { boardS, alightS, extraS: boardS != null && alightS != null ? Math.max(0, alightS - boardS) : null };
}

export type StopCount = { id: string; name: string; n: number };
export type RouteCount = { route: string; color: string; text: string; n: number; avgDelayS: number | null };
export type PairCount = { from: string; to: string; n: number };
export type JourneyRecord<R> = { legs: R[]; value: number };

export interface RideStats<R extends StatRide> {
  journeys: number;
  loops: number;
  km: number;
  minutes: number;
  vehicles: [string, number][];
  routes: RouteCount[];
  onTimePct: number | null;
  /** a buszon a késések miatt plusz eltöltött idő összesen (mp) */
  extraOnboardS: number;
  /** a késő buszra a megállóban várva (mp) — a menetrendhez képest */
  lateWaitS: number;
  /** ennyi útnál ismert a fel- és leszálláskori késés is */
  delayMeasured: number;
  boardStops: StopCount[];
  alightStops: StopCount[];
  /** minden megálló, ahol fel- vagy leszálltál */
  stopsCollected: StopCount[];
  pairs: PairCount[];
  /** felszállások óránként (0–23) */
  hours: number[];
  /** felszállások a hét napjain (0 = hétfő) */
  weekdays: number[];
  longest: JourneyRecord<R> | null;
  mostDelayed: JourneyRecord<R> | null;
  longestTime: JourneyRecord<R> | null;
}

const HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function bump(m: Map<string, StopCount>, id: string | null, name: string | null) {
  if (!id && !name) return;
  // ugyanaz a hely más azonosítóval (a menetrend változásai) — a név köti össze
  const key = name ?? id!;
  const cur = m.get(key);
  m.set(key, { id: cur?.id ?? id ?? key, name: name ?? id!, n: (cur?.n ?? 0) + 1 });
}

const sorted = (m: Map<string, StopCount>) => [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "hu"));

function better<R>(cur: JourneyRecord<R> | null, legs: R[], value: number | null): JourneyRecord<R> | null {
  if (value == null || value <= 0) return cur;
  return !cur || value > cur.value ? { legs, value } : cur;
}

/** Az utak (menetei sorrendben, körbeutazásnál több) összesítése. */
export function rideStats<R extends StatRide>(journeys: readonly R[][]): RideStats<R> {
  const vehicles = new Map<string, number>();
  const routes = new Map<string, { sample: R; n: number; delaySum: number; delayN: number }>();
  const board = new Map<string, StopCount>();
  const alight = new Map<string, StopCount>();
  const collected = new Map<string, StopCount>();
  const pairs = new Map<string, PairCount>();
  const hours = Array.from({ length: 24 }, () => 0);
  const weekdays = Array.from({ length: 7 }, () => 0);
  let meters = 0;
  let minutes = 0;
  let measured = 0;
  let onTime = 0;
  let extraOnboardS = 0;
  let lateWaitS = 0;
  let delayMeasured = 0;
  let loops = 0;
  let longest: JourneyRecord<R> | null = null;
  let mostDelayed: JourneyRecord<R> | null = null;
  let longestTime: JourneyRecord<R> | null = null;

  for (const legs of journeys) {
    if (!legs.length) continue;
    const first = legs[0];
    const last = legs[legs.length - 1];
    if (legs.length > 1) loops++;
    let jm = 0;
    for (const r of legs) {
      if (r.vehicleId) vehicles.set(r.vehicleId, (vehicles.get(r.vehicleId) ?? 0) + 1);
      const rt = routes.get(r.route) ?? { sample: r, n: 0, delaySum: 0, delayN: 0 };
      rt.n++;
      if (r.delayAtBoardS != null) {
        rt.delaySum += r.delayAtBoardS;
        rt.delayN++;
      }
      routes.set(r.route, rt);
      jm += r.distanceM ?? 0;
    }
    meters += jm;
    const jmin = last.alightedAt ? Math.max(0, Math.round((last.alightedAt - first.boardedAt) / 60)) : null;
    if (jmin != null) minutes += jmin;

    const d = journeyDelay(legs);
    if (d.boardS != null) {
      measured++;
      if (Math.abs(d.boardS) <= ON_TIME_S) onTime++;
      lateWaitS += Math.max(0, d.boardS);
    }
    if (d.extraS != null) {
      delayMeasured++;
      extraOnboardS += d.extraS;
    }

    bump(board, first.fromStopId, first.fromStopName);
    bump(alight, last.toStopId, last.toStopName);
    bump(collected, first.fromStopId, first.fromStopName);
    bump(collected, last.toStopId, last.toStopName);
    if (first.fromStopName && last.toStopName) {
      const key = `${first.fromStopName}\u0000${last.toStopName}`;
      const p = pairs.get(key);
      pairs.set(key, { from: first.fromStopName, to: last.toStopName, n: (p?.n ?? 0) + 1 });
    }
    const at = new Date(first.boardedAt * 1000);
    hours[Number(HOUR.format(at)) % 24]++;
    const dow = DOW.indexOf(WEEKDAY.format(at));
    if (dow >= 0) weekdays[dow]++;

    longest = better(longest, legs, jm || null);
    mostDelayed = better(mostDelayed, legs, d.extraS);
    longestTime = better(longestTime, legs, jmin);
  }

  return {
    journeys: journeys.filter((l) => l.length).length,
    loops,
    km: meters / 1000,
    minutes,
    vehicles: [...vehicles].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "hu", { numeric: true })),
    routes: [...routes]
      .map(([route, v]) => ({ route, color: v.sample.color, text: v.sample.text, n: v.n, avgDelayS: v.delayN ? Math.round(v.delaySum / v.delayN) : null }))
      .sort((a, b) => b.n - a.n || a.route.localeCompare(b.route, "hu", { numeric: true })),
    onTimePct: measured ? Math.round((100 * onTime) / measured) : null,
    extraOnboardS,
    lateWaitS,
    delayMeasured,
    boardStops: sorted(board),
    alightStops: sorted(alight),
    stopsCollected: sorted(collected),
    pairs: [...pairs.values()].sort((a, b) => b.n - a.n),
    hours,
    weekdays,
    longest,
    mostDelayed,
    longestTime,
  };
}
