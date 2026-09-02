import type { Pool } from "mysql2/promise";

const RECENT_MONTHS = 6;

function monthsBack(ym: number, n: number): number[] {
  const out: number[] = [];
  let y = Math.floor(ym / 100);
  let m = ym % 100;
  for (let i = 0; i < n; i++) {
    out.push(y * 100 + m);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export async function logRoutePrediction(
  pool: Pool,
  runId: number,
  vehicleKey: number,
  serviceDate: string,
  actualRouteKey: number,
): Promise<void> {
  const ym = Number(serviceDate.slice(0, 4) + serviceDate.slice(5, 7));
  const months = monthsBack(ym, RECENT_MONTHS);
  const ph = months.map(() => "?").join(",");

  const [rows] = await pool.query(
    `SELECT route_key, SUM(runs) AS runs
       FROM agg_vehicle_route
      WHERE vehicle_key = ? AND period_ym IN (${ph})
      GROUP BY route_key
      ORDER BY runs DESC`,
    [vehicleKey, ...months],
  );
  const dist = rows as { route_key: number; runs: number }[];
  const total = dist.reduce((a, r) => a + Number(r.runs), 0);
  if (!total) return;

  const top = dist[0];
  const predictedRouteKey = top.route_key;
  const predictedProb = Math.round((100 * Number(top.runs)) / total);
  const correct = predictedRouteKey === actualRouteKey ? 1 : 0;

  try {
    await pool.query(
      `INSERT INTO vehicle_route_prediction
         (vehicle_key, service_date, run_id, predicted_route_key, predicted_prob_pct,
          samples, actual_route_key, correct, created_at)
       VALUES (?,?,?,?,?,?,?,?, UNIX_TIMESTAMP())
       ON DUPLICATE KEY UPDATE run_id = run_id`,
      [
        vehicleKey,
        serviceDate,
        runId,
        predictedRouteKey,
        predictedProb,
        total,
        actualRouteKey,
        correct,
      ],
    );
  } catch {
  }
}
