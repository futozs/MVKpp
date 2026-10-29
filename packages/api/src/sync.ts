/**
 * /v3/sync — kétirányú, kulcsonkénti felhős szinkron.
 *
 * Minden mvk_* localStorage-kulcs külön sor; a később módosított nyer
 * (last-write-wins a szerkesztés ideje szerint; a letöltés kurzora a szerver
 * írási ideje, így a késő órájú vagy offline eszköz módosítása is átér). Új eszközön
 * bejelentkezve az összes kedvenc és beállítás letöltődik; változáskor a
 * többi bejelentkezett eszköz WebSocketen azonnal értesül.
 */
import { getPool, sql } from "@mvk/db";
import { ApiError, body, dispatch, json, route, type Route } from "./http.ts";
import { requireUser } from "./account.ts";

export type StateItem = { key: string; value: unknown; deleted?: boolean; updatedAt: string };

const KEY_RE = /^mvk_[a-z0-9_:-]{1,80}$/i;
const MAX_ITEMS = 200;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_USER_BYTES = 4 * 1024 * 1024;
/** Eszközhöz kötött kulcsok: ezeket nem szinkronizáljuk (pl. a telepítési banner elrejtése). */
// Ugyanaz a lista, mint a kliensen (apps/web/src/lib/sync.ts). Az mvk_account
// a munkamenet-tokent tartalmazza: az SOHA nem kerülhet a szerverre.
// Az értesítés-figyelések az adott eszköz push-feliratkozásához tartoznak, a
// helymeghatározás engedélye is eszközönkénti — ezek sem utazhatnak át.
export const DEVICE_ONLY = new Set([
  "mvk_account",
  "mvk_device_id",
  "mvk_sync_meta",
  "mvk_install_dismissed",
  "mvk_geo_last_fix",
  "mvk_geo_enabled",
  "mvk_notify_watches",
  "mvk_notify_settings",
  "mvk_view_state",
  "mvk_map_view",
  "mvk_timetable_view",
  "mvk_rides",
  "mvk_ride_active",
  "mvk_ride_deleted",
  "mvk_heat_route",
  "mvk_map_panel",
  "mvk_watch_view",
  // az eszköz push-feliratkozásához tartozó különleges értesítések
  "mvk_alert_watches",
]);

export async function applyState(userId: string, items: StateItem[], deviceId: string | null): Promise<{ applied: string[]; stale: StateItem[] }> {
  const applied: string[] = [];
  const stale: StateItem[] = [];
  const now = Date.now();
  for (const it of items.slice(0, MAX_ITEMS)) {
    if (!KEY_RE.test(it.key) || DEVICE_ONLY.has(it.key)) continue;
    const size = JSON.stringify(it.value ?? null).length;
    if (size > MAX_VALUE_BYTES) continue;
    let t = Date.parse(it.updatedAt);
    if (!Number.isFinite(t)) t = now;
    // A jövőbe mutató kliens-óra ne „nyerjen” örökre.
    if (t > now + 60_000) t = now;
    const r = await getPool().query<{ key: string }>(
      `INSERT INTO user_state (user_id, key, value, deleted, updated_at, device_id) VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, deleted = EXCLUDED.deleted, updated_at = EXCLUDED.updated_at,
         device_id = EXCLUDED.device_id, synced_at = now()
         WHERE user_state.updated_at < EXCLUDED.updated_at
       RETURNING key`,
      [userId, it.key, JSON.stringify(it.value ?? null), Boolean(it.deleted), t, deviceId],
    );
    if (r.rowCount) applied.push(it.key);
    else {
      const cur = await sql<{ value: unknown; deleted: boolean; updated_at: Date }>(`SELECT value, deleted, updated_at FROM user_state WHERE user_id = $1 AND key = $2`, [userId, it.key]);
      if (cur[0]) stale.push({ key: it.key, value: cur[0].value, deleted: cur[0].deleted, updatedAt: cur[0].updated_at.toISOString() });
    }
  }
  if (applied.length) {
    await getPool().query(`SELECT pg_notify('mvk_events', $1)`, [JSON.stringify({ type: "sync", userId, keys: applied.slice(0, 50), deviceId })]);
  }
  return { applied, stale };
}

const routes: Route[] = [
  route("GET", "/v3/sync", async (req, _p, url) => {
    const u = await requireUser(req);
    const since = url.searchParams.get("since");
    const sinceOk = since && Number.isFinite(Date.parse(since)) ? since : null;
    // A kurzor a szerver írási ideje (synced_at): amit a kliens a legutóbbi
    // `serverTime` óta nem látott, az mind jön — a szerkesztő eszköz órájától függetlenül.
    const serverTime = new Date().toISOString();
    const rows = await sql<{ key: string; value: unknown; deleted: boolean; updated_at: Date }>(
      `SELECT key, value, deleted, updated_at FROM user_state WHERE user_id = $1 ${sinceOk ? "AND synced_at > $2::timestamptz - interval '5 seconds'" : ""} ORDER BY synced_at`,
      sinceOk ? [u.id, sinceOk] : [u.id],
    );
    return json({
      serverTime,
      email: u.email,
      items: rows.map((r) => ({ key: r.key, value: r.value, deleted: r.deleted, updatedAt: r.updated_at.toISOString() })),
    });
  }),

  route("PUT", "/v3/sync", async (req) => {
    const u = await requireUser(req);
    const b = await body<{ deviceId?: string; items?: StateItem[] }>(req);
    if (!b || !Array.isArray(b.items)) throw new ApiError(400, "hiányzó items[]");
    const usage = await sql<{ bytes: number }>(`SELECT coalesce(sum(length(value::text)), 0)::int AS bytes FROM user_state WHERE user_id = $1`, [u.id]);
    if ((usage[0]?.bytes ?? 0) > MAX_USER_BYTES) throw new ApiError(413, "A fiók szinkron-tárhelye megtelt.");
    const r = await applyState(u.id, b.items, typeof b.deviceId === "string" ? b.deviceId.slice(0, 64) : null);
    return json({ ok: true, serverTime: new Date().toISOString(), ...r });
  }),
];

export const handleSync = (req: Request) => dispatch(routes, req);
