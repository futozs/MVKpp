/**
 * A térkép pályája (`k`): [hely a nyomvonalon (m), idő a fix óta (mp)] pontok.
 * A modell rácspontonként a várható (medián) elmozdulást adja; ebből egy nem
 * csökkenő, enyhén simított pálya lesz  a busz a valóságban sem tolat.
 */
import { MOTION_BIN_M, isStanding, typicalDisp, type ShapeProfile } from "./profile.ts";
import type { MotionAnchor } from "./features.ts";

/** a pálya rácspontjai (mp a fix óta): 2 mp-enként egy percig, utána 5 mp-enként */
export const MOTION_GRID: readonly number[] = (() => {
  const g: number[] = [];
  for (let h = 0; h <= 60; h += 2) g.push(h);
  for (let h = 65; h <= 90; h += 5) g.push(h);
  return g;
})();

/** A legközelebbi nem csökkenő sorozat (pool-adjacent-violators, legkisebb négyzetek). */
export function isotonic(y: readonly number[]): number[] {
  const val: number[] = [];
  const w: number[] = [];
  for (const v of y) {
    val.push(v);
    w.push(1);
    while (val.length > 1 && val[val.length - 2] > val[val.length - 1]) {
      const b = val.pop()!;
      const bw = w.pop()!;
      const a = val.pop()!;
      const aw = w.pop()!;
      val.push((a * aw + b * bw) / (aw + bw));
      w.push(aw + bw);
    }
  }
  const out: number[] = [];
  val.forEach((v, i) => {
    for (let k = 0; k < w[i]; k++) out.push(v);
  });
  return out;
}

/**
 * Rácspontonkénti elmozdulásokból (`disp[i]` a `MOTION_GRID[i]` időpontra) a pálya:
 * monoton, a szomszédos pontokkal simítva, a végállomásnál megállva.
 */
export function motionTrajectory(x0: number, disp: readonly number[], endAlong: number): [number, number][] {
  const d = isotonic(disp.map((v, i) => (MOTION_GRID[i] === 0 ? 0 : Math.max(0, v))));
  const smooth = d.map((v, i) => (i === 0 ? 0 : i === d.length - 1 ? v : (d[i - 1] + v + d[i + 1]) / 3));
  return MOTION_GRID.map((h, i) => [Math.round(Math.min(endAlong, x0 + smooth[i]) * 10) / 10, h]);
}

/** állás végének becslésekor legalább ennyi még hátravan (mp) */
const MIN_REMAINING_DWELL_S = 4;
const DEFAULT_DWELL_S = 25;
const DEFAULT_SPEED = 6;

/**
 * Tartalék becslés modell nélkül: az álló busz kivárja a hely jellemző állásidejét,
 * utána a profil tempójával halad. (A modell ennél bizonyítottan pontosabb  ez
 * csak akkor él, ha nincs modell, vagy élesben rosszabbul teljesít.)
 */
export function fallbackDisp(a: MotionAnchor, H: number, p: ShapeProfile | undefined): number {
  const standing = isStanding(a.v);
  if (!p) return standing ? 0 : (Number.isFinite(a.v) ? a.v : DEFAULT_SPEED) * H;
  let h = H;
  if (standing) {
    const b = Math.floor(a.x / MOTION_BIN_M);
    const dw = b < p.dwell.length && Number.isFinite(p.dwell[b]) ? p.dwell[b] : DEFAULT_DWELL_S;
    const rem = Math.max(MIN_REMAINING_DWELL_S, dw - (Number.isFinite(a.stoppedFor) ? a.stoppedFor : 0));
    h = Math.max(0, H - rem);
  }
  return typicalDisp(p, a.x, h);
}
