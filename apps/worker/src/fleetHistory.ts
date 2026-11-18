/**
 * A flotta-rangsor visszanézése az adatbázisból, amíg van adat: egy múltbeli
 * pillanat teljes állapota (ugyanaz az összerakás, mint élőben), a nap
 * késésgörbéje, és a korábbi összeomlások keresése visszafelé.
 */
import {
  breakdowns,
  dayBuckets,
  isMvkId,
  dayRecords,
  mergeRecords,
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
  type DayRecords,
  type RecordQuery,
  type RecordsResult,
  type RunPeak,
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

/** a villamosvonalak rövid nevei a mai menetrendből (a rövid nevek napról napra ugyanazok) */
function tramShorts(feeds: FeedManager): Set<string> {
  const feed = feeds.cachedDay(serviceClock().iso)?.feed;
  return new Set(feed ? [...feed.routes.values()].filter((r) => r.type === "900" && isMvkId(r.id)).map((r) => r.short) : ["1V", "1AV", "2V"]);
}

/** A nap rekordjai: menetenként a csúcskésés és a legnagyobb sietés (egy adatbázis-összesítésből). */
export function recordsOfDay(deps: Deps, iso: string): Promise<DayRecords> {
  const today = serviceClock().iso;
  return cached(`fleet-rec:v3:${iso}`, iso < today ? 30 * DAY_S : 300, () => buildDayRecords(deps, iso));
}

async function buildDayRecords({ feeds }: Deps, iso: string): Promise<DayRecords> {
  const from = localMidnightUnix(iso) + 3 * 3600;
  // menetenként a legnagyobb és a legkisebb mért késés; a becsült végállomást (src 3) és a
  // nyilvánvaló illesztési hibát (két óránál nagyobb eltérés) kihagyjuk, és legalább három mérés kell
  const rows = await sql<{
    run_key: string;
    trip_id: string;
    vehicle_id: string;
    route_short: string;
    headsign: string | null;
    start_delay_s: number | null;
    hi_s: number;
    hi_ts: number;
    hi_stop: string;
    lo_s: number;
    lo_ts: number;
    lo_stop: string;
  }>(
    `WITH ev AS (
       SELECT run_key, delay_s, ts, stop_id FROM stop_event
        WHERE service_date = $1 AND ts BETWEEN to_timestamp($2) - interval '1 hour' AND to_timestamp($2) + interval '27 hours'
          AND vehicle_id NOT LIKE '%:%' AND src <> 3 AND delay_s BETWEEN -1800 AND 7200
     ), counted AS (
       SELECT run_key FROM ev GROUP BY run_key HAVING count(*) >= 3
     ), hi AS (
       SELECT DISTINCT ON (run_key) run_key, delay_s, ts, stop_id FROM ev WHERE run_key IN (SELECT run_key FROM counted) ORDER BY run_key, delay_s DESC, ts
     ), lo AS (
       SELECT DISTINCT ON (run_key) run_key, delay_s, ts, stop_id FROM ev WHERE run_key IN (SELECT run_key FROM counted) ORDER BY run_key, delay_s ASC, ts
     )
     SELECT r.run_key, r.trip_id, r.vehicle_id, r.route_short, r.headsign, r.start_delay_s,
            hi.delay_s AS hi_s, extract(epoch FROM hi.ts)::int AS hi_ts, hi.stop_id AS hi_stop,
            lo.delay_s AS lo_s, extract(epoch FROM lo.ts)::int AS lo_ts, lo.stop_id AS lo_stop
       FROM hi JOIN lo USING (run_key) JOIN trip_run r ON r.run_key = hi.run_key`,
    [iso, from],
  );
  const trams = tramShorts(feeds);
  const feed = feeds.cachedDay(serviceClock().iso)?.feed;
  const stops = feed?.stops;
  // csak az MVK vonalai: a közös menetrendben a Volán helyi vonalainak rövid neve ugyanaz lehet („23”)
  const routeByShort = new Map(feed ? [...feed.routes.values()].filter((r) => isMvkId(r.id)).map((r) => [r.short, r] as const) : []);
  const name = (id: string) => stops?.get(id)?.name ?? id;
  const peaks: RunPeak[] = rows.map((r) => ({
    date: iso,
    tripId: r.trip_id,
    vehicleId: r.vehicle_id,
    route: r.route_short,
    color: routeByShort.get(r.route_short)?.color ?? "",
    text: routeByShort.get(r.route_short)?.text ?? "",
    headsign: r.headsign ?? "",
    tram: trams.has(r.route_short),
    startDelayS: r.start_delay_s,
    hiS: r.hi_s,
    hiTs: r.hi_ts,
    hiStop: name(r.hi_stop),
    loS: r.lo_s,
    loTs: r.lo_ts,
    loStop: name(r.lo_stop),
  }));
  return dayRecords(iso, peaks);
}

export type RecordPeriod = "day" | "7" | "30" | "all";

/** napok egyszerre legfeljebb ennyi párhuzamos lekérdezéssel */
async function eachDay<T>(days: string[], fn: (d: string) => Promise<T>, parallel = 4): Promise<T[]> {
  const out: T[] = new Array(days.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, days.length) }, async () => {
      while (next < days.length) {
        const i = next++;
        out[i] = await fn(days[i]);
      }
    }),
  );
  return out;
}

/** Rekordok egy időszakra: a nap, az előző 7 vagy 30 nap, vagy minden, amiről adat van. */
export async function fleetRecords(deps: Deps, date: string, period: RecordPeriod, q: RecordQuery): Promise<RecordsResult & { from: string; to: string }> {
  const today = serviceClock().iso;
  const first = (await firstDay()) ?? date;
  const to = period === "all" ? today : date;
  const span = period === "day" ? 1 : period === "7" ? 7 : period === "30" ? 30 : Number.POSITIVE_INFINITY;
  const days: string[] = [];
  for (let d = to; d >= first && days.length < span; d = shiftIso(d, -1)) days.push(d);
  const recs = await eachDay(days, (d) => recordsOfDay(deps, d));
  return { ...mergeRecords(recs, q), from: days[days.length - 1] ?? to, to };
}

/**
 * A lezárt napok görbéje és rekordjai előre kiszámolva, a háttérben: így a
 * visszanézés, az összeomlás-keresés és a „mindig” rekordok gyorsítótárból jönnek.
 */
export async function warmFleetHistory(deps: Deps): Promise<number> {
  const first = await firstDay();
  if (!first) return 0;
  let n = 0;
  for (let d = shiftIso(serviceClock().iso, -1); d >= first; d = shiftIso(d, -1)) {
    await fleetDay(deps, d);
    await recordsOfDay(deps, d);
    n++;
    // a napi forgalmat ne fogja meg: kis szünet napok között
    await new Promise((r) => setTimeout(r, 150));
  }
  return n;
}
