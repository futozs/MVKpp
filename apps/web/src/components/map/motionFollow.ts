/**
 * A jelölő mozgása a szerver pályáján (`k`): a pálya a busz várható helye
 * minden pillanatban (a tanított mozgás-modelltől). A jelölő ezt követi, és
 * SOSEM tolat:
 *  - ha lemaradt, rövid gyorsítással utoléri,
 *  - ha előrébb jár (a busz valójában még áll a megállóban, a lámpánál),
 *    lelassít, megáll, és kivárja, amíg a busz odaér — utána vele megy tovább.
 * A modell úgy tanul, hogy ahol a busz megállhat, ott inkább kivárjon, mint
 * elszaladjon (core `motion/cost`), így a kivárás ritka és rövid. Csak durva
 * eltérésnél ugrik (új menet, `snapM`-nél nagyobb hiba); hosszú szünet után
 * (háttérbe tett lap) előre a buszhoz ugrik, de vissza akkor sem.
 * Függőség nélküli, hogy a visszamérés ugyanezt a kódot futtathassa.
 */

export type MotionPath = { s: string; t: number; k: [number, number][] };
/** az előzőleg kirajzolt hely, a jelölő sebessége (m/s) és a rajzolás ideje */
export type Shown = { shape: string; along: number; u?: number; at?: number };

/** a pálya utolsó pontja után a busz ott marad (mp) */
export const MAX_PATH_S = 90;

export type FollowParams = {
  /** a lemaradás ennyi idő alatt tűnik el (mp) */
  catchS: number;
  /** ha előrébb jár: ennyi idő alatt fogy el az előnye — addig lassabban megy a pályánál, vagy áll (mp) */
  holdS: number;
  maxSpeed: number;
  /** ekkora eltérésnél nem követ, hanem odaugrik (m) — csak hibás illesztésnél fordul elő */
  snapM: number;
  /** ennél hosszabb rajzolási szünet után nem siklik (mp) */
  maxStepS: number;
};

export const FOLLOW: Readonly<FollowParams> = { catchS: 1.2, holdS: 1.5, maxSpeed: 25, snapM: 400, maxStepS: 5 };

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
export function followPath(m: MotionPath, now: number, shown: Shown | undefined, p: Readonly<FollowParams> = FOLLOW): Shown {
  const target = pathAt(m, now);
  const vPath = Math.max(0, pathAt(m, now + 0.5) - pathAt(m, now - 0.5));
  if (!shown || shown.shape !== m.s || Math.abs(target - shown.along) > p.snapM) return { shape: m.s, along: target, u: vPath, at: now };
  const step = shown.at != null ? now - shown.at : Infinity;
  // az óra visszaugrott (szerveróra-igazítás): marad, ahol volt
  if (step <= 0) return { ...shown, at: now };
  // hosszú szünet után nem siklik — előre a buszhoz ugrik, vissza nem
  if (step > p.maxStepS) return { shape: m.s, along: Math.max(shown.along, target), u: vPath, at: now };
  const gap = target - shown.along; // > 0: a jelölő lemaradt
  if (gap >= 0) {
    const u = Math.min(p.maxSpeed, vPath + gap / p.catchS);
    // a célon nem lő túl (nincs ide-oda rezgés körülötte)
    return { shape: m.s, along: Math.min(target, shown.along + u * step), u, at: now };
  }
  // Előrébb jár: a pálya tempójánál annyival lassabban halad (vagy áll), hogy az előny `holdS` alatt elfogyjon.
  // Az előnyt az előző rajzoláskori pályához mérjük — a mostanihoz mérve egy lépésnyit mindig elöl maradna.
  const lead = shown.along - pathAt(m, now - step);
  const u = Math.max(0, vPath - Math.max(0, lead) / p.holdS);
  return { shape: m.s, along: shown.along + u * step, u, at: now };
}
