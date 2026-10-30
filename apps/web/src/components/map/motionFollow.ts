/**
 * A jelölő mozgása a szerver pályáján (`k`): a pálya a busz várható helye
 * minden pillanatban (a tanított mozgás-modelltől). A jelölő ezt szorosan
 * követi — új jelnél nem ugrik, hanem egy pillanat alatt odasiklik:
 *  - ha lemaradt, rövid gyorsítással utoléri,
 *  - ha kicsit előrébb jár, lassít / megáll, amíg a pálya utoléri (nem tolat),
 *  - ha nagyon előrébb jár (a busz valójában még áll), gyorsan visszacsúszik —
 *    a pontosság fontosabb, mint hogy soha ne mozduljon visszafelé.
 * A visszamérés (2 nap, valós jelek) szerint így ~3 m-rel pontatlanabb, mint
 * a pálya ugrásokkal, de nincs ugrás. Függőség nélküli, hogy a visszamérés
 * ugyanezt a kódot futtathassa.
 */

export type MotionPath = { s: string; t: number; k: [number, number][] };
/** az előzőleg kirajzolt hely, a jelölő sebessége (m/s) és a rajzolás ideje */
export type Shown = { shape: string; along: number; u?: number; at?: number };

/** a pálya utolsó pontja után a busz ott marad (mp) */
export const MAX_PATH_S = 90;

export const FOLLOW = {
  /** a lemaradás ennyi idő alatt tűnik el (mp) */
  catchS: 0.8,
  /** az előreszaladás ennyi idő alatt tűnik el (mp) */
  backS: 0.6,
  /** eddig az előreszaladásig csak lassít / vár, nem tolat (m) */
  holdM: 8,
  maxSpeed: 28,
  maxBack: 20,
  /** ekkora eltérésnél (vagy hosszú szünet után) nem siklik, hanem odaugrik (m) */
  snapM: 400,
  maxStepS: 5,
} as const;

/** Hol tart a pálya `now` (szerveridő, mp) pillanatban. */
export function pathAt(m: MotionPath, now: number): number {
  const k = m.k;
  const dt = Math.min(MAX_PATH_S, now - m.t);
  if (dt <= k[0][1]) return k[0][0];
  for (let i = 1; i < k.length; i++) {
    if (dt <= k[i][1]) {
      const [a0, t0] = k[i - 1];
      const [a1, t1] = k[i];
      return t1 > t0 ? a0 + ((a1 - a0) * (dt - t0)) / (t1 - t0) : a1;
    }
  }
  return k[k.length - 1][0];
}

/** A jelölő következő helye; `shown` az előző rajzolás. */
export function followPath(m: MotionPath, now: number, shown: Shown | undefined, p: typeof FOLLOW = FOLLOW): Shown {
  const target = pathAt(m, now);
  const vPath = Math.max(0, pathAt(m, now + 0.5) - pathAt(m, now - 0.5));
  const step = shown?.at != null ? now - shown.at : Infinity;
  if (!shown || shown.shape !== m.s || !(step > 0) || step > p.maxStepS || Math.abs(target - shown.along) > p.snapM) {
    return { shape: m.s, along: target, u: vPath, at: now };
  }
  const gap = target - shown.along; // > 0: a jelölő lemaradt
  let u: number;
  if (gap >= 0) u = Math.min(p.maxSpeed, vPath + gap / p.catchS);
  else if (-gap <= p.holdM) u = Math.max(0, vPath + gap / p.backS);
  else u = Math.max(-p.maxBack, vPath + gap / p.backS);
  let along = shown.along + u * step;
  // A célon nem lő túl (nincs ide-oda rezgés körülötte).
  if (gap >= 0 && along > target + vPath * step) along = Math.max(shown.along, target + vPath * step);
  else if (gap < 0 && u < 0 && along < target) along = target;
  return { shape: m.s, along, u, at: now };
}
