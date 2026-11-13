/**
 * Felhasználók (passkey-fiókok): lista, részletek, kedvencek, eszközök,
 * utazások, push  és a kezelés (munkamenetek visszavonása, passkey vagy
 * fiók törlése, adatexport).
 */
import { getPool, sql, sqlOne } from "@mvk/db";
import { HubError } from "./http.ts";
import { gtfsNames, type Names } from "./services.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A felhős szinkron kulcsai, amelyek kedvenceket tartanak (érték: a localStorage szövege). */
export const FAVORITE_KEYS: Record<string, string> = {
  mvk_timetable_favorites: "lines",
  mvk_monitored_stops: "stops",
  mvk_stats_favorite_stops: "statStops",
  mvk_stats_favorite_vehicles: "vehicles",
  mvk_parking_favorites: "parking",
  mvk_kiosk_stops: "kiosk",
};

export function assertUuid(id: string): string {
  if (!UUID_RE.test(id)) throw new HubError(400, "érvénytelen felhasználó-azonosító");
  return id;
}

function parseStored(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export type UserRow = {
  id: string;
  email: string;
  createdAt: string;
  legacyId: number | null;
  passkeys: number;
  sessions: number;
  lastSeen: string | null;
  devices: number;
  rides: number;
  pushSubs: number;
  stateKeys: number;
  favorites: Record<string, number>;
};

export async function listUsers(q: string, limit: number): Promise<{ total: number; users: UserRow[] }> {
  const rows = await sql<Omit<UserRow, "favorites">>(
    `SELECT u.id, u.email::text AS email, u.created_at AS "createdAt", u.legacy_account_id AS "legacyId",
            (SELECT count(*)::int FROM passkey p WHERE p.user_id = u.id) AS passkeys,
            (SELECT count(*)::int FROM user_session s WHERE s.user_id = u.id AND s.expires_at > now()) AS sessions,
            (SELECT max(s.last_seen_at) FROM user_session s WHERE s.user_id = u.id) AS "lastSeen",
            (SELECT count(*)::int FROM usage_device d WHERE d.user_id = u.id) AS devices,
            (SELECT count(*)::int FROM ride r WHERE r.user_id = u.id) AS rides,
            (SELECT count(*)::int FROM push_subscription ps WHERE ps.user_id = u.id) AS "pushSubs",
            (SELECT count(*)::int FROM user_state st WHERE st.user_id = u.id AND NOT st.deleted) AS "stateKeys"
       FROM app_user u
      WHERE $1 = '' OR u.email ILIKE '%' || $1 || '%'
      ORDER BY "lastSeen" DESC NULLS LAST, u.created_at DESC
      LIMIT $2`,
    [q, limit],
  );
  const total = (await sqlOne<{ n: number }>(`SELECT count(*)::int AS n FROM app_user`))?.n ?? 0;
  const favRows = rows.length
    ? await sql<{ user_id: string; key: string; value: unknown }>(`SELECT user_id, key, value FROM user_state WHERE user_id = ANY($1::uuid[]) AND key = ANY($2) AND NOT deleted`, [
        rows.map((r) => r.id),
        Object.keys(FAVORITE_KEYS),
      ])
    : [];
  const favs = new Map<string, Record<string, number>>();
  for (const f of favRows) {
    const v = parseStored(f.value);
    const m = favs.get(f.user_id) ?? {};
    m[FAVORITE_KEYS[f.key]] = Array.isArray(v) ? v.length : 0;
    favs.set(f.user_id, m);
  }
  return { total, users: rows.map((r) => ({ ...r, favorites: favs.get(r.id) ?? {} })) };
}

export type NamedFavorites = {
  lines: { routeId: string; dir: string; short: string; color: string; text: string; long: string }[];
  stops: { id: string; name: string }[];
  statStops: { id: string; name: string }[];
  vehicles: string[];
  parking: string[];
  kiosk: { id: string; name: string }[];
};

/** Egy kedvenc-pillanatkép (fiókból vagy eszközről) nevekkel. */
export function nameFavorites(raw: Record<string, unknown>, names: Names): NamedFavorites {
  const arr = (k: string) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]) : []);
  const stop = (id: unknown) => ({ id: String(id), name: names.stops.get(String(id)) ?? String(id) });
  return {
    lines: arr("lines")
      .filter((l): l is { routeId: string; dir: string } => typeof (l as { routeId?: unknown })?.routeId === "string")
      .map((l) => {
        const r = names.routes.get(l.routeId);
        return { routeId: l.routeId, dir: String(l.dir ?? ""), short: r?.short ?? l.routeId, color: r?.color ?? "888888", text: r?.text ?? "FFFFFF", long: r?.long ?? "" };
      }),
    stops: arr("stops").map(stop),
    statStops: arr("statStops").map(stop),
    vehicles: arr("vehicles").map(String),
    parking: arr("parking").map((p) => String(p).replace(/^t:/, "").replace(/^d:/, "kocsiszín: ")),
    kiosk: arr("kiosk").map(stop),
  };
}

export async function userDetail(id: string) {
  assertUuid(id);
  const user = await sqlOne<{ id: string; email: string; createdAt: string; legacyId: number | null }>(
    `SELECT id, email::text AS email, created_at AS "createdAt", legacy_account_id AS "legacyId" FROM app_user WHERE id = $1`,
    [id],
  );
  if (!user) throw new HubError(404, "nincs ilyen felhasználó");
  const [passkeys, sessions, devices, state, rides, rideStats, pushSubs, names] = await Promise.all([
    sql(`SELECT left(credential_id, 12) AS id, device_name AS "deviceName", device_type AS "deviceType", backed_up AS "backedUp", transports, created_at AS "createdAt", last_used_at AS "lastUsedAt" FROM passkey WHERE user_id = $1 ORDER BY created_at`, [id]),
    sql(`SELECT left(token_hash, 10) AS id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", expires_at AS "expiresAt", user_agent AS "userAgent" FROM user_session WHERE user_id = $1 ORDER BY last_seen_at DESC NULLS LAST`, [id]),
    sql(`SELECT device_id AS "deviceId", platform, browser, standalone, first_seen AS "firstSeen", last_seen AS "lastSeen", opens FROM usage_device WHERE user_id = $1 ORDER BY last_seen DESC`, [id]).catch(() => []),
    sql<{ key: string; value: unknown; updatedAt: string; deviceId: string | null }>(`SELECT key, value, updated_at AS "updatedAt", device_id AS "deviceId" FROM user_state WHERE user_id = $1 AND NOT deleted ORDER BY key`, [id]),
    sql(`SELECT data FROM ride WHERE user_id = $1 ORDER BY boarded_at DESC LIMIT 25`, [id]),
    sqlOne(`SELECT count(*)::int AS n, min(boarded_at) AS first, max(boarded_at) AS last FROM ride WHERE user_id = $1`, [id]),
    sql(
      `SELECT ps.id, split_part(split_part(ps.endpoint, '://', 2), '/', 1) AS host, ps.enabled, ps.fail_count AS "failCount", ps.last_success_at AS "lastSuccessAt", ps.created_at AS "createdAt",
              (SELECT count(*)::int FROM push_watch w WHERE w.subscription_id = ps.id) AS watches
         FROM push_subscription ps WHERE ps.user_id = $1 ORDER BY ps.created_at`,
      [id],
    ),
    gtfsNames(),
  ]);
  const favRaw: Record<string, unknown> = {};
  for (const s of state) if (FAVORITE_KEYS[s.key]) favRaw[FAVORITE_KEYS[s.key]] = parseStored(s.value);
  return {
    user,
    passkeys,
    sessions,
    devices,
    favorites: nameFavorites(favRaw, names),
    settings: state.filter((s) => !FAVORITE_KEYS[s.key]).map((s) => ({ key: s.key, value: parseStored(s.value), updatedAt: s.updatedAt })),
    rides: { ...rideStats, recent: rides.map((r) => (r as { data: unknown }).data) },
    push: pushSubs,
  };
}

export async function revokeSessions(id: string): Promise<number> {
  const r = await getPool().query(`DELETE FROM user_session WHERE user_id = $1`, [assertUuid(id)]);
  return r.rowCount ?? 0;
}

export async function deletePasskey(userId: string, credPrefix: string): Promise<number> {
  if (!/^[\w-]{6,40}$/.test(credPrefix)) throw new HubError(400, "érvénytelen passkey");
  const r = await getPool().query(`DELETE FROM passkey WHERE user_id = $1 AND left(credential_id, 12) = $2`, [assertUuid(userId), credPrefix]);
  return r.rowCount ?? 0;
}

export async function deleteUser(id: string): Promise<boolean> {
  const r = await getPool().query(`DELETE FROM app_user WHERE id = $1`, [assertUuid(id)]);
  return (r.rowCount ?? 0) > 0;
}

/** Minden, amit a rendszer a felhasználóról tárol (GDPR-hozzáférési kérés)  a munkamenet-hash-ek nélkül. */
export async function exportUser(id: string) {
  assertUuid(id);
  const [user, state, rides, passkeys, push, devices] = await Promise.all([
    sqlOne(`SELECT id, email::text AS email, created_at, legacy_account_id FROM app_user WHERE id = $1`, [id]),
    sql(`SELECT key, value, updated_at, device_id FROM user_state WHERE user_id = $1 ORDER BY key`, [id]),
    sql(`SELECT ride_id, boarded_at, data FROM ride WHERE user_id = $1 ORDER BY boarded_at`, [id]),
    sql(`SELECT device_name, device_type, backed_up, created_at, last_used_at FROM passkey WHERE user_id = $1`, [id]),
    sql(
      `SELECT ps.created_at, ps.enabled, ps.dnd_start_min, ps.dnd_end_min, ps.user_agent,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('stop', w.stop_name, 'kind', w.kind, 'routes', w.route_shorts, 'threshold', w.threshold_min)) FROM push_watch w WHERE w.subscription_id = ps.id), '[]') AS watches
         FROM push_subscription ps WHERE ps.user_id = $1`,
      [id],
    ),
    sql(`SELECT device_id, platform, browser, standalone, first_seen, last_seen, opens, favorites FROM usage_device WHERE user_id = $1`, [id]).catch(() => []),
  ]);
  if (!user) throw new HubError(404, "nincs ilyen felhasználó");
  return { exportedAt: new Date().toISOString(), user, state: state.map((s) => ({ ...s, value: parseStored((s as { value: unknown }).value) })), rides, passkeys, push, devices };
}
