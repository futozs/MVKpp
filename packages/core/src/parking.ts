/**
 * Parkoló: ki hol áll most, ha nincs bevetésen.
 *
 * Járművenként a mai menetekből, az utolsó GPS-jelből és a flotta múltjából:
 *  - service:  menetet visz (vagy menet nélkül úton van)
 *  - terminus: végállomáson áll  a menete ott ért véget, vagy élőben ott látszik,
 *              vagy az MVK már kiadta a következő menetét („indulásra vár")
 *  - depot:    kocsiszínben  G-járattal beállt, ma még nem volt kint, vagy
 *              1 órája néma (a buszok gyakran kikapcsolva mennek vissza)
 *  - nosignal: menet közben elnémult, még az 1 órás határon belül
 *
 * Tiszta függvény: minden bemenetet kívülről kap, így tesztelhető.
 */
import { fastDistM } from "./geo.ts";
import type { RunOut } from "./matcher.ts";

export type FleetKind = "bus" | "tram";

/** A flotta múltja járművenként (a mai nap nélkül). */
export type FleetVehicle = {
  id: string;
  kind: FleetKind;
  /** az utolsó nap, amikor menetet vitt (ISO), ha volt */
  lastDate: string | null;
  /** hány egymást követő napon volt kint tegnapig */
  streakDays: number;
  /** ezen a naptípuson a napok hányad részén volt kint (8 hét) */
  outShare: number | null;
  /** szokásos első indulása ezen a naptípuson (mp a nap kezdetétől) */
  usualOutS: number | null;
  /** az utolsó 14 nap, a legrégebbitől tegnapig: "1" kint volt, "0" nem */
  recent: string;
  topRoutes: string[];
};

export type LiveSeen = { ts: number; lat: number; lon: number; speed: number | null; route: string | null };
export type Place = { name: string; lat: number; lon: number };
export type TripEnds = { first: Place; last: Place };
export type TripTip = { tripId: string; route: string; startS: number; confidence: number; certain: boolean };

export type DepotReason = "pull-in" | "seen" | "timeout" | "not-today";
export type DepotId = FleetKind;

export type ParkedVehicle = {
  id: string;
  kind: FleetKind;
  /** mióta áll itt (unix), ha tudjuk */
  since: number | null;
  /** az utolsó jel (unix) */
  lastSeen: number | null;
  online: boolean;
  lastRoute: string | null;
  lastHeadsign: string | null;
  /** a beérkezéskori késés (mp) */
  arrivalDelayS: number | null;
  next: TripTip | null;
};

export type DepotVehicle = ParkedVehicle & {
  reason: DepotReason;
  outToday: boolean;
};

export type ServiceVehicle = {
  id: string;
  kind: FleetKind;
  route: string | null;
  headsign: string | null;
  tripId: string | null;
  delayS: number | null;
  /** menet nélkül úton (átállás, garázsmenet) */
  deadhead: boolean;
};

export type KindCounts = { service: number; terminus: number; depot: number; nosignal: number; total: number };

export type ParkingSnapshot = {
  at: number;
  serviceDate: string;
  /** a szolgáltatási nap kezdete (unix)  a tippek `startS`-e ehhez képest értendő */
  midnight: number;
  limitS: number;
  counts: Record<FleetKind, KindCounts>;
  terminals: { name: string; lat: number; lon: number; vehicles: ParkedVehicle[] }[];
  depots: { id: DepotId; name: string; vehicles: DepotVehicle[] }[];
  nosignal: (ParkedVehicle & { place: string | null })[];
  service: ServiceVehicle[];
  /** a flotta múltja járművenként (a pillanatképben szereplőkre) */
  fleet: Record<string, FleetVehicle>;
  /**
   * Volán és vasút: csak a megyén belüli végállomásokon álló járművek (kocsiszín és
   * „néma = beállt” szabály nélkül  az az MVK-é). A felület külön kapcsolóval mutatja.
   */
  regional?: { terminals: ParkingSnapshot["terminals"] };
};

export type ParkingInput = {
  now: number;
  serviceDate: string;
  midnight: number;
  fleet: FleetVehicle[];
  runs: Iterable<RunOut>;
  seen: ReadonlyMap<string, LiveSeen>;
  tripEnds: (tripId: string) => TripEnds | null;
  /** a nap összes végállomása (név szerint összevonva) */
  terminals: Place[];
  /** a buszkocsiszín helye (a villamosé nem ismert  ott csak az időszabály dönt) */
  busDepot: Place | null;
  isDepotStop: (kind: FleetKind, stopName: string) => boolean;
  isTramRoute: (routeShort: string) => boolean;
  /** a legkorábbi, erre a járműre jósolt még el nem indult menet */
  tipFor: (vehicleId: string) => TripTip | null;
};

export const PARKING = {
  /** néma járműnél ennyi után vesszük úgy, hogy a kocsiszínbe ment */
  limitS: 3600,
  /** ennyin belüli jel számít élőnek */
  onlineS: 180,
  nearTerminusM: 500,
  nearDepotM: 500,
  /** ennél gyorsabban haladó, menet nélküli jármű úton van (m/s) */
  movingMps: 3,
} as const;

export const DEPOT_NAMES: Record<DepotId, string> = {
  bus: "Szondi György utcai kocsiszín",
  tram: "Villamos-kocsiszín",
};

type Verdict =
  | { state: "service"; v: ServiceVehicle }
  | { state: "terminus"; place: Place; v: ParkedVehicle }
  | { state: "depot"; v: DepotVehicle }
  | { state: "nosignal"; place: string | null; v: ParkedVehicle };

export function computeParking(input: ParkingInput): ParkingSnapshot {
  const lastRun = latestRuns(input.runs);
  const history = new Map(input.fleet.map((f) => [f.id, f]));
  const ids = new Set<string>([...history.keys(), ...lastRun.keys(), ...input.seen.keys()]);

  const counts = { bus: emptyCounts(), tram: emptyCounts() };
  const terminals = new Map<string, { name: string; lat: number; lon: number; vehicles: ParkedVehicle[] }>();
  const depots = new Map<DepotId, DepotVehicle[]>([
    ["bus", []],
    ["tram", []],
  ]);
  const nosignal: (ParkedVehicle & { place: string | null })[] = [];
  const service: ServiceVehicle[] = [];

  for (const id of ids) {
    const run = lastRun.get(id) ?? null;
    const kind = kindOf(id, history.get(id), run, input);
    const verdict = classify(id, kind, run, input);
    const c = counts[kind];
    c.total++;
    if (verdict.state === "service") {
      c.service++;
      service.push(verdict.v);
    } else if (verdict.state === "terminus") {
      c.terminus++;
      const t = terminals.get(verdict.place.name) ?? { ...verdict.place, vehicles: [] };
      t.vehicles.push(verdict.v);
      terminals.set(verdict.place.name, t);
    } else if (verdict.state === "depot") {
      c.depot++;
      depots.get(kind)!.push(verdict.v);
    } else {
      c.nosignal++;
      nosignal.push({ ...verdict.v, place: verdict.place });
    }
  }

  const bySince = (a: ParkedVehicle, b: ParkedVehicle) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.id.localeCompare(b.id, "hu", { numeric: true });
  return {
    at: input.now,
    serviceDate: input.serviceDate,
    midnight: input.midnight,
    limitS: PARKING.limitS,
    counts,
    terminals: [...terminals.values()]
      .map((t) => ({ ...t, vehicles: [...t.vehicles].sort(bySince) }))
      .sort((a, b) => b.vehicles.length - a.vehicles.length || a.name.localeCompare(b.name, "hu")),
    depots: (["bus", "tram"] as const).map((id) => ({ id, name: DEPOT_NAMES[id], vehicles: [...depots.get(id)!].sort(depotOrder) })),
    nosignal: [...nosignal].sort(bySince),
    service: [...service].sort((a, b) => a.id.localeCompare(b.id, "hu", { numeric: true })),
    fleet: Object.fromEntries([...ids].flatMap((id) => (history.has(id) ? [[id, history.get(id)!]] : []))),
  };
}

function classify(id: string, kind: FleetKind, run: RunOut | null, input: ParkingInput): Verdict {
  const { now } = input;
  const live = input.seen.get(id) ?? null;
  const online = Boolean(live && now - live.ts <= PARKING.onlineS);
  const lastSeen = Math.max(run?.lastTs ?? 0, live?.ts ?? 0) || null;
  const base = (since: number | null, next: TripTip | null): ParkedVehicle => ({
    id,
    kind,
    since,
    lastSeen,
    online,
    lastRoute: run?.routeShort ?? live?.route ?? null,
    lastHeadsign: run?.headsign ?? null,
    arrivalDelayS: run?.endDelayS ?? null,
    next,
  });
  const depot = (reason: DepotReason, since: number | null): Verdict => ({
    state: "depot",
    v: { ...base(since, input.tipFor(id)), reason, outToday: Boolean(run) },
  });
  const ends = run ? input.tripEnds(run.tripId) : null;

  if (run?.status === "running") {
    // Kiadták neki a menetet, de még nem indult el: a kiinduló végállomáson vár.
    const waitingAt = run.actualStart == null && ends && (!live || fastDistM(live.lat, live.lon, ends.first.lat, ends.first.lon) <= PARKING.nearTerminusM) ? ends.first : null;
    if (waitingAt) {
      const next: TripTip = { tripId: run.tripId, route: run.routeShort, startS: run.schedStartS, confidence: 1, certain: true };
      return { state: "terminus", place: waitingAt, v: { ...base(run.openedTs, next), lastRoute: run.routeShort, lastHeadsign: run.headsign, arrivalDelayS: null } };
    }
    return { state: "service", v: { id, kind, route: run.routeShort, headsign: run.headsign, tripId: run.tripId, delayS: run.lastDelayS, deadhead: false } };
  }

  const endedAt = run ? (run.actualEnd ?? run.lastTs) : null;
  const reachedEnd = run ? run.closeReason === "final-stop" || (run.stopsTotal > 0 && run.stopsSeen >= run.stopsTotal - 1) : false;

  // Élőben látszik: a helye dönt.
  if (live && online) {
    if (kind === "bus" && input.busDepot && fastDistM(live.lat, live.lon, input.busDepot.lat, input.busDepot.lon) <= PARKING.nearDepotM) {
      return depot("seen", endedAt ?? live.ts);
    }
    if ((live.speed ?? 0) < PARKING.movingMps) {
      const near = nearestPlace(input.terminals, live.lat, live.lon, PARKING.nearTerminusM);
      if (near) {
        const arrivedHere = ends && ends.last.name === near.name ? endedAt : null;
        return { state: "terminus", place: near, v: base(arrivedHere, input.tipFor(id)) };
      }
      // A kocsiállás néha a megállótól távolabb van: a nemrég elért végállomáshoz soroljuk.
      if (ends && reachedEnd && fastDistM(live.lat, live.lon, ends.last.lat, ends.last.lon) <= 1500) {
        return { state: "terminus", place: ends.last, v: base(endedAt, input.tipFor(id)) };
      }
    }
    return { state: "service", v: { id, kind, route: live.route, headsign: null, tripId: null, delayS: null, deadhead: true } };
  }

  if (run && endedAt != null) {
    if (ends && reachedEnd && input.isDepotStop(kind, ends.last.name)) return depot("pull-in", endedAt);
    if (lastSeen != null && now - lastSeen <= PARKING.limitS) {
      if (reachedEnd && ends) return { state: "terminus", place: ends.last, v: base(endedAt, input.tipFor(id)) };
      const place = live ? (nearestPlace(input.terminals, live.lat, live.lon, 3000)?.name ?? null) : null;
      return { state: "nosignal", place, v: base(lastSeen, null) };
    }
    return depot("timeout", lastSeen);
  }

  return depot("not-today", null);
}

const DEPOT_ORDER: Record<DepotReason, number> = { "pull-in": 0, seen: 1, timeout: 2, "not-today": 3 };

function depotOrder(a: DepotVehicle, b: DepotVehicle): number {
  return (
    DEPOT_ORDER[a.reason] - DEPOT_ORDER[b.reason] ||
    (b.since ?? 0) - (a.since ?? 0) ||
    a.id.localeCompare(b.id, "hu", { numeric: true })
  );
}

function latestRuns(runs: Iterable<RunOut>): Map<string, RunOut> {
  const out = new Map<string, RunOut>();
  for (const r of runs) {
    const prev = out.get(r.vehicleId);
    if (!prev || r.openedTs > prev.openedTs) out.set(r.vehicleId, r);
  }
  return out;
}

function kindOf(id: string, history: FleetVehicle | undefined, run: RunOut | null, input: ParkingInput): FleetKind {
  if (run) return input.isTramRoute(run.routeShort) ? "tram" : "bus";
  if (history) return history.kind;
  const route = input.seen.get(id)?.route;
  return route && input.isTramRoute(route) ? "tram" : "bus";
}

function nearestPlace(places: Place[], lat: number, lon: number, maxM: number): Place | null {
  let best: Place | null = null;
  let bestD = maxM;
  for (const p of places) {
    const d = fastDistM(lat, lon, p.lat, p.lon);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function emptyCounts(): KindCounts {
  return { service: 0, terminus: 0, depot: 0, nosignal: 0, total: 0 };
}
