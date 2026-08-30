/**
 * Roller — aggregátumok építése.
 *
 * Minden UI-chart és minden előrejelzés KIZÁRÓLAG az itt előállított L2
 * táblákból olvas. Ettől marad a felület milliszekundumos akkor is, ha alatta
 * évek adata van: a nehéz munka éjszaka fut le egyszer, nem kérésenként.
 *
 * A percentiliseket ablakfüggvénnyel számoljuk az adatbázisban, nem Node-ban:
 * így a több millió szakaszmérés soha nem utazik át a hálózaton.
 */
import type { Pool } from 'mysql2/promise'

/** Menetrendtartási ablak: 1 perc sietéstől 5 perc késésig. */
export const OTP_EARLY_S = -60
export const OTP_LATE_S = 300
/** A szakaszprofil gördülő tanulóablaka. */
export const PROFILE_WINDOW_DAYS = Number(process.env.PROFILE_WINDOW_DAYS ?? 120)
/** Ennél kisebb követési idő torlódásnak számít. */
const BUNCHING_S = 120

/**
 * Szakaszprofil: (megállóköz × naptípus × tanév × 15 perces sáv) -> percentilisek.
 * Ez válaszolja meg a „mennyi idő A-ból B-be" kérdést.
 */
export async function rollSegmentProfile(pool: Pool, days = PROFILE_WINDOW_DAYS): Promise<number> {
  const [res] = await pool.query(
    `INSERT INTO agg_segment_profile
       (segment_key, daytype, school, tod_bucket, n, p50_s, p85_s, p95_s, mean_s, sd_s, sched_s, updated_at)
     SELECT segment_key, daytype, school, tod_bucket, n,
            MAX(CASE WHEN rn = r50 THEN travel_s END),
            MAX(CASE WHEN rn = r85 THEN travel_s END),
            MAX(CASE WHEN rn = r95 THEN travel_s END),
            ROUND(AVG(travel_s)),
            ROUND(COALESCE(STDDEV_SAMP(travel_s), 0)),
            ROUND(AVG(sched_s)),
            NOW()
       FROM (
         SELECT segment_key, daytype, school, tod_bucket, travel_s, sched_s,
                ROW_NUMBER() OVER w AS rn,
                COUNT(*)     OVER w AS n,
                GREATEST(1, CEIL(COUNT(*) OVER w * 0.50)) AS r50,
                GREATEST(1, CEIL(COUNT(*) OVER w * 0.85)) AS r85,
                GREATEST(1, CEIL(COUNT(*) OVER w * 0.95)) AS r95
           FROM segment_run
          WHERE service_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         WINDOW w AS (PARTITION BY segment_key, daytype, school, tod_bucket ORDER BY travel_s)
       ) x
      GROUP BY segment_key, daytype, school, tod_bucket, n
     ON DUPLICATE KEY UPDATE
       n = VALUES(n), p50_s = VALUES(p50_s), p85_s = VALUES(p85_s), p95_s = VALUES(p95_s),
       mean_s = VALUES(mean_s), sd_s = VALUES(sd_s), sched_s = VALUES(sched_s),
       updated_at = VALUES(updated_at)`,
    [days]
  )
  return (res as { affectedRows: number }).affectedRows
}

/** Napi járműösszegzés: km, üzemidő, késés, telephely. */
export async function rollVehicleDay(pool: Pool, isoDate: string): Promise<number> {
  await pool.query(
    `INSERT INTO agg_vehicle_day
       (vehicle_key, service_date, runs, routes_n, dist_m, service_s, moving_s, dwell_s,
        max_speed_dms, first_ts, last_ts, gaps_n)
     SELECT vehicle_key, service_date,
            COUNT(*), COUNT(DISTINCT route_key),
            COALESCE(SUM(dist_m), 0),
            COALESCE(SUM(GREATEST(0, COALESCE(actual_end, 0) - COALESCE(actual_start, 0))), 0),
            COALESCE(SUM(moving_s), 0), COALESCE(SUM(dwell_s), 0),
            MAX(max_speed_dms), MIN(actual_start), MAX(actual_end),
            SUM(status = 'partial' OR status = 'aborted')
       FROM trip_run
      WHERE service_date = ? AND vehicle_key > 0 AND status <> 'ghost'
      GROUP BY vehicle_key, service_date
     ON DUPLICATE KEY UPDATE
       runs = VALUES(runs), routes_n = VALUES(routes_n), dist_m = VALUES(dist_m),
       service_s = VALUES(service_s), moving_s = VALUES(moving_s), dwell_s = VALUES(dwell_s),
       max_speed_dms = VALUES(max_speed_dms), first_ts = VALUES(first_ts),
       last_ts = VALUES(last_ts), gaps_n = VALUES(gaps_n)`,
    [isoDate]
  )

  // Késésmutatók a megálló-eseményekből.
  await pool.query(
    `UPDATE agg_vehicle_day a
       JOIN (
         SELECT vehicle_key, ROUND(AVG(delay_s)) AS avg_d,
                MAX(CASE WHEN rn = r85 THEN delay_s END) AS p85_d
           FROM (
             SELECT vehicle_key, delay_s,
                    ROW_NUMBER() OVER w AS rn,
                    GREATEST(1, CEIL(COUNT(*) OVER w * 0.85)) AS r85
               FROM stop_event
              WHERE service_date = ? AND delay_s IS NOT NULL
             WINDOW w AS (PARTITION BY vehicle_key ORDER BY delay_s)
           ) t GROUP BY vehicle_key
       ) d ON d.vehicle_key = a.vehicle_key
      SET a.avg_delay_s = d.avg_d, a.p85_delay_s = d.p85_d
    WHERE a.service_date = ?`,
    [isoDate, isoDate]
  )

  // Telephely: a nap első pontjának helye. A ping-táblán ez indexelt keresés
  // járművenként, mert a kulcs (vehicle_key, feed_ts) szerint klaszterezett.
  const [vehicles] = await pool.query(
    `SELECT vehicle_key FROM agg_vehicle_day WHERE service_date = ?`,
    [isoDate]
  )
  for (const v of vehicles as { vehicle_key: number }[]) {
    await pool.query(
      `UPDATE agg_vehicle_day a
          SET depot_lat_e7 = (SELECT lat_e7 FROM veh_ping
                               WHERE vehicle_key = ? AND service_date = ? ORDER BY feed_ts LIMIT 1),
              depot_lon_e7 = (SELECT lon_e7 FROM veh_ping
                               WHERE vehicle_key = ? AND service_date = ? ORDER BY feed_ts LIMIT 1)
        WHERE a.vehicle_key = ? AND a.service_date = ?`,
      [v.vehicle_key, isoDate, v.vehicle_key, isoDate, v.vehicle_key, isoDate]
    )
  }
  return (vehicles as unknown[]).length
}

/** Vonal-nap: menetrendtartás, késéseloszlás, szellemmenetek, torlódás. */
export async function rollRouteDay(pool: Pool, isoDate: string): Promise<number> {
  await pool.query(
    `INSERT INTO agg_route_day
       (route_key, service_date, direction, runs, ghost_runs, events_n,
        otp_pct, early_pct, late_pct, avg_delay_s, p50_delay_s, p85_delay_s, p95_delay_s, bunching_n)
     SELECT route_key, service_date, direction,
            SUM(status <> 'ghost'), SUM(status = 'ghost'), 0,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0
       FROM trip_run
      WHERE service_date = ?
      GROUP BY route_key, service_date, direction
     ON DUPLICATE KEY UPDATE runs = VALUES(runs), ghost_runs = VALUES(ghost_runs)`,
    [isoDate]
  )

  // A megálló-események vonalanként — irány nélkül, mert az esemény nem hordoz
  // irányt; a menetből kellene visszakeresni, ami itt fölösleges kör.
  await pool.query(
    `UPDATE agg_route_day a
       JOIN (
         SELECT route_key, COUNT(*) AS n,
                ROUND(100 * SUM(delay_s BETWEEN ? AND ?) / COUNT(*)) AS otp,
                ROUND(100 * SUM(delay_s < ?) / COUNT(*)) AS early,
                ROUND(100 * SUM(delay_s > ?) / COUNT(*)) AS late,
                ROUND(AVG(delay_s)) AS avg_d,
                MAX(CASE WHEN rn = r50 THEN delay_s END) AS p50,
                MAX(CASE WHEN rn = r85 THEN delay_s END) AS p85,
                MAX(CASE WHEN rn = r95 THEN delay_s END) AS p95
           FROM (
             SELECT route_key, delay_s,
                    ROW_NUMBER() OVER w AS rn,
                    GREATEST(1, CEIL(COUNT(*) OVER w * 0.50)) AS r50,
                    GREATEST(1, CEIL(COUNT(*) OVER w * 0.85)) AS r85,
                    GREATEST(1, CEIL(COUNT(*) OVER w * 0.95)) AS r95
               FROM stop_event
              WHERE service_date = ? AND delay_s IS NOT NULL
             WINDOW w AS (PARTITION BY route_key ORDER BY delay_s)
           ) t GROUP BY route_key
       ) d ON d.route_key = a.route_key
      SET a.events_n = d.n, a.otp_pct = d.otp, a.early_pct = d.early, a.late_pct = d.late,
          a.avg_delay_s = d.avg_d, a.p50_delay_s = d.p50, a.p85_delay_s = d.p85, a.p95_delay_s = d.p95
    WHERE a.service_date = ?`,
    [OTP_EARLY_S, OTP_LATE_S, OTP_EARLY_S, OTP_LATE_S, isoDate, isoDate]
  )

  // Torlódás: ugyanazon a vonalon, ugyanabban a megállóban két jármű két
  // percen belül. A követési időt is itt számoljuk ki visszamenőleg.
  await pool.query(
    `UPDATE stop_event e
       JOIN (
         SELECT stop_key, route_key, arr_ts, service_date,
                arr_ts - LAG(arr_ts) OVER (PARTITION BY stop_key, route_key ORDER BY arr_ts) AS hw
           FROM stop_event
          WHERE service_date = ? AND arr_ts IS NOT NULL
       ) h ON h.stop_key = e.stop_key AND h.route_key = e.route_key
          AND h.arr_ts = e.arr_ts AND h.service_date = e.service_date
      SET e.headway_s = h.hw
    WHERE e.service_date = ? AND h.hw IS NOT NULL AND h.hw > 0`,
    [isoDate, isoDate]
  )

  await pool.query(
    `UPDATE agg_route_day a
       JOIN (
         SELECT route_key, SUM(headway_s < ?) AS bn
           FROM stop_event WHERE service_date = ? AND headway_s IS NOT NULL
          GROUP BY route_key
       ) b ON b.route_key = a.route_key
      SET a.bunching_n = b.bn
    WHERE a.service_date = ?`,
    [BUNCHING_S, isoDate, isoDate]
  )
  return 1
}

/**
 * Megálló-óra: pontosság, tartózkodási idő, követési idő.
 * Az `hour` az ÜZEMI nap kezdetétől számít, ezért éjfél utáni járatoknál
 * 24–26 is lehet — ez szándékos, így nem csúszik át a következő napra.
 */
export async function rollStopHour(pool: Pool, isoDate: string, midnightUnix: number): Promise<number> {
  const [res] = await pool.query(
    `INSERT INTO agg_stop_hour
       (stop_key, service_date, hour, events_n, otp_pct, avg_delay_s, p85_delay_s, avg_dwell_s, avg_headway_s)
     SELECT stop_key, service_date, hour, n, otp, avg_d,
            MAX(CASE WHEN rn = r85 THEN delay_s END), avg_dw, avg_hw
       FROM (
         SELECT stop_key, service_date, delay_s,
                LEAST(255, GREATEST(0, FLOOR((arr_ts - ?) / 3600))) AS hour,
                ROW_NUMBER() OVER w AS rn,
                COUNT(*)     OVER w AS n,
                GREATEST(1, CEIL(COUNT(*) OVER w * 0.85)) AS r85,
                ROUND(AVG(delay_s) OVER w) AS avg_d,
                ROUND(100 * AVG(delay_s BETWEEN ? AND ?) OVER w) AS otp,
                ROUND(AVG(dwell_s) OVER w) AS avg_dw,
                ROUND(AVG(headway_s) OVER w) AS avg_hw
           FROM stop_event
          WHERE service_date = ? AND arr_ts IS NOT NULL AND delay_s IS NOT NULL
         WINDOW w AS (PARTITION BY stop_key, LEAST(255, GREATEST(0, FLOOR((arr_ts - ?) / 3600))))
       ) x
      GROUP BY stop_key, service_date, hour, n, otp, avg_d, avg_dw, avg_hw
     ON DUPLICATE KEY UPDATE
       events_n = VALUES(events_n), otp_pct = VALUES(otp_pct), avg_delay_s = VALUES(avg_delay_s),
       p85_delay_s = VALUES(p85_delay_s), avg_dwell_s = VALUES(avg_dwell_s),
       avg_headway_s = VALUES(avg_headway_s)`,
    [midnightUnix, OTP_EARLY_S, OTP_LATE_S, isoDate, midnightUnix]
  )
  return (res as { affectedRows: number }).affectedRows
}

/**
 * Jármű–vonal megoszlás havonta. Ez válaszolja meg a „milyen vonalakon szokott
 * ez a busz járni" kérdést — a kulcs pontosan a kérdés alakja.
 */
export async function rollVehicleRoute(pool: Pool, ym: number): Promise<number> {
  const [res] = await pool.query(
    `INSERT INTO agg_vehicle_route
       (vehicle_key, period_ym, route_key, runs, share_pct, dist_km, service_s, days_active,
        avg_delay_s, p85_delay_s)
     SELECT t.vehicle_key, ? AS period_ym, t.route_key,
            COUNT(*) AS runs,
            LEAST(100, ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY t.vehicle_key))) AS share_pct,
            ROUND(COALESCE(SUM(t.dist_m), 0) / 1000) AS dist_km,
            COALESCE(SUM(GREATEST(0, COALESCE(t.actual_end,0) - COALESCE(t.actual_start,0))), 0) AS service_s,
            COUNT(DISTINCT t.service_date) AS days_active,
            ROUND(AVG(t.start_delay_s)) AS avg_delay_s,
            NULL
       FROM trip_run t
      WHERE t.vehicle_key > 0 AND t.status <> 'ghost'
        AND DATE_FORMAT(t.service_date, '%Y%m') = ?
      GROUP BY t.vehicle_key, t.route_key
     ON DUPLICATE KEY UPDATE
       runs = VALUES(runs), share_pct = VALUES(share_pct), dist_km = VALUES(dist_km),
       service_s = VALUES(service_s), days_active = VALUES(days_active),
       avg_delay_s = VALUES(avg_delay_s)`,
    [ym, String(ym)]
  )
  return (res as { affectedRows: number }).affectedRows
}
