/**
 * Üzemi adatok, amelyek nem érdemelnek külön modult: push-értesítések,
 * ütemezett feladatok (pg-boss), MVK-feed egészség és GTFS-verziók.
 */
import { sql } from "@mvk/db";
import { settle } from "./http.ts";
import { workerJson } from "./services.ts";

export async function pushOverview() {
  const [subs, byHost, watches, deliveries, failures] = await Promise.all([
    sql(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled, count(*) FILTER (WHERE fail_count > 0)::int AS failing,
              count(*) FILTER (WHERE user_id IS NOT NULL)::int AS linked, count(*) FILTER (WHERE last_success_at > now() - interval '7 days')::int AS "deliveredWeek"
         FROM push_subscription`,
    ).then((r) => r[0]),
    sql(
      `SELECT CASE WHEN endpoint LIKE '%push.apple.com%' THEN 'Apple' WHEN endpoint LIKE '%googleapis.com%' THEN 'Google (FCM)'
                   WHEN endpoint LIKE '%mozilla%' THEN 'Mozilla' WHEN endpoint LIKE '%windows%' OR endpoint LIKE '%notify.windows%' THEN 'Windows' ELSE 'egyéb' END AS host,
              count(*)::int AS n
         FROM push_subscription GROUP BY 1 ORDER BY 2 DESC`,
    ),
    sql(`SELECT kind, count(*)::int AS n, count(DISTINCT stop_id)::int AS stops FROM push_watch GROUP BY 1 ORDER BY 2 DESC`),
    sql(
      `SELECT (created_at AT TIME ZONE 'Europe/Budapest')::date::text AS day, status, count(*)::int AS n
         FROM push_delivery WHERE created_at > now() - interval '14 days' GROUP BY 1, 2 ORDER BY 1`,
    ),
    sql(
      `SELECT d.created_at AS "createdAt", d.kind, d.status, d.attempts, d.last_error AS "lastError", w.stop_name AS "stopName", d.trip_id AS "tripId"
         FROM push_delivery d JOIN push_watch w ON w.id = d.watch_id
        WHERE d.status IN ('failed', 'gone') ORDER BY d.created_at DESC LIMIT 30`,
    ),
  ]);
  const topStops = await sql(`SELECT stop_name AS name, stop_id AS id, count(*)::int AS n FROM push_watch GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15`);
  return { subs, byHost, watches, deliveries, failures, topStops };
}

export async function jobsOverview() {
  const [schedules, recent, lastRuns, jobState, runs, ml, predictor] = await Promise.all([
    settle(sql(`SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name`)),
    settle(
      sql(
        `SELECT name, state::text AS state, count(*)::int AS n FROM pgboss.job
          WHERE created_on > now() - interval '2 days' AND name NOT LIKE '__pgboss%' GROUP BY 1, 2 ORDER BY 1, 2`,
      ),
    ),
    settle(
      sql(
        `SELECT DISTINCT ON (name) name, state::text AS state, started_on AS "startedOn", completed_on AS "completedOn",
                EXTRACT(epoch FROM completed_on - started_on)::int AS seconds, left(output::text, 400) AS output
           FROM pgboss.job WHERE name NOT LIKE '__pgboss%' AND started_on IS NOT NULL
          ORDER BY name, started_on DESC`,
      ),
    ),
    settle(sql(`SELECT job, last_ok_at AS "lastOkAt", last_error AS "lastError", last_error_at AS "lastErrorAt", info FROM job_state ORDER BY job`)),
    settle(workerJson<{ jobs: string[]; running: string[]; runs: unknown[] }>("/system/jobs/runs")),
    settle(workerJson("/engine/ml/status")),
    settle(workerJson("/engine/predict/status")),
  ]);
  return { schedules, recent, lastRuns, jobState, runs, ml, predictor };
}

export async function feedOverview() {
  const [health, feeds] = await Promise.all([
    sql(
      `SELECT service_date::text AS day, polls_ok AS ok, polls_fail AS fail, pings_kept AS pings, vehicles_max AS "vehiclesMax"
         FROM feed_health ORDER BY service_date DESC LIMIT 45`,
    ),
    sql(
      `SELECT id, version, fetched_at AS "fetchedAt", start_date::text AS "startDate", end_date::text AS "endDate",
              n_stops AS stops, n_routes AS routes, n_trips AS trips, status, left(validation::text, 600) AS validation, octet_length(zip) AS "zipBytes"
         FROM gtfs_feed ORDER BY fetched_at DESC LIMIT 25`,
    ),
  ]);
  return { health: health.reverse(), feeds };
}
