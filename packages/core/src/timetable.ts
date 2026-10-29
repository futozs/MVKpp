/** Menetrendkönyv: vonal × irány táblázat egy napra — a régi formátumban (az iOS app is ezt olvassa). */
import type { ServiceDay } from "./gtfs/service.ts";
import type { Route, Trip } from "./gtfs/feed.ts";
import { secToHm } from "./time.ts";

export type TimetableTripRow = {
  tripId: string;
  headsign: string;
  departure: string;
  departureSec: number;
  arrival: string;
  arrivalSec: number;
  originName: string;
  destinationName: string;
  stopCount: number;
  deviates: boolean;
  headsignDiffers: boolean;
  times: (string | null)[];
};

export type TimetableTable = {
  route: Route;
  dir: string;
  date: string;
  headsign: string;
  stops: { id: string; code: string; name: string; lat: number | null; lon: number | null }[];
  trips: TimetableTripRow[];
  note?: string;
};

export type TimetableRouteRow = {
  id: string;
  short: string;
  long: string;
  type: string;
  color: string;
  text: string;
  directions: { dir: string; headsign: string; tripsToday: number; tripsTotal: number; firstDeparture: string | null }[];
};

export type DaySchedule = {
  date: string;
  feedVersion: string;
  routes: TimetableRouteRow[];
  tables: Record<string, TimetableTable>;
};

function tripsOfRouteDir(day: ServiceDay, routeId: string, dir: string) {
  const { feed, services } = day;
  const out: { tripId: string; trip: Trip; stopsOfTrip: { stopId: string; dep: number }[] }[] = [];
  for (const t of feed.trips.values()) {
    if (t.routeId !== routeId || t.dir !== dir || !services.has(t.serviceId)) continue;
    const stopsOfTrip = feed.tripStops.get(t.id);
    if (!stopsOfTrip?.length) continue;
    out.push({ tripId: t.id, trip: t, stopsOfTrip });
  }
  out.sort((a, b) => a.stopsOfTrip[0].dep - b.stopsOfTrip[0].dep);
  return out;
}

export function compareRouteShort(a: string, b: string): number {
  const na = Number.parseInt(a, 10);
  const nb = Number.parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb || a.localeCompare(b, "hu");
  if (!Number.isNaN(na)) return -1;
  if (!Number.isNaN(nb)) return 1;
  return a.localeCompare(b, "hu");
}

export function buildRouteIndex(day: ServiceDay): TimetableRouteRow[] {
  const { feed, services } = day;
  type DirAgg = { headsigns: Map<string, number>; today: number; total: number; firstDep: number | null };
  const byRoute = new Map<string, Map<string, DirAgg>>();

  for (const t of feed.trips.values()) {
    if (!feed.routes.has(t.routeId)) continue;
    let dirs = byRoute.get(t.routeId);
    if (!dirs) byRoute.set(t.routeId, (dirs = new Map()));
    let agg = dirs.get(t.dir);
    if (!agg) dirs.set(t.dir, (agg = { headsigns: new Map(), today: 0, total: 0, firstDep: null }));
    agg.total++;
    if (t.headsign) agg.headsigns.set(t.headsign, (agg.headsigns.get(t.headsign) || 0) + 1);
    if (services.has(t.serviceId)) {
      agg.today++;
      const dep = feed.tripStops.get(t.id)?.[0]?.dep;
      if (dep != null && (agg.firstDep == null || dep < agg.firstDep)) agg.firstDep = dep;
    }
  }

  const out = [...byRoute.entries()].map(([routeId, dirs]) => {
    const r = feed.routes.get(routeId)!;
    const directions = [...dirs.entries()]
      .map(([dir, agg]) => {
        let headsign = "";
        let best = -1;
        for (const [h, n] of agg.headsigns)
          if (n > best) {
            best = n;
            headsign = h;
          }
        return {
          dir,
          headsign,
          tripsToday: agg.today,
          tripsTotal: agg.total,
          firstDeparture: agg.firstDep == null ? null : secToHm(agg.firstDep),
        };
      })
      .sort((a, b) => a.dir.localeCompare(b.dir));
    return { id: r.id, short: r.short, long: r.long, type: r.type, color: r.color, text: r.text, directions };
  });
  out.sort((a, b) => compareRouteShort(a.short, b.short));
  return out;
}

export function buildTable(day: ServiceDay, routeId: string, dir: string): TimetableTable | null {
  const { feed } = day;
  const route = feed.routes.get(routeId);
  if (!route) return null;
  const list = tripsOfRouteDir(day, routeId, dir);
  if (!list.length) {
    return { route, dir, date: day.ymd, headsign: "", stops: [], trips: [], note: "Ezen a napon nem közlekedik." };
  }

  const longest = list.reduce((a, b) => (b.stopsOfTrip.length > a.stopsOfTrip.length ? b : a), list[0]);
  const stopOrder = longest.stopsOfTrip.map((x) => x.stopId);
  const indexOfStop = new Map(stopOrder.map((id, i) => [id, i]));
  const stopList = stopOrder.map((id) => {
    const s = feed.stops.get(id);
    return { id, code: s?.code || "", name: s?.name || id, lat: s?.lat ?? null, lon: s?.lon ?? null };
  });

  const counts = new Map<string, number>();
  for (const x of list) if (x.trip.headsign) counts.set(x.trip.headsign, (counts.get(x.trip.headsign) || 0) + 1);
  let headsign = "";
  let best = -1;
  for (const [h, n] of counts)
    if (n > best) {
      best = n;
      headsign = h;
    }

  const trips: TimetableTripRow[] = list.map((x) => {
    const times: (string | null)[] = new Array(stopOrder.length).fill(null);
    let extra = 0;
    for (const st of x.stopsOfTrip) {
      const i = indexOfStop.get(st.stopId);
      if (i == null) {
        extra++;
        continue;
      }
      if (times[i] == null) times[i] = secToHm(st.dep);
    }
    const first = x.stopsOfTrip[0];
    const last = x.stopsOfTrip[x.stopsOfTrip.length - 1];
    const tripHeadsign = x.trip.headsign || headsign;
    return {
      tripId: x.tripId,
      headsign: tripHeadsign,
      departure: secToHm(first.dep),
      departureSec: first.dep,
      arrival: secToHm(last.dep),
      arrivalSec: last.dep,
      originName: feed.stops.get(first.stopId)?.name || first.stopId,
      destinationName: feed.stops.get(last.stopId)?.name || last.stopId,
      stopCount: x.stopsOfTrip.length,
      deviates: extra > 0,
      headsignDiffers: headsign.length > 0 && tripHeadsign !== headsign,
      times,
    };
  });
  return { route, dir, date: day.ymd, headsign, stops: stopList, trips };
}

export function buildDaySchedule(day: ServiceDay): DaySchedule {
  const routes = buildRouteIndex(day);
  const tables: Record<string, TimetableTable> = {};
  for (const r of routes) {
    for (const d of r.directions) {
      if (d.tripsToday === 0) continue;
      const table = buildTable(day, r.id, d.dir);
      if (table?.trips.length) tables[`${r.id}|${d.dir}`] = table;
    }
  }
  return { date: day.ymd, feedVersion: day.feed.version, routes, tables };
}
