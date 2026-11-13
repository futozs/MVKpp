/**
 * Tanult útprofil a térképi mozgásbecsléshez: nyomvonalanként 20 méteres
 * rekeszekben, hogy a buszok ott jellemzően
 *  - mennyi időt töltenek (a fixek között lineárisan; az álló fix a helyén marad),
 *  - a menetek hányad része állt meg ott (megálló, lámpa, kereszteződés, sor),
 *  - mennyi ideig álltak, ha megálltak.
 * A lámpákat így senkinek nem kell felvinnie: ahol a buszok rendszeresen állnak,
 * azt a profil megtanulja.
 *
 * A napi összegek összeadhatók (és kivonhatók): a tanításkor egy nap a saját
 * adatai nélküli profillal számol, hogy a modell ne lássa előre a saját jövőjét.
 */

export const MOTION_BIN_M = 20;
/** egy rekeszben eltöltött idő felső korlátja menetenként (mp)  egy lerobbanás ne torzítson */
const CAP_BIN_S = 90;
/** egy állás hosszának felső korlátja (mp) */
const CAP_DWELL_S = 180;
/** ennél kevesebb menetnél a rekesz a nyomvonal átlagára (illetve az egész napos profilra) támaszkodik */
const MIN_RUNS = 3;
const SHRINK_RUNS = 4;
const DEFAULT_PACE_S = MOTION_BIN_M / 7;
/** ekkora elmozdulás még ugyanaz az állás (m) */
export const STANDSTILL_MOVE_M = 15;

/** [idő (unix), hely a nyomvonalon (m), GPS-sebesség (m/s; -1 = ismeretlen)] */
export type MotionFix = [number, number, number];
export type MotionRun = { shapeId: string; fixes: MotionFix[] };

/** a jármű áll (ugyanaz a küszöb, mint az illesztőben) */
export const isStanding = (v: number) => v >= 0 && v <= 1;

/** napszak-osztályok határai (óra): hajnal · reggeli csúcs · délelőtt · kora délután · délutáni csúcs · este */
const HOUR_BOUNDS = [6.5, 9, 13, 16, 19];
export const HOUR_CLASSES = HOUR_BOUNDS.length + 1;
export function hourClassOf(hour: number): number {
  let c = 0;
  while (c < HOUR_BOUNDS.length && hour >= HOUR_BOUNDS[c]) c++;
  return c;
}

type ShapeSums = { n: Float64Array; pace: Float64Array; stop: Float64Array; dwN: Float64Array; dw: Float64Array };
type Sums = Map<string, ShapeSums>;
/** egy vagy több nap összesített (additív) mérései: egész nap + napszakonként */
export type ProfileSums = { all: Sums; byClass: Sums[] };

function sumsFor(m: Sums, shape: string, bins: number): ShapeSums {
  const hit = m.get(shape);
  if (hit && hit.n.length >= bins) return hit;
  const grow = (old?: Float64Array) => {
    const f = new Float64Array(Math.max(bins, old?.length ?? 0));
    if (old) f.set(old);
    return f;
  };
  const s = { n: grow(hit?.n), pace: grow(hit?.pace), stop: grow(hit?.stop), dwN: grow(hit?.dwN), dw: grow(hit?.dw) };
  m.set(shape, s);
  return s;
}

function addRun(m: Sums, run: MotionRun) {
  const f = run.fixes;
  if (f.length < 3) return;
  const lastX = f[f.length - 1][1];
  const a = sumsFor(m, run.shapeId, Math.ceil((lastX + 1) / MOTION_BIN_M) + 1);
  const spent = new Map<number, number>();
  const stoodIn = new Set<number>();
  for (let i = 1; i < f.length; i++) {
    const [t0, x0, v0] = f[i - 1];
    const [t1, x1] = f[i];
    const dt = t1 - t0;
    if (dt <= 0 || dt > 120) continue;
    if (isStanding(v0)) stoodIn.add(Math.floor(x0 / MOTION_BIN_M));
    if (x1 - x0 < 1) {
      const b = Math.floor(x0 / MOTION_BIN_M);
      spent.set(b, (spent.get(b) ?? 0) + dt);
      continue;
    }
    for (let b = Math.floor(x0 / MOTION_BIN_M); b * MOTION_BIN_M < x1; b++) {
      const lo = Math.max(x0, b * MOTION_BIN_M);
      const hi = Math.min(x1, (b + 1) * MOTION_BIN_M);
      if (hi > lo) spent.set(b, (spent.get(b) ?? 0) + (dt * (hi - lo)) / (x1 - x0));
    }
  }
  // Csak a teljesen bejárt rekeszek számítanak (az első és az utolsó félig bejárt torzítana).
  const b0 = Math.floor(f[0][1] / MOTION_BIN_M) + 1;
  const b1 = Math.floor(lastX / MOTION_BIN_M) - 1;
  for (let b = b0; b <= b1; b++) {
    const s = spent.get(b);
    if (s == null) continue;
    a.n[b] += 1;
    a.pace[b] += Math.min(CAP_BIN_S, s);
    if (stoodIn.has(b)) a.stop[b] += 1;
  }
  // Állások: az első álló fixtől az első, már továbbhaladó fixig.
  let ep: { t: number; x: number } | null = null;
  for (const [t, x, v] of f) {
    if (isStanding(v) && !ep) ep = { t, x };
    else if (ep && (!isStanding(v) || x - ep.x > STANDSTILL_MOVE_M)) {
      const b = Math.floor(ep.x / MOTION_BIN_M);
      if (b < a.dw.length) {
        a.dwN[b] += 1;
        a.dw[b] += Math.min(CAP_DWELL_S, t - ep.t);
      }
      ep = null;
    }
  }
}

/** Egy nap menetei. `midnight`: a szolgáltatási nap helyi éjfele (a napszakhoz). */
export function profileSumsOf(runs: readonly MotionRun[], midnight: number): ProfileSums {
  const all: Sums = new Map();
  const byClass: Sums[] = Array.from({ length: HOUR_CLASSES }, () => new Map());
  for (const r of runs) {
    if (r.fixes.length < 3) continue;
    addRun(all, r);
    const mid = (r.fixes[0][0] + r.fixes[r.fixes.length - 1][0]) / 2;
    addRun(byClass[hourClassOf((mid - midnight) / 3600)], r);
  }
  return { all, byClass };
}

function combine(parts: Sums[], sign: number[]): Sums {
  const out: Sums = new Map();
  parts.forEach((p, k) => {
    for (const [shape, a] of p) {
      const o = sumsFor(out, shape, a.n.length);
      for (let b = 0; b < a.n.length; b++) {
        o.n[b] += sign[k] * a.n[b];
        o.pace[b] += sign[k] * a.pace[b];
        o.stop[b] += sign[k] * a.stop[b];
        o.dwN[b] += sign[k] * a.dwN[b];
        o.dw[b] += sign[k] * a.dw[b];
      }
    }
  });
  return out;
}

/** Napok összege; `minus` megadásával egy nap kivonva (a tanításhoz). */
export function sumProfiles(parts: readonly ProfileSums[], minus?: ProfileSums): ProfileSums {
  const list = minus ? [...parts, minus] : [...parts];
  const sign = list.map((_, k) => (minus && k === list.length - 1 ? -1 : 1));
  return {
    all: combine(
      list.map((p) => p.all),
      sign,
    ),
    byClass: Array.from({ length: HOUR_CLASSES }, (_, c) =>
      combine(
        list.map((p) => p.byClass[c]),
        sign,
      ),
    ),
  };
}

export type ShapeProfile = {
  /** a nyomvonal elejétől az adott rekesz elejéig a jellemző idő (mp); hossza = rekeszek + 1 */
  cum: Float64Array;
  /** jellemző idő rekeszenként (mp) */
  pace: Float32Array;
  /** a menetek hányad része állt meg a rekeszben (0–1) */
  stop: Float32Array;
  /** az itt kezdődő állások átlagos hossza (mp; NaN, ha kevés a mérés) */
  dwell: Float32Array;
};
export type RoadProfile = { all: Map<string, ShapeProfile>; byClass: Map<string, ShapeProfile>[] };

function withCum(pace: Float32Array, stop: Float32Array, dwell: Float32Array): ShapeProfile {
  const cum = new Float64Array(pace.length + 1);
  for (let b = 0; b < pace.length; b++) cum[b + 1] = cum[b] + pace[b];
  return { cum, pace, stop, dwell };
}

function finalizeShape(a: ShapeSums, base?: ShapeProfile): ShapeProfile {
  const nb = a.n.length;
  const pace = new Float32Array(nb);
  const stop = new Float32Array(nb);
  const dwell = new Float32Array(nb);
  let sp = 0;
  let sn = 0;
  for (let b = 0; b < nb; b++) {
    sp += a.pace[b];
    sn += a.n[b];
  }
  const shapePace = sn > 0 ? sp / sn : DEFAULT_PACE_S;
  for (let b = 0; b < nb; b++) {
    if (base && b < base.pace.length) pace[b] = (a.pace[b] + SHRINK_RUNS * base.pace[b]) / (a.n[b] + SHRINK_RUNS);
    else if (a.n[b] >= MIN_RUNS) pace[b] = a.pace[b] / a.n[b];
    else pace[b] = a.n[b] > 0 ? (a.pace[b] + shapePace * MIN_RUNS) / (a.n[b] + MIN_RUNS) : shapePace;
    stop[b] = a.n[b] > 0 ? a.stop[b] / (a.n[b] + 1) : 0;
    let dn = 0;
    let dw = 0;
    for (let k = -1; k <= 1; k++) {
      if (b + k < 0 || b + k >= nb) continue;
      dn += a.dwN[b + k];
      dw += a.dw[b + k];
    }
    dwell[b] = dn >= 2 ? dw / dn : NaN;
  }
  return withCum(pace, stop, dwell);
}

/** A használható profil: a ritka rekeszek kisimítva, a napszakosak az egész naposra támaszkodva. */
export function finalizeProfile(s: ProfileSums): RoadProfile {
  const all = new Map<string, ShapeProfile>();
  for (const [shape, a] of s.all) all.set(shape, finalizeShape(a));
  const byClass = s.byClass.map((c) => {
    const m = new Map<string, ShapeProfile>();
    for (const [shape, a] of c) m.set(shape, finalizeShape(a, all.get(shape)));
    return m;
  });
  return { all, byClass };
}

function cumAt(p: ShapeProfile, x: number): number {
  const nb = p.pace.length;
  if (x <= 0) return 0;
  const b = Math.floor(x / MOTION_BIN_M);
  if (b >= nb) return p.cum[nb] + ((x - nb * MOTION_BIN_M) / MOTION_BIN_M) * DEFAULT_PACE_S;
  return p.cum[b] + ((x - b * MOTION_BIN_M) / MOTION_BIN_M) * p.pace[b];
}

/** Jellemzően mennyi idő alatt jut el egy busz `x`-ből `y`-ba (mp). */
export function typicalTime(p: ShapeProfile, x: number, y: number): number {
  return cumAt(p, y) - cumAt(p, x);
}

/** Hol tart egy jellemző busz `x`-ből indulva `h` másodperc múlva (elmozdulás, m). */
export function typicalDisp(p: ShapeProfile, x: number, h: number): number {
  if (h <= 0) return 0;
  const nb = p.pace.length;
  const target = cumAt(p, x) + h;
  if (target >= p.cum[nb]) return nb * MOTION_BIN_M + ((target - p.cum[nb]) / DEFAULT_PACE_S) * MOTION_BIN_M - x;
  let lo = 0;
  let hi = nb;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= target) lo = mid;
    else hi = mid;
  }
  const frac = p.pace[lo] > 0 ? (target - p.cum[lo]) / p.pace[lo] : 0;
  return Math.max(0, lo * MOTION_BIN_M + Math.min(1, frac) * MOTION_BIN_M - x);
}

// ── tárolás (a modell mellett az adatbázisban) ─────────────────────────────

/** JSON-ba írható, tömör alak: rekeszenként tized mp, százalék, egész mp (255 = nincs). */
export type PackedProfile = { v: 1; bin: number; shapes: Record<string, { pace: string; stop: string; dwell: string; cls: string[] }> };

// btoa/atob: a core a böngészőben is fut, ott nincs Buffer
function b64(a: ArrayBufferView): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const packPace = (p: Float32Array) => b64(Uint16Array.from(p, (x) => Math.min(65535, Math.max(0, Math.round(x * 10)))));
const unpackPace = (s: string) => Float32Array.from(new Uint16Array(fromB64(s).buffer), (x) => x / 10);

export function packProfile(p: RoadProfile): PackedProfile {
  const shapes: PackedProfile["shapes"] = {};
  for (const [id, s] of p.all) {
    shapes[id] = {
      pace: packPace(s.pace),
      stop: b64(Uint8Array.from(s.stop, (x) => Math.round(Math.min(1, Math.max(0, x)) * 250))),
      dwell: b64(Uint8Array.from(s.dwell, (x) => (Number.isFinite(x) ? Math.min(254, Math.round(x)) : 255))),
      cls: p.byClass.map((c) => {
        const cs = c.get(id);
        return cs ? packPace(cs.pace) : "";
      }),
    };
  }
  return { v: 1, bin: MOTION_BIN_M, shapes };
}

export function unpackProfile(packed: PackedProfile): RoadProfile {
  const all = new Map<string, ShapeProfile>();
  const byClass: Map<string, ShapeProfile>[] = Array.from({ length: HOUR_CLASSES }, () => new Map());
  for (const [id, s] of Object.entries(packed.shapes)) {
    const stop = Float32Array.from(fromB64(s.stop), (x) => x / 250);
    const dwell = Float32Array.from(fromB64(s.dwell), (x) => (x === 255 ? NaN : x));
    const base = withCum(unpackPace(s.pace), stop, dwell);
    all.set(id, base);
    s.cls.forEach((c, k) => {
      if (c && k < HOUR_CLASSES) byClass[k].set(id, withCum(unpackPace(c), stop, dwell));
    });
  }
  return { all, byClass };
}

export function isPackedProfile(x: unknown): x is PackedProfile {
  const p = x as PackedProfile;
  return !!p && p.v === 1 && p.bin === MOTION_BIN_M && typeof p.shapes === "object" && p.shapes != null;
}
