/**
 * Mibe kerül a térképen egy rossz becslés? A jelölő sosem tolat (lásd a web
 * `motionFollow`-ját), ezért a két irány nem egyforma:
 *  - ha a busz MÖGÖTT mutatjuk, a lemaradás addig látszik, amíg meg nem jön a
 *    következő fix, és a jelölő utol nem éri (`lag` mp);
 *  - ha ELŐTTE, a jelölő megáll, és kivárja, amíg a valódi busz odaér  egy
 *    megállóban vagy lámpánál álló busznál ez a hátralévő állás, egy haladónál
 *    1–2 mp (`pass` mp).
 * A költség méterenként ennyi másodpercnyi látható hiba. Ebből tanulja meg a
 * modell, hogy ahol a busz megállhat, ott inkább kivárjon, mint elszaladjon 
 * egyenesben viszont a medián (a soha-ne-előzz határ: a túllövés sosem olcsóbb
 * a lemaradásnál, különben a jelölő haladás közben is meg-megállna).
 */
import type { RowCosts } from "../ml/gbdt.ts";
import type { MotionFix } from "./profile.ts";

/** ennyivel kell a valódi busznak továbbjutnia, hogy a megállt jelölőt elérje (m) */
export const PASS_M = 15;
/** a következő fix megérkezése után ennyi idő, amíg a jelölő utoléri (mp) */
export const CATCH_S = 2;
/** a kivárás ennél tovább nem számít többnek (mp) */
export const PASS_CAP_S = 90;
/** a túllövés (megállt, előreszaladt jelölő) súlya a lemaradáshoz képest */
export const OVER_WEIGHT = 1;

/**
 * Fixenként: mennyi idő múlva járt a busz `PASS_M` méterrel előrébb (mp, a fixek
 * között egyenletes haladással). Ha a menet addig véget ért: a menet végéig, legfeljebb `PASS_CAP_S`.
 */
export function passTimes(f: readonly MotionFix[]): Float32Array {
  const out = new Float32Array(f.length);
  for (let j = 0; j < f.length; j++) {
    const goal = f[j][1] + PASS_M;
    let k = j + 1;
    while (k < f.length && f[k][1] < goal && f[k][0] - f[j][0] < PASS_CAP_S) k++;
    if (k >= f.length) {
      out[j] = Math.min(PASS_CAP_S, f[f.length - 1][0] - f[j][0]);
      continue;
    }
    const [t0, x0] = f[k - 1];
    const [t1, x1] = f[k];
    // f[k-1] még nem érte el a célt (vagy maga a j-edik fix)
    const tg = x1 >= goal ? t0 + ((t1 - t0) * (goal - x0)) / (x1 - x0) : t1;
    out[j] = Math.min(PASS_CAP_S, Math.max(0, tg - f[j][0]));
  }
  return out;
}

/** A lemaradás ára (mp): a mutatott pálya `until`-ig (a következő fix megérkezéséig) látszik a `t` pillanat után. */
export function lagSeconds(t: number, until: number): number {
  return Math.max(0, until - t) + CATCH_S;
}

/** A két irány költsége soronként: alá lövés = `lag`, fölé lövés = a kivárás, de legalább a lemaradás ára. */
export function displayCosts(lag: ArrayLike<number>, pass: ArrayLike<number>, overWeight = OVER_WEIGHT): RowCosts {
  const n = lag.length;
  const over = new Float32Array(n);
  const under = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    under[i] = lag[i];
    over[i] = Math.max(lag[i], overWeight * pass[i]);
  }
  return { over, under };
}
