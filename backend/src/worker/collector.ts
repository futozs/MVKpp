import type { Pool } from "mysql2/promise";
import { budapestOffsetSec, routes, serviceNow } from "../lib/gtfs.ts";
import { keys, vehicleKey } from "../db/dims.ts";

const GATEWAY = process.env.STATS_GATEWAY ?? "http://127.0.0.1:8088";
export const COLLECT_INTERVAL_MS = Number(
  process.env.COLLECT_INTERVAL_MS ?? 5000,
);

type FeedVehicle = {
  id: string;
  label?: string;
  routeId?: string;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  speed: number | null;
  tripId?: string;
  timestamp: number | null;
};

export type CollectResult = {
  kept: number;
  dup: number;
  vehicles: number;
  ok: boolean;
  error?: string;
};

const e7 = (v: number) => Math.round(v * 1e7);
const u = (v: number | null, scale = 1, max = 65535): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  const n = Math.round(v * scale);
  return n < 0 ? null : Math.min(n, max);
};

export async function collectOnce(pool: Pool): Promise<CollectResult> {
  let feed: { vehicles: FeedVehicle[] };
  try {
    const res = await fetch(`${GATEWAY}/live/positions`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok)
      return {
        kept: 0,
        dup: 0,
        vehicles: 0,
        ok: false,
        error: `HTTP ${res.status}`,
      };
    feed = (await res.json()) as { vehicles: FeedVehicle[] };
  } catch (e) {
    return {
      kept: 0,
      dup: 0,
      vehicles: 0,
      ok: false,
      error: (e as Error).message,
    };
  }

  const list = (feed.vehicles || []).filter(
    (v) => v.lat != null && v.lon != null && v.timestamp,
  );
  if (!list.length) return { kept: 0, dup: 0, vehicles: 0, ok: true };

  const offset = budapestOffsetSec();

  const rows: unknown[][] = [];
  for (const v of list) {
    const utcTs = Number(v.timestamp) - offset;
    if (!Number.isFinite(utcTs) || utcTs <= 0) continue;

    const vk =
      keys.vehicle.get(v.id) ??
      (await vehicleKey(pool, v.id, v.label || "UNKNOWN"));
    if (!vk) continue;

    const short = v.routeId ? routes.get(v.routeId)?.short || v.routeId : "";
    const rk = short ? (keys.route.get(short) ?? null) : null;

    rows.push([
      serviceNow(utcTs).isoDate,
      vk,
      utcTs,
      e7(v.lat as number),
      e7(v.lon as number),
      u(v.speed, 10),
      u(v.bearing, 1, 359),
      rk,
      v.tripId || null,
    ]);
  }
  if (!rows.length) return { kept: 0, dup: 0, vehicles: list.length, ok: true };

  const [res] = await pool.query(
    `INSERT IGNORE INTO veh_ping
       (service_date, vehicle_key, feed_ts, lat_e7, lon_e7, speed_dms, bearing_deg, route_key, trip_hint)
     VALUES ?`,
    [rows],
  );
  const kept = (res as { affectedRows: number }).affectedRows;
  return { kept, dup: rows.length - kept, vehicles: list.length, ok: true };
}

export async function recordHealth(
  pool: Pool,
  r: CollectResult,
): Promise<void> {
  const date = serviceNow().isoDate;
  await pool.query(
    `INSERT INTO feed_health (service_date, polls_ok, polls_fail, pings_kept, pings_dup, vehicles_max)
       VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       polls_ok = polls_ok + VALUES(polls_ok),
       polls_fail = polls_fail + VALUES(polls_fail),
       pings_kept = pings_kept + VALUES(pings_kept),
       pings_dup = pings_dup + VALUES(pings_dup),
       vehicles_max = GREATEST(vehicles_max, VALUES(vehicles_max))`,
    [date, r.ok ? 1 : 0, r.ok ? 0 : 1, r.kept, r.dup, r.vehicles],
  );
}
