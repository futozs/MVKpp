/**
 * Utólag rögzített utazás: a menetrendből választott menet.
 *
 * Az utas naptári napban és faliórában gondolkodik („ma 0:05-kor jöttem a
 * 36-ossal”), a menetrend viszont szolgáltatási napokban: az éjfél utáni
 * menetek az előző nap végén futnak (24:xx). Egy naptári nap menetei ezért a
 * saját szolgáltatási napjának éjfél előtti, és az előző nap éjfél utáni menetei.
 */
import type { ServiceDay } from "./gtfs/service.ts";
import { compareRouteShort } from "./timetable.ts";
import { endsAtLoop, terminusKind, type TerminusKind } from "./loops.ts";
import { localMidnightUnix } from "./time.ts";
import { isMvkId } from "./transit/modes.ts";

const DAY_S = 86_400;
/** a végállomáson ennyivel korábban induló menet is lehet a folytatás (a busz késve ért be, vagy korán indul) */
const NEXT_EARLY_S = 5 * 60;
/** ennyi időn belül induló menetek jöhetnek szóba folytatásként a végállomásról */
export const NEXT_WINDOW_S = 45 * 60;
const MAX_NEXT = 8;

export type PastRoute = { short: string; long: string; color: string; text: string };

export type PastTrip = {
  tripId: string;
  /** a menet szolgáltatási napja (ez kell a menet adataihoz) */
  serviceDate: string;
  route: string;
  color: string;
  text: string;
  headsign: string;
  /** menetrend szerinti indulás az első megállóból és érkezés az utolsóba (unix) */
  depTs: number;
  endTs: number;
  originName: string;
  destinationName: string;
  /** a végállomás fordulóhurok: ülve maradva a következő menettel tovább lehet utazni */
  loopEnd: boolean;
};

type Part = { day: ServiceDay; keep: (depS: number) => boolean };

/** A naptári nap részei: a nap éjfél előtti, és az előző szolgáltatási nap éjfél utáni menetei. */
function partsOf(day: ServiceDay | null, prev: ServiceDay | null): Part[] {
  const out: Part[] = [];
  if (prev) out.push({ day: prev, keep: (s) => s >= DAY_S });
  if (day) out.push({ day, keep: (s) => s < DAY_S });
  return out;
}

function pastTrip(day: ServiceDay, tripId: string): PastTrip | null {
  const { feed } = day;
  const t = feed.trips.get(tripId);
  const st = feed.tripStops.get(tripId);
  if (!t || !st || st.length < 2) return null;
  const route = feed.routes.get(t.routeId);
  const midnight = localMidnightUnix(day.iso);
  const first = st[0];
  const last = st[st.length - 1];
  return {
    tripId,
    serviceDate: day.iso,
    route: route?.short ?? t.routeId,
    color: route?.color ?? "1FB574",
    text: route?.text ?? "FFFFFF",
    headsign: t.headsign || feed.stops.get(last.stopId)?.name || "",
    depTs: midnight + first.dep,
    endTs: midnight + last.arr,
    originName: feed.stops.get(first.stopId)?.name ?? first.stopId,
    destinationName: feed.stops.get(last.stopId)?.name ?? last.stopId,
    loopEnd: endsAtLoop(feed, tripId),
  };
}

/** Az MVK vonalai, amelyeken a naptári napon indult menet. */
export function calendarRoutes(day: ServiceDay | null, prev: ServiceDay | null): PastRoute[] {
  const out = new Map<string, PastRoute>();
  for (const { day: d, keep } of partsOf(day, prev)) {
    for (const t of d.feed.trips.values()) {
      if (!isMvkId(t.routeId) || !d.services.has(t.serviceId)) continue;
      const route = d.feed.routes.get(t.routeId);
      if (!route || out.has(route.short)) continue;
      const first = d.feed.tripStops.get(t.id)?.[0];
      if (first && keep(first.dep)) out.set(route.short, { short: route.short, long: route.long, color: route.color, text: route.text });
    }
  }
  return [...out.values()].sort((a, b) => compareRouteShort(a.short, b.short));
}

/** Egy MVK-vonal naptári napon induló menetei, indulás szerint. */
export function calendarTrips(day: ServiceDay | null, prev: ServiceDay | null, routeShort: string): PastTrip[] {
  const out: PastTrip[] = [];
  for (const { day: d, keep } of partsOf(day, prev)) {
    for (const t of d.feed.trips.values()) {
      if (!isMvkId(t.routeId) || !d.services.has(t.serviceId)) continue;
      if (d.feed.routes.get(t.routeId)?.short !== routeShort) continue;
      const first = d.feed.tripStops.get(t.id)?.[0];
      if (!first || !keep(first.dep)) continue;
      const p = pastTrip(d, t.id);
      if (p) out.push(p);
    }
  }
  return out.sort((a, b) => a.depTs - b.depTs || a.route.localeCompare(b.route));
}

export type NextLegChoice = PastTrip & { kind: TerminusKind };

/**
 * Körbeutazás utólag: a menet végállomásáról (ugyanabból vagy a szomszédos
 * kocsiállásból) a beérkezés körül induló menetek, indulás szerint  ezek
 * közül folytatta a busz. Melyiket, azt a jármű menetei döntik el (ha ismertek).
 */
export function nextLegChoices(day: ServiceDay, tripId: string, windowS = NEXT_WINDOW_S): NextLegChoice[] {
  const { feed } = day;
  const st = feed.tripStops.get(tripId);
  if (!st?.length) return [];
  const end = st[st.length - 1];
  const out: NextLegChoice[] = [];
  for (const t of feed.trips.values()) {
    if (t.id === tripId || !day.services.has(t.serviceId)) continue;
    const first = feed.tripStops.get(t.id)?.[0];
    if (!first || first.dep < end.arr - NEXT_EARLY_S || first.dep > end.arr + windowS) continue;
    const kind = terminusKind(feed, end.stopId, first.stopId);
    if (!kind) continue;
    const p = pastTrip(day, t.id);
    if (p) out.push({ ...p, kind });
  }
  return out.sort((a, b) => a.depTs - b.depTs).slice(0, MAX_NEXT);
}
