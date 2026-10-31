/**
 * Útvonaltervező — RAPTOR (Round-bAsed Public Transit Optimized Router).
 *
 * Bármelyik napra működik, amire van menetrend (élő feed, tárolt feed, vagy
 * a v2-archívum), így a MÚLTBA is lehet tervezni. A legekhez:
 *  - jövő / most: késés-előrejelzés (élő késés, ha a busz már úton van;
 *    különben a mért előzmény az adott vonalra, megállóra, napszakra);
 *  - múlt: a TÉNYLEGES indulás/érkezés és a jármű a megálló-eseményekből.
 * Miskolc mérete mellett egy keresés néhány ezredmásodperc.
 */
import {
  budapestOffsetSec,
  chanceLevel,
  dayInfo,
  fastDistM,
  isMvkId,
  localMidnightUnix,
  modeOfRoute,
  MVK_MODES,
  serviceClock,
  spreadOf,
  trainParts,
  transferChance,
  type DaySchedule,
  type ServiceDay,
  type TransitMode,
} from "@mvk/core";
import { sql } from "@mvk/db";
import type { Engine } from "./engine.ts";
import type { TripInsights } from "./insights.ts";
import { scheduleFor } from "./schedule.ts";

const WALK_MPS = 1.25;
const WALK_DETOUR = 1.3;
const MAX_FOOTPATH_M = 450;
const MAX_ACCESS_M = 700;
/** a tervezett szakasz módja (az MVK API `mode` értékeivel egyezően; COACH, RAIL a regionális) */
const LEG_MODE: Record<TransitMode, string> = { tram: "TRAM", bus: "BUS", coach: "COACH", rail: "RAIL" };

/**
 * Vágány / kocsiállás a felszállásnál: mára az élő (a MÁV táblájáról, a változással együtt),
 * különben a menetrendi. Az állomást figyeltre tesszük, hogy a következő kérésre már élő legyen.
 */
function platformOf(engine: Engine, net: Net, tripId: string, stopId: string): { fromPlatform?: string } {
  let live: string | null = null;
  if (net.iso === engine.today && !isMvkId(stopId) && engine.regional) {
    engine.regional.touch(stopId);
    live = engine.regional.platform(tripId, stopId);
  }
  const p = live ?? net.day?.feed.stops.get(stopId)?.platform;
  return p ? { fromPlatform: p } : {};
}

/** a vonatszám és a vonat neve a menet rövid nevéből („582 TOKAJ InterCity” → 582, TOKAJ) */
function trainOf(tripShort: string): { trainNo?: string; trainName?: string } {
  const t = trainParts(tripShort);
  return { ...(t.no ? { trainNo: t.no } : {}), ...(t.name ? { trainName: t.name } : {}) };
}
const MIN_TRANSFER_S = 60;
const MAX_ROUNDS = 4;
const INF = 1e12;

type PStop = { id: string; name: string; lat: number; lon: number };
/** `key`: a vonal kulcsa a statisztikában (MVK: a rövid név, máshol a vonal-azonosító); `mode`: a közlekedési mód */
type PTrip = { id: string; routeId: string; short: string; key: string; mode: TransitMode; long: string; color: string; text: string; type: string; headsign: string; dep: number[]; arr: number[]; tripShort?: string };
type Pattern = { stops: number[]; trips: PTrip[]; shapeId: string | null };
type Net = {
  iso: string;
  feedVersion: string;
  source: "feed" | "legacy";
  fallback: string | null;
  stops: PStop[];
  stopIdx: Map<string, number>;
  patterns: Pattern[];
  stopPatterns: { p: number; pos: number }[][];
  foot: { to: number; s: number }[][];
  day: ServiceDay | null;
};

const netCache = new Map<string, Net>();

function finishNet(base: Omit<Net, "stopPatterns" | "foot">): Net {
  const n = base.stops.length;
  const stopPatterns: Net["stopPatterns"] = Array.from({ length: n }, () => []);
  base.patterns.forEach((pt, p) => pt.stops.forEach((s, pos) => stopPatterns[s].push({ p, pos })));
  const foot: Net["foot"] = Array.from({ length: n }, () => []);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const sa = base.stops[a];
      const sb = base.stops[b];
      if (Math.abs(sa.lat - sb.lat) > 0.005 || Math.abs(sa.lon - sb.lon) > 0.007) continue;
      const d = fastDistM(sa.lat, sa.lon, sb.lat, sb.lon);
      if (d > MAX_FOOTPATH_M && sa.name !== sb.name) continue;
      if (d > 900) continue;
      const s = Math.round((d * WALK_DETOUR) / WALK_MPS) + 20;
      foot[a].push({ to: b, s });
      foot[b].push({ to: a, s });
    }
  }
  for (const p of base.patterns) p.trips.sort((x, y) => x.dep[0] - y.dep[0]);
  return { ...base, stopPatterns, foot };
}

function netFromFeed(day: ServiceDay): Net {
  const feed = day.feed;
  const stops: PStop[] = [];
  const stopIdx = new Map<string, number>();
  const idx = (id: string) => {
    let i = stopIdx.get(id);
    if (i == null) {
      const s = feed.stops.get(id);
      i = stops.length;
      stops.push({ id, name: s?.name ?? id, lat: s?.lat ?? 0, lon: s?.lon ?? 0 });
      stopIdx.set(id, i);
    }
    return i;
  };
  const byKey = new Map<string, Pattern>();
  for (const t of feed.trips.values()) {
    if (!day.services.has(t.serviceId)) continue;
    const st = feed.tripStops.get(t.id);
    if (!st || st.length < 2) continue;
    const key = st.map((x) => x.stopId).join(">");
    let p = byKey.get(key);
    if (!p) byKey.set(key, (p = { stops: st.map((x) => idx(x.stopId)), trips: [], shapeId: t.shapeId || null }));
    const r = feed.routes.get(t.routeId);
    p.trips.push({
      id: t.id, routeId: t.routeId, short: r?.short ?? t.routeId, key: r?.key ?? t.routeId, mode: modeOfRoute(t.routeId, r?.type ?? ""), long: r?.long ?? "", color: r?.color ?? "888888", text: r?.text ?? "FFFFFF",
      type: r?.type ?? "3", headsign: t.headsign, dep: st.map((x) => x.dep), arr: st.map((x) => x.arr), ...(t.shortName ? { tripShort: t.shortName } : {}),
    });
  }
  return finishNet({ iso: day.iso, feedVersion: day.feed.version, source: "feed", fallback: day.fallback?.templateIso ?? null, stops, stopIdx, patterns: [...byKey.values()], day });
}

/** A v2-archívum (perces pontosságú táblák) → hálózat. */
function netFromLegacy(iso: string, data: DaySchedule, fallback: string | null): Net {
  const stops: PStop[] = [];
  const stopIdx = new Map<string, number>();
  const byKey = new Map<string, Pattern>();
  const hm = (s: string) => Number(s.slice(0, 2)) * 3600 + Number(s.slice(3, 5)) * 60;
  for (const table of Object.values(data.tables)) {
    const tStops = table.stops.map((s) => {
      let i = stopIdx.get(s.id);
      if (i == null) {
        i = stops.length;
        stops.push({ id: s.id, name: s.name, lat: s.lat ?? 0, lon: s.lon ?? 0 });
        stopIdx.set(s.id, i);
      }
      return i;
    });
    for (const trip of table.trips) {
      const seq: number[] = [];
      const times: number[] = [];
      let prev = -1;
      trip.times.forEach((t, k) => {
        if (!t) return;
        let sec = hm(t);
        if (prev >= 0) while (sec < prev - 6 * 3600) sec += 86400; // éjfél utáni idők
        if (prev < 0 && sec < 3 * 3600) sec += 86400;
        prev = sec;
        seq.push(tStops[k]);
        times.push(sec);
      });
      if (seq.length < 2) continue;
      const key = seq.join(">");
      let p = byKey.get(key);
      if (!p) byKey.set(key, (p = { stops: seq, trips: [], shapeId: null }));
      const r = table.route;
      p.trips.push({ id: trip.tripId, routeId: r.id, short: r.short, key: r.short, mode: modeOfRoute(r.id, r.type), long: r.long, color: r.color, text: r.text, type: r.type, headsign: trip.headsign, dep: times, arr: times });
    }
  }
  return finishNet({ iso, feedVersion: data.feedVersion, source: "legacy", fallback, stops, stopIdx, patterns: [...byKey.values()], day: null });
}

export async function netFor(engine: Engine, iso: string): Promise<Net | null> {
  const src = await scheduleFor(engine.feeds, iso);
  if (!src) return null;
  // A kulcsban a feed is: ha közben megjön az igazi menetrend (a holnapi napra
  // eddig a sablon-nap élt), a régi hálózat ne ragadjon be.
  const key = src.kind === "feed" ? `${iso}|${src.day.feed.hash}|${src.day.fallback?.templateIso ?? ""}` : `${iso}|legacy`;
  const hit = netCache.get(key);
  if (hit) return hit;
  const net = src.kind === "feed" ? netFromFeed(src.day) : netFromLegacy(iso, src.data, src.fallbackFrom);
  netCache.set(key, net);
  if (netCache.size > 4) netCache.delete(netCache.keys().next().value!);
  return net;
}

// ── RAPTOR ─────────────────────────────────────────────────────────────

type Parent =
  | { t: "origin"; walk: number }
  | { t: "ride"; p: number; trip: PTrip; board: number; alight: number; from: number }
  | { t: "walk"; from: number; s: number };

type Endpoint = { stop: number; walk: number };

/**
 * `skip`: kihagyandó menetek (az MVK által ma kihúzottak — azokra nem tervezünk);
 * `modes`: csak ezekkel a közlekedési módokkal (a felhasználó beállítása szerint).
 */
function raptor(net: Net, origins: Endpoint[], dests: Endpoint[], dep: number, skip: ReadonlySet<string> = new Set(), modes: ReadonlySet<TransitMode> | null = null) {
  const n = net.stops.length;
  const tau: Float64Array[] = Array.from({ length: MAX_ROUNDS + 1 }, () => new Float64Array(n).fill(INF));
  const parent: (Parent | null)[][] = Array.from({ length: MAX_ROUNDS + 1 }, () => new Array(n).fill(null));
  const best = new Float64Array(n).fill(INF);
  let marked = new Set<number>();
  for (const o of origins) {
    const t = dep + o.walk;
    if (t < tau[0][o.stop]) {
      tau[0][o.stop] = t;
      best[o.stop] = t;
      parent[0][o.stop] = { t: "origin", walk: o.walk };
      marked.add(o.stop);
    }
  }
  const destBest = () => {
    let b = INF;
    for (const d of dests) b = Math.min(b, best[d.stop] + d.walk);
    return b;
  };

  for (let k = 1; k <= MAX_ROUNDS; k++) {
    const queue = new Map<number, number>();
    for (const s of marked)
      for (const { p, pos } of net.stopPatterns[s]) {
        const cur = queue.get(p);
        if (cur == null || pos < cur) queue.set(p, pos);
      }
    const nextMarked = new Set<number>();
    const bound = destBest();
    for (const [p, startPos] of queue) {
      const pat = net.patterns[p];
      let trip: PTrip | null = null;
      let boardPos = -1;
      let boardStop = -1;
      for (let i = startPos; i < pat.stops.length; i++) {
        const s = pat.stops[i];
        if (trip) {
          const a = trip.arr[i];
          if (a < Math.min(best[s], bound)) {
            tau[k][s] = a;
            best[s] = a;
            parent[k][s] = { t: "ride", p, trip, board: boardPos, alight: i, from: boardStop };
            nextMarked.add(s);
          }
        }
        const prevArr = tau[k - 1][s];
        if (prevArr < INF && (!trip || prevArr + (k > 1 ? MIN_TRANSFER_S : 0) <= trip.dep[i])) {
          const need = prevArr + (k > 1 ? MIN_TRANSFER_S : 0);
          let cand: PTrip | null = null;
          for (const t of pat.trips) if (!skip.has(t.id) && (!modes || modes.has(t.mode)) && t.dep[i] >= need && (!cand || t.dep[i] < cand.dep[i])) cand = t;
          if (cand && (!trip || cand.dep[i] < trip.dep[i])) {
            trip = cand;
            boardPos = i;
            boardStop = s;
          }
        }
      }
    }
    for (const s of [...nextMarked]) {
      for (const f of net.foot[s]) {
        const a = tau[k][s] + f.s;
        if (a < tau[k][f.to] && a < best[f.to]) {
          tau[k][f.to] = a;
          best[f.to] = a;
          parent[k][f.to] = { t: "walk", from: s, s: f.s };
          nextMarked.add(f.to);
        }
      }
    }
    if (!nextMarked.size) break;
    marked = nextMarked;
  }

  // Pareto: körönként (átszállásszám) a legjobb érkezés.
  type Journey = { arrival: number; rounds: number; dest: Endpoint; legs: Parent[]; stops: number[] };
  const out: Journey[] = [];
  let bestSoFar = INF;
  for (let k = 1; k <= MAX_ROUNDS; k++) {
    let bd: Endpoint | null = null;
    let ba = INF;
    for (const d of dests) {
      const a = tau[k][d.stop] + d.walk;
      if (a < ba) {
        ba = a;
        bd = d;
      }
    }
    if (!bd || ba >= bestSoFar) continue;
    bestSoFar = ba;
    const legs: Parent[] = [];
    const legStops: number[] = [];
    let s = bd.stop;
    let r = k;
    for (let guard = 0; guard < 20; guard++) {
      const pa = parent[r][s];
      if (!pa) break;
      legs.unshift(pa);
      legStops.unshift(s);
      if (pa.t === "origin") break;
      if (pa.t === "ride") {
        s = pa.from;
        r -= 1;
      } else s = pa.from;
    }
    if (legs[0]?.t === "origin") out.push({ arrival: ba, rounds: k, dest: bd, legs, stops: legStops });
  }
  return out;
}

// ── lekérdezés ─────────────────────────────────────────────────────────

/** `modes`: a tervezésben használható módok (alapból csak az MVK, mint eddig) */
export type PlanQuery = { from: string; to: string; at: number; arriveBy?: boolean; limit?: number; modes?: ReadonlySet<TransitMode> };

function endpoints(net: Net, spec: string, maxWalk: number, lookup: (id: string) => { lat: number; lon: number; name: string } | null): { eps: Endpoint[]; point: { lat: number; lon: number; name: string } } | null {
  let lat: number;
  let lon: number;
  let name: string;
  const m = spec.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  const sid = spec.replace(/^stop:/, "");
  if (m) {
    lat = Number(m[1]);
    lon = Number(m[2]);
    name = "Kiválasztott pont";
  } else {
    const i = net.stopIdx.get(sid);
    // A megálló aznap nem kiszolgált is lehet (más irány / más nap) — ilyenkor a helyéhez legközelebbi megállókat használjuk.
    const s = i != null ? net.stops[i] : lookup(sid);
    if (!s) return null;
    ({ lat, lon, name } = s);
  }
  const eps: Endpoint[] = [];
  net.stops.forEach((s, i) => {
    const d = fastDistM(lat, lon, s.lat, s.lon);
    const same = !m && s.name === name;
    // Helynévre keresünk: az azonos nevű megállóoszlopok (pl. a Tiszai pu. 6 oszlopa)
    // ugyanaz a hely, közöttük nem mutatunk külön „gyaloglást”.
    if (d <= maxWalk || (same && d < 900)) eps.push({ stop: i, walk: same ? 0 : Math.round((d * WALK_DETOUR) / WALK_MPS) });
  });
  return eps.length ? { eps, point: { lat, lon, name } } : null;
}

export async function plan(engine: Engine, q: PlanQuery, insights?: TripInsights) {
  const clock = serviceClock(q.at);
  const net = await netFor(engine, clock.iso);
  if (!net) return { error: "Erre a napra nincs menetrend." } as const;
  const lookup = (id: string) => {
    const s = engine.feeds.latest()?.stops.get(id) ?? net.day?.feed.stops.get(id);
    return s ? { lat: s.lat, lon: s.lon, name: s.name } : null;
  };
  const o = endpoints(net, q.from, MAX_ACCESS_M, lookup);
  const d = endpoints(net, q.to, MAX_ACCESS_M, lookup);
  if (!o || !d) return { error: "Ismeretlen kiinduló- vagy célpont." } as const;
  const midnight = localMidnightUnix(clock.iso);
  const limit = Math.max(1, Math.min(6, q.limit ?? 4));
  // a mai kihúzott menetekkel nem tervezünk (más napra nincs ilyen lista)
  const skip: ReadonlySet<string> =
    net.iso === engine.today ? (engine.regional?.cancelled.size ? new Set([...engine.cancelled.ids, ...engine.regional.cancelled]) : engine.cancelled.ids) : new Set();
  const modes = q.modes ?? new Set(MVK_MODES);

  type J = ReturnType<typeof raptor>[number];
  const found = new Map<string, J & { dep: number }>();
  const target = q.at - midnight;
  let t = target - (q.arriveBy ? 2 * 3600 : 0);
  // Indulási időre: néhány egymást követő indulás elég. Érkezésire: a célidőig végigmegyünk.
  const more = (iter: number) => (q.arriveBy ? iter < 60 && t < target : iter < 16 && found.size < limit * 3);
  for (let iter = 0; more(iter); iter++) {
    const js = raptor(net, o.eps, d.eps, t, skip, modes);
    if (!js.length) break;
    let nextT = INF;
    for (const j of js) {
      const first = j.legs.find((x) => x.t === "ride") as Extract<Parent, { t: "ride" }> | undefined;
      if (!first) continue;
      const depAt = first.trip.dep[first.board];
      nextT = Math.min(nextT, depAt + 60);
      const key = j.legs.map((x) => (x.t === "ride" ? `${x.trip.id}:${x.board}-${x.alight}` : x.t)).join("|");
      if (!found.has(key)) found.set(key, { ...j, dep: depAt });
    }
    if (nextT >= INF || nextT <= t) break;
    t = nextT;
  }
  let list = [...found.values()];
  if (q.arriveBy) {
    list = list.filter((j) => j.arrival <= target).sort((a, b) => b.dep - a.dep || a.arrival - b.arrival);
  } else {
    // Ne kínáljunk olyat, ami később indul ÉS később ér be, mint egy másik.
    list.sort((a, b) => a.arrival - b.arrival || a.rounds - b.rounds);
    list = list.filter((j, i) => !list.slice(0, i).some((x) => x.dep >= j.dep && x.arrival <= j.arrival && x.rounds <= j.rounds));
    list.sort((a, b) => a.dep - b.dep);
  }
  list = list.slice(0, limit);

  const mode = clock.iso < engine.today ? "past" : q.at > Date.now() / 1000 + 600 ? "future" : "now";
  const trips = [];
  for (const j of list) trips.push(await describe(engine, net, j, o.point, d.point, midnight, mode, insights));
  return {
    date: clock.iso,
    at: q.at,
    mode,
    arriveBy: Boolean(q.arriveBy),
    schedule: { feedVersion: net.feedVersion, source: net.source, fallback: net.fallback },
    from: o.point,
    to: d.point,
    trips,
  } as const;
}

type Mode = "past" | "now" | "future";

async function describe(engine: Engine, net: Net, j: ReturnType<typeof raptor>[number], from: { lat: number; lon: number; name: string }, to: { lat: number; lon: number; name: string }, midnight: number, mode: Mode, insights?: TripInsights) {
  const iso = net.iso;
  const legs: Record<string, unknown>[] = [];
  const iso8601 = (sec: number) => new Date((midnight + sec) * 1000).toISOString();
  let cursor = 0;
  const origin = j.legs[0] as Extract<Parent, { t: "origin" }>;
  const firstStop = net.stops[j.stops[0]];
  const firstRide = j.legs.find((x) => x.t === "ride") as Extract<Parent, { t: "ride" }>;
  const startSec = firstRide.trip.dep[firstRide.board] - origin.walk;
  cursor = startSec;
  if (origin.walk > 0) {
    legs.push(walkLeg(from.name, from, null, firstStop, iso8601(cursor), iso8601(cursor + origin.walk), origin.walk));
  }
  cursor += origin.walk;
  for (let i = 1; i < j.legs.length; i++) {
    const L = j.legs[i];
    if (L.t === "walk") {
      const a = net.stops[L.from];
      const b = net.stops[j.stops[i]];
      legs.push(walkLeg(a.name, a, a.id, b, iso8601(cursor), iso8601(cursor + L.s), L.s));
      cursor += L.s;
    } else if (L.t === "ride") {
      const pat = net.patterns[L.p];
      const a = net.stops[pat.stops[L.board]];
      const b = net.stops[pat.stops[L.alight]];
      const dep = L.trip.dep[L.board];
      const arr = L.trip.arr[L.alight];
      const inter = pat.stops.slice(L.board + 1, L.alight).map((s) => net.stops[s].name);
      let dist = 0;
      for (let k = L.board; k < L.alight; k++) {
        const x = net.stops[pat.stops[k]];
        const y = net.stops[pat.stops[k + 1]];
        dist += fastDistM(x.lat, x.lon, y.lat, y.lon);
      }
      const shape = shapeSlice(net, L.trip.id, pat.stops.slice(L.board, L.alight + 1).map((s) => net.stops[s]));
      const info = mode === "past" ? await actual(iso, L.trip, a.id, b.id, dep, arr) : await predicted(engine, iso, L.trip, a.id, b.id, midnight + dep, mode);
      legs.push({
        mode: LEG_MODE[L.trip.mode],
        routeShortName: L.trip.short,
        // v3: a vonal kulcsa, a menet neve (vasút: „5139 személyvonat”) és a vágány / kocsiállás
        routeKey: L.trip.key,
        ...(L.trip.tripShort ? { tripShortName: L.trip.tripShort } : {}),
        // vonatnál a szám és a név külön (a csempén „IC 582”, mellette „TOKAJ”)
        ...(L.trip.mode === "rail" && L.trip.tripShort ? trainOf(L.trip.tripShort) : {}),
        ...platformOf(engine, net, L.trip.id, a.id),
        routeLongName: L.trip.long,
        routeColor: L.trip.color,
        routeTextColor: L.trip.text,
        polyline: null,
        shape,
        tripId: L.trip.id,
        headsign: L.trip.headsign,
        fromStopId: a.id,
        fromName: a.name,
        from: { lat: a.lat, lon: a.lon },
        toStopId: b.id,
        toName: b.name,
        to: { lat: b.lat, lon: b.lon },
        start: iso8601(dep),
        end: iso8601(arr),
        durationSec: arr - dep,
        distanceMeter: Math.round(dist),
        intermediateStopNames: inter,
        schedDep: midnight + dep,
        schedArr: midnight + arr,
        ...info,
      });
      cursor = arr;
    }
  }
  const last = net.stops[j.dest.stop];
  if (j.dest.walk > 0) legs.push(walkLeg(last.name, last, last.id, to, iso8601(cursor), iso8601(cursor + j.dest.walk), j.dest.walk));
  const end = j.arrival;

  // Átszállási kockázat: elérjük-e a következő járatot a várható késésekkel.
  const rides = legs.filter((l) => l.mode !== "WALK") as Record<string, any>[];
  const transfers = [];
  for (let k = 0; k < rides.length - 1; k++) {
    const a = rides[k];
    const b = rides[k + 1];
    // A két járat közti gyaloglás is az átszállási időből megy el.
    const ia = legs.indexOf(a);
    const ib = legs.indexOf(b);
    const walk = legs.slice(ia + 1, ib).reduce((s2, l) => s2 + (l.mode === "WALK" ? Number(l.durationSec ?? 0) : 0), 0);
    const arrive = a.schedArr + (a.prediction?.arrDelayP85S ?? a.actual?.arrDelayS ?? 0) + walk;
    const leave = b.schedDep + (b.prediction?.depDelayS ?? b.actual?.depDelayS ?? 0);
    const margin = leave - arrive;
    if (mode === "past") {
      transfers.push({ at: a.toName, marginSec: margin, risk: margin < 0 ? "risky" : margin < 180 ? "tight" : "safe" });
      continue;
    }
    // Jövő / most: valódi esély a két busz bizonytalan idejéből (ma az élő és a
    // hamarosan induló menetekre az előrejelzés, különben a mért előzmény).
    const ids = { fromTripId: a.tripId, toTripId: b.tripId, alightStopId: a.toStopId, boardStopId: b.fromStopId, walkS: walk, fromRoute: a.routeShortName, toRoute: b.routeShortName };
    const hist = { arrDelayS: a.prediction?.arrDelayS ?? null, arrUpperS: a.prediction?.arrDelayP85S ?? null, depDelayS: b.prediction?.depDelayS ?? null };
    const today = insights && net.iso === engine.today;
    const o = today ? insights.transferOutlook({ fromTrip: a.tripId, alightStopId: a.toStopId, toTrip: b.tripId, boardStopId: b.fromStopId, walkS: walk }, undefined, hist) : null;
    const chance =
      o?.chance ??
      Math.round(
        transferChance(
          spreadOf(a.schedArr + (hist.arrDelayS ?? 0), hist.arrUpperS != null ? a.schedArr + hist.arrUpperS : null),
          spreadOf(b.schedDep + (hist.depDelayS ?? 0), null),
          walk,
        ) * 100,
      ) / 100;
    // Ha nem biztos: mi a következő lehetőség ugyanazzal a vonallal, ha lekésed.
    const ready = (o?.arriveUnix ?? a.schedArr + (hist.arrUpperS ?? hist.arrDelayS ?? 0)) + walk;
    const fallback = today && chance < 0.85 ? insights.nextDeparture(b.fromStopId, b.routeShortName, Math.max(ready, b.schedDep + 60)) : null;
    transfers.push({ at: a.toName, marginSec: o?.marginS ?? margin, risk: chanceLevel(chance), chance, fallback, ...ids });
  }
  const tracked = rides.every((r) => r.actual?.tracked);
  return {
    logDetailsId: 0,
    travelProfile: "TRANSIT",
    start: iso8601(startSec),
    end: iso8601(end),
    durationSec: end - startSec,
    distanceMeter: legs.reduce((s, l) => s + Number(l.distanceMeter ?? 0), 0),
    transfers: rides.length - 1,
    transferChecks: transfers,
    legs,
    ...(mode === "past" ? { actualOutcome: rides.length ? summarizeActual(rides, tracked) : null } : {}),
  };
}

function walkLeg(fromName: string, from: { lat: number; lon: number }, fromId: string | null, to: { lat: number; lon: number; name: string; id?: string }, start: string, end: string, s: number) {
  return {
    mode: "WALK",
    routeShortName: null,
    routeLongName: null,
    routeColor: null,
    polyline: null,
    fromStopId: fromId,
    fromName,
    from: { lat: from.lat, lon: from.lon },
    toStopId: to.id ?? null,
    toName: to.name,
    to: { lat: to.lat, lon: to.lon },
    start,
    end,
    durationSec: s,
    distanceMeter: Math.round((s * WALK_MPS) / WALK_DETOUR),
    intermediateStopNames: [],
  };
}

function shapeSlice(net: Net, tripId: string, stops: PStop[]): [number, number][] {
  const feed = net.day?.feed;
  const t = feed?.trips.get(tripId);
  const shape = t?.shapeId ? feed!.shapes.get(t.shapeId) : undefined;
  if (!shape || stops.length < 2) return stops.map((s) => [s.lat, s.lon]);
  const a = shape.projectForward(stops[0].lat, stops[0].lon, 0, 80, 300);
  const b = shape.projectForward(stops[stops.length - 1].lat, stops[stops.length - 1].lon, a?.alongM ?? 0, 80, 300);
  if (!a || !b || b.alongM <= a.alongM) return stops.map((s) => [s.lat, s.lon]);
  const pts: [number, number][] = [shape.pointAt(a.alongM)];
  for (let i = 0; i < shape.points.length; i++) if (shape.cum[i] > a.alongM && shape.cum[i] < b.alongM) pts.push(shape.points[i]);
  pts.push(shape.pointAt(b.alongM));
  return pts;
}

/** Múlt: mi történt valójában ezzel a menettel (megálló-eseményekből). */
async function actual(iso: string, trip: PTrip, fromStop: string, toStop: string, depS: number, arrS: number) {
  // Menet-azonosító helyett vonal + menetrendi idő alapján keresünk: így a
  // v2-archívum és az új feed eltérő trip_id-i mellett is egyezik.
  const ev = await sql<{ stop_id: string; run_key: string; vehicle_id: string; arr: number; dep: number | null; delay_s: number; sched_dep_s: number; src: number }>(
    `SELECT stop_id, run_key, vehicle_id, extract(epoch FROM ts)::int AS arr, extract(epoch FROM dep_ts)::int AS dep, delay_s, sched_dep_s, src
       FROM stop_event WHERE service_date = $1 AND route_short = $2 AND
            ((stop_id = $3 AND abs(sched_dep_s - $4) <= 60) OR (stop_id = $5 AND abs(sched_arr_s - $6) <= 60))`,
    [iso, trip.key, fromStop, depS, toStop, arrS],
  );
  const boardEv = ev.find((e) => e.stop_id === fromStop);
  const alightEv = ev.find((e) => e.stop_id === toStop && (!boardEv || e.run_key === boardEv.run_key));
  const midnight = localMidnightUnix(iso);
  return {
    actual: {
      tracked: Boolean(boardEv || alightEv),
      vehicleId: boardEv?.vehicle_id ?? alightEv?.vehicle_id ?? null,
      depTs: boardEv ? (boardEv.dep ?? boardEv.arr) : null,
      arrTs: alightEv?.arr ?? null,
      depDelayS: boardEv ? (boardEv.dep ?? boardEv.arr) - (midnight + depS) : null,
      arrDelayS: alightEv ? alightEv.arr - (midnight + arrS) : null,
      estimated: alightEv?.src === 3,
    },
  };
}

function summarizeActual(rides: Record<string, any>[], tracked: boolean) {
  const last = rides[rides.length - 1].actual;
  const first = rides[0].actual;
  return {
    tracked,
    departedDelayS: first?.depDelayS ?? null,
    arrivedDelayS: last?.arrDelayS ?? null,
    vehicles: rides.map((r) => r.actual?.vehicleId ?? null),
  };
}

const histCache = new Map<string, { at: number; v: { avg: number | null; p85: number | null; n: number } }>();

async function historyDelay(route: string, stop: string, iso: string, unix: number) {
  const info = dayInfo(iso);
  const hour = new Date((unix + budapestOffsetSec(unix)) * 1000).getUTCHours();
  const key = `${route}|${stop}|${info.daytype}|${hour}`;
  const hit = histCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v;
  const r = await sql<{ n: number; avg: number | null; p85: number | null }>(
    `SELECT sum(h.n)::int AS n, sum(h.avg_delay_s * h.n) / nullif(sum(h.n), 0) AS avg, approx_percentile(0.85, rollup(h.delay_pct)) AS p85
       FROM stop_event_hourly h JOIN calendar_day c USING (service_date)
      WHERE h.route_short = $1 AND h.stop_id = $2 AND c.daytype = $3 AND h.service_date >= CURRENT_DATE - 90
        AND abs(extract(hour FROM h.bucket AT TIME ZONE 'Europe/Budapest') - $4) <= 1`,
    [route, stop, info.daytype, hour],
  );
  const v = { avg: r[0]?.n >= 3 ? Math.round(r[0].avg ?? 0) : null, p85: r[0]?.n >= 3 && r[0].p85 != null ? Math.round(r[0].p85) : null, n: r[0]?.n ?? 0 };
  histCache.set(key, { at: Date.now(), v });
  if (histCache.size > 5000) histCache.clear();
  return v;
}

/** Jövő / most: várható késés a felszálláskor és a leszálláskor. */
async function predicted(engine: Engine, iso: string, trip: PTrip, fromStop: string, toStop: string, depUnix: number, mode: Mode) {
  const [hb, ha] = await Promise.all([historyDelay(trip.key, fromStop, iso, depUnix), historyDelay(trip.key, toStop, iso, depUnix)]);
  let live: number | null = null;
  let vehicleId: string | null = null;
  if (mode === "now" && iso === engine.today) {
    // A Volánnál és a vasútnál a MÁV hivatalos késése a pontosabb (a jelük 30–60 mp-cel késik,
    // a GPS-ből mért késés elmarad tőle) — a térkép, a tábla és az előrejelzés is ezt mutatja.
    const official = isMvkId(trip.id) ? null : (engine.snapshot.decoded.find((v) => v.tripId === trip.id)?.delaySec ?? null);
    live = official ?? engine.matcher.liveDelay(trip.id, Math.floor(Date.now() / 1000));
    vehicleId = engine.snapshot.vehicles.find((v) => v.tripId === trip.id)?.id ?? null;
  }
  const histGrowth = hb.avg != null && ha.avg != null ? ha.avg - hb.avg : 0;
  const depDelay = live ?? hb.avg;
  const arrDelay = live != null ? live + Math.max(-60, Math.min(240, histGrowth)) : ha.avg;
  return {
    prediction: {
      source: live != null ? "live" : hb.n ? "history" : "none",
      depDelayS: depDelay,
      arrDelayS: arrDelay,
      arrDelayP85S: ha.p85 ?? arrDelay,
      samples: Math.min(hb.n, ha.n) || hb.n || ha.n,
      vehicleId,
    },
  };
}

/** /stats/segment kompatibilitás: közvetlen járat két megálló között, mért menetidővel. */
export async function segmentEstimate(engine: Engine, fromStop: string, toStop: string, at: number) {
  const res = await plan(engine, { from: `stop:${fromStop}`, to: `stop:${toStop}`, at, limit: 1 });
  if ("error" in res) return null;
  const t = res.trips.find((x) => x.transfers === 0) ?? res.trips[0];
  const ride = t?.legs.find((l) => l.mode !== "WALK") as Record<string, any> | undefined;
  if (!t || !ride) return null;
  const info = dayInfo(res.date);
  const delayGrowth = (ride.prediction?.arrDelayS ?? ride.actual?.arrDelayS ?? 0) - (ride.prediction?.depDelayS ?? ride.actual?.depDelayS ?? 0);
  const p50 = ride.durationSec + delayGrowth;
  return {
    from: ride.fromName,
    to: ride.toName,
    at: new Date(at * 1000).toISOString(),
    daytype: info.daytype,
    school: info.school,
    via: ride.tripId,
    routeShort: ride.routeShortName,
    routeColor: ride.routeColor,
    headsign: ride.headsign,
    scheduleExact: !res.schedule.fallback,
    stopsBetween: ride.intermediateStopNames.length + 1,
    schedS: ride.durationSec,
    p50S: p50,
    p85S: p50 + Math.max(0, (ride.prediction?.arrDelayP85S ?? p50) - (ride.prediction?.arrDelayS ?? p50)),
    rawP50S: p50,
    liveFactor: null,
    liveSamples: 0,
    samples: ride.prediction?.samples ?? (ride.actual?.tracked ? 1 : 0),
    coverage: ride.prediction?.samples ? 100 : 0,
    confidence: (ride.prediction?.samples ?? 0) >= 20 ? "magas" : (ride.prediction?.samples ?? 0) > 0 ? "alacsony" : "nincs adat",
    legs: [],
  };
}
