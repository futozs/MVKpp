/**
 * Késve induló / kimaradó menet előrejelzése, MIELŐTT az MVK kihúzná.
 *
 * Egy menetet az a busz viszi, amelyik az előző menetét befejezte (a fordában
 * egymás után). Ha ez a busz még úton van, és az előző menete várhatóan a mi
 * indulásunk után ér be, a mi menetünk sem indulhat időben: legkorábban a
 * beérkezés + egy rövid fordulóidő (+ ha másik végállomáson áll, az átállás) után.
 */

export const START_RISK = {
  /** ennyi idő kell a végállomáson a következő indulásig (mp) */
  LAYOVER_S: 60,
  /** átállás másik végállomásra: ennyi m/s-mal (üresen, városban) */
  DEADHEAD_MPS: 7,
  /** ennél kisebb késést nem jelzünk (mp) */
  MIN_DELAY_S: 120,
  /** ennél nagyobbnál „valószínűleg kimarad” (mp) */
  LIKELY_MISSED_S: 15 * 60,
} as const;

export type StartRiskLevel = "late" | "likely-missed";

export type StartRisk = {
  /** a busz, amelyik a menetet várhatóan viszi */
  vehicleId: string;
  /** várhatóan ennyivel indul később (mp) */
  expectedDelayS: number;
  level: StartRiskLevel;
  /** az előző menete (amin most van) */
  prevRoute: string | null;
  /** mikor ér be az előző menetéről (unix) */
  prevEndUnix: number;
  /** a rendszám csak jóslás (nem az MVK osztotta ki) */
  predicted: boolean;
};

export function startRiskOf(input: {
  vehicleId: string;
  /** a mi menetünk menetrendi indulása (unix) */
  schedStartUnix: number;
  /** a busz előző menetének várható beérkezése (unix) */
  prevEndUnix: number;
  /** az előző menet végállomása és a mi kiinduló megállónk távolsága (m) */
  deadheadM: number;
  prevRoute?: string | null;
  predicted?: boolean;
}): StartRisk | null {
  const deadheadS = input.deadheadM > 400 ? input.deadheadM / START_RISK.DEADHEAD_MPS : 0;
  const ready = input.prevEndUnix + START_RISK.LAYOVER_S + deadheadS;
  const delay = Math.round(ready - input.schedStartUnix);
  if (delay < START_RISK.MIN_DELAY_S) return null;
  return {
    vehicleId: input.vehicleId,
    expectedDelayS: delay,
    level: delay >= START_RISK.LIKELY_MISSED_S ? "likely-missed" : "late",
    prevRoute: input.prevRoute ?? null,
    prevEndUnix: Math.round(input.prevEndUnix),
    predicted: Boolean(input.predicted),
  };
}
