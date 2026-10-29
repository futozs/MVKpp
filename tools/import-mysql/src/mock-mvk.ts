/**
 * Fejlesztői MVK-szimulátor: egy rögzített nap valódi GPS-pontjait játssza
 * vissza GTFS-RT protobufként, a mostani napszakhoz igazítva (pontosan
 * N nappal eltolva). Így a teljes élő lánc (worker → DB → WebSocket → UI)
 * token nélkül is tesztelhető.
 *
 *   node src/mock-mvk.ts 2026-10-28 8899
 */
import "@mvk/core/dev-clock";
import { createServer } from "node:http";
import mysql from "mysql2/promise";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { budapestOffsetSec, localMidnightUnix, serviceClock } from "@mvk/core";

const { transit_realtime } = GtfsRealtimeBindings;
const day = process.argv[2] ?? "2026-10-28";
const port = Number(process.argv[3] ?? 8899);
/** opcionális: a visszajátszás kezdő helyi ideje a rögzített napon, pl. "07:30" */
const startAt = process.argv[4];

const conn = await mysql.createConnection({ host: "127.0.0.1", user: "root", database: process.env.MYSQL_DB ?? "mvk_prod" });
const [rows] = await conn.query(
  `SELECT v.vehicle_id AS id, p.feed_ts AS ts, p.lat_e7, p.lon_e7, p.speed_dms, p.bearing_deg, p.trip_hint
     FROM veh_ping p JOIN dim_vehicle v USING (vehicle_key) WHERE p.service_date = ? ORDER BY p.feed_ts`,
  [day],
);
const [cancelledRows] = await conn.query(`SELECT trip_id FROM cancelled_trip_log WHERE service_date = ?`, [day]);
await conn.end();

type P = { id: string; ts: number; lat: number; lon: number; speed: number | null; bearing: number | null; trip: string };
const pings: P[] = (rows as any[]).map((r) => ({
  id: String(r.id),
  ts: Number(r.ts),
  lat: r.lat_e7 / 1e7,
  lon: r.lon_e7 / 1e7,
  speed: r.speed_dms == null ? null : r.speed_dms / 10,
  bearing: r.bearing_deg,
  trip: r.trip_hint ?? "",
}));
const cancelled = (cancelledRows as any[]).map((r) => r.trip_id as string);
const shift = startAt
  ? Math.floor(Date.now() / 1000) - (localMidnightUnix(day) + Number(startAt.split(":")[0]) * 3600 + Number(startAt.split(":")[1] ?? 0) * 60)
  : localMidnightUnix(serviceClock().iso) - localMidnightUnix(day);
console.log(`[mock] ${pings.length} pont (${day}), eltolás ${(shift / 3600).toFixed(2)} óra, :${port}`);

let cursor = 0;
const latest = new Map<string, P>();

function positions(): Uint8Array {
  const now = Math.floor(Date.now() / 1000) - shift;
  while (cursor < pings.length && pings[cursor].ts <= now) {
    latest.set(pings[cursor].id, pings[cursor]);
    cursor++;
  }
  const off = budapestOffsetSec();
  const entity = [...latest.values()]
    .filter((p) => now - p.ts < 600)
    .map((p) => ({
      id: p.id,
      vehicle: {
        trip: { tripId: p.trip },
        vehicle: { id: p.id, label: p.id },
        position: { latitude: p.lat, longitude: p.lon, bearing: p.bearing ?? undefined, speed: p.speed ?? undefined },
        // Az MVK helyi időt küld unix-ként — a szimulátor is így tesz.
        timestamp: p.ts + shift + off,
      },
    }));
  const msg = transit_realtime.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: "2.0", timestamp: Math.floor(Date.now() / 1000) + off }, entity });
  return transit_realtime.FeedMessage.encode(msg).finish();
}

function updates(): Uint8Array {
  const msg = transit_realtime.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: "2.0", timestamp: Math.floor(Date.now() / 1000) }, entity: [] });
  return transit_realtime.FeedMessage.encode(msg).finish();
}

createServer((req, res) => {
  if (req.url?.startsWith("/api/v1/gtfs/get-positions")) {
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end(positions());
  } else if (req.url?.startsWith("/api/v1/gtfs/get-updates")) {
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end(updates());
  } else if (req.url?.startsWith("/api/v1/gtfs/list-cancelled-trips")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(cancelled));
  } else {
    res.writeHead(404);
    res.end("{}");
  }
}).listen(port, "127.0.0.1");
