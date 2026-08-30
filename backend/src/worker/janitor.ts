import type { Pool } from "mysql2/promise";
import {
  PARTITIONED,
  ensurePartitions,
  dropPartitionsBefore,
} from "../db/partitions.ts";
import { PING_RETENTION_DAYS } from "../db/pool.ts";

const GATEWAY = process.env.STATS_GATEWAY ?? "http://127.0.0.1:8088";

export type JanitorResult = { created: string[]; dropped: string[] };

export async function runJanitor(pool: Pool): Promise<JanitorResult> {
  const created: string[] = [];
  const dropped: string[] = [];

  for (const p of PARTITIONED) {
    created.push(...(await ensurePartitions(pool, p.table, p.g, p.ahead)));
  }

  const cutoff = new Date(Date.now() - PING_RETENTION_DAYS * 86400_000);
  dropped.push(
    ...(await dropPartitionsBefore(pool, "veh_ping", "day", cutoff)),
  );

  for (const t of ["stop_event", "segment_run", "trip_run"]) {
    await pool.query(`ANALYZE TABLE \`${t}\``);
  }

  return { created, dropped };
}

export async function captureWeather(pool: Pool): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY}/weather`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const w = (await res.json()) as {
      tempC: number | null;
      feelsLikeC: number | null;
      windKmh: number | null;
      code: number;
    };
    const hourTs = Math.floor(Date.now() / 3600_000) * 3600;
    await pool.query(
      `INSERT INTO wx_hour (hour_ts, temp_c, feels_c, wind_kmh, wmo_code) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE temp_c = VALUES(temp_c), feels_c = VALUES(feels_c),
           wind_kmh = VALUES(wind_kmh), wmo_code = VALUES(wmo_code)`,
      [
        hourTs,
        w.tempC,
        w.feelsLikeC,
        w.windKmh,
        w.code >= 0 && w.code <= 255 ? w.code : null,
      ],
    );
    return true;
  } catch {
    return false;
  }
}
