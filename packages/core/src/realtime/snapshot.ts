/**
 * MVK GTFS-RT (protobuf) → RealtimeSnapshot.
 *
 * Az MVK furcsasága: a feed `timestamp`/`time` mezői helyi időt hordoznak
 * unix-ként (Budapest falióra), ezért az eltolást le kell vonni — a régi
 * gateway és a collector is így csinálta, és az adatok ezt igazolják.
 */
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { ServiceDay } from "../gtfs/service.ts";
import { resolveTripNear } from "../gtfs/service.ts";
import { localMidnightUnix } from "../time.ts";
import { isMvkId, modeOfRoute, stationKeyOf } from "../transit/modes.ts";
import type { RtVehicle } from "../transit/otp2Realtime.ts";
import { isRailTrip, trainParts } from "../transit/regionalGtfs.ts";
import type { DecodedVehicle, LiveVeh, RealtimeSnapshot, StopPrediction } from "./types.ts";

const { transit_realtime } = GtfsRealtimeBindings;

/** A nyers protobuf olvasható objektumként (a rendszer-hub API-vizsgálójához). */
export function decodeRtFeedJson(buf: Uint8Array): { header: unknown; entity: unknown[] } {
  const msg = transit_realtime.FeedMessage.decode(buf);
  const obj = transit_realtime.FeedMessage.toObject(msg, { longs: Number, enums: String, defaults: false }) as { header?: unknown; entity?: unknown[] };
  return { header: obj.header ?? null, entity: obj.entity ?? [] };
}

export type DecodeInput = {
  positions: Uint8Array | null;
  updates: Uint8Array | null;
  /** a feed helyi idejének eltolása (budapestOffsetSec) */
  offset: number;
  /** a ma érvényes szolgáltatási nap(ok) — a menet-feloldáshoz */
  days: ServiceDay[];
  /** a szolgáltatási nap referencia-éjfele, a csak késést tartalmazó frissítésekhez */
  midnightUnix: number;
  rtError?: string | null;
  /** a lekérés ideje (unix): ugyanaz a menetazonosító több napon is él, ehhez a legközelebbi */
  now?: number;
  /**
   * További járművek a MÁV+ OTP2-ből: a Volán és a vasút, illetve tartalék
   * üzemben az MVK is. Valódi UTC időbélyeggel; a natív MVK-jármű elsőbbséget élvez.
   */
  extra?: RtVehicle[];
  /**
   * Jármű nélküli előrejelzések (a MÁV+ állomástábláiból: a még el nem indult vonat
   * késése; tartalék üzemben az MVK-menetek megállónkénti ideje). `exact`: csak arra a
   * megállóra; különben a menet hátralévő megállóira is.
   */
  extraPreds?: { tripId: string; stopId: string; delay: number; exact?: boolean }[];
};

/** A menet a `now`-hoz időben legközelebbi napon (03:00 után a még futó éjszakai menet a tegnapi napé). */
function resolveIn(days: ServiceDay[], rtTripId: string, now: number | null) {
  const hit = resolveTripNear(
    days.map((day) => ({ day, midnightUnix: localMidnightUnix(day.iso) })),
    rtTripId,
    now,
  );
  return hit ? { trip: hit.trip, day: hit.dc.day, midnightUnix: hit.dc.midnightUnix } : null;
}

export function buildSnapshot(input: DecodeInput): RealtimeSnapshot {
  const decoded: DecodedVehicle[] = [];
  const vehicles: LiveVeh[] = [];
  let header = { version: "", timestamp: 0 };
  const primary = input.days[0];

  if (input.positions?.length) {
    const feed = transit_realtime.FeedMessage.decode(input.positions);
    header = { version: feed.header.gtfsRealtimeVersion, timestamp: Number(feed.header.timestamp || 0) };
    for (const e of feed.entity) {
      const v = e.vehicle;
      if (!v) continue;
      const rtTrip = v.trip?.tripId || "";
      const hit = resolveIn(input.days, rtTrip, input.now ?? null);
      const tripId = hit?.trip.id ?? rtTrip;
      const feedOf = hit?.day.feed ?? primary?.feed;
      const rawRoute = (v.trip?.routeId || "").trim();
      const routeId = resolveRouteId(feedOf, rawRoute, hit?.trip.routeId);
      const r = feedOf?.routes.get(routeId);
      const lat = v.position?.latitude ?? null;
      const lon = v.position?.longitude ?? null;
      const item: DecodedVehicle = {
        id: v.vehicle?.id || e.id,
        label: v.vehicle?.label || "",
        routeId,
        routeShort: r?.short || routeId,
        routeColor: r?.color || "888888",
        routeText: r?.text || "FFFFFF",
        headsign: hit?.trip.headsign || "",
        lat,
        lon,
        bearing: v.position?.bearing ?? null,
        speed: v.position?.speed ?? null,
        tripId,
        timestamp: v.timestamp ? Number(v.timestamp) : null,
        ...(rtTrip && rtTrip !== tripId ? { rtTripId: rtTrip } : {}),
      };
      decoded.push(item);
      if (lat != null && lon != null) {
        vehicles.push({ id: item.id, lat, lon, bearing: item.bearing, speed: item.speed, routeId, tripId });
      }
    }
  }

  const seenIds = new Set(decoded.map((v) => v.id));
  /** tripId → (megálló-index, késés, nap) a tartalék / regionális előrejelzéshez */
  const extraDelays: { tripId: string; stopId: string; delay: number; feed: ServiceDay["feed"]; midnightUnix: number }[] = [];
  for (const v of input.extra ?? []) {
    if (seenIds.has(v.id)) continue;
    seenIds.add(v.id);
    const hit = v.rtTripId ? resolveIn(input.days, v.rtTripId, input.now ?? null) : null;
    const feedOf = hit?.day.feed ?? primary?.feed;
    const routeId = hit?.trip.routeId ?? v.routeId;
    const r = feedOf?.routes.get(routeId);
    const mvk = isMvkId(v.id);
    const mode = modeOfRoute(routeId, r?.type ?? "");
    const tp = hit && isRailTrip(hit.trip) ? trainParts(hit.trip.shortName) : null;
    const item: DecodedVehicle = {
      id: v.id,
      // A natív MVK-feedben a label a jármű fajtája; a rendszám külön mezőben jön.
      label: mvk ? (mode === "tram" ? "TRAM" : "BUS") : v.label,
      routeId,
      routeShort: r?.short || routeId,
      routeColor: r?.color || "888888",
      routeText: r?.text || "FFFFFF",
      headsign: hit?.trip.headsign || "",
      lat: v.lat,
      lon: v.lon,
      bearing: v.bearing,
      speed: v.speed,
      tripId: hit?.trip.id ?? v.rtTripId,
      // A v2-mező helyi időt hordoz unixként (mint az MVK feedje) — a fogyasztók levonják az eltolást.
      timestamp: v.ts + input.offset,
      mode,
      routeKey: r?.key ?? routeId,
      source: "otp2",
      delaySec: v.delayS,
      ...(v.label ? { plate: v.label } : {}),
      ...(tp?.no ? { trainNo: tp.no } : {}),
      ...(tp?.name ? { trainName: tp.name } : {}),
      ...(v.estimated ? { estimated: true } : {}),
    };
    decoded.push(item);
    vehicles.push({ id: item.id, lat: v.lat, lon: v.lon, bearing: v.bearing, speed: v.speed, routeId, tripId: item.tripId });
    if (hit && v.delayS != null && v.nextStopId) {
      extraDelays.push({ tripId: hit.trip.id, stopId: v.nextStopId, delay: v.delayS, feed: hit.day.feed, midnightUnix: hit.midnightUnix });
    }
  }

  const predByStop = new Map<string, Map<string, StopPrediction>>();
  let updatesHeaderTs = 0;
  let updatesCount = 0;
  if (input.updates?.length) {
    const feed = transit_realtime.FeedMessage.decode(input.updates);
    updatesHeaderTs = Number(feed.header.timestamp || 0);
    updatesCount = feed.entity.length;
    for (const e of feed.entity) {
      const tu = e.tripUpdate;
      if (!tu) continue;
      const rtTrip = tu.trip?.tripId || "";
      const hit = resolveIn(input.days, rtTrip, input.now ?? null);
      const tripId = hit?.trip.id ?? rtTrip;
      const sched = hit ? hit.day.feed.tripStops.get(hit.trip.id) : undefined;
      for (const stu of tu.stopTimeUpdate || []) {
        const stopId = stu.stopId || "";
        if (!stopId) continue;
        let byTrip = predByStop.get(stopId);
        if (byTrip?.has(tripId)) continue;
        let unix: number | null = null;
        let delay: number | null = null;
        if (stu.arrival?.time) unix = Number(stu.arrival.time) - input.offset;
        else if (stu.departure?.time) unix = Number(stu.departure.time) - input.offset;
        if (stu.arrival?.delay != null || stu.departure?.delay != null) {
          delay = Number(stu.arrival?.delay ?? stu.departure?.delay);
        }
        if (unix == null && delay != null && sched) {
          const s = sched.find((x) => x.stopId === stopId);
          if (s) unix = input.midnightUnix + s.dep + delay;
        }
        if (unix == null) continue;
        if (!byTrip) predByStop.set(stopId, (byTrip = new Map()));
        byTrip.set(tripId, { unix, delay });
      }
    }
  }

  // Jármű nélküli előrejelzések: a pontos (megállónkénti) értékek előbb, a vetítettek csak a hézagokba.
  const preds = [...(input.extraPreds ?? [])].sort((a, b) => Number(Boolean(b.exact)) - Number(Boolean(a.exact)));
  for (const p of preds) {
    const hit = resolveIn(input.days, p.tripId, input.now ?? null);
    if (!hit) continue;
    if (p.exact) {
      const s = hit.day.feed.tripStops.get(hit.trip.id)?.find((x) => x.stopId === p.stopId || stationKeyOf(x.stopId) === stationKeyOf(p.stopId));
      if (!s) continue;
      let byTrip = predByStop.get(s.stopId);
      if (byTrip?.has(hit.trip.id)) continue;
      if (!byTrip) predByStop.set(s.stopId, (byTrip = new Map()));
      byTrip.set(hit.trip.id, { unix: hit.midnightUnix + s.dep + p.delay, delay: p.delay });
    } else extraDelays.push({ tripId: hit.trip.id, stopId: p.stopId, delay: p.delay, feed: hit.day.feed, midnightUnix: hit.midnightUnix });
  }

  // Tartalék / regionális előrejelzés: a következő megállóban mért hivatalos késés a menet hátralévő
  // megállóira (az OTP2 maga is így vetíti előre; a natív MVK-előrejelzés elsőbbséget élvez).
  for (const d of extraDelays) {
    const sched = d.feed.tripStops.get(d.tripId);
    if (!sched) continue;
    // A MÁV+ a vágány-megállót adja (…_3), a menetrend az állomásszintűt (…_0): az állomás kulcsán párosítunk.
    let from = sched.findIndex((x) => x.stopId === d.stopId);
    if (from < 0) from = sched.findIndex((x) => stationKeyOf(x.stopId) === stationKeyOf(d.stopId));
    if (from < 0) continue;
    for (let i = from; i < sched.length; i++) {
      const s = sched[i];
      let byTrip = predByStop.get(s.stopId);
      if (byTrip?.has(d.tripId)) continue;
      if (!byTrip) predByStop.set(s.stopId, (byTrip = new Map()));
      byTrip.set(d.tripId, { unix: d.midnightUnix + s.dep + d.delay, delay: d.delay });
    }
  }

  return {
    fetchedAt: Date.now(),
    header,
    decoded,
    vehicles,
    predByStop,
    updatesHeaderTs,
    updatesCount,
    rtError: input.rtError ?? null,
  };
}

function resolveRouteId(feed: ServiceDay["feed"] | undefined, raw: string, fromTrip?: string): string {
  if (!feed) return raw || fromTrip || "";
  if (raw && feed.routes.has(raw)) return raw;
  if (fromTrip && feed.routes.has(fromTrip)) return fromTrip;
  if (raw) {
    for (const part of raw.split(/[-–—/]/)) {
      const p = part.trim();
      if (p && feed.routes.has(p)) return p;
    }
  }
  return raw || fromTrip || "";
}
