/**
 * Elkapó: honnan, mivel és melyik megállóba menj, hogy pár perccel az adventi
 * villamos előtt odaérj. A villamos ma még hátralévő menetei a RAPTOR-hálózatba
 * kerülnek (az élő késéssel eltolva); az odajutás gyalog vagy bármelyik MVK-járattal
 * megy, a felszállás után pedig megállónként: hol vagy, és mivel jössz vissza.
 */
import { fastDistM, localMidnightUnix, MVK_MODES, nowUnix, serviceClock, type TransitMode } from "@mvk/core";
import type { CatchLeg, CatchOption, CatchPlan, CatchRide } from "@mvk/core/advent/catch";
import { adventRuns, type AdventRun, type FeedAdventTrip } from "@mvk/core/advent/runs";
import { dayPlan, seasonOn, type AdventSeason } from "@mvk/core/advent/season";
import type { AdventTracker } from "./advent.ts";
import type { Engine } from "./engine.ts";
import {
  cancelledToday,
  endpoints,
  INF,
  LEG_MODE,
  MAX_ACCESS_M,
  MAX_ROUNDS,
  MIN_TRANSFER_S,
  netFor,
  search,
  trace,
  WALK_DETOUR,
  WALK_MPS,
  withAdventRuns,
  type Endpoint,
  type Net,
  type Parent,
  type PTrip,
  type Search,
} from "./planner.ts";

export const CATCH_PLAN = {
  /** gyalog legkésőbb ennyivel érj oda (mp): a vártnál korábban is jöhet */
  walkMarginS: 120,
  /** gyalog ennyi az a minimum, amivel még elkapod, ha pontos (mp) */
  walkMinS: 30,
  /** járművel ennyivel: a busz is késhet */
  rideMarginS: 150,
  /** csak gyalog legfeljebb ennyit (m) */
  walkOnlyM: 1500,
  /** ennyi lehetőséget adunk, és legfeljebb ennyi menetet nézünk */
  options: 3,
  /** az indulási idők söprése: ilyen lépésben (mp), legfeljebb ennyi időre előre */
  sweepS: 5 * 60,
  horizonS: 150 * 60,
  /** a „menj elébe” lehetőség csak ennyivel korábbi elérésnél (mp) */
  chaseS: 10 * 60,
  /** felszállásonként ennyit számolunk rá (mp): egy megállóért nem éri meg buszra szállni */
  boardS: 4 * 60,
};

export type CatchInput = {
  /** a hálózat a befűzött adventi menetekkel (withAdventRuns) */
  net: Net;
  runs: AdventRun[];
  adventTrips: ReadonlySet<string>;
  season: AdventSeason;
  origin: { eps: Endpoint[]; point: { lat: number; lon: number; name: string } };
  now: number;
  /** a ma kihúzott menetek */
  skip?: ReadonlySet<string>;
  /** a menet élő késése (mp), ha úton van */
  liveDelay?: (tripId: string) => number | null;
};

type Ride = Extract<Parent, { t: "ride" }>;
type Path = { legs: Parent[]; stops: number[] };
/** a nap mp-ében: `leave` indulás, `arrive` odaérés a megállóhoz (a menet élő késésével) */
type Reach = { leave: number; arrive: number; path: Path | null };
type Cand = { run: AdventRun; pos: number; si: number; reach: Reach; chase: boolean };

const MODES: ReadonlySet<TransitMode> = new Set(MVK_MODES);

const lastRide = (p: Path): Ride | null => {
  for (let i = p.legs.length - 1; i >= 0; i--) {
    const l = p.legs[i];
    if (l.t === "ride") return l;
  }
  return null;
};

const firstRide = (p: Path): Ride | null => p.legs.find((l): l is Ride => l.t === "ride") ?? null;

/**
 * Menetenként az a megálló, ahol a legkevesebb idő megy el az indulástól a
 * villamosig (séta, utazás, várakozás, és felszállásonként egy kis teher), és ha elébe menve legalább
 * `chaseS`-sel korábban elkapod, az is. Járművel a legkésőbb induló, még jó út:
 * az indulási időket `sweepS` lépésben söpörjük, a választottat percre pontosítjuk.
 */
export function catchOptions(inp: CatchInput): CatchOption[] {
  const { net, season, origin, now } = inp;
  const midnight = localMidnightUnix(net.iso);
  const t0 = now - midnight;
  const skip = inp.skip ?? new Set<string>();
  // odafelé nem az adventi villamossal: azt éppen elkapni akarjuk
  const accessSkip = new Set([...skip, ...inp.adventTrips]);
  const runs = inp.runs.slice(0, CATCH_PLAN.options + 1);
  const until = Math.min(t0 + CATCH_PLAN.horizonS, Math.max(t0, ...runs.map((r) => r.stops[r.stops.length - 1].t - midnight)));

  const arrival = (path: Path, a: number) => {
    const last = lastRide(path);
    return a + Math.max(0, (last && inp.liveDelay?.(last.trip.id)) ?? 0);
  };
  const leaveOf = (path: Path) => {
    const first = firstRide(path);
    const o = path.legs[0];
    return (first ? first.trip.dep[first.board] : t0) - (o.t === "origin" ? o.walk : 0);
  };

  /**
   * Az 1-es vonalon a villamosok nem előzik egymást: ha az utolsó szakasz egy azonos
   * irányú villamos, és az adventi már előtte jár (vagy elhagyta a felszállást), nem érjük utol.
   */
  const overtakes = (path: Path, run: AdventRun) => {
    const last = lastRide(path);
    if (!last || last.trip.mode !== "tram") return false;
    const boardId = net.stops[net.patterns[last.p].stops[last.board]].id;
    if (!season.stops.some((s) => (run.dir === "out" ? s.out : s.back) === boardId)) return false;
    const at = run.stops.find((s) => s.stopId === boardId);
    return !at || at.t - midnight < last.trip.dep[last.board];
  };

  /** a legkevesebb átszállással időben odaérő út a keresésből */
  const rideTo = (sr: Search, run: AdventRun, si: number, deadline: number): Reach | null => {
    for (let k = 1; k <= MAX_ROUNDS; k++) {
      const a = sr.tau[k][si];
      if (a >= INF) continue;
      const path = trace(sr, k, si);
      if (!path || overtakes(path, run)) continue;
      const arrive = arrival(path, a);
      if (arrive + CATCH_PLAN.rideMarginS <= deadline) return { leave: leaveOf(path), arrive, path };
    }
    return null;
  };

  // megállónként a legkésőbbi még jó indulás: gyalog pontosan, járművel söpréssel
  type Cell = { si: number; deadline: number; best: Reach | null; open: boolean };
  const cells = runs.map((run) =>
    run.stops.map((rs): Cell | null => {
      const si = net.stopIdx.get(rs.stopId);
      if (si == null) return null;
      const st = net.stops[si];
      const d = fastDistM(origin.point.lat, origin.point.lon, st.lat, st.lon);
      const walkS = Math.round((d * WALK_DETOUR) / WALK_MPS);
      const deadline = rs.t - midnight;
      const onFoot = d <= CATCH_PLAN.walkOnlyM && t0 + walkS + CATCH_PLAN.walkMinS <= deadline;
      const leave = Math.max(t0, deadline - CATCH_PLAN.walkMarginS - walkS);
      return { si, deadline, best: onFoot ? { leave, arrive: leave + walkS, path: null } : null, open: deadline <= until };
    }),
  );
  for (let tau = t0; tau <= until; tau += CATCH_PLAN.sweepS) {
    if (!cells.some((row) => row.some((c) => c?.open))) break;
    const sr = search(net, origin.eps, null, tau, accessSkip, MODES, until);
    runs.forEach((run, ri) =>
      cells[ri].forEach((c) => {
        if (!c?.open) return;
        const got = rideTo(sr, run, c.si, c.deadline);
        // később indulva sem lesz jobb: ennél a megállónál vége a söprésnek
        if (!got) c.open = false;
        else if (!c.best || got.leave > c.best.leave) c.best = got;
      }),
    );
  }

  /** a söprés lépésközén belül: percenként még később indulva is odaér-e */
  const refine = (run: AdventRun, si: number, deadline: number, r: Reach): Reach => {
    let cur = r;
    for (let i = 0; cur.path && i < CATCH_PLAN.sweepS / 60; i++) {
      const sr = search(net, origin.eps, [{ stop: si, walk: 0 }], cur.leave + 60, accessSkip, MODES, until);
      const next = rideTo(sr, run, si, deadline);
      if (!next) break;
      cur = next;
    }
    return cur;
  };

  const picked: Cand[] = [];
  for (const [ri, run] of runs.entries()) {
    const boards = (c: Cand) => c.reach.path?.legs.filter((l) => l.t === "ride").length ?? 0;
    const cost = (c: Cand) => run.stops[c.pos].t - midnight - c.reach.leave + boards(c) * CATCH_PLAN.boardS;
    let calm: Cand | null = null;
    let first: Cand | null = null;
    for (const [pos, c] of cells[ri].entries()) {
      if (!c?.best) continue;
      const cand: Cand = { run, pos, si: c.si, reach: c.best, chase: false };
      first ??= cand;
      if (!calm || cost(cand) < cost(calm)) calm = cand;
    }
    if (!calm || !first) continue;
    picked.push(calm);
    if (first.pos !== calm.pos && run.stops[calm.pos].t - run.stops[first.pos].t >= CATCH_PLAN.chaseS) picked.push({ ...first, chase: true });
  }

  return picked.slice(0, CATCH_PLAN.options).map((c) => {
    const rs = c.run.stops[c.pos];
    const stop = net.stops[c.si];
    const reach = refine(c.run, c.si, rs.t - midnight, c.reach);
    const legs = reach.path ? legsOf(net, reach.path, origin.point, midnight, inp.liveDelay) : [walkLeg(origin.point.name, stop.name, midnight + reach.leave, midnight + reach.arrive, origin.point, stop)];
    return {
      run: c.run.key,
      dir: c.run.dir,
      headsign: c.run.headsign,
      live: c.run.live,
      uncertain: c.run.uncertain,
      stop: rs.stop,
      name: season.stops[rs.stop].name,
      at: rs.t,
      sched: rs.sched,
      leave: midnight + reach.leave,
      arrive: midnight + reach.arrive,
      slackS: rs.t - (midnight + reach.arrive),
      walkOnly: reach.path == null,
      chase: c.chase,
      legs,
      rides: ridesOf(net, season, c.run, c.pos, midnight, skip),
    };
  });
}

function walkLeg(from: string, to: string, dep: number, arr: number, a: { lat: number; lon: number }, b: { lat: number; lon: number }): CatchLeg {
  return { kind: "walk", from, to, dep, arr, m: Math.round(fastDistM(a.lat, a.lon, b.lat, b.lon)) };
}

function legsOf(net: Net, path: Path, from: { lat: number; lon: number; name: string }, midnight: number, liveDelay?: (tripId: string) => number | null): CatchLeg[] {
  const out: CatchLeg[] = [];
  const o = path.legs[0];
  const first = firstRide(path);
  let cursor = first ? first.trip.dep[first.board] : 0;
  if (o.t === "origin" && o.walk > 0) {
    const s = net.stops[path.stops[0]];
    out.push(walkLeg(from.name, s.name, midnight + cursor - o.walk, midnight + cursor, from, s));
  }
  for (let i = 1; i < path.legs.length; i++) {
    const l = path.legs[i];
    if (l.t === "walk") {
      const a = net.stops[l.from];
      const b = net.stops[path.stops[i]];
      out.push(walkLeg(a.name, b.name, midnight + cursor, midnight + cursor + l.s, a, b));
      cursor += l.s;
    } else if (l.t === "ride") {
      const pat = net.patterns[l.p];
      const t = l.trip;
      out.push({
        kind: "ride",
        mode: LEG_MODE[t.mode],
        route: t.short,
        color: t.color,
        text: t.text,
        headsign: t.headsign,
        from: net.stops[pat.stops[l.board]].name,
        to: net.stops[pat.stops[l.alight]].name,
        dep: midnight + t.dep[l.board],
        arr: midnight + t.arr[l.alight],
        stops: l.alight - l.board,
        delayS: liveDelay?.(t.id) ?? null,
      });
      cursor = t.arr[l.alight];
    }
  }
  return out;
}

/** a megálló és a vele egy helyen lévők (a másik irány oszlopa, azonos nevű szomszédok), a gyaloglással */
function placeOf(net: Net, si: number): Endpoint[] {
  const name = net.stops[si].name;
  return [{ stop: si, walk: 0 }, ...net.foot[si].filter((f) => net.stops[f.to].name === name).map((f) => ({ stop: f.to, walk: f.s }))];
}

/** a leggyorsabb közvetlen járat `from` valamelyik megállójából `to` egyikébe, `after` után */
function directRide(net: Net, from: Endpoint[], to: ReadonlySet<number>, after: number, skip: ReadonlySet<string>): { trip: PTrip; dep: number; arr: number } | null {
  let best: { trip: PTrip; dep: number; arr: number } | null = null;
  for (const o of from)
    for (const { p, pos } of net.stopPatterns[o.stop]) {
      const pat = net.patterns[p];
      let j = pos + 1;
      while (j < pat.stops.length && !to.has(pat.stops[j])) j++;
      if (j >= pat.stops.length) continue;
      for (const t of pat.trips) {
        if (skip.has(t.id) || !MODES.has(t.mode) || t.dep[pos] < after + o.walk) continue;
        if (!best || t.arr[j] < best.arr) best = { trip: t, dep: t.dep[pos], arr: t.arr[j] };
      }
    }
  return best;
}

/** felszállsz, n megállót utazol: hol vagy, és mivel érsz vissza a felszállás helyére */
function ridesOf(net: Net, season: AdventSeason, run: AdventRun, pos: number, midnight: number, skip: ReadonlySet<string>): CatchRide[] {
  const boardSi = net.stopIdx.get(run.stops[pos].stopId);
  if (boardSi == null) return [];
  const home = new Set(placeOf(net, boardSi).map((e) => e.stop));
  const out: CatchRide[] = [];
  for (let q = pos + 1; q < run.stops.length; q++) {
    const rs = run.stops[q];
    const si = net.stopIdx.get(rs.stopId);
    if (si == null) continue;
    const back = directRide(net, placeOf(net, si), home, rs.t - midnight + MIN_TRANSFER_S, skip);
    out.push({
      n: q - pos,
      stop: rs.stop,
      name: season.stops[rs.stop].name,
      at: rs.t,
      back: back
        ? {
            mode: LEG_MODE[back.trip.mode],
            route: back.trip.short,
            color: back.trip.color,
            text: back.trip.text,
            advent: season.routeShorts.includes(back.trip.short),
            dep: midnight + back.dep,
            arr: midnight + back.arr,
          }
        : null,
    });
  }
  return out;
}

/** a betöltött feed ADV-menetei (ha az MVK már közzétette őket) */
export function feedAdventTrips(net: Net, season: AdventSeason): FeedAdventTrip[] {
  const midnight = localMidnightUnix(net.iso);
  const out: FeedAdventTrip[] = [];
  for (const p of net.patterns)
    for (const t of p.trips)
      if (season.routeShorts.includes(t.short)) out.push({ id: t.id, stops: p.stops.map((s, i) => ({ stopId: net.stops[s].id, dep: midnight + t.dep[i] })) });
  return out;
}

export async function adventPlan(engine: Engine, advent: AdventTracker, from: string, now = nowUnix()): Promise<CatchPlan | { error: string }> {
  const iso = serviceClock(now).iso;
  const season = seasonOn(iso);
  if (!season) return { error: "Ma nem jár az adventi villamos." };
  const base = await netFor(engine, iso);
  if (!base) return { error: "Erre a napra nincs menetrend." };
  const day = advent.live(now);
  const feedTrips = feedAdventTrips(base, season);
  const onRoad = day?.trips.find((t) => t.verdict === "running" && t.key === day.now.trip);
  const running = onRoad ? { key: onRoad.key, delayS: day?.now.delayS ?? null } : null;
  const runs = adventRuns(season, dayPlan(season, iso), day?.etas ?? null, now, feedTrips, running);
  const place = (id: string) => {
    const s = engine.feeds.latest()?.stops.get(id) ?? base.day?.feed.stops.get(id);
    return s ? { name: s.name, lat: s.lat, lon: s.lon } : null;
  };
  const { net, tripIds } = withAdventRuns(base, runs, season, place);
  const origin = endpoints(net, from, MAX_ACCESS_M, place);
  if (!origin) return { error: "Ismeretlen kiindulópont, vagy nincs a közelében megálló." };
  const options = catchOptions({
    net,
    runs,
    adventTrips: tripIds,
    season,
    origin,
    now,
    skip: iso === engine.today ? cancelledToday(engine) : new Set(),
    liveDelay: (id) => engine.matcher.liveDelay(id, now),
  });
  const plan: CatchPlan = { at: now, date: iso, from: origin.point, live: day != null, source: feedTrips.length ? "feed" : "poster", runsLeft: runs.length, options };
  return plan;
}
