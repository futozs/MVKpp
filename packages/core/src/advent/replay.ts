/**
 * A nap visszajátszása a térképen. Menetenként a GPS-pontok a menet irányának
 * nyomvonalára vetítve (méter a nyomvonal elejétől), úgy, hogy a hely sosem
 * csökken: a jelölő sosem lép vissza (a felhasználó kemény szabálya). Ha a
 * villamos a végállomáson hallgat, ott vár, és csak a jel előtti utolsó
 * szakaszon indul el; a beérkezés előtti csendben előbb beér, aztán vár. Két
 * menet között az előző menet végén áll.
 */
import type { ProjectedShape } from "../geo.ts";
import type { AdventEnd } from "./season.ts";
import { TRACK, type LegEnd, type Track } from "./track.ts";

export type ReplayDir = "out" | "back";

export type ReplayLeg = {
  dir: ReplayDir;
  from: AdventEnd | null;
  to: AdventEnd | null;
  end: LegEnd;
  /** [ts, m a menet irányának nyomvonalán] időrendben; m sosem csökken */
  pts: [number, number][];
};

export type DayReplay = {
  /** a day.legs-szel azonos sorrendben és számban (a menet indexe ugyanaz) */
  legs: ReplayLeg[];
  /** a folyamatos jel szakaszai [tól, ig]: a pontok közt legfeljebb TRACK.gapS */
  signal: [number, number][];
};

export type ReplayShapes = Record<ReplayDir, ProjectedShape>;

export const REPLAY = {
  /** ekkora előreugrás, amit a következő pont sem igazol, GPS-tüske (m) */
  spikeM: 80,
  /** a jel nélküli indulás és beérkezés feltételezett tempója (m/s) */
  gapSpeed: 6,
  /** ennél hosszabb jelköz a végállomáson már várakozás (mp) */
  quietS: 60,
  /** a jel ennyi ideig számít frissnek az utolsó pont után (mp) */
  freshS: 30,
  /** a haladás irányát ennyivel előrébb nézzük a nyomvonalon (m) */
  lookM: 35,
};

/** Egy menet a nyomvonalán: vetítés az előző hely környékén, tüskeszűrés, majd sosem csökkenő hely. */
function replayLeg(leg: Track["legs"][number], shape: ProjectedShape): ReplayLeg {
  const out: ReplayLeg = { dir: leg.dir, from: leg.from, to: leg.to, end: leg.end, pts: [] };
  // a végállomásról induló menet a nyomvonal elején kezdődik: a hurkon a globális legközelebbi pont a rossz ágon lehet
  let hint: number | undefined = leg.from ? 0 : undefined;
  const raw: { ts: number; m: number; place: string }[] = [];
  for (const f of leg.fixes) {
    if (f.place === "off") continue;
    const p = shape.project(f.lat, f.lon, hint);
    if (!p) continue;
    raw.push({ ts: f.ts, m: p.alongM, place: f.place });
    hint = Math.max(hint ?? p.alongM, p.alongM);
  }
  const kept = raw.filter((p, i) => {
    const a = raw[i - 1];
    const b = raw[i + 1];
    return !(a && b && p.m - a.m > REPLAY.spikeM && p.m - b.m > REPLAY.spikeM);
  });

  let m = -Infinity;
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    const prev = out.pts[out.pts.length - 1];
    const next = Math.round(Math.max(m, p.m));
    if (prev && i > 0 && p.ts - kept[i - 1].ts > REPLAY.quietS && next > prev[1]) {
      const travel = (next - prev[1]) / REPLAY.gapSpeed;
      // a végállomáson hallgatott: ott várt, a jel előtt nem sokkal indult
      const wait = leg.from && kept[i - 1].place === leg.from ? Math.round(p.ts - travel) : null;
      // a beérkezés előtt hallgatott: beért, aztán ott várt
      const arrive = wait == null && leg.to && p.place === leg.to ? Math.round(prev[0] + travel) : null;
      if (wait != null && wait > prev[0] && wait < p.ts) out.pts.push([wait, prev[1]]);
      if (arrive != null && arrive > prev[0] && arrive < p.ts) out.pts.push([arrive, next]);
    }
    m = Math.max(m, p.m);
    out.pts.push([p.ts, next]);
  }
  return out;
}

function signalOf(fixes: { ts: number }[]): [number, number][] {
  const out: [number, number][] = [];
  for (const f of fixes) {
    const last = out[out.length - 1];
    if (last && f.ts - last[1] <= TRACK.gapS) last[1] = f.ts;
    else out.push([f.ts, f.ts]);
  }
  return out;
}

/** A nap visszajátszható menetei a menetek irányának nyomvonalán. */
export function replayDay(track: Track, shapes: ReplayShapes): DayReplay {
  return { legs: track.legs.map((l) => replayLeg(l, shapes[l.dir])), signal: signalOf(track.fixes) };
}

export type ReplayPose = {
  lat: number;
  lon: number;
  /** a haladás iránya a nyomvonalon (fok, észak = 0) */
  heading: number;
  dir: ReplayDir;
  /** a hely a menet irányának nyomvonalán (m) */
  m: number;
  /** a menet indexe; null: két menet között, az első előtt vagy az utolsó után (ott áll) */
  leg: number | null;
  /** a legközelebbi menet (amelyiknek a végén / elején áll) */
  near: number;
  /** jött-e jel a közelmúltban: ha nem, a hely becsült */
  fresh: boolean;
};

function headingAt(shape: ProjectedShape, m: number): number {
  const a = Math.min(m, shape.lengthM - REPLAY.lookM);
  const [la1, lo1] = shape.pointAt(Math.max(0, a));
  const [la2, lo2] = shape.pointAt(Math.max(0, a) + REPLAY.lookM);
  const dx = (lo2 - lo1) * Math.cos((la1 * Math.PI) / 180);
  const dy = la2 - la1;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** az utolsó index, amelyre pts[i][0] <= t (-1, ha nincs) */
function lastAtOrBefore(pts: [number, number][], t: number): number {
  let lo = 0;
  let hi = pts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Hol járt a villamos `t`-kor: a menet két pontja közt a nyomvonal mentén
 * (nem légvonalban), menet nélkül az előző menet végén (az első előtt az első
 * menet elején). null, ha a napnak nincs visszajátszható menete.
 */
export function replayAt(r: DayReplay, shapes: ReplayShapes, t: number): ReplayPose | null {
  let k = -1;
  let first = -1;
  for (let i = 0; i < r.legs.length; i++) {
    const pts = r.legs[i].pts;
    if (!pts.length) continue;
    if (first < 0) first = i;
    if (pts[0][0] <= t) k = i;
    else break;
  }
  if (first < 0) return null;
  const near = k < 0 ? first : k;
  const leg = r.legs[near];
  const pts = leg.pts;
  let m: number;
  let inLeg = false;
  if (k < 0) m = pts[0][1];
  else {
    const i = lastAtOrBefore(pts, t);
    const a = pts[i];
    const b = pts[i + 1];
    if (b) {
      m = a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0]);
      inLeg = true;
    } else {
      m = a[1];
      inLeg = t === a[0];
    }
  }
  const shape = shapes[leg.dir];
  const [lat, lon] = shape.pointAt(m);
  const fresh = r.signal.some(([from, to]) => t >= from && t <= to + REPLAY.freshS);
  return { lat, lon, heading: headingAt(shape, m), dir: leg.dir, m, leg: inLeg ? near : null, near, fresh };
}
