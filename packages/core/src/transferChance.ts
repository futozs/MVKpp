/**
 * Átszállási esély: elérem-e a következő járatot, a két busz bizonytalan
 * érkezésével/indulásával együtt.
 *
 * Egy busz várható ideje körüli bizonytalanságot két-darabos normális
 * eloszlással írjuk le: a késés felőli oldal széles (a 85%-os felső becslésből),
 * a korai oldal fele olyan széles (a busz ritkán siet sokat). Az eloszlást úgy
 * illesztjük, hogy a MEDIÁNJA a becsült medián, a 85%-os pontja a felső becslés
 * legyen. Az esély: P(első busz érkezése + séta + minimális átszállás ≤ második indulása).
 */

/** a korai oldal szélessége a késés felőlihez képest */
const RHO = 0.5;
/** legalább ekkora a bizonytalanság (mp) */
export const MIN_SIGMA_S = 20;
/** ha nincs felső becslés: ennyivel lehet később 85%-ban (mp) */
export const DEFAULT_UPPER_S = 120;
/** ennyi kell legalább az átszálláshoz (le-, felszállás) */
export const MIN_TRANSFER_S = 30;

/** Standard normális eloszlásfüggvény (Abramowitz–Stegun 7.1.26, |hiba| < 1,5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** A standard normális inverze (Acklam-féle közelítés, relatív hiba < 1,2e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.928510446969, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// A medián és a 85%-os pont helye a késés felőli oldalon (z-értékben), RHO-ból.
const Z_MED = normInv((1.5 - 0.5 * RHO) / 2);
const Z_85 = normInv((1.85 - 0.15 * RHO) / 2);

/** Egy busz idejének eloszlása: csúcs (`mode`), korai (`lo`) és késő (`hi`) szórás (mp). */
export type TimeSpread = { mode: number; lo: number; hi: number };

/** Eloszlás a medián és a 85%-os felső becslés alapján (unix vagy bármilyen mp-skála). */
export function spreadOf(median: number, upper?: number | null): TimeSpread {
  const up = upper != null && Number.isFinite(upper) ? Math.max(upper, median) : median + DEFAULT_UPPER_S;
  const hi = Math.max(MIN_SIGMA_S, (up - median) / (Z_85 - Z_MED));
  return { mode: median - Z_MED * hi, lo: RHO * hi, hi };
}

/** Az eloszlásfüggvény: P(idő ≤ x). */
export function spreadCdf(s: TimeSpread, x: number): number {
  const w = s.lo + s.hi;
  if (x < s.mode) return ((2 * s.lo) / w) * normCdf((x - s.mode) / s.lo);
  return (s.lo + s.hi * (2 * normCdf((x - s.mode) / s.hi) - 1)) / w;
}

/** Egy kvantilis helye (pl. 0,5 → medián) — ellenőrzéshez és a kiírásokhoz. */
export function spreadQuantile(s: TimeSpread, p: number): number {
  const w = s.lo + s.hi;
  const atMode = s.lo / w;
  if (p < atMode) return s.mode + s.lo * normInv((p * w) / (2 * s.lo));
  return s.mode + s.hi * normInv((p * w - s.lo) / (2 * s.hi) + 0.5);
}

const STEPS = 400;

/**
 * Elérem-e a második buszt: P(érkezés + séta + `MIN_TRANSFER_S` ≤ indulás).
 * Az első busz eloszlásán numerikusan integrálunk (determinisztikus).
 */
export function transferChance(arrive: TimeSpread, depart: TimeSpread, walkS: number, minS = MIN_TRANSFER_S): number {
  const need = walkS + minS;
  const from = arrive.mode - 6 * arrive.lo;
  const to = arrive.mode + 6 * arrive.hi;
  const step = (to - from) / STEPS;
  let p = 0;
  let prev = spreadCdf(arrive, from);
  for (let i = 1; i <= STEPS; i++) {
    const x = from + i * step;
    const cur = spreadCdf(arrive, x);
    const mid = x - step / 2;
    p += (cur - prev) * (1 - spreadCdf(depart, mid + need));
    prev = cur;
  }
  return Math.min(1, Math.max(0, p));
}

/** Szöveges besorolás (a felület színeihez). */
export function chanceLevel(p: number): "safe" | "tight" | "risky" {
  return p >= 0.85 ? "safe" : p >= 0.5 ? "tight" : "risky";
}
