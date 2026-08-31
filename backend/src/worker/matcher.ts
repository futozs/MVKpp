import type { Pool } from "mysql2/promise";
import {
  localMidnightUnix,
  projectOntoShapeKm,
  patternHash,
  routes,
  shapes,
  tripStopsAlong,
  trips,
  budapestOffsetSec,
} from "../lib/gtfs.ts";
import { keys, segPairKey } from "../db/dims.ts";
import { logRoutePrediction } from "./routePrediction.ts";

const RUN_NONE = 0;
const MAX_OFF_ROUTE_M = 500;
const DWELL_WINDOW_M = 40;
const STOPPED_DMS = 10;
const MAX_SEGMENT_S = 3600;
const UNDECIDED_GRACE_S = 300;
// A valós, GPS-jel nélküli szakaszokon (pl. hegyekben) a pingek közti interpolált
// érkezés simán túlfuthat egy ésszerű késésen. Ilyenkor a 16 bites oszlopra vágás
// (i16 clamp) korábban 32767 mp-es (546 perc) hamis "extrém késés" kiugrást hozott
// létre, ami néhány éjszakai eseményen az egész órás átlagot eltorzította.
// Ehelyett a nem hihető értéket NULL-ra állítjuk, hogy kimaradjon az átlagból.
const MAX_SANE_DELAY_S = 3600;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)));
const i16 = (v: number) => clamp(v, -32768, 32767);
const saneDelay = (v: number) =>
  Math.abs(v) > MAX_SANE_DELAY_S ? null : Math.round(v);

export type PingRow = {
  vehicle_key: number;
  feed_ts: number;
  lat_e7: number;
  lon_e7: number;
  speed_dms: number | null;
  trip_hint: string | null;
  service_date: string;
};

type Enriched = PingRow & { along: number; off: number };

export type CalendarInfo = { daytype: number; school: number };
export type MatchResult = {
  pings: number;
  runs: number;
  events: number;
  segments: number;
};

const calendar = new Map<string, CalendarInfo>();

export async function loadCalendar(pool: Pool): Promise<void> {
  const [rows] = await pool.query(
    `SELECT service_date, daytype, school FROM dim_calendar
      WHERE service_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 400 DAY) AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)`,
  );
  calendar.clear();
  for (const r of rows as {
    service_date: string;
    daytype: number;
    school: number;
  }[]) {
    calendar.set(r.service_date, { daytype: r.daytype, school: r.school });
  }
}

const calOf = (d: string): CalendarInfo =>
  calendar.get(d) ?? { daytype: 0, school: 0 };

const runIdCache = new Map<string, number>();

async function resolveRunId(
  pool: Pool,
  tripId: string,
  serviceDate: string,
  vehicleKey: number,
): Promise<number> {
  const t = trips.get(tripId);
  const along = tripStopsAlong(tripId);
  if (!t || !along || along.length < 2) return RUN_NONE;

  const ph = patternHash(tripId);
  const patternKey = ph ? keys.pattern.get(ph) : undefined;
  const routeKey = keys.route.get(routes.get(t.routeId)?.short || t.routeId);
  if (!patternKey || !routeKey) return RUN_NONE;

  const schedStart = along[0].dep;
  const schedEnd = along[along.length - 1].dep;
  const cacheKey = `${serviceDate}|${vehicleKey}|${patternKey}|${schedStart}`;
  const hit = runIdCache.get(cacheKey);
  if (hit) return hit;

  const [res] = await pool.query(
    `INSERT INTO trip_run
       (service_date, vehicle_key, route_key, direction, pattern_key,
        sched_start_s, sched_end_s, stops_total, status, gtfs_trip_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'running', ?, NOW())
     ON DUPLICATE KEY UPDATE run_id = LAST_INSERT_ID(run_id), updated_at = NOW()`,
    [
      serviceDate,
      vehicleKey,
      routeKey,
      Number(t.dir) || 0,
      patternKey,
      schedStart,
      schedEnd,
      Math.min(along.length, 255),
      tripId,
    ],
  );
  const { insertId, affectedRows } = res as {
    insertId: number;
    affectedRows: number;
  };
  const runId = insertId || RUN_NONE;
  if (runId) runIdCache.set(cacheKey, runId);

  // affectedRows === 1 az INSERT ... ON DUPLICATE KEY UPDATE MySQL-konvenciója
  // szerint azt jelenti, hogy ez tényleg egy MOST beszúrt, új trip_run — csak
  // ekkor van értelme megjósolni (a korábbi hónapok alapján), melyik vonalra
  // számítanánk ezt a járművet, és rögtön naplózni is a tényleges találatot.
  if (runId && affectedRows === 1) {
    logRoutePrediction(pool, runId, vehicleKey, serviceDate, routeKey).catch(
      () => {},
    );
  }

  return runId;
}

function deriveEvents(
  tripId: string,
  runId: number,
  serviceDate: string,
  vehicleKey: number,
  routeKey: number,
  pings: Enriched[],
) {
  const along = tripStopsAlong(tripId);
  if (!along) return { events: [] as unknown[][] };

  const usable = pings
    .filter((p) => p.off <= MAX_OFF_ROUTE_M)
    .sort((a, b) => a.feed_ts - b.feed_ts);
  if (usable.length < 2) return { events: [] as unknown[][] };

  const midnight = localMidnightUnix(serviceDate);

  type Ev = {
    seq: number;
    stopKey: number;
    sched: number;
    arr: number;
    dep: number | null;
    dwell: number | null;
    src: number;
  };
  const found: Ev[] = [];

  for (const s of along) {
    const stopKey = keys.stop.get(s.stopId);
    if (!stopKey) continue;

    const near = usable.filter(
      (p) => Math.abs(p.along - s.alongM) <= DWELL_WINDOW_M,
    );
    const stopped = near.filter((p) => (p.speed_dms ?? 9999) <= STOPPED_DMS);
    if (stopped.length) {
      const arr = stopped[0].feed_ts;
      const dep = stopped[stopped.length - 1].feed_ts;
      found.push({
        seq: s.seq,
        stopKey,
        sched: s.dep,
        arr,
        dep,
        dwell: dep - arr,
        src: 1,
      });
      continue;
    }

    let arr: number | null = null;
    for (let i = 0; i < usable.length - 1; i++) {
      const a = usable[i];
      const b = usable[i + 1];
      if (b.along <= a.along) continue;
      if (a.along <= s.alongM && s.alongM < b.along) {
        // Ha a két szomszédos GPS-jel közt eltelt idő túl nagy (pl. térerő
        // hiánya a hegyekben), az interpolált érkezés nem megbízható — inkább
        // ne generáljunk belőle eseményt, mint hogy hamis késés/torlódás jelet adjon.
        if (b.feed_ts - a.feed_ts > MAX_SEGMENT_S) break;
        const t = (s.alongM - a.along) / (b.along - a.along);
        arr = Math.round(a.feed_ts + t * (b.feed_ts - a.feed_ts));
        break;
      }
    }
    if (arr != null)
      found.push({
        seq: s.seq,
        stopKey,
        sched: s.dep,
        arr,
        dep: null,
        dwell: null,
        src: 3,
      });
  }

  found.sort((a, b) => a.seq - b.seq);

  const events = found.map((e) => [
    serviceDate,
    e.stopKey,
    e.sched,
    runId,
    Math.min(e.seq, 255),
    routeKey,
    vehicleKey,
    e.arr,
    e.dep,
    saneDelay(e.arr - (midnight + e.sched)),
    e.dwell,
    e.src,
  ]);

  return { events };
}

async function buildSegments(
  pool: Pool,
  runIds: number[],
): Promise<unknown[][]> {
  if (!runIds.length) return [];
  const ph = runIds.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT run_id, service_date, stop_key, stop_seq, sched_s, route_key,
            arr_ts, dep_ts, delay_s, dwell_s
       FROM stop_event
      WHERE run_id IN (${ph}) AND arr_ts IS NOT NULL
      ORDER BY run_id, stop_seq`,
    runIds,
  );
  type Ev = {
    run_id: number;
    service_date: string;
    stop_key: number;
    stop_seq: number;
    sched_s: number;
    route_key: number;
    arr_ts: number;
    dep_ts: number | null;
    delay_s: number | null;
    dwell_s: number | null;
  };

  const byRun = new Map<number, Ev[]>();
  for (const e of rows as Ev[]) {
    let a = byRun.get(e.run_id);
    if (!a) byRun.set(e.run_id, (a = []));
    a.push(e);
  }

  const out: unknown[][] = [];
  for (const evs of byRun.values()) {
    for (let i = 0; i < evs.length - 1; i++) {
      const a = evs[i];
      const b = evs[i + 1];
      const segKey = keys.segment.get(segPairKey(a.stop_key, b.stop_key));
      if (!segKey) continue;

      const from = a.dep_ts ?? a.arr_ts;
      const travel = b.arr_ts - from;
      if (travel <= 0 || travel > MAX_SEGMENT_S) continue;
      const schedGap = b.sched_s - a.sched_s;
      if (schedGap <= 0 || schedGap > MAX_SEGMENT_S) continue;

      const localSec = from + budapestOffsetSec(new Date(from * 1000));
      const todBucket = Math.floor(
        (((localSec % 86400) + 86400) % 86400) / 900,
      );
      const cal = calOf(a.service_date);

      out.push([
        segKey,
        a.service_date,
        from,
        a.run_id,
        a.route_key,
        Math.min(travel, 65535),
        Math.min(schedGap, 65535),
        a.dwell_s,
        a.delay_s,
        todBucket,
        cal.daytype,
        cal.school,
      ]);
    }
  }
  return out;
}

export async function matchOnce(
  pool: Pool,
  carry: Map<number, PingRow>,
  limit = 20000,
): Promise<MatchResult> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const [raw] = await pool.query(
    `SELECT service_date, vehicle_key, feed_ts, lat_e7, lon_e7, speed_dms, trip_hint
       FROM veh_ping
      WHERE run_id IS NULL AND service_date >= DATE_SUB(CURDATE(), INTERVAL 2 DAY)
      ORDER BY vehicle_key, feed_ts
      LIMIT ?`,
    [limit],
  );
  const pings = raw as PingRow[];
  if (!pings.length) return { pings: 0, runs: 0, events: 0, segments: 0 };

  const byVehicle = new Map<number, PingRow[]>();
  for (const p of pings) {
    let a = byVehicle.get(p.vehicle_key);
    if (!a) byVehicle.set(p.vehicle_key, (a = []));
    a.push(p);
  }

  const pingUpdates: unknown[][] = [];
  const allEvents: unknown[][] = [];
  const touchedRuns = new Set<number>();

  for (const [vk, list] of byVehicle) {
    const prev = carry.get(vk);
    const seq = prev && prev.feed_ts < list[0].feed_ts ? [prev, ...list] : list;

    let i = 0;
    while (i < seq.length) {
      const hint = seq[i].trip_hint;
      let j = i;
      while (j < seq.length && seq[j].trip_hint === hint) j++;
      const slice = seq.slice(i, j);
      i = j;

      const isNew = (p: PingRow) => p !== prev;

      if (!hint || !trips.has(hint) || !tripStopsAlong(hint)) {
        for (const p of slice)
          if (isNew(p))
            pingUpdates.push([
              p.service_date,
              p.vehicle_key,
              p.feed_ts,
              p.lat_e7,
              p.lon_e7,
              RUN_NONE,
              null,
              null,
            ]);
        continue;
      }

      const t = trips.get(hint)!;
      const shape = t.shapeId ? shapes.get(t.shapeId) : null;
      if (!shape) {
        for (const p of slice)
          if (isNew(p))
            pingUpdates.push([
              p.service_date,
              p.vehicle_key,
              p.feed_ts,
              p.lat_e7,
              p.lon_e7,
              RUN_NONE,
              null,
              null,
            ]);
        continue;
      }

      const enriched: Enriched[] = [];
      for (const p of slice) {
        const proj = projectOntoShapeKm(shape, p.lat_e7 / 1e7, p.lon_e7 / 1e7);
        enriched.push({
          ...p,
          along: proj ? clamp(proj.alongKm * 1000, 0, 16_777_215) : 0,
          off: proj ? clamp(proj.distKm * 1000, 0, 65535) : 65535,
        });
      }

      const onRoute = enriched.filter((p) => p.off <= MAX_OFF_ROUTE_M).length;
      const serviceDate = slice[slice.length - 1].service_date;
      const decided = onRoute >= Math.max(2, Math.ceil(enriched.length * 0.5));

      if (!decided && onRoute > 0) {
        const newest = slice[slice.length - 1].feed_ts;
        if (nowUnix - newest < UNDECIDED_GRACE_S) continue;
      }

      const runId = decided
        ? await resolveRunId(pool, hint, serviceDate, vk)
        : RUN_NONE;

      for (const p of enriched) {
        if (!isNew(p)) continue;
        pingUpdates.push([
          p.service_date,
          p.vehicle_key,
          p.feed_ts,
          p.lat_e7,
          p.lon_e7,
          runId,
          p.along,
          p.off,
        ]);
      }

      if (runId !== RUN_NONE) {
        touchedRuns.add(runId);
        const routeKey = keys.route.get(
          routes.get(t.routeId)?.short || t.routeId,
        )!;
        const { events } = deriveEvents(
          hint,
          runId,
          serviceDate,
          vk,
          routeKey,
          enriched,
        );
        allEvents.push(...events);
      }
    }

    carry.set(vk, list[list.length - 1]);
  }

  for (let k = 0; k < pingUpdates.length; k += 2000) {
    await pool.query(
      `INSERT INTO veh_ping (service_date, vehicle_key, feed_ts, lat_e7, lon_e7, run_id, along_m, off_route_m)
       VALUES ?
       ON DUPLICATE KEY UPDATE run_id = VALUES(run_id), along_m = VALUES(along_m), off_route_m = VALUES(off_route_m)`,
      [pingUpdates.slice(k, k + 2000)],
    );
  }
  for (let k = 0; k < allEvents.length; k += 1000) {
    await pool.query(
      `INSERT INTO stop_event
         (service_date, stop_key, sched_s, run_id, stop_seq, route_key, vehicle_key,
          arr_ts, dep_ts, delay_s, dwell_s, src)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         arr_ts = LEAST(COALESCE(stop_event.arr_ts, VALUES(arr_ts)), VALUES(arr_ts)),
         dep_ts = GREATEST(COALESCE(stop_event.dep_ts, 0), COALESCE(VALUES(dep_ts), 0)),
         delay_s = VALUES(delay_s), dwell_s = COALESCE(VALUES(dwell_s), stop_event.dwell_s),
         src = LEAST(stop_event.src, VALUES(src))`,
      [allEvents.slice(k, k + 1000)],
    );
  }
  const allSegments = await buildSegments(pool, [...touchedRuns]);
  for (let k = 0; k < allSegments.length; k += 1000) {
    await pool.query(
      `INSERT INTO segment_run
         (segment_key, service_date, dep_ts, run_id, route_key, travel_s, sched_s,
          dwell_s, entry_delay_s, tod_bucket, daytype, school)
       VALUES ?
       ON DUPLICATE KEY UPDATE travel_s = VALUES(travel_s), entry_delay_s = VALUES(entry_delay_s)`,
      [allSegments.slice(k, k + 1000)],
    );
  }

  return {
    pings: pingUpdates.length,
    runs: touchedRuns.size,
    events: allEvents.length,
    segments: allSegments.length,
  };
}

export const clearRunCache = () => runIdCache.clear();
