/**
 * v2 (MySQL) → v3 (Postgres/Timescale) adatátvitel + újraszámolás.
 *
 *   MYSQL_DB=mvk_prod DATABASE_URL=postgres://… APP_SECRET=… node src/main.ts
 *
 * Lépések (mind idempotens, újrafuttatható):
 *  1. dimenziók, menetrend-archívum, fiókok/passkey-k, push, kimaradt menetek, időjárás
 *  2. azokra a napokra, amelyekhez NINCS nyers GPS: a v2 menetek és
 *     megálló-események átvétele (source = 'legacy'), újraszámolt státusszal
 *  3. azokra a napokra, amelyekhez VAN nyers GPS: teljes újraszámolás az új
 *     illesztővel (source = 'replay'); amit az új illesztő nem tudott
 *     feloldani (régi feed-verzió), azt a v2-ből pótoljuk menetenként
 *  4. folyamatos aggregátumok frissítése, üzemzavarok újragenerálása
 *
 * A hamis v2-üzemzavarokat és a „ghost” meneteket nem visszük át.
 */
import mysql, { type RowDataPacket } from "mysql2/promise";
import { localMidnightUnix, resolveServiceDay, serviceClock, shiftIso, TripMatcher } from "@mvk/core";
import { closeDb, getPool, sql } from "@mvk/db";
import { migrate } from "@mvk/db/migrate";
import { FeedManager, ensureCalendar } from "../../../apps/worker/src/feeds.ts";
import { Persister } from "../../../apps/worker/src/persist.ts";
import { detectIncidentsForDay } from "../../../apps/worker/src/incidents.ts";

const MYSQL = { host: process.env.MYSQL_HOST ?? "127.0.0.1", port: Number(process.env.MYSQL_PORT ?? 3306), user: process.env.MYSQL_USER ?? "root", password: process.env.MYSQL_PASS ?? "", database: process.env.MYSQL_DB ?? "mvk_prod" };
const only = new Set((process.env.STEPS ?? "static,legacy,replay,fill,refresh,incidents").split(","));
const t0 = Date.now();
const log = (m: string) => console.log(`[import +${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const my = await mysql.createConnection({ ...MYSQL, dateStrings: true, supportBigNumbers: true });
const q = async <T = any>(s: string, p: unknown[] = []) => (await my.query<RowDataPacket[]>(s, p))[0] as T[];

await migrate();
const pg = getPool();

// ── kulcs-feloldó térképek ───────────────────────────────────────────────
const stopKey = new Map<number, string>();
for (const r of await q(`SELECT stop_key, gtfs_stop_id FROM dim_stop`)) stopKey.set(r.stop_key, r.gtfs_stop_id);
const routeKey = new Map<number, string>();
for (const r of await q(`SELECT route_key, route_short FROM dim_route`)) routeKey.set(r.route_key, r.route_short);
const vehicleKey = new Map<number, string>();
for (const r of await q(`SELECT vehicle_key, vehicle_id FROM dim_vehicle`)) vehicleKey.set(r.vehicle_key, String(r.vehicle_id));
const patternKey = new Map<number, string>();
for (const r of await q(`SELECT pattern_key, pattern_hash FROM dim_pattern`)) patternKey.set(r.pattern_key, r.pattern_hash);
const segKey = new Map<number, [string, string]>();
for (const r of await q(`SELECT segment_key, from_stop_key, to_stop_key FROM dim_segment`)) segKey.set(r.segment_key, [stopKey.get(r.from_stop_key) ?? "", stopKey.get(r.to_stop_key) ?? ""]);

const pingDays = (await q(`SELECT DISTINCT service_date AS d FROM veh_ping ORDER BY 1`)).map((r) => iso(r.d));
const firstPingDay = pingDays[0] ?? "9999-12-31";
const runDays = (await q(`SELECT DISTINCT service_date AS d FROM trip_run ORDER BY 1`)).map((r) => iso(r.d));
log(`nyers GPS: ${pingDays[0]} … ${pingDays[pingDays.length - 1]} (${pingDays.length} nap); menetek: ${runDays.length} nap`);

// ── 1. statikus adatok ───────────────────────────────────────────────────
if (only.has("static")) {
  const stops = await q(`SELECT gtfs_stop_id, stop_code, name, lat_e7, lon_e7, first_seen, last_seen FROM dim_stop`);
  await pg.query(
    `INSERT INTO stop (stop_id, code, name, lat, lon, first_seen, last_seen)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::float8[], $6::date[], $7::date[])
     ON CONFLICT (stop_id) DO UPDATE SET first_seen = LEAST(stop.first_seen, EXCLUDED.first_seen)`,
    [stops.map((s) => s.gtfs_stop_id), stops.map((s) => s.stop_code), stops.map((s) => s.name), stops.map((s) => s.lat_e7 / 1e7), stops.map((s) => s.lon_e7 / 1e7), stops.map((s) => iso(s.first_seen)), stops.map((s) => iso(s.last_seen))],
  );
  const routes = await q(`SELECT route_short, gtfs_route_id, long_name, kind, color, text_color FROM dim_route`);
  await pg.query(
    `INSERT INTO route (route_short, gtfs_route_id, long_name, kind, color, text_color, first_seen, last_seen)
     SELECT r, g, l, k, c, t, '2026-08-30', CURRENT_DATE FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(r, g, l, k, c, t)
     ON CONFLICT (route_short) DO NOTHING`,
    [routes.map((r) => r.route_short), routes.map((r) => r.gtfs_route_id), routes.map((r) => r.long_name), routes.map((r) => r.kind), routes.map((r) => r.color), routes.map((r) => r.text_color)],
  );
  const veh = await q(`SELECT vehicle_id, kind, first_seen, last_seen FROM dim_vehicle`);
  await pg.query(
    `INSERT INTO vehicle (vehicle_id, kind, first_seen, last_seen)
     SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])
     ON CONFLICT (vehicle_id) DO UPDATE SET first_seen = LEAST(vehicle.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(vehicle.last_seen, EXCLUDED.last_seen)`,
    [veh.map((v) => String(v.vehicle_id)), veh.map((v) => (v.kind === "UNKNOWN" ? null : v.kind)), veh.map((v) => `${v.first_seen}Z`), veh.map((v) => `${v.last_seen}Z`)],
  );
  await ensureCalendar("2025-08-01", 1200);

  // Menetrend-archívum (v2 sched_day/sched_blob)
  const days = await q(`SELECT d.service_date, d.feed_version, d.n_trips, b.payload FROM sched_day d JOIN sched_blob b USING (blob_hash)`);
  for (const d of days) {
    await pg.query(
      `INSERT INTO legacy_schedule_day (service_date, feed_version, n_trips, payload) VALUES ($1, $2, $3, $4)
       ON CONFLICT (service_date) DO UPDATE SET feed_version = EXCLUDED.feed_version, n_trips = EXCLUDED.n_trips, payload = EXCLUDED.payload`,
      [iso(d.service_date), d.feed_version, d.n_trips, d.payload],
    );
  }
  log(`menetrend-archívum: ${days.length} nap (ebből ${days.filter((d) => !d.n_trips).length} üres  ezekre fallback lesz)`);

  // Fiókok, passkey-k, munkamenetek, mentések
  const accounts = await q(`SELECT account_id, email, created_at FROM account`);
  const userOf = new Map<number, string>();
  for (const a of accounts) {
    const r = await pg.query<{ id: string }>(
      `INSERT INTO app_user (email, created_at, legacy_account_id) VALUES ($1, to_timestamp($2), $3)
       ON CONFLICT (email) DO UPDATE SET legacy_account_id = EXCLUDED.legacy_account_id RETURNING id`,
      [a.email, a.created_at, a.account_id],
    );
    userOf.set(a.account_id, r.rows[0].id);
  }
  for (const c of await q(`SELECT * FROM account_credential`)) {
    const uid = userOf.get(c.account_id);
    if (!uid) continue;
    await pg.query(
      `INSERT INTO passkey (credential_id, user_id, public_key, counter, transports, device_type, backed_up, device_name, created_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), to_timestamp($10)) ON CONFLICT (credential_id) DO NOTHING`,
      [c.credential_id, uid, c.public_key, Number(c.counter), c.transports, c.device_type, Boolean(c.backed_up), c.device_name, c.created_at, c.last_used_at],
    );
  }
  for (const s of await q(`SELECT * FROM account_session`)) {
    const uid = userOf.get(s.account_id);
    if (!uid) continue;
    await pg.query(
      `INSERT INTO user_session (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, to_timestamp($3), to_timestamp($4)) ON CONFLICT DO NOTHING`,
      [s.session_hash, uid, s.created_at, s.expires_at],
    );
  }
  for (const b of await q(`SELECT * FROM account_backup`)) {
    const uid = userOf.get(b.account_id);
    if (!uid) continue;
    const payload: Buffer = b.payload;
    await pg.query(
      `INSERT INTO legacy_backup (user_id, payload, bytes, updated_at) VALUES ($1, $2, $3, to_timestamp($4))
       ON CONFLICT (user_id) DO UPDATE SET payload = EXCLUDED.payload, bytes = EXCLUDED.bytes, updated_at = EXCLUDED.updated_at`,
      [uid, payload, b.bytes, b.updated_at],
    );
    // A mentés egy localStorage-pillanatkép ({kulcs: szöveg})  kulcsonként a szinkron-táblába.
    try {
      const obj = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== "string" || !k.startsWith("mvk_") || ["mvk_account", "mvk_device_id", "mvk_sync_meta", "mvk_install_dismissed", "mvk_geo_last_fix", "mvk_view_state", "mvk_map_view", "mvk_timetable_view"].includes(k)) continue;
        await pg.query(
          `INSERT INTO user_state (user_id, key, value, updated_at, device_id) VALUES ($1, $2, to_jsonb($3::text), to_timestamp($4), 'v2-backup')
           ON CONFLICT (user_id, key) DO NOTHING`,
          [uid, k, v, b.updated_at],
        );
      }
    } catch {
      log(`figyelem: a(z) ${b.account_id}. fiók mentése nem JSON  csak nyersen vettük át`);
    }
  }
  log(`fiókok: ${accounts.length}`);

  // Push
  const subs = await q(`SELECT * FROM push_subscription`);
  const subOf = new Map<number, number>();
  for (const s of subs) {
    const r = await pg.query<{ id: number }>(
      `INSERT INTO push_subscription (endpoint, p256dh, auth, created_at, enabled, dnd_start_min, dnd_end_min)
       VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth RETURNING id`,
      [s.endpoint, s.p256dh, s.auth, s.created_at, Boolean(s.enabled), s.dnd_start_min, s.dnd_end_min],
    );
    subOf.set(s.sub_id, r.rows[0].id);
  }
  for (const w of await q(`SELECT * FROM push_watch`)) {
    const sid = subOf.get(w.sub_id);
    if (!sid) continue;
    await pg.query(
      `INSERT INTO push_watch (subscription_id, slot, stop_id, stop_name, threshold_min, route_shorts, trip_id, sched_min, is_departure, updated_at)
       VALUES ($1, 'default', $2, $3, $4, $5, $6, $7, $8, to_timestamp($9)) ON CONFLICT (subscription_id, stop_id, slot) DO NOTHING`,
      [sid, w.stop_id, w.stop_name, w.threshold_min, w.route_shorts ? String(w.route_shorts).split(",").filter(Boolean) : null, w.trip_id, w.sched_min, Boolean(w.is_departure), w.updated_at],
    );
  }
  log(`push: ${subs.length} feliratkozás`);

  const canc = await q(`SELECT service_date, trip_id, first_seen, last_seen, samples FROM cancelled_trip_log`);
  for (let i = 0; i < canc.length; i += 2000) {
    const b = canc.slice(i, i + 2000);
    await pg.query(
      `INSERT INTO cancelled_trip (service_date, trip_id, first_seen, last_seen, samples)
       SELECT d, t, to_timestamp(f), to_timestamp(l), s FROM unnest($1::date[], $2::text[], $3::float8[], $4::float8[], $5::int4[]) AS x(d, t, f, l, s)
       ON CONFLICT DO NOTHING`,
      [b.map((r) => iso(r.service_date)), b.map((r) => r.trip_id), b.map((r) => r.first_seen), b.map((r) => r.last_seen), b.map((r) => r.samples)],
    );
  }
  const wx = await q(`SELECT hour_ts, temp_c, feels_c, wind_kmh, wmo_code FROM wx_hour`);
  await pg.query(
    `INSERT INTO weather_hour (hour, temp_c, feels_c, wind_kmh, wmo_code)
     SELECT to_timestamp(h), t, f, w, c FROM unnest($1::float8[], $2::real[], $3::real[], $4::real[], $5::int2[]) AS x(h, t, f, w, c) ON CONFLICT DO NOTHING`,
    [wx.map((r) => r.hour_ts), wx.map((r) => r.temp_c), wx.map((r) => r.feels_c), wx.map((r) => r.wind_kmh), wx.map((r) => r.wmo_code)],
  );
  const fh = await q(`SELECT service_date, polls_ok, polls_fail, pings_kept, vehicles_max FROM feed_health`);
  for (const r of fh) {
    await pg.query(
      `INSERT INTO feed_health (service_date, polls_ok, polls_fail, pings_kept, vehicles_max) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [iso(r.service_date), r.polls_ok, r.polls_fail, r.pings_kept, r.vehicles_max],
    );
  }
  log(`kimaradt menetek: ${canc.length}, időjárás: ${wx.length} óra, feed-egészség: ${fh.length} nap`);
}

// ── 2–4. menetek ─────────────────────────────────────────────────────────
type LegacyRun = { run_id: number; service_date: string; vehicle_key: number; route_key: number; direction: number; pattern_key: number; sched_start_s: number; sched_end_s: number; stops_total: number; gtfs_trip_id: string | null; dist_m: number | null; max_speed_dms: number | null };

/** v2 menetek (+ események, szakaszidők) átvétele egy napra; `skip` = a replay által már lefedett slotok. */
async function importLegacyDay(day: string, skip: Set<string> | null): Promise<number> {
  const runs = await q<LegacyRun>(
    `SELECT run_id, service_date, vehicle_key, route_key, direction, pattern_key, sched_start_s, sched_end_s, stops_total, gtfs_trip_id, dist_m, max_speed_dms
       FROM trip_run WHERE service_date = ? AND vehicle_key > 0 AND status <> 'ghost' AND gtfs_trip_id IS NOT NULL`,
    [day],
  );
  const keep = runs.filter((r) => !skip?.has(`${vehicleKey.get(r.vehicle_key)}|${routeKey.get(r.route_key)}|${r.sched_start_s}`));
  if (!keep.length) return 0;
  const byRun = new Map<number, LegacyRun>(keep.map((r) => [r.run_id, r]));
  const ids = [...byRun.keys()];
  const events: any[] = [];
  for (let i = 0; i < ids.length; i += 2000) {
    events.push(...(await q(`SELECT * FROM stop_event WHERE service_date = ? AND run_id IN (?) ORDER BY run_id, stop_seq`, [day, ids.slice(i, i + 2000)])));
  }
  const evOfRun = new Map<number, any[]>();
  for (const e of events) {
    const l = evOfRun.get(e.run_id);
    if (l) l.push(e);
    else evOfRun.set(e.run_id, [e]);
  }
  const midnight = localMidnightUnix(day);
  const runRows: any[] = [];
  const evRows: any[] = [];
  for (const r of keep) {
    const evs = evOfRun.get(r.run_id) ?? [];
    const vid = vehicleKey.get(r.vehicle_key) ?? String(r.vehicle_key);
    const runKey = `${day}|${r.gtfs_trip_id}|${vid}`;
    const share = evs.length / Math.max(1, r.stops_total);
    const status = evs.length === 0 ? "aborted" : share >= 0.8 ? "complete" : "partial";
    const first = evs[0];
    const last = evs[evs.length - 1];
    // Az MVK stop_sequence 1-től folytonos: a megálló indexe seq − 1.
    const reachedEnd = last != null && last.stop_seq >= r.stops_total;
    runRows.push({
      runKey, day, trip: r.gtfs_trip_id, vid, route: routeKey.get(r.route_key) ?? "?", dir: r.direction, pattern: patternKey.get(r.pattern_key) ?? "",
      ss: r.sched_start_s, se: r.sched_end_s, total: r.stops_total, seen: evs.length,
      opened: first?.arr_ts ?? midnight + r.sched_start_s, lastSeen: last?.dep_ts ?? last?.arr_ts ?? null,
      a0: first?.arr_ts ?? null, a1: reachedEnd ? last.arr_ts : null,
      sd: first?.stop_seq === 1 ? first.delay_s : null, ed: reachedEnd ? last.delay_s : null, ld: last?.delay_s ?? null,
      lsi: last ? last.stop_seq - 1 : null, dist: r.dist_m, ms: r.max_speed_dms != null ? r.max_speed_dms / 10 : null, status,
    });
    for (const e of evs) {
      if (e.arr_ts == null || e.delay_s == null) continue;
      const idx = Math.max(0, e.stop_seq - 1);
      evRows.push([e.arr_ts, day, runKey, r.gtfs_trip_id, vid, routeKey.get(e.route_key) ?? "?", stopKey.get(e.stop_key) ?? "?", e.stop_seq, idx, e.stop_seq === 1, e.stop_seq >= r.stops_total, e.sched_s, e.sched_s, e.dep_ts, e.delay_s, e.dwell_s, e.headway_s, e.sched_hw_s]);
    }
  }
  for (let i = 0; i < runRows.length; i += 1000) {
    const b = runRows.slice(i, i + 1000);
    await pg.query(
      `INSERT INTO trip_run (run_key, service_date, trip_id, vehicle_id, route_short, direction, pattern, sched_start_s, sched_end_s, stops_total, stops_seen,
                             opened_at, last_seen_at, actual_start, actual_end, start_delay_s, end_delay_s, last_delay_s, last_stop_idx, dist_m, max_speed, status, close_reason, source)
       SELECT rk, d::date, t, v, r, dir, p, ss, se, tot, seen, to_timestamp(op), to_timestamp(ls), to_timestamp(a0), to_timestamp(a1), sd, ed, ld, lsi, dist, ms, st, 'legacy', 'legacy'
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int2[], $7::text[], $8::int4[], $9::int4[], $10::int2[], $11::int2[],
                     $12::float8[], $13::float8[], $14::float8[], $15::float8[], $16::int4[], $17::int4[], $18::int4[], $19::int2[], $20::int4[], $21::real[], $22::text[])
              AS x(rk, d, t, v, r, dir, p, ss, se, tot, seen, op, ls, a0, a1, sd, ed, ld, lsi, dist, ms, st)
       ON CONFLICT (run_key) DO NOTHING`,
      [b.map((x) => x.runKey), b.map((x) => x.day), b.map((x) => x.trip), b.map((x) => x.vid), b.map((x) => x.route), b.map((x) => x.dir), b.map((x) => x.pattern), b.map((x) => x.ss), b.map((x) => x.se), b.map((x) => x.total), b.map((x) => x.seen),
        b.map((x) => x.opened), b.map((x) => x.lastSeen), b.map((x) => x.a0), b.map((x) => x.a1), b.map((x) => x.sd), b.map((x) => x.ed), b.map((x) => x.ld), b.map((x) => x.lsi), b.map((x) => x.dist), b.map((x) => x.ms), b.map((x) => x.status)],
    );
  }
  for (let i = 0; i < evRows.length; i += 5000) {
    const b = evRows.slice(i, i + 5000);
    const col = (k: number) => b.map((x) => x[k]);
    await pg.query(
      `INSERT INTO stop_event (ts, service_date, run_key, trip_id, vehicle_id, route_short, stop_id, stop_seq, stop_idx, is_first, is_last, sched_arr_s, sched_dep_s, dep_ts, delay_s, dwell_s, headway_s, sched_headway_s, src)
       SELECT to_timestamp(a), d, rk, t, v, r, s, sq, si, f, l, sa, sp, to_timestamp(dp), dl, dw, hw, shw, 9
         FROM unnest($1::float8[], $2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int2[], $9::int2[], $10::bool[], $11::bool[], $12::int4[], $13::int4[], $14::float8[], $15::int4[], $16::int4[], $17::int4[], $18::int4[])
              AS x(a, d, rk, t, v, r, s, sq, si, f, l, sa, sp, dp, dl, dw, hw, shw)
       ON CONFLICT DO NOTHING`,
      Array.from({ length: 18 }, (_, k) => col(k)),
    );
  }
  // Szakaszidők az átvett menetekhez
  const runKeyOf = new Map<number, string>(runRows.map((x, i) => [keep[i].run_id, x.runKey]));
  const segs: any[] = [];
  for (let i = 0; i < ids.length; i += 2000) {
    segs.push(...(await q(`SELECT * FROM segment_run WHERE service_date = ? AND run_id IN (?)`, [day, ids.slice(i, i + 2000)])));
  }
  for (let i = 0; i < segs.length; i += 5000) {
    const b = segs.slice(i, i + 5000).filter((s) => segKey.has(s.segment_key) && runKeyOf.has(s.run_id));
    if (!b.length) continue;
    await pg.query(
      `INSERT INTO segment_run (ts, service_date, from_stop, to_stop, route_short, run_key, travel_s, sched_s, dwell_s, entry_delay_s, tod_bucket, daytype, school)
       SELECT to_timestamp(t), d, f, s, r, rk, tr, sc, dw, ed, tb, dt, sch
         FROM unnest($1::float8[], $2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int4[], $8::int4[], $9::int4[], $10::int4[], $11::int2[], $12::int2[], $13::bool[])
              AS x(t, d, f, s, r, rk, tr, sc, dw, ed, tb, dt, sch)
       ON CONFLICT DO NOTHING`,
      [b.map((s) => s.dep_ts), b.map(() => day), b.map((s) => segKey.get(s.segment_key)![0]), b.map((s) => segKey.get(s.segment_key)![1]), b.map((s) => routeKey.get(s.route_key) ?? "?"), b.map((s) => runKeyOf.get(s.run_id)!),
        b.map((s) => s.travel_s), b.map((s) => s.sched_s), b.map((s) => s.dwell_s), b.map((s) => s.entry_delay_s), b.map((s) => s.tod_bucket), b.map((s) => s.daytype), b.map((s) => Boolean(s.school))],
    );
  }
  return keep.length;
}

const feeds = new FeedManager();
if (only.has("replay") || only.has("fill") || only.has("incidents")) {
  process.env.BOOTSTRAP_GTFS ||= "../../data/gtfs-cache/latest.zip";
  await feeds.init();
}

if (only.has("legacy")) {
  for (const day of runDays.filter((d) => d < firstPingDay)) {
    await pg.query(`DELETE FROM stop_event WHERE service_date = $1 AND src = 9`, [day]);
    await pg.query(`DELETE FROM segment_run WHERE service_date = $1 AND run_key IN (SELECT run_key FROM trip_run WHERE service_date = $1 AND source = 'legacy')`, [day]);
    await pg.query(`DELETE FROM trip_run WHERE service_date = $1 AND source = 'legacy'`, [day]);
    log(`${day}: ${await importLegacyDay(day, null)} v2 menet átvéve`);
  }
}

if (only.has("replay")) {
  const latest = feeds.latest();
  if (!latest) throw new Error("nincs betöltött GTFS a replay-hez");
  for (const day of pingDays) {
    // A nap tiszta lappal: a korábbi replay/legacy adatok törlése.
    for (const t of ["stop_event", "segment_run"]) await pg.query(`DELETE FROM ${t} WHERE service_date = $1`, [day]);
    await pg.query(`DELETE FROM trip_run WHERE service_date = $1`, [day]);
    await pg.query(`DELETE FROM veh_ping WHERE service_date = $1 OR (service_date IS NULL AND ts >= to_timestamp($2) AND ts < to_timestamp($3))`, [day, localMidnightUnix(day) + 3 * 3600, localMidnightUnix(day) + 27 * 3600]);
    const persister = new Persister("replay");
    const sdCache = new Map<string, ReturnType<typeof resolveServiceDay>>();
    const dayOf = (d: string) => {
      if (!sdCache.has(d)) sdCache.set(d, resolveServiceDay([latest], d));
      return sdCache.get(d)!;
    };
    const matcher = new TripMatcher(
      (ts) => {
        const i = serviceClock(ts).iso;
        return [i, shiftIso(i, -1)].map((d) => ({ day: dayOf(d)!, midnightUnix: localMidnightUnix(d) })).filter((x) => x.day);
      },
      { ping: (p) => persister.ping(p), runOpened: (r) => persister.run(r), runUpdated: (r) => persister.run(r), runClosed: (r) => persister.run(r), stopEvent: (e) => persister.stopEvent(e) },
    );
    const rows = await q(
      `SELECT v.vehicle_id, p.feed_ts, p.lat_e7, p.lon_e7, p.speed_dms, p.bearing_deg, p.trip_hint
         FROM veh_ping p JOIN dim_vehicle v USING (vehicle_key) WHERE p.service_date = ? ORDER BY p.feed_ts, v.vehicle_id`,
      [day],
    );
    let lastSweep = 0;
    for (const r of rows) {
      const ts = Number(r.feed_ts);
      if (ts - lastSweep > 60) {
        matcher.sweep(ts);
        lastSweep = ts;
        if (persister.pending() > 20000) await persister.flush();
      }
      matcher.push({ vehicleId: String(r.vehicle_id), ts, lat: r.lat_e7 / 1e7, lon: r.lon_e7 / 1e7, speed: r.speed_dms == null ? null : r.speed_dms / 10, bearing: r.bearing_deg, rtTripId: r.trip_hint ?? "" });
    }
    matcher.flush();
    await persister.flush();
    await persister.flush();
    let filled = 0;
    if (only.has("fill")) {
      const covered = new Set(
        (await sql<{ k: string }>(`SELECT vehicle_id || '|' || route_short || '|' || sched_start_s AS k FROM trip_run WHERE service_date = $1`, [day])).map((x) => x.k),
      );
      filled = await importLegacyDay(day, covered);
    }
    const s = persister.stats;
    log(`${day}: ${rows.length} pont → ${s.runs ? (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM trip_run WHERE service_date = $1 AND source = 'replay'`, [day]))[0].n : 0} menet újraszámolva, ${s.events} esemény, +${filled} v2-ből pótolva${s.errors ? `, ${s.errors} írási hiba!` : ""}`);
  }
}

if (only.has("refresh")) {
  log("folyamatos aggregátumok frissítése…");
  await pg.query(`CALL refresh_continuous_aggregate('stop_event_hourly', '2026-08-01', now())`);
  await pg.query(`CALL refresh_continuous_aggregate('segment_daily', '2026-08-01', now())`);
}

if (only.has("incidents")) {
  const today = serviceClock().iso;
  for (const day of runDays.filter((d) => d < today)) await detectIncidentsForDay(feeds, day);
}

await my.end();
await closeDb();
log("kész");
