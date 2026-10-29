/**
 * Üzemzavarok v3 — csak bizonyítékkal, csak lezárt napra.
 *
 * A régi detektor 5 percenként futott a FOLYAMATBAN lévő napra, és minden
 * félbeszakadt menetet (amit egy versenyhelyzet maga okozott) „menet közben
 * elhallgatott”-nak könyvelt — két hónap alatt 2693 hamis esetet.
 *
 * Most:
 *  - cancelled  — az MVK hivatalos törlési listája (100% biztos)
 *  - missed     — menetrend szerinti menet, amit senki nem vitt, MIKÖZBEN a
 *                 vonal szomszédos meneteit láttuk (tehát a követés működött)
 *  - breakdown  — menet közben elnémuló jármű, ami 20+ percig nem bukkan fel,
 *                 és NEM ismert térerő-hiányos helyen (ahol ugyanez a minta
 *                 más napokon is rendszeresen elhallgat)
 */
import { localMidnightUnix, secToHm, type ServiceDay } from "@mvk/core";
import { getPool, sql } from "@mvk/db";
import type { FeedManager } from "./feeds.ts";
import { log } from "./log.ts";

type IncidentIn = {
  kind: "cancelled" | "missed" | "breakdown";
  source: "mvk" | "detected";
  confidence: number;
  route: string | null;
  tripId: string | null;
  vehicleId: string | null;
  stopId: string | null;
  startedAt: number;
  endedAt: number | null;
  lat: number | null;
  lon: number | null;
  title: string;
  detail: string | null;
  evidence: Record<string, unknown>;
};

export async function detectIncidentsForDay(feeds: FeedManager, iso: string): Promise<{ inserted: number; skipped: string | null }> {
  const day = await feeds.serviceDay(iso);
  if (!day) return { inserted: 0, skipped: "nincs menetrend erre a napra" };
  const health = await sql<{ polls_ok: number; polls_fail: number; pings_kept: number }>(`SELECT polls_ok, polls_fail, pings_kept FROM feed_health WHERE service_date = $1`, [iso]);
  const h = health[0];
  const collectionOk = h && h.polls_ok + h.polls_fail > 0 && h.polls_fail / (h.polls_ok + h.polls_fail) < 0.1;

  const out: IncidentIn[] = [];
  out.push(...(await officialCancellations(day, iso)));
  if (collectionOk) {
    // Kimaradt menetet csak a nap VALÓDI menetrendjéhez mérünk: fallback-
    // menetrenddel (más nap sablonja) minden eltérés hamis „kimaradás” lenne.
    if (!day.fallback) out.push(...(await missedTrips(day, iso)));
    out.push(...(await breakdowns(day, iso)));
  }

  await getPool().query(`DELETE FROM incident WHERE service_date = $1 AND source = 'detected'`, [iso]);
  let inserted = 0;
  for (const x of out) {
    const r = await getPool().query(
      `INSERT INTO incident (service_date, kind, source, confidence, route_short, trip_id, vehicle_id, stop_id, started_at, ended_at, lat, lon, title, detail, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), to_timestamp($10), $11, $12, $13, $14, $15)
       ON CONFLICT DO NOTHING`,
      [iso, x.kind, x.source, x.confidence, x.route, x.tripId, x.vehicleId, x.stopId, x.startedAt, x.endedAt, x.lat, x.lon, x.title, x.detail, JSON.stringify(x.evidence)],
    );
    inserted += r.rowCount ?? 0;
  }
  log.info("incidents", `${iso}: ${inserted} esemény (${out.filter((x) => x.kind === "cancelled").length} hivatalos törlés)${collectionOk ? "" : " — a gyűjtés akadozott, saját észlelés kihagyva"}`);
  return { inserted, skipped: collectionOk ? null : "a gyűjtés akadozott ezen a napon" };
}

async function officialCancellations(day: ServiceDay, iso: string): Promise<IncidentIn[]> {
  const rows = await sql<{ trip_id: string; first_seen: Date }>(`SELECT trip_id, first_seen FROM cancelled_trip WHERE service_date = $1`, [iso]);
  const midnight = localMidnightUnix(iso);
  return rows.map((r) => {
    const t = day.feed.trips.get(r.trip_id);
    const st = day.feed.tripStops.get(r.trip_id);
    const route = t ? (day.feed.routes.get(t.routeId)?.short ?? t.routeId) : null;
    const dep = st?.[0]?.dep;
    return {
      kind: "cancelled" as const,
      source: "mvk" as const,
      confidence: 100,
      route,
      tripId: r.trip_id,
      vehicleId: null,
      stopId: st?.[0]?.stopId ?? null,
      startedAt: dep != null ? midnight + dep : Math.floor(r.first_seen.getTime() / 1000),
      endedAt: null,
      lat: null,
      lon: null,
      title: `${route ?? "?"}${dep != null ? ` · ${secToHm(dep)}` : ""} — az MVK törölte a menetet`,
      detail: t ? `${t.headsign}` : null,
      evidence: { source: "list-cancelled-trips", firstSeen: r.first_seen },
    };
  });
}

async function missedTrips(day: ServiceDay, iso: string): Promise<IncidentIn[]> {
  const ran = await sql<{ trip_id: string; route_short: string; sched_start_s: number }>(
    `SELECT trip_id, route_short, sched_start_s FROM trip_run WHERE service_date = $1 AND status <> 'aborted'`,
    [iso],
  );
  const cancelled = new Set((await sql<{ trip_id: string }>(`SELECT trip_id FROM cancelled_trip WHERE service_date = $1`, [iso])).map((x) => x.trip_id));
  const ranIds = new Set(ran.map((r) => r.trip_id));
  const byRoute = new Map<string, number[]>();
  for (const r of ran) {
    const l = byRoute.get(r.route_short);
    if (l) l.push(r.sched_start_s);
    else byRoute.set(r.route_short, [r.sched_start_s]);
  }
  const midnight = localMidnightUnix(iso);
  const out: IncidentIn[] = [];
  for (const t of day.feed.trips.values()) {
    if (!day.services.has(t.serviceId) || ranIds.has(t.id) || cancelled.has(t.id)) continue;
    const st = day.feed.tripStops.get(t.id);
    if (!st || st.length < 2) continue;
    const route = day.feed.routes.get(t.routeId)?.short ?? t.routeId;
    const dep = st[0].dep;
    // A követés működött-e ezen a vonalon ekkor: legalább 2 menet ±75 percen belül.
    const near = (byRoute.get(route) ?? []).filter((s) => Math.abs(s - dep) <= 75 * 60).length;
    if (near < 2) continue;
    out.push({
      kind: "missed",
      source: "detected",
      confidence: near >= 4 ? 80 : 65,
      route,
      tripId: t.id,
      vehicleId: null,
      stopId: st[0].stopId,
      startedAt: midnight + dep,
      endedAt: null,
      lat: null,
      lon: null,
      title: `${route} · ${secToHm(dep)} — valószínűleg kimaradt`,
      detail: `${t.headsign} — egyetlen jármű sem teljesítette, miközben a vonal ${near} szomszédos menetét követtük.`,
      evidence: { trackedNeighbours: near, cancelledByMvk: false },
    });
  }
  return out;
}

async function breakdowns(day: ServiceDay, iso: string): Promise<IncidentIn[]> {
  const runs = await sql<{
    run_key: string;
    trip_id: string;
    vehicle_id: string;
    route_short: string;
    pattern: string;
    stops_seen: number;
    stops_total: number;
    last_stop_idx: number | null;
    last_seen: number;
    sched_end_s: number;
  }>(
    `SELECT run_key, trip_id, vehicle_id, route_short, pattern, stops_seen, stops_total, last_stop_idx,
            extract(epoch FROM last_seen_at)::int AS last_seen, sched_end_s
       FROM trip_run WHERE service_date = $1 AND status = 'partial' AND last_stop_idx IS NOT NULL`,
    [iso],
  );
  if (!runs.length) return [];
  // Nyers GPS nélkül nem igazolható, hogy a jármű visszatért-e — ilyen napra nem jelzünk meghibásodást.
  const hasPings = await sql<{ x: number }>(`SELECT 1 AS x FROM veh_ping WHERE service_date = $1 LIMIT 1`, [iso]);
  if (!hasPings.length) return [];
  // Ismert „néma zónák”: ugyanaz a minta, ugyanott (±1 megálló) más napokon is gyakran megszakad.
  const hist = await sql<{ pattern: string; idx: number; n: number; total: number }>(
    `WITH w AS (
       SELECT pattern, last_stop_idx AS idx, status FROM trip_run
        WHERE service_date BETWEEN $1::date - 14 AND $1::date - 1 AND last_stop_idx IS NOT NULL)
     SELECT p.pattern, p.idx, p.n, t.total FROM
       (SELECT pattern, idx, count(*)::int AS n FROM w WHERE status = 'partial' GROUP BY pattern, idx) p
       JOIN (SELECT pattern, count(*)::int AS total FROM w GROUP BY pattern) t USING (pattern)`,
    [iso],
  );
  const dead = new Map<string, number>();
  for (const x of hist) dead.set(`${x.pattern}|${x.idx}`, x.n / Math.max(1, x.total));
  const deadShare = (p: string, idx: number) => Math.max(dead.get(`${p}|${idx}`) ?? 0, dead.get(`${p}|${idx - 1}`) ?? 0, dead.get(`${p}|${idx + 1}`) ?? 0);

  const out: IncidentIn[] = [];
  for (const r of runs) {
    const progress = r.stops_seen / Math.max(1, r.stops_total);
    if (progress >= 0.85 || (r.last_stop_idx ?? 0) >= r.stops_total - 2) continue;
    const share = deadShare(r.pattern, r.last_stop_idx ?? 0);
    if (share >= 0.15) continue; // ismert térerő-hiányos szakasz (a minta 15%+-a itt szakad meg)
    const next = await sql<{ t: number; trip: string | null }>(
      `SELECT extract(epoch FROM ts)::int AS t, trip_id AS trip FROM veh_ping
        WHERE vehicle_id = $1 AND ts > to_timestamp($2 + 60) AND ts < to_timestamp($2 + 4 * 3600) ORDER BY ts LIMIT 1`,
      [r.vehicle_id, r.last_seen],
    );
    const back = next[0]?.t ?? null;
    const silentMin = back ? Math.round((back - r.last_seen) / 60) : null;
    if (silentMin != null && silentMin < 30) continue;
    // Ugyanazzal a menettel jelentkezett újra: GPS-kiesés volt, nem meghibásodás.
    if (back && next[0]?.trip === r.trip_id) continue;
    const pos = await sql<{ lat: number; lon: number }>(
      `SELECT lat, lon FROM veh_ping WHERE vehicle_id = $1 AND ts <= to_timestamp($2) ORDER BY ts DESC LIMIT 1`,
      [r.vehicle_id, r.last_seen],
    );
    const stopId = day.feed.tripStopsAlong(r.trip_id)?.[r.last_stop_idx ?? 0]?.stopId ?? null;
    const stopName = stopId ? (day.feed.stops.get(stopId)?.name ?? stopId) : "?";
    let confidence = 55;
    if (silentMin == null) confidence += 20;
    else if (silentMin > 60) confidence += 10;
    if (progress < 0.5) confidence += 5;
    // Késő este a végleges elnémulás inkább műszakvég (garázsmenet), mint hiba.
    const localHour = new Date((r.last_seen + 3600) * 1000).getUTCHours();
    if (silentMin == null && (localHour >= 20 || localHour < 4)) confidence -= 25;
    confidence -= Math.round(share * 150);
    out.push({
      kind: "breakdown",
      source: "detected",
      confidence: Math.max(30, Math.min(90, confidence)),
      route: r.route_short,
      tripId: r.trip_id,
      vehicleId: r.vehicle_id,
      stopId,
      startedAt: r.last_seen,
      endedAt: back,
      lat: pos[0]?.lat ?? null,
      lon: pos[0]?.lon ?? null,
      title: `${r.route_short} (${r.vehicle_id}) — menet közben megállt, ${stopName} után`,
      detail:
        silentMin == null
          ? `A menet ${Math.round(progress * 100)}%-ánál elnémult, és aznap nem tért vissza.`
          : `A menet ${Math.round(progress * 100)}%-ánál elnémult, ${silentMin} perc múlva jelentkezett újra.`,
      evidence: { progressPct: Math.round(progress * 100), silentMin, deadZoneShare: Math.round(share * 100) / 100 },
    });
  }
  return out;
}
