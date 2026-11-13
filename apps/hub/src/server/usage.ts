/**
 * Ki és hogyan használja az appot: aktív eszközök naponta (DAU / heti / havi),
 * új eszközök, platform és böngésző, telepített app arány, nézetek, és a
 * kedvencek ranglistája (vonal, megálló, jármű, parkoló)  mind a /v3/usage
 * jeleiből. Plusz: ki van fent épp most (a worker WebSocket-hubjából).
 */
import { sql, sqlOne } from "@mvk/db";
import { gtfsNames } from "./services.ts";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function activitySeries(days: number) {
  return sql<{ day: string; dau: number; wau: number; mau: number; fresh: number; returning: number }>(
    `WITH d AS (
       SELECT generate_series((now() AT TIME ZONE 'Europe/Budapest')::date - ($1::int - 1), (now() AT TIME ZONE 'Europe/Budapest')::date, '1 day')::date AS day
     )
     SELECT d.day::text AS day,
            (SELECT count(*)::int FROM usage_day u WHERE u.day = d.day) AS dau,
            (SELECT count(DISTINCT device_id)::int FROM usage_day u WHERE u.day BETWEEN d.day - 6 AND d.day) AS wau,
            (SELECT count(DISTINCT device_id)::int FROM usage_day u WHERE u.day BETWEEN d.day - 29 AND d.day) AS mau,
            (SELECT count(*)::int FROM usage_device x WHERE (x.first_seen AT TIME ZONE 'Europe/Budapest')::date = d.day) AS fresh,
            (SELECT count(*)::int FROM usage_day u JOIN usage_device x USING (device_id)
              WHERE u.day = d.day AND (x.first_seen AT TIME ZONE 'Europe/Budapest')::date < d.day) AS returning
       FROM d ORDER BY d.day`,
    [days],
  );
}

export async function usageSummary() {
  const [totals, platforms, browsers, views, recentDevices] = await Promise.all([
    sqlOne<{ devices: number; today: number; week: number; month: number; standalone: number; linked: number; withFavorites: number }>(
      `SELECT count(*)::int AS devices,
              count(*) FILTER (WHERE last_seen > now() - interval '1 day')::int AS today,
              count(*) FILTER (WHERE last_seen > now() - interval '7 days')::int AS week,
              count(*) FILTER (WHERE last_seen > now() - interval '30 days')::int AS month,
              count(*) FILTER (WHERE standalone AND last_seen > now() - interval '30 days')::int AS standalone,
              count(*) FILTER (WHERE user_id IS NOT NULL)::int AS linked,
              count(*) FILTER (WHERE favorites IS NOT NULL AND favorites::text <> '{}')::int AS "withFavorites"
         FROM usage_device`,
    ),
    sql<{ key: string; n: number }>(`SELECT COALESCE(platform, 'other') AS key, count(*)::int AS n FROM usage_device WHERE last_seen > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`),
    sql<{ key: string; n: number }>(`SELECT COALESCE(browser, 'other') AS key, count(*)::int AS n FROM usage_device WHERE last_seen > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`),
    sql<{ key: string; n: number; devices: number }>(
      `SELECT v.key, sum(v.value::int)::int AS n, count(DISTINCT u.device_id)::int AS devices
         FROM usage_day u CROSS JOIN LATERAL jsonb_each_text(u.views) v
        WHERE u.day > (now() AT TIME ZONE 'Europe/Budapest')::date - 30
        GROUP BY 1 ORDER BY 2 DESC`,
    ),
    sql(
      `SELECT d.device_id AS "deviceId", d.platform, d.browser, d.standalone, d.lang, d.screen, d.first_seen AS "firstSeen", d.last_seen AS "lastSeen", d.opens,
              u.email::text AS email, d.user_id AS "userId",
              (SELECT count(*)::int FROM usage_day x WHERE x.device_id = d.device_id) AS "activeDays",
              COALESCE(jsonb_array_length(d.favorites->'lines'), 0) + COALESCE(jsonb_array_length(d.favorites->'stops'), 0)
                + COALESCE(jsonb_array_length(d.favorites->'vehicles'), 0) + COALESCE(jsonb_array_length(d.favorites->'parking'), 0) AS "favoriteCount"
         FROM usage_device d LEFT JOIN app_user u ON u.id = d.user_id
        ORDER BY d.last_seen DESC LIMIT 200`,
    ),
  ]);
  return { totals, platforms, browsers, views, recentDevices };
}

/** A kedvencek ranglistája az elmúlt `days` napban aktív eszközökön, nevekkel. */
export async function favoriteLeaderboard(days: number) {
  const active = `last_seen > now() - make_interval(days => $1)`;
  const [lines, stops, statStops, vehicles, parking, kiosk, names] = await Promise.all([
    sql<{ routeId: string; dir: string; n: number }>(
      `SELECT l->>'routeId' AS "routeId", COALESCE(l->>'dir', '') AS dir, count(*)::int AS n
         FROM usage_device, jsonb_array_elements(favorites->'lines') l WHERE ${active} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 40`,
      [days],
    ),
    topIds("stops", days),
    topIds("statStops", days),
    topIds("vehicles", days),
    topIds("parking", days),
    topIds("kiosk", days),
    gtfsNames(),
  ]);
  const stopName = (id: string) => names.stops.get(id) ?? id;
  return {
    lines: lines.map((l) => {
      const r = names.routes.get(l.routeId);
      return { ...l, short: r?.short ?? l.routeId, long: r?.long ?? "", color: r?.color ?? "888888", text: r?.text ?? "FFFFFF" };
    }),
    stops: stops.map((s) => ({ ...s, name: stopName(s.id) })),
    statStops: statStops.map((s) => ({ ...s, name: stopName(s.id) })),
    vehicles,
    parking: parking.map((p) => ({ ...p, name: p.id.replace(/^t:/, "").replace(/^d:/, "kocsiszín: ") })),
    kiosk: kiosk.map((s) => ({ ...s, name: stopName(s.id) })),
  };
}

async function topIds(field: string, days: number) {
  return sql<{ id: string; n: number }>(
    `SELECT x AS id, count(*)::int AS n
       FROM usage_device, jsonb_array_elements_text(favorites->$2) x
      WHERE last_seen > now() - make_interval(days => $1)
      GROUP BY 1 ORDER BY 2 DESC LIMIT 40`,
    [days, field],
  );
}

export async function deviceDetail(deviceId: string) {
  if (!/^[\w-]{8,64}$/.test(deviceId)) return null;
  const d = await sqlOne<Record<string, unknown>>(
    `SELECT d.*, u.email::text AS email FROM usage_device d LEFT JOIN app_user u ON u.id = d.user_id WHERE d.device_id = $1`,
    [deviceId],
  );
  if (!d) return null;
  const days = await sql<{ day: string; hits: number; views: Record<string, number> }>(`SELECT day::text, hits, views FROM usage_day WHERE device_id = $1 ORDER BY day DESC LIMIT 60`, [deviceId]);
  return { device: d, days: days.filter((x) => DAY_RE.test(x.day)) };
}
