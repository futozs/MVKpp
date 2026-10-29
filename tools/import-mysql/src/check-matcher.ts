/**
 * Fejlesztői ellenőrzés: az új illesztő egy valódi nap nyers GPS-én.
 *   node src/check-matcher.ts 2026-10-28 ../../data/gtfs-cache/latest.zip
 */
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { feedFromZip, resolveServiceDay, localMidnightUnix, shiftIso, serviceClock, TripMatcher, type RunOut, type StopEventOut } from "@mvk/core";

const date = process.argv[2] ?? "2026-10-28";
const zip = process.argv[3] ?? "../../data/gtfs-cache/latest.zip";
const db = process.env.MYSQL_DB ?? "mvk_prod";

const feed = feedFromZip(new Uint8Array(readFileSync(zip)));
const dayCache = new Map<string, ReturnType<typeof resolveServiceDay>>();
const dayFor = (iso: string) => {
  if (!dayCache.has(iso)) dayCache.set(iso, resolveServiceDay([feed], iso));
  return dayCache.get(iso)!;
};

const runs = new Map<string, RunOut>();
const events: StopEventOut[] = [];
const matcher = new TripMatcher(
  (ts) => {
    const iso = serviceClock(ts).iso;
    const out = [];
    for (const d of [iso, shiftIso(iso, -1)]) {
      const day = dayFor(d);
      if (day) out.push({ day, midnightUnix: localMidnightUnix(d) });
    }
    return out;
  },
  {
    runOpened: (r) => runs.set(r.runKey, r),
    runClosed: (r) => runs.set(r.runKey, r),
    stopEvent: (e) => events.push(e),
  },
);

const conn = await mysql.createConnection({ host: "127.0.0.1", user: "root", database: db });
const [rows] = await conn.query(
  `SELECT v.vehicle_id, p.feed_ts, p.lat_e7, p.lon_e7, p.speed_dms, p.bearing_deg, p.trip_hint
     FROM veh_ping p JOIN dim_vehicle v ON v.vehicle_key = p.vehicle_key
    WHERE p.service_date = ? ORDER BY p.feed_ts, v.vehicle_id`,
  [date],
);
await conn.end();

const t0 = Date.now();
let last = 0;
for (const r of rows as any[]) {
  const ts = Number(r.feed_ts);
  if (ts - last > 60) {
    matcher.sweep(ts);
    last = ts;
  }
  matcher.push({
    vehicleId: String(r.vehicle_id),
    ts,
    lat: r.lat_e7 / 1e7,
    lon: r.lon_e7 / 1e7,
    speed: r.speed_dms == null ? null : r.speed_dms / 10,
    bearing: r.bearing_deg,
    rtTripId: r.trip_hint ?? "",
  });
}
matcher.flush();
const ms = Date.now() - t0;

const all = [...runs.values()];
const by = (s: string) => all.filter((r) => r.status === s).length;
const sched = dayFor(date)!;
let schedTrips = 0;
for (const t of feed.trips.values()) if (sched.services.has(t.serviceId)) schedTrips++;
const pct = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const startDelays = all.map((r) => r.startDelayS).filter((x): x is number => x != null);
const endDelays = all.map((r) => r.endDelayS).filter((x): x is number => x != null);
const lastStopSeen = all.filter((r) => r.actualEnd != null).length;

console.log(JSON.stringify({
  date,
  pings: (rows as any[]).length,
  ms,
  scheduledTrips: schedTrips,
  runs: all.length,
  complete: by("complete"),
  partial: by("partial"),
  aborted: by("aborted"),
  running: by("running"),
  withActualStart: all.filter((r) => r.actualStart != null).length,
  withLastStop: lastStopSeen,
  events: events.length,
  eventsPerRun: +(events.length / Math.max(1, all.length)).toFixed(1),
  avgCoverage: +(all.reduce((a, r) => a + r.stopsSeen / r.stopsTotal, 0) / Math.max(1, all.length)).toFixed(3),
  startDelay: { p10: pct(startDelays, 0.1), p50: pct(startDelays, 0.5), p90: pct(startDelays, 0.9) },
  endDelay: { p10: pct(endDelays, 0.1), p50: pct(endDelays, 0.5), p90: pct(endDelays, 0.9) },
  srcMix: events.reduce<Record<string, number>>((a, e) => ((a[e.src] = (a[e.src] ?? 0) + 1), a), {}),
}, null, 2));

const bad = all.filter((r) => r.status === "partial").slice(0, 8);
for (const r of bad) console.log("partial", r.tripId, r.vehicleId, `${r.stopsSeen}/${r.stopsTotal}`, r.closeReason);

const noEnd = all.filter((r) => r.status === "complete" && r.actualEnd == null);
const gapHist: Record<string, number> = {};
const reasonHist: Record<string, number> = {};
const routeHist: Record<string, number> = {};
for (const r of noEnd) {
  const gap = String(r.stopsTotal - 1 - (r.lastStopIdx ?? -1));
  gapHist[gap] = (gapHist[gap] ?? 0) + 1;
  reasonHist[r.closeReason ?? "?"] = (reasonHist[r.closeReason ?? "?"] ?? 0) + 1;
  routeHist[r.routeShort] = (routeHist[r.routeShort] ?? 0) + 1;
}
console.log("noEnd", noEnd.length, { gapHist, reasonHist, routeHist });
console.log("sample", noEnd.slice(0, 5).map((r) => [r.tripId, r.vehicleId, r.lastStopIdx, r.stopsTotal, r.closeReason]));
