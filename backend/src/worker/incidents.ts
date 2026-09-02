import type { Pool } from "mysql2/promise";
import { haversineKm, localMidnightUnix, stops } from "../lib/gtfs.ts";

const SILENT_MIN = 15;
const STUCK_MIN = 8;
const STOPPED_DMS = 10;
const AT_STOP_M = 70;

const PEER_RADIUS_E7 = 27_000;
const PEER_TRAFFIC = 2;
const NEAR_COMPLETE_PCT = 90;
const ABSENCE_DAYS = 2;
const FEED_FAIL_RATIO = 0.1;

export type IncidentResult = {
  detected: number;
  closed: number;
  skipped: string | null;
};

type IncidentRow = {
  vehicleKey: number;
  kind: string;
  startedTs: number;
  endedTs: number | null;
  durationS: number | null;
  runId: number | null;
  routeKey: number | null;
  latE7: number | null;
  lonE7: number | null;
  progressPct: number | null;
  severity: number;
  confidence: number;
  peersStuck: number;
  resolution: string | null;
  note: string | null;
};

const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

async function insertIncidents(
  pool: Pool,
  date: string,
  rows: IncidentRow[],
): Promise<number> {
  if (!rows.length) return 0;
  const values = rows.map((r) => [
    r.vehicleKey,
    date,
    r.kind,
    r.startedTs,
    r.endedTs,
    r.durationS,
    r.runId,
    r.routeKey,
    r.latE7,
    r.lonE7,
    r.progressPct,
    r.severity,
    r.confidence,
    r.peersStuck,
    r.resolution,
    r.note,
  ]);
  const [res] = await pool.query(
    `INSERT INTO vehicle_incident
       (vehicle_key, service_date, kind, started_ts, ended_ts, duration_s, run_id,
        route_key, lat_e7, lon_e7, progress_pct, severity, confidence,
        peers_stuck, resolution, note, detected_at)
     VALUES ${values.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())").join(",")}
     ON DUPLICATE KEY UPDATE
       ended_ts = COALESCE(VALUES(ended_ts), ended_ts),
       duration_s = COALESCE(VALUES(duration_s), duration_s),
       confidence = VALUES(confidence),
       peers_stuck = VALUES(peers_stuck),
       resolution = COALESCE(VALUES(resolution), resolution)`,
    values.flat(),
  );
  return (res as { affectedRows: number }).affectedRows;
}

async function feedTrustworthy(
  pool: Pool,
  date: string,
): Promise<string | null> {
  const [rows] = await pool.query(
    `SELECT polls_ok, polls_fail FROM feed_health WHERE service_date = ?`,
    [date],
  );
  const h = (rows as { polls_ok: number; polls_fail: number }[])[0];
  if (!h) return "nincs feed-egészség adat erre a napra";
  const total = h.polls_ok + h.polls_fail;
  if (!total) return "nem volt lekérdezés ezen a napon";
  if (h.polls_fail / total > FEED_FAIL_RATIO) {
    return `a gyűjtés akadozott (${h.polls_fail}/${total} hibás lekérdezés)`;
  }
  return null;
}

async function detectMidTripStops(
  pool: Pool,
  date: string,
): Promise<IncidentRow[]> {
  const midnight = localMidnightUnix(date);

  const [rows] = await pool.query(
    `SELECT r.run_id, r.vehicle_key, r.route_key, r.stops_seen, r.stops_total,
            r.sched_end_s,
            (SELECT MAX(p.feed_ts) FROM veh_ping p WHERE p.run_id = r.run_id) AS last_ts,
            (SELECT p.lat_e7 FROM veh_ping p WHERE p.run_id = r.run_id
              ORDER BY p.feed_ts DESC LIMIT 1) AS lat_e7,
            (SELECT p.lon_e7 FROM veh_ping p WHERE p.run_id = r.run_id
              ORDER BY p.feed_ts DESC LIMIT 1) AS lon_e7
       FROM trip_run r
      WHERE r.service_date = ? AND r.status IN ('aborted', 'partial')
      LIMIT 400`,
    [date],
  );
  type R = {
    run_id: number;
    vehicle_key: number;
    route_key: number;
    stops_seen: number;
    stops_total: number;
    sched_end_s: number;
    last_ts: number | null;
    lat_e7: number | null;
    lon_e7: number | null;
  };

  const out: IncidentRow[] = [];
  for (const r of rows as R[]) {
    if (!r.last_ts) continue;

    const progress = r.stops_total
      ? clampPct((r.stops_seen * 100) / r.stops_total)
      : 0;
    const schedEndTs = midnight + r.sched_end_s;
    if (r.last_ts >= schedEndTs - 120) continue;
    if (progress >= NEAR_COMPLETE_PCT) continue;

    const [nextRows] = await pool.query(
      `SELECT MIN(feed_ts) AS next_ts FROM veh_ping
        WHERE vehicle_key = ? AND service_date = ? AND feed_ts > ?`,
      [r.vehicle_key, date, r.last_ts + 60],
    );
    const nextTs =
      (nextRows as { next_ts: number | null }[])[0]?.next_ts ?? null;
    const gap = nextTs ? nextTs - r.last_ts : null;

    if (gap != null && gap < SILENT_MIN * 60) continue;

    const severity = progress < 30 ? 4 : progress < 60 ? 3 : 2;
    let confidence = 55;
    if (gap == null) confidence += 20;
    else if (gap > 3600) confidence += 15;
    if (progress < 40) confidence += 10;

    out.push({
      vehicleKey: r.vehicle_key,
      kind: "mid_trip_stop",
      startedTs: r.last_ts,
      endedTs: nextTs,
      durationS: gap,
      runId: r.run_id,
      routeKey: r.route_key,
      latE7: r.lat_e7,
      lonE7: r.lon_e7,
      progressPct: progress,
      severity,
      confidence: clampPct(confidence),
      peersStuck: 0,
      resolution: nextTs ? "aznap folytatta" : "nem tért vissza",
      note: `A menet ${progress}%-ánál hallgatott el.`,
    });
  }
  return out;
}

function nearAnyStop(latE7: number, lonE7: number): boolean {
  const lat = latE7 / 1e7;
  const lon = lonE7 / 1e7;
  for (const s of stops.values()) {
    if (Math.abs(s.lat - lat) > 0.001 || Math.abs(s.lon - lon) > 0.0015)
      continue;
    if (haversineKm(lat, lon, s.lat, s.lon) * 1000 <= AT_STOP_M) return true;
  }
  return false;
}

async function detectStuck(pool: Pool, date: string): Promise<IncidentRow[]> {
  const [rows] = await pool.query(
    `SELECT p.vehicle_key, p.feed_ts, p.lat_e7, p.lon_e7, p.run_id, p.route_key
       FROM veh_ping p
      WHERE p.service_date = ? AND p.run_id > 0
        AND p.speed_dms IS NOT NULL AND p.speed_dms <= ?
      ORDER BY p.vehicle_key, p.feed_ts`,
    [date, STOPPED_DMS],
  );
  type P = {
    vehicle_key: number;
    feed_ts: number;
    lat_e7: number;
    lon_e7: number;
    run_id: number;
    route_key: number | null;
  };
  const pings = rows as P[];

  const runsOfStops: P[][] = [];
  let cur: P[] = [];
  for (const p of pings) {
    const last = cur[cur.length - 1];
    if (
      last &&
      last.vehicle_key === p.vehicle_key &&
      p.feed_ts - last.feed_ts <= 180
    ) {
      cur.push(p);
    } else {
      if (cur.length) runsOfStops.push(cur);
      cur = [p];
    }
  }
  if (cur.length) runsOfStops.push(cur);

  const out: IncidentRow[] = [];
  for (const seq of runsOfStops) {
    const from = seq[0];
    const to = seq[seq.length - 1];
    const dur = to.feed_ts - from.feed_ts;
    if (dur < STUCK_MIN * 60) continue;

    const distinctPositions = new Set(
      seq.map((p) => `${p.lat_e7},${p.lon_e7}`),
    ).size;
    if (distinctPositions === 1) {
      out.push({
        vehicleKey: from.vehicle_key,
        kind: "no_signal",
        startedTs: from.feed_ts,
        endedTs: to.feed_ts,
        durationS: dur,
        runId: from.run_id,
        routeKey: from.route_key,
        latE7: from.lat_e7,
        lonE7: from.lon_e7,
        progressPct: null,
        severity: 1,
        confidence: clampPct(40 + Math.min(dur / 120, 30)),
        peersStuck: 0,
        resolution: "adat érkezett újra",
        note: `${Math.round(dur / 60)} percig nem érkezett friss helyzetadat (a pozíció nem változott) — valószínűleg térerő hiánya, nem torlódás.`,
      });
      continue;
    }

    if (nearAnyStop(from.lat_e7, from.lon_e7)) continue;

    const [peerRows] = await pool.query(
      `SELECT COUNT(DISTINCT vehicle_key) AS peers
         FROM veh_ping
        WHERE service_date = ? AND vehicle_key <> ?
          AND feed_ts BETWEEN ? AND ?
          AND speed_dms <= ?
          AND lat_e7 BETWEEN ? AND ? AND lon_e7 BETWEEN ? AND ?`,
      [
        date,
        from.vehicle_key,
        from.feed_ts,
        to.feed_ts,
        STOPPED_DMS,
        from.lat_e7 - PEER_RADIUS_E7,
        from.lat_e7 + PEER_RADIUS_E7,
        from.lon_e7 - PEER_RADIUS_E7,
        from.lon_e7 + PEER_RADIUS_E7,
      ],
    );
    const peers = (peerRows as { peers: number }[])[0]?.peers ?? 0;

    const traffic = peers >= PEER_TRAFFIC;
    const confidence = traffic
      ? Math.max(10, 40 - peers * 5)
      : Math.min(85, 45 + dur / 120);

    out.push({
      vehicleKey: from.vehicle_key,
      kind: "stuck",
      startedTs: from.feed_ts,
      endedTs: to.feed_ts,
      durationS: dur,
      runId: from.run_id,
      routeKey: from.route_key,
      latE7: from.lat_e7,
      lonE7: from.lon_e7,
      progressPct: null,
      severity: dur > 1800 ? 4 : dur > 900 ? 3 : 2,
      confidence: clampPct(confidence),
      peersStuck: Math.min(peers, 255),
      resolution: "elindult",
      note: traffic
        ? `${peers} másik jármű is állt a közelben — valószínűleg forgalmi torlódás.`
        : `${Math.round(dur / 60)} percig mozdulatlan az útvonalon.`,
    });
  }
  return out;
}

async function detectAbsence(
  pool: Pool,
  date: string,
): Promise<{ opened: IncidentRow[]; closed: number }> {
  const [activeRows] = await pool.query(
    `SELECT DISTINCT vehicle_key FROM trip_run WHERE service_date = ? AND vehicle_key > 0`,
    [date],
  );
  const activeToday = new Set(
    (activeRows as { vehicle_key: number }[]).map((r) => r.vehicle_key),
  );

  await pool.query(
    `INSERT INTO vehicle_presence (vehicle_key, service_date, runs, service_s, active)
     SELECT vehicle_key, service_date, COUNT(*),
            COALESCE(SUM(GREATEST(0, COALESCE(actual_end,0) - COALESCE(actual_start,0))), 0), 1
       FROM trip_run
      WHERE service_date = ? AND vehicle_key > 0
      GROUP BY vehicle_key, service_date
     ON DUPLICATE KEY UPDATE runs = VALUES(runs), service_s = VALUES(service_s), active = 1`,
    [date],
  );

  let closed = 0;
  if (activeToday.size) {
    const ids = [...activeToday];
    const ph = ids.map(() => "?").join(",");
    const [res] = await pool.query(
      `UPDATE vehicle_incident
          SET ended_ts = UNIX_TIMESTAMP(),
              absent_days = DATEDIFF(?, service_date),
              duration_s = LEAST(16777215, UNIX_TIMESTAMP() - started_ts),
              resolution = 'forgalomba állt',
              note = CONCAT('Visszatért ', DATEDIFF(?, service_date), ' nap kiesés után.')
        WHERE kind = 'absence' AND ended_ts IS NULL AND vehicle_key IN (${ph})`,
      [date, date, ...ids],
    );
    closed = (res as { affectedRows: number }).affectedRows;
  }

  const [gapRows] = await pool.query(
    `SELECT p.vehicle_key, MAX(p.service_date) AS last_date
       FROM vehicle_presence p
      WHERE p.active = 1
      GROUP BY p.vehicle_key
     HAVING DATEDIFF(?, last_date) >= ?`,
    [date, ABSENCE_DAYS],
  );
  type G = { vehicle_key: number; last_date: string };

  const [openRows] = await pool.query(
    `SELECT vehicle_key FROM vehicle_incident WHERE kind = 'absence' AND ended_ts IS NULL`,
  );
  const alreadyOpen = new Set(
    (openRows as { vehicle_key: number }[]).map((r) => r.vehicle_key),
  );

  const opened: IncidentRow[] = [];
  for (const g of gapRows as G[]) {
    if (activeToday.has(g.vehicle_key) || alreadyOpen.has(g.vehicle_key))
      continue;
    const days = Math.round(
      (Date.parse(date) - Date.parse(g.last_date)) / 86400_000,
    );
    opened.push({
      vehicleKey: g.vehicle_key,
      kind: "absence",
      startedTs: localMidnightUnix(g.last_date.slice(0, 10)),
      endedTs: null,
      durationS: null,
      runId: null,
      routeKey: null,
      latE7: null,
      lonE7: null,
      progressPct: null,
      severity: days >= 14 ? 5 : days >= 7 ? 4 : 3,
      confidence: clampPct(35 + days * 6),
      peersStuck: 0,
      resolution: null,
      note: `${days} napja nem látták forgalomban.`,
    });
  }

  for (const o of opened) {
    const g = (gapRows as G[]).find((x) => x.vehicle_key === o.vehicleKey)!;
    await insertIncidents(pool, g.last_date.slice(0, 10), [o]);
  }

  return { opened, closed };
}

export async function detectIncidents(
  pool: Pool,
  date: string,
): Promise<IncidentResult> {
  const distrust = await feedTrustworthy(pool, date);
  if (distrust) {
    return { detected: 0, closed: 0, skipped: distrust };
  }

  const rows = [
    ...(await detectMidTripStops(pool, date)),
    ...(await detectStuck(pool, date)),
  ];
  const detected = await insertIncidents(pool, date, rows);
  const absence = await detectAbsence(pool, date);

  await pool.query(
    `UPDATE vehicle_presence p
        SET incidents_n = (
              SELECT COUNT(*) FROM vehicle_incident i
               WHERE i.vehicle_key = p.vehicle_key AND i.service_date = p.service_date
            )
      WHERE p.service_date = ?`,
    [date],
  );

  return {
    detected: detected + absence.opened.length,
    closed: absence.closed,
    skipped: null,
  };
}
