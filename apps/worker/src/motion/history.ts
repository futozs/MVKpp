/**
 * A mozgás-modell tanításához: a múltbeli napok nyers GPS-jeit ugyanazon az
 * illesztőn játsszuk vissza, ami élesben fut  így a tanító fixek pontosan
 * azok, amelyekből a térkép élesben becsül (ugyanaz az elfogadás, ugyanaz a
 * vetítés a nyomvonalra).
 */
import { dayInfo, localMidnightUnix, serviceClock, shiftIso, TripMatcher, type MotionFix, type MotionTrip } from "@mvk/core";
import { sql } from "@mvk/db";
import type { FeedManager } from "../feeds.ts";

export type HistoryRun = { tripId: string; vehicleId: string; shapeId: string; fixes: MotionFix[] };
export type HistoryDay = { iso: string; midnight: number; daytype: number; runs: HistoryRun[]; trip(tripId: string): MotionTrip };

/** a szolgáltatási nap ettől eddig tart (helyi óra) */
const DAY_START_H = 3;
/** ennél kevesebb fixes menetből nincs mit tanulni */
const MIN_FIXES = 3;

export async function replayDay(feeds: FeedManager, iso: string): Promise<HistoryDay> {
  for (const d of [shiftIso(iso, -1), iso]) await feeds.serviceDay(d);
  const matcher = new TripMatcher((ts) => {
    const d = serviceClock(ts).iso;
    const out = [];
    for (const x of [d, shiftIso(d, -1)]) {
      const day = feeds.cachedDay(x);
      if (day) out.push({ day, midnightUnix: localMidnightUnix(x) });
    }
    return out;
  });
  const from = localMidnightUnix(iso) + DAY_START_H * 3600;
  const to = localMidnightUnix(shiftIso(iso, 1)) + DAY_START_H * 3600;
  const rows = await sql<{ v: string; ts: number; lat: number; lon: number; speed: number | null; bearing: number | null; rt: string | null }>(
    `SELECT vehicle_id AS v, extract(epoch FROM ts)::int AS ts, lat, lon, speed, bearing, rt_trip_id AS rt
       FROM veh_ping WHERE ts >= to_timestamp($1) AND ts < to_timestamp($2) AND vehicle_id NOT LIKE '%:%' ORDER BY ts, vehicle_id`,
    [from, to],
  );
  const runs = new Map<string, HistoryRun>();
  const lastTs = new Map<string, number>();
  let lastSweep = 0;
  for (const r of rows) {
    if (r.ts - lastSweep > 60) {
      matcher.sweep(r.ts);
      lastSweep = r.ts;
    }
    if (r.ts <= (lastTs.get(r.v) ?? 0)) continue;
    lastTs.set(r.v, r.ts);
    matcher.push({ vehicleId: r.v, ts: r.ts, lat: r.lat, lon: r.lon, speed: r.speed, bearing: r.bearing, rtTripId: r.rt ?? "" });
    // Ugyanaz a szabály, mint élesben (MotionPredictor): fix az, amit az illesztő a saját idején elfogadott.
    const m = matcher.motion(r.v);
    if (!m || m.ts !== r.ts) continue;
    const key = `${m.tripId}|${r.v}`;
    let run = runs.get(key);
    if (!run) runs.set(key, (run = { tripId: m.tripId, vehicleId: r.v, shapeId: m.shapeId, fixes: [] }));
    run.fixes.push([m.ts, m.alongM, r.speed ?? -1]);
  }
  const trips = new Map<string, MotionTrip>();
  const trip = (tripId: string): MotionTrip => {
    let t = trips.get(tripId);
    if (!t) {
      const a = feeds.cachedDay(iso)?.feed.tripStopsAlong(tripId) ?? feeds.cachedDay(shiftIso(iso, -1))?.feed.tripStopsAlong(tripId) ?? [];
      trips.set(tripId, (t = { along: a.map((s) => s.alongM), arr: a.map((s) => s.arr), dep: a.map((s) => s.dep) }));
    }
    return t;
  };
  return {
    iso,
    midnight: localMidnightUnix(iso),
    daytype: dayInfo(iso).daytype,
    runs: [...runs.values()].filter((r) => r.fixes.length >= MIN_FIXES),
    trip,
  };
}
