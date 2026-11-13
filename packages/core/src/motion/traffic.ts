/**
 * Élő forgalom a busz előtti útszakaszon: az ugyanezen a nyomvonalon az utóbbi
 * 20 percben előtte járó buszok mennyi idő alatt tették meg a következő 300 m-t,
 * a tanult profilhoz képest. Ez a modell „mai” tudása: dugó, útlezárás, terelés.
 *
 * Minden áthaladásnak két ideje van: mikor történt, és mikor derült ki (a
 * következő fix ideje). A lekérdezés csak a már kiderült áthaladásokat látja 
 * így a tanításkor sem lát a jövőbe.
 */
import { MOTION_BIN_M, typicalTime, type MotionFix, type ShapeProfile } from "./profile.ts";

export const TRAFFIC_WINDOW_S = 20 * 60;
export const TRAFFIC_AHEAD_M = 300;

type RunPass = { key: string; pass: Float64Array; known: Float64Array; lastFix: MotionFix | null; lastSeen: number };

export class StretchTraffic {
  private byShape = new Map<string, Map<string, RunPass>>();

  /**
   * Egy menet új fixe (időrendben). `bins`: a nyomvonal rekeszeinek száma.
   * A két fix közötti rekeszhatárokon az áthaladás ideje lineárisan becsülve.
   */
  addFix(shapeId: string, runKey: string, fix: MotionFix, bins: number): void {
    let runs = this.byShape.get(shapeId);
    if (!runs) this.byShape.set(shapeId, (runs = new Map()));
    let r = runs.get(runKey);
    if (!r) {
      r = { key: runKey, pass: new Float64Array(bins + 1).fill(NaN), known: new Float64Array(bins + 1).fill(NaN), lastFix: null, lastSeen: fix[0] };
      runs.set(runKey, r);
    }
    const prev = r.lastFix;
    r.lastFix = fix;
    r.lastSeen = fix[0];
    if (!prev || fix[0] <= prev[0] || fix[1] <= prev[1]) return;
    const [t0, x0] = prev;
    const [t1, x1] = fix;
    for (let b = Math.ceil(x0 / MOTION_BIN_M); b * MOTION_BIN_M <= x1 && b < r.pass.length; b++) {
      if (b * MOTION_BIN_M < x0 || !Number.isNaN(r.pass[b])) continue;
      r.pass[b] = t0 + ((b * MOTION_BIN_M - x0) / (x1 - x0)) * (t1 - t0);
      r.known[b] = t1;
    }
  }

  /** A teljes menet egyszerre (a tanításhoz). */
  addRun(shapeId: string, runKey: string, fixes: readonly MotionFix[], bins: number): void {
    for (const f of fixes) this.addFix(shapeId, runKey, f, bins);
  }

  /** A régi menetek elengedése (élesben percenként). */
  prune(now: number): void {
    for (const [shape, runs] of this.byShape) {
      for (const [k, r] of runs) if (now - r.lastSeen > TRAFFIC_WINDOW_S + 600) runs.delete(k);
      if (!runs.size) this.byShape.delete(shape);
    }
  }

  /**
   * A [x, x + 300 m] szakasz mostani lassulása: a már kiderült, 20 percnél
   * frissebb áthaladások menetidejének mediánja a profil idejéhez képest
   * (>1 = lassabb a szokásosnál), és a legfrissebb kora (mp).
   */
  query(shapeId: string, x: number, t: number, p: ShapeProfile | undefined, selfKey: string): { ratio: number; age: number } {
    const runs = this.byShape.get(shapeId);
    if (!runs || !p) return { ratio: NaN, age: NaN };
    const b0 = Math.ceil(x / MOTION_BIN_M);
    const b1 = b0 + Math.round(TRAFFIC_AHEAD_M / MOTION_BIN_M);
    const typical = typicalTime(p, b0 * MOTION_BIN_M, b1 * MOTION_BIN_M);
    if (!(typical > 0)) return { ratio: NaN, age: NaN };
    const ratios: number[] = [];
    let age = Infinity;
    for (const r of runs.values()) {
      if (r.key === selfKey || b1 >= r.pass.length) continue;
      const t0 = r.pass[b0];
      const t1 = r.pass[b1];
      if (!(t1 > t0) || !(r.known[b1] <= t) || t1 < t - TRAFFIC_WINDOW_S) continue;
      ratios.push((t1 - t0) / typical);
      age = Math.min(age, t - t1);
    }
    if (!ratios.length) return { ratio: NaN, age: NaN };
    ratios.sort((a, b) => a - b);
    return { ratio: ratios[ratios.length >> 1], age };
  }

  size(): number {
    let n = 0;
    for (const runs of this.byShape.values()) n += runs.size;
    return n;
  }
}
