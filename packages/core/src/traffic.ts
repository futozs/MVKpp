/**
 * Élő forgalom a buszok menetidejéből: hol áll be az út most.
 *
 * Két jel szakaszonként (megállótól megállóig, a menetidőben a megállóban
 * állás nincs benne):
 *  · átért buszok: a legutóbbi néhány áthaladás menetideje a szokásoshoz
 *    (az adott naptípus és óra mediánjához) képest
 *  · bent ragadt busz: aki most halad a szakaszon, és már jóval tovább tart
 *    neki, mint szokott — így a dugó azonnal látszik, nem csak utólag
 *
 * Egyetlen lassú áthaladás nem elég (egy busz kerekesszékes utast vesz fel,
 * lámpát kap): ahhoz erősebb lassulás kell. A rövid szakaszok arányát a
 * minimális többletidő szűri (30 mp helyett 50 nem dugó).
 */

export const TRAFFIC = {
  /** ennél régebbi áthaladás már nem számít (mp) */
  WINDOW_S: 20 * 60,
  /** a legutóbbi ennyi áthaladás mediánja a szakasz mostani állapota */
  RECENT_N: 4,
  /** ennyiszer lassabb a szokásosnál, attól jelezzük */
  MIN_RATIO: 1.35,
  /** és legalább ennyi a többletidő (mp) */
  MIN_EXCESS_S: 40,
  /** egyetlen áthaladásból csak erősebb lassulást hiszünk el */
  SINGLE_MIN_RATIO: 1.7,
  SINGLE_MIN_EXCESS_S: 75,
  /** bent ragadt busz: legalább ennyivel tovább tart neki (mp) */
  STUCK_MIN_EXCESS_S: 90,
  /** ennél a lassulásnál a legsötétebb vörös */
  MAX_RATIO: 3,
} as const;

/** egy átért busz egy szakaszon */
export type TrafficObs = { endTs: number; travelS: number; typicalS: number };
/** egy most a szakaszon haladó busz: mióta van úton (mp) */
export type TrafficStuck = { elapsedS: number; typicalS: number };

export type SegmentCongestion = {
  /** hányszor lassabb a szokásosnál */
  ratio: number;
  /** többletidő a szakaszon (mp) */
  excessS: number;
  /** hány átért busz mérése */
  n: number;
  /** hány busz ragadt most bent */
  stuck: number;
  /** 0 (citrom, enyhe) … 1 (sötétvörös, teljesen beállt) */
  level: number;
  /** a legutóbbi mérés ideje (unix) */
  lastTs: number;
};

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Egy szakasz mostani torlódása, vagy `null`, ha nincs érdemi lassulás. */
export function segmentCongestion(obs: readonly TrafficObs[], stuck: readonly TrafficStuck[], now: number): SegmentCongestion | null {
  const recent = obs
    .filter((o) => o.typicalS > 0 && o.endTs <= now && now - o.endTs <= TRAFFIC.WINDOW_S)
    .sort((a, b) => b.endTs - a.endTs)
    .slice(0, TRAFFIC.RECENT_N);

  let ratio = 0;
  let excess = 0;
  if (recent.length >= 2) {
    ratio = median(recent.map((o) => o.travelS / o.typicalS));
    excess = median(recent.map((o) => o.travelS - o.typicalS));
  } else if (recent.length === 1) {
    const o = recent[0];
    const r = o.travelS / o.typicalS;
    if (r >= TRAFFIC.SINGLE_MIN_RATIO && o.travelS - o.typicalS >= TRAFFIC.SINGLE_MIN_EXCESS_S) {
      ratio = r;
      excess = o.travelS - o.typicalS;
    }
  }

  let stuckN = 0;
  for (const s of stuck) {
    if (s.typicalS <= 0) continue;
    const ex = s.elapsedS - s.typicalS;
    const r = s.elapsedS / s.typicalS;
    if (ex < TRAFFIC.STUCK_MIN_EXCESS_S || r < TRAFFIC.MIN_RATIO) continue;
    stuckN++;
    // A bent ragadt busz alsó becslés (még nem ért át) — ha lassabb, mint amit az átértek mutatnak, az a mostani állapot.
    if (r > ratio) {
      ratio = r;
      excess = ex;
    }
  }

  if (ratio < TRAFFIC.MIN_RATIO || excess < TRAFFIC.MIN_EXCESS_S) return null;
  const level = Math.min(1, Math.max(0, (ratio - TRAFFIC.MIN_RATIO) / (TRAFFIC.MAX_RATIO - TRAFFIC.MIN_RATIO)));
  return {
    ratio: Math.round(ratio * 100) / 100,
    excessS: Math.round(excess),
    n: recent.length,
    stuck: stuckN,
    level: Math.round(level * 100) / 100,
    lastTs: stuckN ? now : (recent[0]?.endTs ?? now),
  };
}
