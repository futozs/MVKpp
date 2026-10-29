/** Hol tart egy jármű a menetén (/live/trip-progress, /live/trip-path) — a régi logika portja. */
import type { Feed } from "../gtfs/feed.ts";
import { haversineKm } from "../geo.ts";
import type { LiveVeh } from "./types.ts";

export type TripStopRow = { id: string; name: string; lat: number | null; lon: number | null; dep: number };

export function tripStopRows(feed: Feed, tripId: string): TripStopRow[] | null {
  const seq = feed.tripStops.get(tripId);
  if (!seq?.length) return null;
  return seq.map((x) => {
    const s = feed.stops.get(x.stopId);
    return { id: x.stopId, name: s?.name || x.stopId, lat: s?.lat ?? null, lon: s?.lon ?? null, dep: x.dep };
  });
}

function deviationSec(stopList: TripStopRow[], segmentIndex: number, fraction: number, secOfDay: number): number | null {
  const from = stopList[segmentIndex];
  if (!from) return null;
  const to = stopList[segmentIndex + 1] ?? from;
  const sched = from.dep + (to.dep - from.dep) * fraction;
  let dev = secOfDay - sched;
  if (dev > 43200) dev -= 86400;
  if (dev < -43200) dev += 86400;
  return Math.abs(dev) > 2700 ? null : Math.round(dev);
}

export function progressOnTrip(feed: Feed, tripId: string, vehicle: LiveVeh, secOfDay: number) {
  const trip = feed.trips.get(tripId);
  const stopList = tripStopRows(feed, tripId);
  if (!trip || !stopList?.length) return null;

  const shape = trip.shapeId ? feed.shapes.get(trip.shapeId) : undefined;
  let segmentIndex: number | null = null;
  let segmentFraction = 0;

  if (shape && shape.points.length >= 2) {
    const along = feed.tripStopsAlong(tripId);
    const bus = shape.project(vehicle.lat, vehicle.lon);
    if (bus && bus.distM <= 1500) {
      const stopAlong = along
        ? stopList.map((s) => along.find((a) => a.stopId === s.id)?.alongM ?? null)
        : stopList.map((s) => (s.lat != null && s.lon != null ? (shape.project(s.lat, s.lon)?.alongM ?? null) : null));
      const pos = bus.alongM;
      for (let i = 0; i < stopAlong.length - 1; i++) {
        const a = stopAlong[i];
        const b = stopAlong[i + 1];
        if (a == null || b == null || b <= a) continue;
        if (pos >= a && pos < b) {
          segmentIndex = i;
          segmentFraction = (pos - a) / (b - a);
          break;
        }
      }
      if (segmentIndex == null) {
        const first = stopAlong.find((x) => x != null);
        const last = [...stopAlong].reverse().find((x) => x != null);
        if (first != null && pos < first) {
          segmentIndex = 0;
          segmentFraction = 0;
        } else if (last != null && pos >= last) {
          segmentIndex = stopList.length - 1;
          segmentFraction = 0;
        }
      }
    }
  }

  if (segmentIndex == null) {
    let best = 0;
    let bestDist = Infinity;
    stopList.forEach((s, i) => {
      if (s.lat == null || s.lon == null) return;
      const d = haversineKm(vehicle.lat, vehicle.lon, s.lat, s.lon);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    segmentIndex = best;
    segmentFraction = 0;
  }

  const denominator = Math.max(1, stopList.length - 1);
  const progress = Math.min(1, Math.max(0, (segmentIndex + segmentFraction) / denominator));
  return {
    stops: stopList,
    segmentIndex,
    segmentFraction,
    progress,
    nextStop: stopList[Math.min(stopList.length - 1, segmentIndex + 1)] ?? null,
    scheduleDeviationSec: deviationSec(stopList, segmentIndex, segmentFraction, secOfDay),
  };
}
