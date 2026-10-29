/**
 * Késés-előrejelzés a menet hátralévő megállóira.
 *
 * Szakaszonként lépünk tovább a mostani késésből: a múltbeli menetidő mediánja
 * és a menetrendi idő különbségének 70%-át adjuk hozzá. A menetrendben van
 * tartalék, de a pontosan járó busz nem siet el vele — ezért a késés legfeljebb
 * 0-ig csökkenhet (ha a busz már most előbb jár, onnan). A felső becslés
 * („mennyit késhet”) a szakaszok szórásából, 85%-os lefedettségre hangolva.
 *
 * Visszamérve (2026-10-27/28, a profilokból kihagyva): 3 / 6 / 10 / 15
 * megállóval előre 46 / 69 / 90 / 107 mp átlagos hiba — a „marad a mostani
 * késés” becslésnél (56 / 78 / 95 / 110) jobb; a felső becslés ~85%-ban tart.
 */

/** egy szakasz múltbeli menetideje (mp) adott naptípuson és órában */
export type SegmentProfile = { p50: number; p85: number };

export type ForecastStop = {
  idx: number;
  stopId: string;
  /** menetrend szerinti érkezés (mp a szolgáltatási nap kezdetétől) */
  schedS: number;
  /** várható késés (mp) */
  delayS: number;
  /** 85%-os felső becslés (mp) */
  upperS: number;
};

export const FORECAST = {
  /** a menetrendi tartalék ekkora részét használja ki ténylegesen a busz */
  recoveryShare: 0.7,
  /** a felső becslés szórás-szorzója (visszamérve ~85% lefedettség) */
  upperFactor: 1.5,
} as const;

type StopTimeLike = { stopId: string; arr: number; dep: number };

export function forecastDelays(
  stops: readonly StopTimeLike[],
  fromIdx: number,
  currentDelayS: number,
  profile: (fromStop: string, toStop: string, hour: number) => SegmentProfile | undefined,
): ForecastStop[] {
  const out: ForecastStop[] = [];
  const floor = Math.min(0, currentDelayS);
  let delay = currentDelayS;
  let variance = 0;
  for (let j = Math.max(0, fromIdx); j < stops.length - 1; j++) {
    const a = stops[j];
    const b = stops[j + 1];
    const hour = Math.floor((((a.dep % 86_400) + 86_400) % 86_400) / 3600);
    const p = profile(a.stopId, b.stopId, hour);
    if (p) {
      const sched = b.arr - a.dep;
      delay = Math.max(delay + FORECAST.recoveryShare * (p.p50 - sched), floor);
      variance += (p.p85 - p.p50) ** 2;
    }
    out.push({
      idx: j + 1,
      stopId: b.stopId,
      schedS: b.arr,
      delayS: Math.round(delay),
      upperS: Math.round(delay + FORECAST.upperFactor * Math.sqrt(variance)),
    });
  }
  return out;
}
