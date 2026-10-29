/**
 * Élőben „valószínűleg kimaradt” menetek — csak akkor szólunk, ha tényleg baj van:
 *
 *  - az „igény esetén” közlekedő menet kérés nélkül el sem indul → soha nem riaszt
 *  - a vonal szomszédos meneteit (±75 perc) látjuk → a követés működik, a hiány valódi
 *  - nincs úton olyan késő busz, ami épp ennek a menetnek az induló végállomására
 *    tart: az fogja vinni, csak késik — ez késés, nem kimaradás
 */
import { fastDistM } from "./geo.ts";

export const MISSING = {
  /** ennyi perce esedékes menetnél kezdünk gyanakodni */
  MIN_LATE_S: 15 * 60,
  /** ennél régebbi esedékességet már nem mutatunk élőben (a lezárt nap elemzése viszi) */
  MAX_LATE_S: 90 * 60,
  NEIGHBOUR_WINDOW_S: 75 * 60,
  MIN_NEIGHBOURS: 2,
  /** a beérkező busz végállomása ennyire lehet a menet első megállójától */
  TURNAROUND_M: 500,
  /** a beérkező menet menetrend szerinti érkezése ennyivel az indulás előtt / után */
  TURNAROUND_BEFORE_S: 30 * 60,
  TURNAROUND_AFTER_S: 5 * 60,
} as const;

const ON_DEMAND_RE = /ig[eé]ny/i;

/** „igény esetén” közlekedő menet (az MVK a célállomás-feliratba írja). */
export function isOnDemandTrip(headsign: string): boolean {
  return ON_DEMAND_RE.test(headsign);
}

export type MissingCandidate = {
  tripId: string;
  route: string;
  headsign: string;
  /** menetrend szerinti indulás, a szolgáltatási nap kezdetétől (mp) */
  depS: number;
  fromLat: number;
  fromLon: number;
};

export type MissingRun = {
  route: string;
  schedStartS: number;
  schedEndS: number;
  running: boolean;
  /** a menet utolsó megállója (csak futó menetnél kell) */
  toLat: number | null;
  toLon: number | null;
};

export type MissingTrip = { tripId: string; route: string; headsign: string; depS: number; lateMin: number };

/** `nowS`: a szolgáltatási nap kezdetétől eltelt másodperc. */
export function findMissingTrips(candidates: MissingCandidate[], runs: MissingRun[], nowS: number): MissingTrip[] {
  const startsByRoute = new Map<string, number[]>();
  for (const r of runs) startsByRoute.set(r.route, [...(startsByRoute.get(r.route) ?? []), r.schedStartS]);
  const inbound = runs.filter((r) => r.running && r.toLat != null && r.toLon != null);

  const out: MissingTrip[] = [];
  for (const c of candidates) {
    const late = nowS - c.depS;
    if (late < MISSING.MIN_LATE_S || late > MISSING.MAX_LATE_S || isOnDemandTrip(c.headsign)) continue;
    const near = (startsByRoute.get(c.route) ?? []).filter((s) => Math.abs(s - c.depS) <= MISSING.NEIGHBOUR_WINDOW_S).length;
    if (near < MISSING.MIN_NEIGHBOURS) continue;
    const busOnItsWay = inbound.some(
      (r) =>
        r.schedEndS >= c.depS - MISSING.TURNAROUND_BEFORE_S &&
        r.schedEndS <= c.depS + MISSING.TURNAROUND_AFTER_S &&
        fastDistM(r.toLat!, r.toLon!, c.fromLat, c.fromLon) <= MISSING.TURNAROUND_M,
    );
    if (busOnItsWay) continue;
    out.push({ tripId: c.tripId, route: c.route, headsign: c.headsign, depS: c.depS, lateMin: Math.round(late / 60) });
  }
  return out.sort((a, b) => a.depS - b.depS);
}
