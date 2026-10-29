/**
 * Megállófigyelő: egy megálló következő indulásai.
 *
 * A régi `arrivalsForStop` algoritmusa változatlan (a felhasználó szerint ez
 * működik jól), két javítással:
 *  - a következő szolgáltatási nap meneteit is nézi, így éjfél után nem
 *    tűnnek el a 24:xx-es, és hajnalban sem a 4:xx-es indulások;
 *  - a trip-frissítéseket a snapshot már megállónként indexelve hozza.
 */
import type { ServiceDay } from "../gtfs/service.ts";
import { haversineKm } from "../geo.ts";
import { hmOfUnix } from "../time.ts";
import type { ArrivalItem, LiveVeh, RealtimeSnapshot, StopArrivals } from "./types.ts";

export type ArrivalExtras = {
  /** tripId → saját mért késés (mp) */
  measuredDelay?: (tripId: string) => number | null;
  /** tripId → előre jelzett rendszám */
  predictedVehicle?: (tripId: string) => { id: string; confidence: number } | null;
  cancelled?: Set<string>;
  /** (tripId, stopId) → várható és legrosszabb esetben várható késés ennél a megállónál */
  forecast?: (tripId: string, stopId: string) => { delayS: number; upperS: number } | null;
};

type DayCtx = { day: ServiceDay; midnightUnix: number };

export function arrivalsForStop(
  stopId: string,
  limit: number,
  snap: RealtimeSnapshot,
  days: DayCtx[],
  nowUnix: number,
  extras: ArrivalExtras = {},
): StopArrivals {
  const primary = days[0];
  const feed = primary?.day.feed;
  const s = feed?.stops.get(stopId);
  const pred = snap.predByStop.get(stopId) ?? new Map();

  type Cand = { unix: number; delay: number | null; hasRT: boolean; dc: DayCtx };
  const cand = new Map<string, Cand>();
  for (const dc of days) {
    for (const { trip, dep } of dc.day.feed.stopSched.get(stopId) || []) {
      const tr = dc.day.feed.trips.get(trip);
      if (!tr || !dc.day.services.has(tr.serviceId)) continue;
      if (cand.has(trip)) continue;
      const p = pred.get(trip);
      cand.set(trip, { unix: p?.unix ?? dc.midnightUnix + dep, delay: p?.delay ?? null, hasRT: !!p, dc });
    }
  }
  if (primary) {
    for (const [trip, p] of pred) if (!cand.has(trip)) cand.set(trip, { unix: p.unix, delay: p.delay, hasRT: true, dc: primary });
  }

  const tripOf = (tripId: string, dc: DayCtx) => dc.day.feed.trips.get(tripId);

  const vehByTrip = new Map<string, LiveVeh>();
  for (const v of snap.vehicles) if (v.tripId) vehByTrip.set(v.tripId, v);

  const seen = new Set<string>();
  const rows = [...cand.entries()]
    .map(([tripId, x]) => {
      const t = tripOf(tripId, x.dc);
      return { tripId, ...x, routeId: t?.routeId || "", headsign: t?.headsign || "" };
    })
    .filter((x) => x.unix >= nowUnix - 60)
    .sort((a, b) => a.unix - b.unix || (b.hasRT ? 1 : 0) - (a.hasRT ? 1 : 0))
    .filter((x) => {
      const k = `${x.routeId}|${hmOfUnix(x.unix)}|${x.headsign}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  const findNearestStop = (lat: number, lon: number) => {
    let bestDist = Infinity;
    let best: { id: string; name: string } | null = null;
    if (!feed) return best;
    for (const st of feed.stops.values()) {
      const d = haversineKm(lat, lon, st.lat, st.lon);
      if (d < bestDist) {
        bestDist = d;
        best = { id: st.id, name: st.name };
      }
    }
    return best;
  };

  const usedVehicleIds = new Set<string>();
  const arrivals: ArrivalItem[] = [];
  for (const x of rows) {
    if (arrivals.length >= limit) break;
    const f = x.dc.day.feed;
    const tr = f.trips.get(x.tripId);
    const r = f.routes.get(tr?.routeId || "");
    let veh = vehByTrip.get(x.tripId) || null;
    if (veh) usedVehicleIds.add(veh.id);
    if (!veh) {
      const routeVehs = snap.vehicles.filter((v) => {
        if (v.routeId !== tr?.routeId || usedVehicleIds.has(v.id)) return false;
        const vDir = v.tripId ? f.trips.get(v.tripId)?.dir : undefined;
        if (vDir != null && tr?.dir != null && vDir !== tr.dir) return false;
        return true;
      });
      if (routeVehs.length === 1) {
        veh = routeVehs[0];
        usedVehicleIds.add(veh.id);
      }
    }

    let currentStopName: string | null = null;
    let currentStopId: string | null = null;
    let distanceToStopKm: number | null = null;
    let progressDesc: string | null = null;

    if (veh && s) {
      distanceToStopKm = +haversineKm(veh.lat, veh.lon, s.lat, s.lon).toFixed(1);
      const nearest = findNearestStop(veh.lat, veh.lon);
      currentStopName = nearest?.name ?? null;
      currentStopId = nearest?.id ?? null;
      const atStop = distanceToStopKm < 0.25;
      if (currentStopName) {
        progressDesc = atStop ? `A megállóban van (${s.name})` : `${currentStopName} közelében (~${distanceToStopKm} km)`;
      }

      let invalid = false;
      if (!atStop && distanceToStopKm >= 0.15) {
        const shape = tr?.shapeId ? f.shapes.get(tr.shapeId) : null;
        if (shape) {
          const vehProj = shape.project(veh.lat, veh.lon);
          if (vehProj) {
            if (vehProj.distM > 500) invalid = true;
            else {
              const stopProj = shape.project(s.lat, s.lon);
              if (stopProj && vehProj.alongM > stopProj.alongM + 100) invalid = true;
            }
          }
        }
        if (!invalid && currentStopId && currentStopId !== stopId) {
          const sched = f.tripStops.get(x.tripId) ?? [];
          const targetDep = sched.find((q) => q.stopId === stopId)?.dep;
          const vehDep = sched.find((q) => q.stopId === currentStopId)?.dep;
          if (targetDep != null && vehDep != null && vehDep > targetDep + 30) invalid = true;
        }
      }
      if (invalid) {
        veh = null;
        currentStopName = null;
        currentStopId = null;
        distanceToStopKm = null;
        progressDesc = null;
      }
    }

    const fc = veh ? (extras.forecast?.(x.tripId, stopId) ?? null) : null;
    arrivals.push({
      route: r?.short || tr?.routeId || "?",
      color: r?.color || "888888",
      text: r?.text || "FFFFFF",
      headsign: tr?.headsign || "",
      time: hmOfUnix(x.unix),
      etaMin: Math.max(0, Math.round((x.unix - nowUnix) / 60)),
      delaySec: x.delay,
      live: x.hasRT || veh != null,
      tripId: x.tripId,
      vehicle: veh,
      currentStopName,
      distanceToStopKm,
      progressDesc,
      measuredDelaySec: extras.measuredDelay?.(x.tripId) ?? null,
      predictedVehicle: veh ? null : (extras.predictedVehicle?.(x.tripId) ?? null),
      cancelled: extras.cancelled?.has(x.tripId) ?? false,
      forecastDelaySec: fc?.delayS ?? null,
      forecastUpperSec: fc?.upperS ?? null,
    });
  }

  return {
    stop: s ? { id: s.id, code: s.code, name: s.name, lat: s.lat, lon: s.lon } : { id: stopId },
    now: nowUnix,
    rtError: snap.rtError,
    arrivals,
  };
}
