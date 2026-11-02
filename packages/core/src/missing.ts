/**
 * Élőben „valószínűleg kimaradt” menetek — csak akkor szólunk, ha tényleg baj van:
 *
 *  - az „igény esetén” közlekedő menet kérés nélkül el sem indul → soha nem riaszt
 *  - a vonal szomszédos meneteit (±75 perc) látjuk → a követés működik, a hiány valódi
 *  - nincs úton olyan késő busz, ami épp ennek a menetnek az induló végállomására
 *    tart: az fogja vinni, csak késik — ez késés, nem kimaradás
 *  - a hiányzó adat nem kimaradás (`quietTripIds`): a garázsból kiálló menet alatt az
 *    OBU gyakran még néma, és ha a busz a menet végállomásán pontosan érkezésre
 *    feltűnik, a menetet levitte, csak nem küldött róla adatot
 */
import { fastDistM } from "./geo.ts";
import type { ServiceDay } from "./gtfs/service.ts";
import { isMvkId } from "./transit/modes.ts";

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

/**
 * Egy menet a mai menetrendből: honnan, mikor, hová. A `serviceId` az MVK-nál a
 * forda-csoport (a menetazonosító eleje): egy busz napi menetei ugyanabba esnek,
 * de egy csoportban több busz is lehet.
 */
export type ScheduledLeg = {
  tripId: string;
  serviceId: string;
  depS: number;
  arrS: number;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
};

export type SeenLeg = ScheduledLeg & { vehicleId: string };

export const QUIET = {
  /** a következő menet menetrend szerint ennyivel az érkezés előtt is indulhat */
  SLACK_S: 2 * 60,
  /** a végállomási állás leghosszabb ideje (ennél hosszabb szünet után a busz „új napot kezd”) */
  LAYOVER_S: MISSING.TURNAROUND_BEFORE_S,
} as const;

/** A mai menetrend MVK-menetei (legalább két megállóval). */
export function scheduledLegs(day: ServiceDay): Map<string, ScheduledLeg> {
  const legs = new Map<string, ScheduledLeg>();
  for (const t of day.feed.trips.values()) {
    if (!isMvkId(t.id) || !day.services.has(t.serviceId)) continue;
    const st = day.feed.tripStops.get(t.id);
    const from = st?.length ? day.feed.stops.get(st[0].stopId) : undefined;
    const to = st && st.length > 1 ? day.feed.stops.get(st[st.length - 1].stopId) : undefined;
    if (!st || !from || !to) continue;
    legs.set(t.id, { tripId: t.id, serviceId: t.serviceId, depS: st[0].dep, arrS: st[st.length - 1].arr, fromLat: from.lat, fromLon: from.lon, toLat: to.lat, toLon: to.lon });
  }
  return legs;
}

/**
 * Garázsmenet (vagy hosszú állás utáni első menet): a csoport egyetlen menete sem
 * érkezik az induló megállójába nem sokkal előtte, a busz tehát láthatatlanul jön.
 * Ilyenkor nincs mihez mérni: a hiányzó adat nem bizonyítja, hogy kimaradt.
 */
export function isPullOut(leg: ScheduledLeg, sameService: readonly ScheduledLeg[]): boolean {
  return !sameService.some(
    (p) =>
      p.tripId !== leg.tripId &&
      p.serviceId === leg.serviceId &&
      p.arrS <= leg.depS + QUIET.SLACK_S &&
      p.arrS >= leg.depS - QUIET.LAYOVER_S &&
      fastDistM(p.toLat, p.toLon, leg.fromLat, leg.fromLon) <= MISSING.TURNAROUND_M,
  );
}

/**
 * A kimaradtnak látszó menetek közül azok, amelyeket egy busz adat nélkül levitt:
 * ugyanannak a csoportnak egy látott menete a végállomásukról indul az érkezésükre,
 * és a busza közben nem volt máshol. A legkésőbbitől visszafelé haladunk, így a
 * néma menetek lánca is visszakövethető; egy jelentkezés csak egy menetet igazol.
 * → tripId → járműazonosító
 */
export function silentRuns(flagged: readonly ScheduledLeg[], seen: readonly SeenLeg[]): Map<string, string> {
  const evidence: SeenLeg[] = [...seen];
  const used = new Set<SeenLeg>();
  const busyByVehicle = new Map<string, ScheduledLeg[]>();
  for (const s of seen) busyByVehicle.set(s.vehicleId, [...(busyByVehicle.get(s.vehicleId) ?? []), s]);

  const out = new Map<string, string>();
  for (const x of [...flagged].sort((a, b) => b.depS - a.depS)) {
    const free = (vehicleId: string) =>
      !(busyByVehicle.get(vehicleId) ?? []).some((o) => o.depS < x.arrS - QUIET.SLACK_S && o.arrS > x.depS + QUIET.SLACK_S);
    let best: SeenLeg | null = null;
    for (const e of evidence) {
      if (used.has(e) || e.serviceId !== x.serviceId) continue;
      if (e.depS < x.arrS - QUIET.SLACK_S || e.depS > x.arrS + QUIET.LAYOVER_S) continue;
      if (fastDistM(e.fromLat, e.fromLon, x.toLat, x.toLon) > MISSING.TURNAROUND_M || !free(e.vehicleId)) continue;
      if (!best || Math.abs(e.depS - x.arrS) < Math.abs(best.depS - x.arrS)) best = e;
    }
    if (!best) continue;
    used.add(best);
    out.set(x.tripId, best.vehicleId);
    // a most igazolt menet maga is jelentkezésnek számít az előtte lévő néma menetre
    const credited: SeenLeg = { ...x, vehicleId: best.vehicleId };
    evidence.push(credited);
    busyByVehicle.set(best.vehicleId, [...(busyByVehicle.get(best.vehicleId) ?? []), credited]);
  }
  return out;
}

/**
 * A kimaradásgyanús menetek közül azok, amelyekről csak az adat hiányzik
 * (garázsmenet, vagy a busz adat nélkül levitte) — ezeket nem nevezzük kimaradtnak.
 * `seen`: a ma látott (nem félbehagyott) menetek és a buszuk.
 */
export function quietTripIds(flaggedIds: Iterable<string>, legs: ReadonlyMap<string, ScheduledLeg>, seen: readonly { tripId: string; vehicleId: string }[]): Set<string> {
  const byService = new Map<string, ScheduledLeg[]>();
  for (const l of legs.values()) byService.set(l.serviceId, [...(byService.get(l.serviceId) ?? []), l]);
  const flagged = [...new Set(flaggedIds)].flatMap((id) => legs.get(id) ?? []);
  const seenLegs = seen.flatMap((s) => {
    const l = legs.get(s.tripId);
    return l ? [{ ...l, vehicleId: s.vehicleId }] : [];
  });
  const quiet = new Set(flagged.filter((l) => isPullOut(l, byService.get(l.serviceId) ?? [])).map((l) => l.tripId));
  for (const id of silentRuns(flagged, seenLegs).keys()) quiet.add(id);
  return quiet;
}
