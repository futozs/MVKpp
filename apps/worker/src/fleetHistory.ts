/**
 * A flotta-rangsor visszanézése az adatbázisból, amíg van adat: egy múltbeli
 * pillanat teljes állapota (ugyanaz az összerakás, mint élőben), a nap
 * késésgörbéje, és a korábbi összeomlások keresése visszafelé.
 */
import {
  breakdowns,
  dayBuckets,
  localMidnightUnix,
  nowUnix,
  runStateAt,
  segmentCongestion,
  segmentPaths,
  serviceClock,
  shiftIso,
  stillFor,
  TRAFFIC,
  type BoardSnapshot,
  type Breakdown,
  type FleetDay,
  type RunEvent,
  type ServiceDay,
  type TrafficObs,
} from "@mvk/core";
import { cached } from "@mvk/cache";
import { sql } from "@mvk/db";
import { assembleBoard, isTramRoute, type FleetInput, type FleetSegment } from "./fleet.ts";
import type { FeedManager } from "./feeds.ts";
import type { DelayForecaster } from "./forecast.ts";

type Deps = { feeds: FeedManager; forecaster: DelayForecaster };

/** ennél régebbi pillanat adatai már nem változnak (mp) */
const SETTLED_S = 600;
/** a visszanézés ennyi másodpercre kerekít (kevesebb külön kiszámolt pillanat) */
const AT_STEP_S = 30;
const DAY_S = 86_400;

type EventRow = { run_key: string; idx: number; stop_id: string; ts: number; dep: number | null; delay_s: number; is_last: boolean };

const toEvent = (r: EventRow): RunEvent => ({ idx: r.idx, stopId: r.stop_id, ts: r.ts, depTs: r.dep, delayS: r.delay_s, isLast: r.is_last });

function groupRuns(rows: EventRow[]): Map<string, RunEvent[]> {
  const runs = new Map<string, RunEvent[]>();
  for (const r of rows) {
    const list = runs.get(r.run_key) ?? [];
    list.push(toEvent(r));
    runs.set(r.run_key, list);
  }
  return runs;
}

/** A flotta állapota a `t` pillanatban, az élő nézettel azonos alakban. */
export async function boardAt(deps: Deps, rawT: number): Promise<BoardSnapshot> {
  const t = Math.floor(rawT / AT_STEP_S) * AT_STEP_S;
  const build = () => buildBoardAt(deps, t);
  return t < nowUnix() - SETTLED_S ? cached(`fleet-at:v1:${t}`, 7 * DAY_S, build) : build();
}

async function buildBoardAt({ feeds, forecaster }: Deps, t: number): Promise<BoardSnapshot> {
  const iso = serviceClock(t).iso;
  const day = await feeds.serviceDay(iso);
  // egy menet legfeljebb ~2 óra: 4 órával korábbról minden futó menet eleje megvan, 1 órával későbbről a következő megállója
  const rows = await sql<EventRow>(
    `SELECT run_key, stop_idx AS idx, stop_id, extract(epoch FROM ts)::int AS ts, extract(epoch FROM dep_ts)::int AS dep, delay_s, is_last
       FROM stop_event
      WHERE ts BETWEEN to_timestamp($1) - interval '4 hours' AND to_timestamp($1) + interval '1 hour'
        AND vehicle_id NOT LIKE '%:%'
      ORDER BY run_key, ts`,
    [t],
  );
  const active = new Map<string, { key: string; state: NonNullable<ReturnType<typeof runStateAt>> }>();
  const runs = groupRuns(rows);
  for (const [key, events] of runs) {
    const state = runStateAt(events, t);
    if (!state) continue;
    // egy jármű egyszerre csak egy menetet visz: a legfrissebb eseményű számít
    const vehicleId = key.split("|")[2] ?? key;
    const prev = active.get(vehicleId);
    if (!prev || state.sinceEventS < prev.state.sinceEventS) active.set(vehicleId, { key, state });
  }
  if (!active.size) return assembleBoard(t, day, [], []);

  const keys = [...active.values()].map((a) => a.key);
  const meta = await sql<{ run_key: string; trip_id: string; vehicle_id: string; route_short: string; route_id: string | null; headsign: string | null; stops_total: number }>(
    `SELECT run_key, trip_id, vehicle_id, route_short, route_id, headsign, stops_total FROM trip_run WHERE run_key = ANY($1::text[])`,
    [keys],
  );
  const pings = await sql<{ v: string; ts: number; lat: number; lon: number }>(
    `SELECT vehicle_id AS v, extract(epoch FROM ts)::int AS ts, lat, lon FROM veh_ping
      WHERE ts BETWEEN to_timestamp($1) - interval '20 minutes' AND to_timestamp($1) AND vehicle_id = ANY($2::text[])
      ORDER BY vehicle_id, ts`,
    [t, [...active.keys()]],
  );
  const pingsOf = new Map<string, { ts: number; lat: number; lon: number }[]>();
  for (const p of pings) pingsOf.set(p.v, [...(pingsOf.get(p.v) ?? []), p]);

  const inputs: FleetInput[] = [];
  for (const m of meta) {
    const a = active.get(m.vehicle_id);
    if (!a || a.key !== m.run_key) continue;
    const s = a.state;
    const stallS = stillFor(pingsOf.get(m.vehicle_id) ?? [], t);
    const route = day?.feed.routes.get(m.route_id ?? "");
    const along = day?.feed.tripStopsAlong(m.trip_id);
    const hasNext = along ? s.lastIdx + 1 < along.length : false;
    inputs.push({
      vehicleId: m.vehicle_id,
      label: m.vehicle_id,
      plate: null,
      routeId: m.route_id ?? "",
      routeShort: m.route_short,
      tripId: m.trip_id,
      headsign: m.headsign ?? "",
      delayS: s.delayS,
      startDelayS: s.startDelayS,
      lastStopIdx: s.lastIdx,
      stopsTotal: m.stops_total,
      trail: s.trail,
      at: hasNext ? { fromIdx: s.lastIdx, toIdx: s.lastIdx + 1, frac: s.frac, stopped: stallS != null } : null,
      stallS,
      color: route?.color ?? "",
      text: route?.text ?? "",
    });
  }
  return assembleBoard(t, day, inputs, day ? await segmentsAt(forecaster, day, t) : []);
}

/**
 * A dugós szakaszok a `t` pillanatban, ugyanazzal a mércével, mint élőben,
 * az addig átért buszok menetidejéből (a bent ragadtakat itt nem becsüljük).
 */
async function segmentsAt(forecaster: DelayForecaster, day: ServiceDay, t: number): Promise<FleetSegment[]> {
  const midnight = localMidnightUnix(day.iso);
  const rows = await sql<{ f: string; to: string; ts: number; travel_s: number }>(
    `SELECT from_stop AS f, to_stop AS "to", extract(epoch FROM ts)::int AS ts, travel_s FROM segment_run
      WHERE ts BETWEEN to_timestamp($1) - make_interval(secs => $2::int) AND to_timestamp($1) AND run_key NOT LIKE '%:%'`,
    [t, TRAFFIC.WINDOW_S + 3600],
  );
  const obs = new Map<string, TrafficObs[]>();
  for (const r of rows) {
    const typicalS = forecaster.typicalTravel(r.f, r.to, day.iso, r.ts - midnight);
    if (!typicalS || r.ts + r.travel_s > t) continue;
    const k = `${r.f}|${r.to}`;
    obs.set(k, [...(obs.get(k) ?? []), { endTs: r.ts + r.travel_s, travelS: r.travel_s, typicalS }]);
  }
  const paths = segmentPaths(day.feed);
  const name = (id: string) => day.feed.stops.get(id)?.name ?? id;
  const out: FleetSegment[] = [];
  for (const k of obs.keys()) {
    const c = segmentCongestion(obs.get(k) ?? [], [], t);
    const p = c ? paths.get(k) : undefined;
    if (c && p) out.push({ fromId: p.from, toId: p.to, from: name(p.from), to: name(p.to), routes: p.routes, excessS: c.excessS, level: c.level });
  }
  return out;
}

/** A nap késésgörbéje és összeomlásai; a lezárult nap egyszer számolódik. */
export function fleetDay(deps: Deps, iso: string): Promise<FleetDay> {
  const today = serviceClock().iso;
  return cached(`fleet-day:v1:${iso}`, iso < today ? 30 * DAY_S : 120, () => buildFleetDay(deps, iso));
}

async function buildFleetDay({ feeds }: Deps, iso: string): Promise<FleetDay> {
  const from = localMidnightUnix(iso) + 3 * 3600;
  const to = Math.min(from + DAY_S, nowUnix());
  const day = await feeds.serviceDay(iso);
  const rows = await sql<EventRow & { route_id: string | null; route_short: string }>(
    `SELECT e.run_key, e.stop_idx AS idx, '' AS stop_id, extract(epoch FROM e.ts)::int AS ts, extract(epoch FROM e.dep_ts)::int AS dep,
            e.delay_s, e.is_last, e.route_short, r.route_id
       FROM stop_event e JOIN trip_run r USING (run_key)
      WHERE e.service_date = $1 AND e.ts BETWEEN to_timestamp($2) - interval '1 hour' AND to_timestamp($3) + interval '3 hours'
        AND e.vehicle_id NOT LIKE '%:%'
      ORDER BY e.run_key, e.ts`,
    [iso, from, from + DAY_S],
  );
  const tramOf = new Map<string, boolean>();
  for (const r of rows) {
    // a villamospótló busz (VP) busznak számít: a villamos-görbe a villamosoké
    if (!tramOf.has(r.run_key)) tramOf.set(r.run_key, day ? isTramRoute(day, r.route_id ?? "") : /^\d*A?V$/.test(r.route_short));
  }
  const runs = [...groupRuns(rows)].map(([key, events]) => ({ tram: tramOf.get(key) ?? false, events }));
  const buckets = to > from ? dayBuckets(runs, from, to) : [];
  return { date: iso, from, to: from + DAY_S, step: buckets.length > 1 ? buckets[1].t - buckets[0].t : 300, buckets, breakdowns: breakdowns(buckets) };
}

/** az első nap, amelyről menetadat van (eddig lehet visszanézni) */
function firstDay(): Promise<string | null> {
  return cached("fleet-first-day", 3600, async () => (await sql<{ d: string | null }>(`SELECT min(service_date)::text AS d FROM trip_run`))[0]?.d ?? null);
}

/**
 * A korábbi összeomlások, a `before` naptól visszafelé, legfeljebb `days` napot
 * átnézve, vagy amíg `limit` darab meg nem lesz. `next`: innen lehet folytatni.
 */
export async function findBreakdowns(deps: Deps, before: string, opts: { days: number; limit: number; kind: Breakdown["kind"] | null }) {
  const first = await firstDay();
  const items: (Breakdown & { date: string })[] = [];
  let d = before;
  let scanned = 0;
  while (scanned < opts.days && (!first || d >= first) && items.length < opts.limit) {
    const day = await fleetDay(deps, d);
    const found = day.breakdowns.filter((b) => !opts.kind || b.kind === opts.kind).sort((a, b) => b.peak - a.peak);
    items.push(...found.map((b) => ({ ...b, date: d })));
    d = shiftIso(d, -1);
    scanned++;
  }
  const end = Boolean(first && d < first);
  return { items: items.slice(0, opts.limit), next: end ? null : d, firstDay: first };
}
