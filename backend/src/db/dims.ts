import type { Pool } from "mysql2/promise";
import {
  routes,
  stops,
  trips,
  tripStops,
  patternHash,
  tripStopsAlong,
  getFeedVersion,
} from "../lib/gtfs.ts";

export type Keys = {
  vehicle: Map<string, number>;
  route: Map<string, number>;
  stop: Map<string, number>;
  pattern: Map<string, number>;
  segment: Map<string, number>;
};

export const keys: Keys = {
  vehicle: new Map(),
  route: new Map(),
  stop: new Map(),
  pattern: new Map(),
  segment: new Map(),
};

const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const e7 = (v: number) => Math.round(v * 1e7);
export const segPairKey = (from: number, to: number) => `${from}>${to}`;

export async function loadKeys(pool: Pool): Promise<void> {
  keys.vehicle.clear();
  keys.route.clear();
  keys.stop.clear();
  keys.pattern.clear();
  keys.segment.clear();

  const [v] = await pool.query(
    "SELECT vehicle_key, vehicle_id FROM dim_vehicle",
  );
  for (const r of v as { vehicle_key: number; vehicle_id: string }[])
    keys.vehicle.set(r.vehicle_id, r.vehicle_key);

  const [rt] = await pool.query("SELECT route_key, route_short FROM dim_route");
  for (const r of rt as { route_key: number; route_short: string }[])
    keys.route.set(r.route_short, r.route_key);

  const [s] = await pool.query("SELECT stop_key, gtfs_stop_id FROM dim_stop");
  for (const r of s as { stop_key: number; gtfs_stop_id: string }[])
    keys.stop.set(r.gtfs_stop_id, r.stop_key);

  const [p] = await pool.query(
    "SELECT pattern_key, pattern_hash FROM dim_pattern",
  );
  for (const r of p as { pattern_key: number; pattern_hash: string }[])
    keys.pattern.set(r.pattern_hash, r.pattern_key);

  const [sg] = await pool.query(
    "SELECT segment_key, from_stop_key, to_stop_key FROM dim_segment",
  );
  for (const r of sg as {
    segment_key: number;
    from_stop_key: number;
    to_stop_key: number;
  }[]) {
    keys.segment.set(segPairKey(r.from_stop_key, r.to_stop_key), r.segment_key);
  }
}

export async function vehicleKey(
  pool: Pool,
  vehicleId: string,
  kind: string,
): Promise<number> {
  const hit = keys.vehicle.get(vehicleId);
  if (hit) {
    return hit;
  }
  const ts = nowSql();
  await pool.query(
    `INSERT INTO dim_vehicle (vehicle_id, kind, first_seen, last_seen) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen),
         kind = IF(VALUES(kind) = 'UNKNOWN', kind, VALUES(kind))`,
    [vehicleId, kind || "UNKNOWN", ts, ts],
  );
  const [rows] = await pool.query(
    "SELECT vehicle_key FROM dim_vehicle WHERE vehicle_id = ?",
    [vehicleId],
  );
  const k = (rows as { vehicle_key: number }[])[0]?.vehicle_key;
  if (k) keys.vehicle.set(vehicleId, k);
  return k;
}

const GTFS_TYPE_TRAM = "900";

export async function syncDimensions(
  pool: Pool,
): Promise<Record<string, number>> {
  const ts = nowSql();
  const stat: Record<string, number> = {
    routes: 0,
    stops: 0,
    patterns: 0,
    segments: 0,
  };

  const routeRows = [...routes.values()].map((r) => [
    r.short || r.id,
    r.id,
    r.long || null,
    r.type === GTFS_TYPE_TRAM ? "TRAM" : "BUS",
    r.color || null,
    r.text || null,
  ]);
  if (routeRows.length) {
    await pool.query(
      `INSERT INTO dim_route (route_short, gtfs_route_id, long_name, kind, color, text_color) VALUES ?
         ON DUPLICATE KEY UPDATE gtfs_route_id = VALUES(gtfs_route_id), long_name = VALUES(long_name),
           kind = VALUES(kind), color = VALUES(color), text_color = VALUES(text_color)`,
      [routeRows],
    );
    stat.routes = routeRows.length;
  }

  const stopRows = [...stops.values()].map((s) => [
    s.id,
    s.code || null,
    s.name,
    e7(s.lat),
    e7(s.lon),
    ts,
    ts,
  ]);
  if (stopRows.length) {
    await pool.query(
      `INSERT INTO dim_stop (gtfs_stop_id, stop_code, name, lat_e7, lon_e7, first_seen, last_seen) VALUES ?
         ON DUPLICATE KEY UPDATE stop_code = VALUES(stop_code), name = VALUES(name),
           lat_e7 = VALUES(lat_e7), lon_e7 = VALUES(lon_e7), last_seen = VALUES(last_seen)`,
      [stopRows],
    );
    stat.stops = stopRows.length;
  }

  await loadKeys(pool);

  const patternSeen = new Map<
    string,
    { routeKey: number; dir: number; n: number; headsign: string }
  >();
  for (const [tripId, t] of trips) {
    const h = patternHash(tripId);
    if (!h) continue;
    const routeKey = keys.route.get(routes.get(t.routeId)?.short || t.routeId);
    if (!routeKey) continue;
    if (!patternSeen.has(h)) {
      patternSeen.set(h, {
        routeKey,
        dir: Number(t.dir) || 0,
        n: tripStops.get(tripId)?.length ?? 0,
        headsign: t.headsign,
      });
    }
  }
  const patRows = [...patternSeen].map(([h, p]) => [
    h,
    p.routeKey,
    p.dir,
    Math.min(p.n, 255),
    p.headsign || null,
    ts,
    ts,
  ]);
  if (patRows.length) {
    await pool.query(
      `INSERT INTO dim_pattern (pattern_hash, route_key, direction, n_stops, headsign, first_seen, last_seen) VALUES ?
         ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), headsign = VALUES(headsign)`,
      [patRows],
    );
    stat.patterns = patRows.length;
  }

  const segSeen = new Map<
    string,
    { from: number; to: number; dist: number | null }
  >();
  for (const tripId of trips.keys()) {
    const along = tripStopsAlong(tripId);
    const seq =
      along ??
      tripStops
        .get(tripId)
        ?.map((x) => ({ ...x, alongM: null as number | null }));
    if (!seq || seq.length < 2) continue;
    for (let i = 0; i < seq.length - 1; i++) {
      const a = keys.stop.get(seq[i].stopId);
      const b = keys.stop.get(seq[i + 1].stopId);
      if (!a || !b || a === b) continue;
      const pk = segPairKey(a, b);
      if (segSeen.has(pk)) continue;
      const am = seq[i].alongM;
      const bm = seq[i + 1].alongM;
      segSeen.set(pk, {
        from: a,
        to: b,
        dist:
          am != null && bm != null && bm > am
            ? Math.min(bm - am, 16_777_215)
            : null,
      });
    }
  }
  const segRows = [...segSeen.values()].map((s) => [s.from, s.to, s.dist]);
  if (segRows.length) {
    await pool.query(
      `INSERT INTO dim_segment (from_stop_key, to_stop_key, dist_m) VALUES ?
         ON DUPLICATE KEY UPDATE dist_m = COALESCE(VALUES(dist_m), dist_m)`,
      [segRows],
    );
    stat.segments = segRows.length;
  }

  const fv = getFeedVersion();
  if (fv) {
    await pool.query(
      `INSERT INTO gtfs_snapshot (feed_version, captured_at, n_stops, n_routes, n_trips) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE captured_at = captured_at`,
      [fv, ts, stops.size, routes.size, trips.size],
    );
  }

  await loadKeys(pool);
  return stat;
}
