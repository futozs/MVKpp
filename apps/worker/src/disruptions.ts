/**
 * A mai nap zavarai egy helyen, utasnak:
 *  · cancelled — az MVK hivatalosan törölte
 *  · missing   — most, 15–90 perce esedékes, egyetlen busz sem vitte (élő észlelés)
 *  · unseen    — korábban ma esedékes volt, és nem láttuk elindulni, pedig a
 *                vonal szomszédos meneteit követtük (nincs kihúzva)
 *
 * Menetenként a pótló indulás (ugyanaz a vonal és irány, ugyanonnan) és — ha
 * a kliens megadja a közelében lévő megállókat — hogy ott mikor állt volna meg.
 */
import { findMissingTrips, isOnDemandTrip, localMidnightUnix, MISSING, nowUnix, secToHm, type MissingCandidate, type MissingRun, type ServiceDay } from "@mvk/core";
import type { Engine } from "./engine.ts";
import type { VehiclePredictor } from "./predict.ts";

/** ugyanaz a nyomvonal ennyin belüli indulással — az MVK más azonosítóval vitte */
const SAME_PATTERN_S = 4 * 60;
/** a pótló indulást legfeljebb ennyi időn belül keressük */
const REPLACEMENT_WITHIN_S = 3 * 3600;

export type DisruptionKind = "cancelled" | "missing" | "unseen";

export type DisruptionTrip = {
  tripId: string;
  kind: DisruptionKind;
  routeId: string;
  route: string;
  color: string;
  text: string;
  dir: string;
  headsign: string;
  depS: number;
  depTime: string;
  arrTime: string;
  from: string;
  to: string;
  /** a következő, nem kimaradó indulás ugyanazon a vonalon és irányban, ugyanonnan */
  replacement: { tripId: string; depTime: string; gapMin: number } | null;
  /** a kliens közelében lévő megállók egyikén mikor állt volna meg */
  near: { stopId: string; name: string; time: string; timeS: number } | null;
  /** a menet (vagy a közeli megállónál az áthaladása) még előttünk van */
  upcoming: boolean;
  /** a forda-terv szerint melyik busz vitte volna */
  plannedVehicle: string | null;
};

/** Az élő „valószínűleg kimaradó” menetek (a fejléc jelvénye és az Üzemzavarok kártya). */
export function liveMissing(engine: Engine, day: ServiceDay, now: number) {
  if (!engine.poll.lastOkAt || Date.now() - engine.poll.lastOkAt >= 120_000) return [];
  const nowS = now - localMidnightUnix(engine.today);
  const candidates: MissingCandidate[] = [];
  for (const t of day.feed.trips.values()) {
    if (!day.services.has(t.serviceId) || engine.todayRuns.has(t.id) || engine.cancelled.ids.has(t.id)) continue;
    const st = day.feed.tripStops.get(t.id);
    const from = st?.length ? day.feed.stops.get(st[0].stopId) : undefined;
    if (!st || !from || nowS - st[0].dep < MISSING.MIN_LATE_S || nowS - st[0].dep > MISSING.MAX_LATE_S) continue;
    const route = day.feed.routes.get(t.routeId)?.short ?? t.routeId;
    candidates.push({ tripId: t.id, route, headsign: t.headsign, depS: st[0].dep, fromLat: from.lat, fromLon: from.lon });
  }
  return findMissingTrips(candidates, missingRuns(engine, day), nowS);
}

function missingRuns(engine: Engine, day: ServiceDay): MissingRun[] {
  const runs: MissingRun[] = [];
  for (const run of engine.todayRuns.values()) {
    if (run.status === "aborted") continue;
    const running = run.status === "running";
    const st = running ? day.feed.tripStops.get(run.tripId) : undefined;
    const to = st?.length ? day.feed.stops.get(st[st.length - 1].stopId) : undefined;
    runs.push({ route: run.routeShort, schedStartS: run.schedStartS, schedEndS: run.schedEndS, running, toLat: to?.lat ?? null, toLon: to?.lon ?? null });
  }
  return runs;
}

export function disruptions(engine: Engine, predictor: VehiclePredictor, day: ServiceDay, nearStopIds: string[]) {
  const feed = day.feed;
  const now = nowUnix();
  const midnight = localMidnightUnix(engine.today);
  const nowS = now - midnight;
  const near = new Set(nearStopIds.filter((id) => feed.stops.has(id)));

  const kinds = new Map<string, DisruptionKind>();
  for (const id of engine.cancelled.ids) if (feed.trips.has(id)) kinds.set(id, "cancelled");
  for (const m of liveMissing(engine, day, now)) if (!kinds.has(m.tripId)) kinds.set(m.tripId, "missing");

  // Korábban ma: nem láttuk elindulni, pedig a vonal szomszédos meneteit igen.
  const ran = new Set<string>();
  const startsByRoute = new Map<string, number[]>();
  for (const run of engine.todayRuns.values()) {
    if (run.status === "aborted") continue;
    const shape = feed.trips.get(run.tripId)?.shapeId ?? "";
    ran.add(`${shape}|${Math.round(run.schedStartS / SAME_PATTERN_S)}`);
    startsByRoute.set(run.routeShort, [...(startsByRoute.get(run.routeShort) ?? []), run.schedStartS]);
  }
  const ranLike = (shape: string, depS: number) => {
    const b = Math.round(depS / SAME_PATTERN_S);
    return ran.has(`${shape}|${b}`) || ran.has(`${shape}|${b - 1}`) || ran.has(`${shape}|${b + 1}`);
  };
  if (engine.poll.lastOkAt) {
    for (const t of feed.trips.values()) {
      if (kinds.has(t.id) || !day.services.has(t.serviceId) || engine.todayRuns.has(t.id) || isOnDemandTrip(t.headsign)) continue;
      const st = feed.tripStops.get(t.id);
      if (!st?.length) continue;
      const dep = st[0].dep;
      if (nowS - dep <= MISSING.MAX_LATE_S || dep < 3 * 3600) continue; // az élő ablakot a missing viszi
      if (ranLike(t.shapeId, dep)) continue;
      const route = feed.routes.get(t.routeId)?.short ?? t.routeId;
      // Előtte ÉS utána is láttunk menetet a vonalon: a követés működött, a hiány valódi
      // (a hajnali első menetek, vagy egy kieső adatszakasz így nem riaszt).
      const starts = startsByRoute.get(route) ?? [];
      const before = starts.some((s) => s < dep && dep - s <= MISSING.NEIGHBOUR_WINDOW_S);
      const after = starts.some((s) => s > dep && s - dep <= MISSING.NEIGHBOUR_WINDOW_S);
      if (before && after) kinds.set(t.id, "unseen");
    }
  }

  // Pótló indulás: ugyanazon a vonalon, irányban, ugyanabból a megállóból a következő, ami nem esik ki.
  const departures = new Map<string, { tripId: string; dep: number }[]>();
  for (const t of feed.trips.values()) {
    if (!day.services.has(t.serviceId)) continue;
    const st = feed.tripStops.get(t.id);
    if (!st?.length) continue;
    const key = `${t.routeId}|${t.dir}|${st[0].stopId}`;
    const list = departures.get(key) ?? [];
    list.push({ tripId: t.id, dep: st[0].dep });
    departures.set(key, list);
  }
  for (const list of departures.values()) list.sort((a, b) => a.dep - b.dep);

  const plan = predictor.planSnapshot();
  const trips: DisruptionTrip[] = [];
  for (const [tripId, kind] of kinds) {
    const t = feed.trips.get(tripId)!;
    const st = feed.tripStops.get(tripId);
    if (!st?.length) continue;
    const r = feed.routes.get(t.routeId);
    const dep = st[0].dep;
    const list = departures.get(`${t.routeId}|${t.dir}|${st[0].stopId}`) ?? [];
    const repl = list.find((x) => x.dep > dep && x.dep - dep <= REPLACEMENT_WITHIN_S && !kinds.has(x.tripId));
    const hit = near.size ? st.find((s) => near.has(s.stopId)) : undefined;
    const atS = hit?.dep ?? dep;
    trips.push({
      tripId,
      kind,
      routeId: t.routeId,
      route: r?.short ?? t.routeId,
      color: r?.color ?? "888888",
      text: r?.text ?? "FFFFFF",
      dir: t.dir,
      headsign: t.headsign,
      depS: dep,
      depTime: secToHm(dep),
      arrTime: secToHm(st[st.length - 1].arr),
      from: feed.stops.get(st[0].stopId)?.name ?? st[0].stopId,
      to: feed.stops.get(st[st.length - 1].stopId)?.name ?? st[st.length - 1].stopId,
      replacement: repl ? { tripId: repl.tripId, depTime: secToHm(repl.dep), gapMin: Math.round((repl.dep - dep) / 60) } : null,
      near: hit ? { stopId: hit.stopId, name: feed.stops.get(hit.stopId)?.name ?? hit.stopId, time: secToHm(hit.dep), timeS: hit.dep } : null,
      upcoming: atS > nowS,
      plannedVehicle: plan?.byTrip.get(tripId)?.vehicle ?? null,
    });
  }
  trips.sort((a, b) => a.depS - b.depS);

  const byHour = new Map<number, { h: number; cancelled: number; missing: number; unseen: number }>();
  for (const t of trips) {
    const h = Math.floor(t.depS / 3600);
    const row = byHour.get(h) ?? { h, cancelled: 0, missing: 0, unseen: 0 };
    row[t.kind]++;
    byHour.set(h, row);
  }
  const count = (k: DisruptionKind) => trips.filter((t) => t.kind === k).length;
  return {
    date: engine.today,
    nowS,
    stale: engine.cancelled.stale,
    counts: { cancelled: count("cancelled"), missing: count("missing"), unseen: count("unseen"), routes: new Set(trips.map((t) => t.route)).size },
    nearStops: [...near].map((id) => ({ id, name: feed.stops.get(id)?.name ?? id })),
    byHour: [...byHour.values()].sort((a, b) => a.h - b.h),
    trips,
  };
}
