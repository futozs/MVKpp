/**
 * A mozgás-modell tanító- és tesztsorai, pontosan úgy, ahogy a térkép használja:
 * a fix `L` mp múlva érkezik meg, és a térkép addig mutatja a becslést, amíg a
 * következő fix meg nem jön. Ami ebben az ablakban valódi fixként előfordul,
 * az egy mért pillanat: hol mutattuk volna a buszt, és hol volt valójában.
 *
 * A tanítónapok profilja a nap saját adatai nélkül készül (nem lát előre), a
 * forgalom-jellemző pedig csak a már kiderült áthaladásokat látja.
 */
import {
  fallbackDisp,
  finalizeProfile,
  hourClassOf,
  isStanding,
  MOTION_FEATURES,
  motionAnchor,
  motionFeatures,
  profileSumsOf,
  StretchTraffic,
  sumProfiles,
  type MotionAnchor,
  type ProfileSums,
  type RoadProfile,
} from "@mvk/core";
import type { HistoryDay, HistoryRun } from "./history.ts";

export type MotionSampleSet = {
  x: Float32Array;
  rows: number;
  cols: number;
  /** cél: elmozdulás a fix óta (m) */
  y: Float32Array;
  /** a profil-alapú tartalék becslése ugyanerre (az összevetéshez) */
  fallback: Float32Array;
  H: Float32Array;
  L: Float32Array;
  /** a fixnél állt-e a busz */
  standing: Uint8Array;
  days: string[];
};

/** a tanításkor a késleltetés (L) ebből a tartományból sorsolt (mp) */
const L_MIN = 1;
const L_MAX = 30;
/** ennél tovább a pálya nem tart (mp) — lásd MOTION_GRID */
const H_MAX = 90;

/** Növekvő Float32 puffer (a sorok száma előre nem ismert). */
class Grow {
  a = new Float32Array(1 << 16);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

class Builder {
  x = new Grow();
  y = new Grow();
  fb = new Grow();
  H = new Grow();
  L = new Grow();
  st = new Grow();
  days: string[] = [];
  set(): MotionSampleSet {
    const rows = this.y.n;
    return { x: this.x.done(), rows, cols: MOTION_FEATURES.length, y: this.y.done(), fallback: this.fb.done(), H: this.H.done(), L: this.L.done(), standing: Uint8Array.from(this.st.done()), days: this.days };
  }
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sumsOfDay = (d: HistoryDay): ProfileSums => profileSumsOf(d.runs, d.midnight);

function trafficOf(d: HistoryDay, prof: RoadProfile): StretchTraffic {
  const t = new StretchTraffic();
  for (const r of d.runs) {
    const p = prof.all.get(r.shapeId);
    if (p) t.addRun(r.shapeId, `${r.tripId}|${r.vehicleId}`, r.fixes, p.pace.length);
  }
  return t;
}

/** Egy menet `i`-edik fixének állapota a forgalommal együtt (élesben ugyanígy). */
export function anchorWithTraffic(d: HistoryDay, r: HistoryRun, i: number, prof: RoadProfile, traffic: StretchTraffic): MotionAnchor {
  const a = motionAnchor(r.fixes, i, d.trip(r.tripId), d.midnight, d.daytype);
  const q = traffic.query(r.shapeId, a.x, a.t, prof.all.get(r.shapeId), `${r.tripId}|${r.vehicleId}`);
  a.traffic = q.ratio;
  a.trafficAge = q.age;
  return a;
}

export type RowOptions = {
  /** a fixek ekkora hányada lesz kiindulópont */
  rate: number;
  /** kiindulópontonként ennyi sorsolt késleltetés — vagy rögzített késleltetések (teszthez) */
  latencies: number | number[];
  rnd: () => number;
};

function addDay(b: Builder, d: HistoryDay, prof: RoadProfile, o: RowOptions) {
  const traffic = trafficOf(d, prof);
  const buf = new Float32Array(MOTION_FEATURES.length);
  b.days.push(d.iso);
  for (const r of d.runs) {
    const p = prof.all.get(r.shapeId);
    const f = r.fixes;
    for (let i = 1; i < f.length - 1; i++) {
      if (o.rnd() > o.rate) continue;
      const a = anchorWithTraffic(d, r, i, prof, traffic);
      const ph = prof.byClass[hourClassOf(a.hour)].get(r.shapeId);
      const Ls = typeof o.latencies === "number" ? Array.from({ length: o.latencies }, () => L_MIN + o.rnd() * (L_MAX - L_MIN)) : o.latencies;
      for (const L of Ls) {
        // a térkép ezt a fixet a megérkezésétől (t + L) a következő megérkezéséig mutatja
        const until = f[i + 1][0] + L;
        for (let j = i + 1; j < f.length && f[j][0] < until; j++) {
          const H = f[j][0] - f[i][0];
          if (H < L) continue;
          if (H > H_MAX) break;
          motionFeatures(a, H, L, p, ph, buf);
          for (let k = 0; k < buf.length; k++) b.x.push(buf[k]);
          b.y.push(f[j][1] - f[i][1]);
          b.fb.push(fallbackDisp(a, H, p));
          b.H.push(H);
          b.L.push(L);
          b.st.push(isStanding(a.v) ? 1 : 0);
        }
      }
    }
  }
}

/**
 * Tanító sorok: minden nap a többi tanítónapból épült profillal (a sajátja nélkül).
 * `total` a tanítónapok összege; a nap saját összegét itt számoljuk újra (kevesebb memória).
 */
export function trainingRows(days: readonly HistoryDay[], total: ProfileSums, o: RowOptions): MotionSampleSet {
  const b = new Builder();
  for (const d of days) addDay(b, d, finalizeProfile(sumProfiles([total], sumsOfDay(d))), o);
  return b.set();
}

/** Validációs / teszt sorok a tanítónapok profiljával. */
export function evalRows(days: readonly HistoryDay[], prof: RoadProfile, o: RowOptions): MotionSampleSet {
  const b = new Builder();
  for (const d of days) addDay(b, d, prof, o);
  return b.set();
}

