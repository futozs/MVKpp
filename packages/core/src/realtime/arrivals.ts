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
import type { StartRisk } from "../startRisk.ts";
import { isMvkId, modeOfRoute, operatorLabel, type TransitMode } from "../transit/modes.ts";
import { isRailTrip, trainParts } from "../transit/regionalGtfs.ts";
import type { ArrivalItem, LiveVeh, RealtimeSnapshot, StopArrivals } from "./types.ts";

export type ArrivalExtras = {
  /** tripId → saját mért késés (mp) */
  measuredDelay?: (tripId: string) => number | null;
  /** tripId → előre jelzett rendszám */
  predictedVehicle?: (tripId: string) => { id: string; confidence: number } | null;
  cancelled?: Set<string>;
  /** (tripId, stopId) → várható és legrosszabb esetben várható késés ennél a megállónál */
  forecast?: (tripId: string, stopId: string) => { delayS: number; upperS: number } | null;
  /** tripId → késve indul / valószínűleg kimarad, mert a busza még az előző menetén van */
  startRisk?: (tripId: string) => StartRisk | null;
  /** (tripId, stopId) → dugó a busz előtt a megállóig */
  trafficAhead?: (tripId: string, stopId: string) => ArrivalItem["trafficAhead"];
  /** csak ezek a módok (a v2 alapból csak MVK) — hiányában minden */
  modes?: ReadonlySet<TransitMode>;
  /** (tripId, stopId) → élő vágány / kocsiállás (vasút, autóbusz-állomás) */
  platform?: (tripId: string, stopId: string) => string | null;
  /** (tripId, stopId) → várható vágány a korábbi napokból, amíg a MÁV nem adta ki */
  predictedPlatform?: (tripId: string, stopId: string) => string | null;
  /** tripId → hivatalos megjegyzések (késés oka, kocsiösszeállítás) */
  notices?: (tripId: string) => string[] | null;
  /** az MVK-sorokhoz is kellenek a v3-mezők (mód, vonal-kulcs) — a v2 alapválasza bájtra a régi marad */
  rich?: boolean;
  /**
   * Közös megálló (lásd `mergedBoard`): ezeknek a megállóknak az indulásai egy táblán
   * (az MVK-oszlop és a mellette álló Volán-megálló). Hiányában csak a kért megállóé.
   */
  boardStops?: readonly string[];
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
  // Állomásnál (vasútállomás, autóbusz-állomás) az összes vágány / kocsiállás indulásai;
  // közös megállónál a pár(ok)é is.
  const board = extras.boardStops?.length ? extras.boardStops : [stopId];
  const stopIds = feed ? [...new Set(board.flatMap((id) => feed.stopsOf(id)))] : [stopId];
  const pred = new Map<string, { unix: number; delay: number | null; stopId: string }>();
  for (const sid of stopIds) for (const [trip, p] of snap.predByStop.get(sid) ?? []) if (!pred.has(trip)) pred.set(trip, { ...p, stopId: sid });

  // A menet-azonosítók napról napra ismétlődnek: ugyanaz a trip_id ma és holnap is
  // közlekedhet. Ezért a jelöltek kulcsa nap + menet — különben este a holnapi
  // (hajnali) indulások kiesnének, mert a mai, már elment példány foglalja a helyet.
  // Az élő adat (előrejelzés, jármű, törlés) csak a mai szolgáltatási napra vonatkozik.
  type Cand = { tripId: string; unix: number; delay: number | null; hasRT: boolean; dc: DayCtx; primary: boolean; stopId: string };
  const cand = new Map<string, Cand>();
  days.forEach((dc, di) => {
    const isPrimary = dc === primary;
    for (const sid of stopIds) {
      for (const { trip, dep } of dc.day.feed.stopSched.get(sid) || []) {
        const tr = dc.day.feed.trips.get(trip);
        if (!tr || !dc.day.services.has(tr.serviceId)) continue;
        const key = `${di}|${trip}`;
        if (cand.has(key)) continue;
        const p = isPrimary ? pred.get(trip) : undefined;
        cand.set(key, { tripId: trip, unix: p?.unix ?? dc.midnightUnix + dep, delay: p?.delay ?? null, hasRT: !!p, dc, primary: isPrimary, stopId: sid });
      }
    }
  });
  if (primary) {
    for (const [trip, p] of pred) if (!cand.has(`0|${trip}`)) cand.set(`0|${trip}`, { tripId: trip, unix: p.unix, delay: p.delay, hasRT: true, dc: primary, primary: true, stopId: p.stopId });
  }
  const modeOk = (routeId: string, dc: DayCtx) => !extras.modes || extras.modes.has(modeOfRoute(routeId, dc.day.feed.routes.get(routeId)?.type ?? ""));

  const tripOf = (tripId: string, dc: DayCtx) => dc.day.feed.trips.get(tripId);

  const vehByTrip = new Map<string, LiveVeh>();
  for (const v of snap.vehicles) if (v.tripId) vehByTrip.set(v.tripId, v);

  const seen = new Set<string>();
  const rows = [...cand.values()]
    .map((x) => {
      const t = tripOf(x.tripId, x.dc);
      return { ...x, routeId: t?.routeId || "", headsign: t?.headsign || "", trainNo: t && isRailTrip(t) ? trainParts(t.shortName).no : null };
    })
    .filter((x) => x.unix >= nowUnix - 60 && modeOk(x.routeId, x.dc))
    .sort((a, b) => a.unix - b.unix || (b.hasRT ? 1 : 0) - (a.hasRT ? 1 : 0))
    .filter((x) => {
      // Ugyanaz a vonat két menetként is szerepelhet (520 HERNÁD-ZEMPLÉN és 520 ZEMPLÉN): vonatszám szerint egy sor.
      const k = x.trainNo ? `T${x.trainNo}|${hmOfUnix(x.unix)}` : `${x.routeId}|${hmOfUnix(x.unix)}|${x.headsign}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  const findNearestStop = (lat: number, lon: number, tripId: string, f: ServiceDay["feed"]) => {
    let bestDist = Infinity;
    let best: { id: string; name: string } | null = null;
    if (!feed) return best;
    // A regionális menetnél a menet saját megállói közül (egy vonat ne „egy buszmegálló közelében” legyen);
    // az MVK-é a régi algoritmus (minden megálló közül).
    const own = isMvkId(tripId) ? null : (f.tripStops.get(tripId) ?? []).map((x) => f.stops.get(x.stopId)).filter((x) => x != null);
    for (const st of own ?? feed.stops.values()) {
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
    let veh = x.primary ? vehByTrip.get(x.tripId) || null : null;
    if (veh) usedVehicleIds.add(veh.id);
    if (!veh && x.primary) {
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
      const nearest = findNearestStop(veh.lat, veh.lon, x.tripId, f);
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

    const cancelled = x.primary ? (extras.cancelled?.has(x.tripId) ?? false) : false;
    // Az előrejelzés élő és még el sem indult (de hamarosan induló) menetre is jár.
    const fc = x.primary && !cancelled ? (extras.forecast?.(x.tripId, x.stopId) ?? null) : null;
    const schedDep = x.dc.day.feed.stopSched.get(x.stopId)?.find((q) => q.trip === x.tripId)?.dep;
    const childStop = f.stops.get(x.stopId);
    const livePlatform = x.primary ? (extras.platform?.(x.tripId, x.stopId) ?? null) : null;
    const schedPlatform = childStop?.platform || null;
    // amíg a MÁV nem adta ki: a korábbi napok szerinti várható vágány (jelölve)
    const guessedPlatform = x.primary && !livePlatform && !schedPlatform ? (extras.predictedPlatform?.(x.tripId, x.stopId) ?? null) : null;
    const tp = tr && isRailTrip(tr) ? trainParts(tr.shortName) : null;
    const notices = x.primary ? (extras.notices?.(x.tripId) ?? null) : null;
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
      measuredDelaySec: x.primary ? (extras.measuredDelay?.(x.tripId) ?? null) : null,
      // kihúzott menetre nem jósolunk buszt: nem jön
      predictedVehicle: veh || !x.primary || cancelled ? null : (extras.predictedVehicle?.(x.tripId) ?? null),
      cancelled,
      forecastDelaySec: fc?.delayS ?? null,
      forecastUpperSec: fc?.upperS ?? null,
      schedUnix: schedDep != null ? x.dc.midnightUnix + schedDep : null,
      // A kiosztott busz is lehet még az előző menetén: az el nem indult menetet a jóslás dönti el.
      startRisk: x.primary && !cancelled ? (extras.startRisk?.(x.tripId) ?? null) : null,
      trafficAhead: x.primary && veh ? (extras.trafficAhead?.(x.tripId, x.stopId) ?? null) : null,
      ...(r && r.key !== r.short
        ? {
            mode: modeOfRoute(r.id, r.type),
            routeKey: r.key,
            operator: operatorLabel(r.agencyName),
            trainNo: tp?.no ?? null,
            trainName: tp?.name ?? null,
            platform: livePlatform ?? schedPlatform ?? guessedPlatform,
            platformChanged: Boolean(livePlatform && schedPlatform && livePlatform !== schedPlatform),
            ...(guessedPlatform && !livePlatform && !schedPlatform ? { platformPredicted: true } : {}),
            stopId: x.stopId,
            ...(notices?.length ? { notices } : {}),
          }
        : extras.rich
          ? { mode: modeOfRoute(tr?.routeId ?? "", r?.type ?? ""), routeKey: r?.key ?? tr?.routeId ?? "", stopId: x.stopId }
          : {}),
    });
  }

  return {
    stop: s ? { id: s.id, code: s.code, name: s.name, lat: s.lat, lon: s.lon } : { id: stopId },
    now: nowUnix,
    rtError: snap.rtError,
    arrivals,
    ...(board.length > 1 ? { merged: [...board] } : {}),
  };
}
