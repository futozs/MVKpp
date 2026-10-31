/**
 * Tanító- és tesztminták a késés-modellhez a lezárt napok megálló-eseményeiből.
 *
 * Egy minta: „a busz az i. megállót d0 késéssel hagyta el — mennyi lesz a
 * késése a j. megállóban?” A jellemzőket a core `delayFeatureVector` adja,
 * ugyanúgy, ahogy élesben. Naponként csak a legjobb minőségű forrás számít
 * (élő > újraszámolt > régi import), hogy egy menet ne szerepeljen kétszer.
 */
import {
  DELAY_FEATURES,
  dayInfo,
  delayFeatureVector,
  forecastDelays,
  localMidnightUnix,
  precipClass,
  profileAhead,
  RECENT_SEGMENTS,
  RecentTraffic,
  RunHistory,
  shiftIso,
  type ProfileFn,
  type SegmentProfile,
} from "@mvk/core";
import { sql } from "@mvk/db";

export type SampleSet = {
  x: Float32Array;
  rows: number;
  cols: number;
  /** cél: késésváltozás a j. megállóig (mp) */
  y: Float32Array;
  /** hány megállóval előre */
  ahead: Uint8Array;
  /** a képletes előrejelzés késésváltozása és felső becslése (mp) — az összevetéshez */
  baseline: Float32Array;
  baselineUpper: Float32Array;
  days: string[];
};

export type DatasetOptions = {
  /** a legutolsó lezárt nap (általában tegnap) */
  lastDay: string;
  /** ennyi nap összesen (tanító + validáció + teszt) */
  days: number;
  /** a végéről ennyi nap a teszthez (tanításból kihagyva) */
  testDays: number;
  /** a teszt előtti ennyi nap a korai leálláshoz és a kalibráláshoz */
  validDays: number;
  /** a tanítósorok felső korlátja (memória) */
  maxTrainRows: number;
  /** a régi (v2) import napjait is használja-e */
  includeLegacy: boolean;
  log?: (msg: string) => void;
};

const SOURCE_RANK: Record<string, number> = { live: 3, replay: 2, legacy: 1 };
const MAX_AHEAD = 30;
const MAX_ABS_DELAY_S = 3600;
/** a minták ekkora része „menet közbeni” időpontból (a többi indulás pillanatából) */
const LIVE_LIKE_SHARE = 0.75;

type Ev = { idx: number; stopId: string; arr: number; dep: number | null; delay: number; schedArr: number; schedDep: number };
type Run = { key: string; pattern: string; stopsTotal: number; events: Ev[] };

/** Napi minták egy gyűjtőben (a végén egyetlen mátrixszá fűzzük). */
class Builder {
  private chunks: { x: Float32Array; y: number[]; ahead: number[]; base: number[]; upper: number[] }[] = [];
  private cur = this.fresh();
  private fresh() {
    return { x: new Float32Array(65_536 * DELAY_FEATURES.length), n: 0, y: [] as number[], ahead: [] as number[], base: [] as number[], upper: [] as number[] };
  }
  rows = 0;
  days: string[] = [];

  push(x: Float32Array, y: number, ahead: number, base: number, upper: number) {
    if (this.cur.n === 65_536) this.flush();
    this.cur.x.set(x, this.cur.n * DELAY_FEATURES.length);
    this.cur.n++;
    this.cur.y.push(y);
    this.cur.ahead.push(ahead);
    this.cur.base.push(base);
    this.cur.upper.push(upper);
    this.rows++;
  }

  private flush() {
    const c = this.cur;
    this.chunks.push({ x: c.x.subarray(0, c.n * DELAY_FEATURES.length), y: c.y, ahead: c.ahead, base: c.base, upper: c.upper });
    this.cur = this.fresh();
  }

  build(): SampleSet {
    if (this.cur.n) this.flush();
    const cols = DELAY_FEATURES.length;
    const out: SampleSet = {
      x: new Float32Array(this.rows * cols),
      rows: this.rows,
      cols,
      y: new Float32Array(this.rows),
      ahead: new Uint8Array(this.rows),
      baseline: new Float32Array(this.rows),
      baselineUpper: new Float32Array(this.rows),
      days: this.days,
    };
    let r = 0;
    for (const c of this.chunks) {
      out.x.set(c.x, r * cols);
      for (let k = 0; k < c.y.length; k++) {
        out.y[r + k] = c.y[k];
        out.ahead[r + k] = Math.min(255, c.ahead[k]);
        out.baseline[r + k] = c.base[k];
        out.baselineUpper[r + k] = c.upper[k];
      }
      r += c.y.length;
    }
    this.chunks = [];
    return out;
  }
}

/** Naponként a legjobb forrás (élő > újraszámolt > régi import), ha van belőle érdemi mennyiség. */
async function pickDays(from: string, to: string, includeLegacy: boolean) {
  const rows = await sql<{ d: string; source: string; n: number }>(
    `SELECT service_date::text AS d, source, count(*)::int AS n FROM trip_run
      WHERE service_date BETWEEN $1 AND $2 AND status <> 'aborted' AND trip_id NOT LIKE '%:%' GROUP BY 1, 2`,
    [from, to],
  );
  const best = new Map<string, { source: string; n: number }>();
  for (const r of rows) {
    if (r.n < 300 || (!includeLegacy && r.source === "legacy")) continue;
    const cur = best.get(r.d);
    if (!cur || SOURCE_RANK[r.source] > SOURCE_RANK[cur.source]) best.set(r.d, { source: r.source, n: r.n });
  }
  return [...best.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => ({ day: d, ...v }));
}

/** Szakaszprofilok (naptípus × óra) a megadott napokból — a teszt napjai nincsenek benne. */
export async function loadProfiles(fromIso: string, toIsoExclusive: string): Promise<Map<string, SegmentProfile>> {
  const rows = await sql<{ f: string; t: string; d: number; h: number; p50: number; p85: number }>(
    `SELECT from_stop AS f, to_stop AS t, daytype AS d, (tod_bucket / 4)::int AS h,
            approx_percentile(0.5, rollup(travel_pct)) AS p50, approx_percentile(0.85, rollup(travel_pct)) AS p85
       FROM segment_daily WHERE bucket >= $1::date AND bucket < $2::date
        -- a késés-modell az MVK-ra tanul (a regionális megállók előtagosak)
        AND from_stop NOT LIKE '%:%' AND to_stop NOT LIKE '%:%'
      GROUP BY 1, 2, 3, 4 HAVING sum(n) >= 4`,
    [fromIso, toIsoExclusive],
  );
  const m = new Map<string, SegmentProfile>();
  for (const r of rows) m.set(`${r.f}|${r.t}|${r.d}|${r.h}`, { p50: r.p50, p85: r.p85 });
  return m;
}

async function loadWeather(fromIso: string, toIso: string) {
  const rows = await sql<{ h: number; temp: number | null; wmo: number | null }>(
    `SELECT (extract(epoch FROM hour) / 3600)::int AS h, temp_c AS temp, wmo_code AS wmo FROM weather_hour
      WHERE hour >= $1::date - 1 AND hour < $2::date + 2`,
    [fromIso, toIso],
  );
  return new Map(rows.map((r) => [r.h, { temp: r.temp, precip: precipClass(r.wmo) }]));
}

async function loadDay(day: string, source: string): Promise<Run[]> {
  const rows = await sql<{ k: string; trip: string; tot: number; idx: number; stop: string; arr: number; dep: number | null; delay: number; sa: number; sd: number }>(
    `SELECT e.run_key AS k, e.trip_id AS trip, t.stops_total AS tot, e.stop_idx AS idx, e.stop_id AS stop,
            extract(epoch FROM e.ts)::int AS arr, extract(epoch FROM e.dep_ts)::int AS dep, e.delay_s AS delay,
            e.sched_arr_s AS sa, e.sched_dep_s AS sd
       FROM stop_event e JOIN trip_run t ON t.run_key = e.run_key
      WHERE e.service_date = $1 AND t.source = $2 AND e.src <> 3 AND e.trip_id NOT LIKE '%:%'
      ORDER BY e.run_key, e.stop_idx`,
    [day, source],
  );
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const r of rows) {
    if (!cur || cur.key !== r.k) {
      cur = { key: r.k, pattern: r.trip.split("_")[1] ?? r.trip, stopsTotal: r.tot, events: [] };
      runs.push(cur);
    }
    const last = cur.events[cur.events.length - 1];
    if (last && last.idx === r.idx) continue;
    cur.events.push({ idx: r.idx, stopId: r.stop, arr: r.arr, dep: r.dep, delay: r.delay, schedArr: r.sa, schedDep: r.sd });
  }
  return runs;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Egy nap mintái. `originShare`: az indulópontok ennyied részéből; `horizons`:
 * indulópontonként ennyi véletlen célmegálló (a teszthez több).
 */
function samplesOfDay(day: string, runs: Run[], profiles: Map<string, SegmentProfile>, weather: Map<number, { temp: number | null; precip: number | null }>, out: Builder, originShare: number, horizons: number, rnd: () => number) {
  const info = dayInfo(day);
  const midnight = localMidnightUnix(day);
  const profile: ProfileFn = (f, t, h) => profiles.get(`${f}|${t}|${info.daytype}|${h}`);
  const history = new RunHistory();
  const traffic = new RecentTraffic();
  for (const r of runs) {
    for (let k = 0; k < r.events.length; k++) {
      const e = r.events[k];
      history.add(r.pattern, r.key, e.idx, e.arr, e.delay);
      const prev = r.events[k - 1];
      if (prev && prev.idx === e.idx - 1) {
        const p = profile(prev.stopId, e.stopId, Math.floor((((prev.schedDep % 86_400) + 86_400) % 86_400) / 3600));
        if (p) traffic.add(prev.stopId, e.stopId, e.arr, e.arr - (prev.dep ?? prev.arr) - p.p50);
      }
    }
  }
  traffic.finalize();

  const x = new Float32Array(DELAY_FEATURES.length);
  for (const r of runs) {
    const seq = r.events.map((e) => ({ stopId: e.stopId, arr: e.schedArr, dep: e.schedDep }));
    for (let p = 0; p < r.events.length - 1; p++) {
      if (rnd() >= originShare) continue;
      const o = r.events[p];
      const next = r.events[p + 1];
      // Élesben bármikor kérdezhetnek: a busz épp elindult, két megálló között jár,
      // vagy a következőben áll (annak eseménye ilyenkor még nincs meg). A késést
      // úgy mérjük, ahogy az élő motor: a menetrend arányos helyéhez képest.
      const depO = o.dep ?? o.arr;
      let t = depO;
      let d0 = depO - (midnight + o.schedDep);
      if (next && next.idx === o.idx + 1 && rnd() < LIVE_LIKE_SHARE) {
        const until = Math.max(depO + 1, next.dep ?? next.arr);
        t = depO + Math.floor(rnd() * (until - depO));
        const frac = Math.min(1, Math.max(0, (t - depO) / Math.max(1, next.arr - depO)));
        d0 = Math.round(t - (midnight + o.schedDep + (next.schedArr - o.schedDep) * frac));
      }
      if (Math.abs(d0) > MAX_ABS_DELAY_S) continue;
      const ahead = profileAhead(seq, p, profile);
      const base = forecastDelays(seq, p, d0, profile);
      const last = Math.min(r.events.length - 1, p + MAX_AHEAD);
      const cands: number[] = [];
      for (let q = p + 1; q <= last; q++) cands.push(q);
      // véletlen célmegállók (Fisher–Yates részlegesen)
      for (let k = 0; k < Math.min(horizons, cands.length); k++) {
        const pick = k + Math.floor(rnd() * (cands.length - k));
        [cands[k], cands[pick]] = [cands[pick], cands[k]];
        const q = cands[k];
        const target = r.events[q];
        const y = target.delay - d0;
        if (Math.abs(target.delay) > MAX_ABS_DELAY_S) continue;
        const segs: [string, string][] = [];
        for (let s = p; s < Math.min(q, p + RECENT_SEGMENTS); s++) segs.push([r.events[s].stopId, r.events[s + 1].stopId]);
        const w = weather.get(Math.floor(t / 3600));
        const b = base[q - p - 1];
        delayFeatureVector(
          {
            d0,
            ahead: target.idx - o.idx,
            schedAhead: target.schedArr - o.schedDep,
            gain: ahead.gain[q - p - 1],
            spread: ahead.spread[q - p - 1],
            baseline: b.delayS - d0,
            hour: (t - midnight) / 3600,
            daytype: info.daytype,
            school: info.school,
            trend: history.trend(r.key, o.idx),
            leader: history.leader(r.pattern, r.key, o.idx, target.idx, t),
            recent: traffic.query(segs, t),
            precip: w?.precip ?? null,
            temp: w?.temp ?? null,
            progress: o.idx / Math.max(1, r.stopsTotal - 1),
          },
          x,
        );
        out.push(x, y, target.idx - o.idx, b.delayS - d0, b.upperS - d0);
      }
    }
  }
}

/**
 * A tanító, validációs és tesztkészlet. A szakaszprofilok csak a teszt előtti
 * napokból készülnek (a teszt így tényleg „sosem látott” napokon mér).
 */
export async function buildDataset(o: DatasetOptions) {
  const log = o.log ?? (() => {});
  const from = shiftIso(o.lastDay, -(o.days - 1));
  const days = await pickDays(from, o.lastDay, o.includeLegacy);
  if (days.length < o.testDays + o.validDays + 3) throw new Error(`kevés nap van tanításhoz (${days.length})`);
  const test = days.slice(-o.testDays);
  const valid = days.slice(-(o.testDays + o.validDays), -o.testDays);
  const train = days.slice(0, -(o.testDays + o.validDays));
  const testStart = test[0].day;
  const profiles = await loadProfiles(shiftIso(testStart, -56), testStart);
  const weather = await loadWeather(from, o.lastDay);
  log(`napok: tanító ${train.length} (${train[0].day}…), validáció ${valid.length}, teszt ${test.length} (${testStart}…) · ${profiles.size} szakaszprofil`);

  // A sorkorláthoz igazított mintavétel: becsült ~35 000 esemény / nap, indulópontonként 3 célmegálló.
  const trainShare = Math.min(1, o.maxTrainRows / Math.max(1, train.length * 35_000 * 3));
  const rnd = mulberry(20261029);
  const sets = { train: new Builder(), valid: new Builder(), test: new Builder() };
  for (const [name, list, share, horizons] of [
    ["train", train, trainShare, 3],
    ["valid", valid, Math.min(1, trainShare * 1.5), 4],
    ["test", test, 0.35, 6],
  ] as const) {
    for (const d of list) {
      const runs = await loadDay(d.day, d.source);
      samplesOfDay(d.day, runs, profiles, weather, sets[name], share, horizons, rnd);
      sets[name].days.push(d.day);
    }
    log(`${name}: ${sets[name].rows} minta`);
  }
  return { train: sets.train.build(), valid: sets.valid.build(), test: sets.test.build(), profilesFrom: shiftIso(testStart, -56), testStart };
}
