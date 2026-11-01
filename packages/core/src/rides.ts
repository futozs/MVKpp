/**
 * Utazásnapló: hol szállt fel és le az utas — becslés a GPS-ből, és javítás.
 *
 * A motor egy megállót akkor jegyez be elértnek (`lastStopIdx`), amikor a busz
 * elhagyja a megálló körzetét: amíg ott áll, a menet még az előző megállónál
 * tart. Aki a megállóban, a busz mellett nyomja meg a „Felszálltam” vagy a
 * „Leszálltam” gombot, annak ezért az előző megálló jönne ki. A telefon (vagy a
 * busz) helyét a megállókhoz mérve ezt itt javítjuk.
 */
import { fastDistM, haversineKm } from "./geo.ts";

export type RidePoint = { lat: number; lon: number };

export interface RideStop {
  idx: number;
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  /** menetrend szerinti indulás (unix) */
  schedTs: number;
}

/** a menet egy megálló-eseménye (`/engine/trip` → `events`) */
export interface RideStopEvent {
  stop_idx: number;
  arr: number;
  dep: number | null;
  delay_s: number;
}

/** ennyire lehet a busz (vagy a telefon) a megállótól, hogy ott álljon (m) — a GPS pontatlanságával */
export const AT_STOP_M = 70;
/** a felszállás helyéhez ennél messzebbi megállót nem tekintünk a felszállás megállójának (m) */
const BOARD_NEAR_M = 400;
/** leszállás után az utas ennyin belül van még a megállótól (m) — ennél messzebbről nem találgatunk */
const ALIGHT_NEAR_M = 500;
/** ennyivel közelebbinek kell lennie egy korábbi megállónak, hogy azt válasszuk a későbbi helyett (m) */
const PREFER_LATER_M = 25;

const distTo = (p: RidePoint, s: RideStop) => (s.lat == null || s.lon == null ? Infinity : fastDistM(p.lat, p.lon, s.lat, s.lon));

/**
 * Hol tart most a busz: az utolsó elhagyott megálló, vagy a következő, ha a
 * megadott hely (a busz vagy a mellette álló telefon) már ott van.
 */
export function currentStopIdx(stops: RideStop[], passedIdx: number, at: RidePoint | null, atStopM = AT_STOP_M): number {
  if (!stops.length) return 0;
  const next = stops[passedIdx + 1];
  // `atStopM`: a vonat 150–300 m-es peronon áll meg, az állomás pontja ettől messzebb lehet
  if (at && next && distTo(at, next) <= atStopM) return passedIdx + 1;
  return Math.max(0, Math.min(passedIdx, stops.length - 1));
}

/** A `from..to` megállók közül a ponthoz legközelebbi (egyenlőség közelében a későbbi), ha `maxM`-en belül van. */
function nearestIdx(stops: RideStop[], from: number, to: number, p: RidePoint, maxM: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = Math.min(to, stops.length - 1); i >= Math.max(0, from); i--) {
    const d = distTo(p, stops[i]);
    if (d < bestD - (best == null ? 0 : PREFER_LATER_M)) {
      best = i;
      bestD = d;
    }
  }
  return best != null && bestD <= maxM ? best : null;
}

/**
 * A felszállás megállója: a telefon felszálláskori helyéhez (felismerésnél
 * ahol a busz mellett állt, mielőtt együtt elindultak) legközelebbi megálló
 * azok közül, ahol a busz már járt, vagy ahol épp áll. Telefonhely nélkül:
 * ahol a busz most tart. A végállomáson nem lehet felszállni (onnan már nem megy tovább).
 */
export function guessBoardIdx(stops: RideStop[], passedIdx: number, phone: RidePoint | null, bus: RidePoint | null): number {
  const lastBoardable = Math.max(0, stops.length - 2);
  const cur = Math.min(currentStopIdx(stops, passedIdx, phone ?? bus), lastBoardable);
  if (!phone) return cur;
  return nearestIdx(stops, 0, cur, phone, BOARD_NEAR_M) ?? cur;
}

/**
 * A leszállás megállója, ha a telefon már nincs a buszon: a busz által a
 * felszállás óta elhagyott megállók közül a telefonhoz legközelebbi (aki
 * leszállt, többnyire a megálló közelében van még), de nem korábbi annál,
 * ahol utoljára a busszal volt. Ennek híján ott, ahol utoljára a busszal volt.
 */
export function guessAlightIdx(stops: RideStop[], fromIdx: number, passedIdx: number, phone: RidePoint | null, lastWithBusIdx: number | null): number {
  const last = stops.length - 1;
  const lo = Math.min(last, Math.max(fromIdx + 1, lastWithBusIdx ?? 0));
  const hi = Math.max(lo, Math.min(passedIdx, last));
  if (phone) {
    const near = nearestIdx(stops, lo, hi, phone, ALIGHT_NEAR_M);
    if (near != null) return near;
  }
  return lastWithBusIdx != null ? lo : hi;
}

export type RideStopTime = { arr: number; dep: number | null; delayS: number };

/** A menet eseményei megállónként (az első esemény számít, ha egy megálló kétszer is szerepelne). */
export function stopTimes(events: readonly RideStopEvent[]): Map<number, RideStopTime> {
  const out = new Map<number, RideStopTime>();
  for (const e of events) if (!out.has(e.stop_idx)) out.set(e.stop_idx, { arr: e.arr, dep: e.dep, delayS: e.delay_s });
  return out;
}

/** A menet megállói közötti út (légvonalban, megállóról megállóra összegezve, m). */
export function pathLengthM(stops: RideStop[], from: number, to: number): number | null {
  let sum = 0;
  for (let i = Math.max(0, from); i < Math.min(to, stops.length - 1); i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return null;
    sum += haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
  }
  return Math.round(sum);
}

/**
 * Egy mentett utazás fel- és leszálló megállójának indexe a menetben. A
 * körjáratnál (Búza tér → … → Búza tér) ugyanaz a megálló kétszer is szerepel:
 * felszállni az elsőnél, leszállni a felszállás utáni elsőnél lehet.
 */
export function rideStopIdx(stops: RideStop[], fromStopId: string | null, toStopId: string | null): { from: number | null; to: number | null } {
  const fi = fromStopId ? stops.findIndex((s) => s.id === fromStopId) : -1;
  const from = fi >= 0 ? fi : null;
  const ti = toStopId ? stops.findIndex((s, i) => i > (from ?? -1) && s.id === toStopId) : -1;
  return { from, to: ti >= 0 ? ti : null };
}

export interface BoardFields {
  fromStopId: string | null;
  fromStopName: string | null;
  boardedAt: number;
  delayAtBoardS: number | null;
}

export interface AlightFields {
  toStopId: string | null;
  toStopName: string | null;
  alightedAt: number;
  delayAtAlightS: number | null;
}

/** tartalék, ha a menetnek abban a megállóban nincs eseménye: egy ismert időpont (null: a menetrend + késés), és a késés */
export type StopFallback = { at: number | null; delayS: number | null };

const fallbackTs = (s: RideStop, f: StopFallback) => f.at ?? s.schedTs + (f.delayS ?? 0);

/**
 * Felszállás egy megállónál: a busz tényleges indulása onnan (ha megvan), és
 * az ottani késés. Esemény nélkül (a busz még ott áll) a tartalék időpont.
 */
export function boardAt(stops: RideStop[], times: Map<number, RideStopTime>, idx: number, fallback: StopFallback): BoardFields | null {
  const s = stops[idx];
  if (!s) return null;
  const t = times.get(idx);
  return {
    fromStopId: s.id,
    fromStopName: s.name,
    boardedAt: t ? (t.dep ?? t.arr) : fallbackTs(s, fallback),
    delayAtBoardS: t ? t.delayS : fallback.delayS,
  };
}

/** Leszállás egy megállónál: a busz érkezése oda (ha megvan), és az ottani késés. */
export function alightAt(stops: RideStop[], times: Map<number, RideStopTime>, idx: number, fallback: StopFallback): AlightFields | null {
  const s = stops[idx];
  if (!s) return null;
  const t = times.get(idx);
  return {
    toStopId: s.id,
    toStopName: s.name,
    alightedAt: t ? t.arr : fallbackTs(s, fallback),
    delayAtAlightS: t ? t.delayS : fallback.delayS,
  };
}

/**
 * Becsült idő egy megállónál, ahol a busznak nincs eseménye (utólag felvett
 * utazás, kihagyott GPS): a menetrend a legközelebbi mért megálló késésével.
 * Mérés nélkül a menetrend.
 */
export function estimatedAt(stops: RideStop[], times: Map<number, RideStopTime>, idx: number): number | null {
  const s = stops[idx];
  if (!s) return null;
  let best: RideStopTime | null = null;
  let bestGap = Infinity;
  for (const [i, t] of times) {
    const gap = Math.abs(i - idx);
    if (gap < bestGap) {
      best = t;
      bestGap = gap;
    }
  }
  return s.schedTs + (best?.delayS ?? 0);
}
