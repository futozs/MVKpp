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
};

/** A menet a `now`-hoz időben legközelebbi napon (03:00 után a még futó éjszakai menet a tegnapi napé). */
function resolveIn(days: ServiceDay[], rtTripId: string, now: number | null) {
  const hit = resolveTripNear(
    days.map((day) => ({ day, midnightUnix: localMidnightUnix(day.iso) })),
    rtTripId,
    now,
  );
  return hit ? { trip: hit.trip, day: hit.dc.day } : null;
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
