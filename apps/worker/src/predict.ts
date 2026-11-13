/**
 * Rendszám-előrejelzés: melyik busz fogja vinni a még el nem indult menetet.
 *
 * A GTFS-ben nincs forda (block_id), ezért a múltból tanuljuk:
 *  - chain:    melyik menet után melyik jön UGYANAZZAL a járművel (forda-lánc)
 *  - slot:     azonos naptípuson ki szokta vinni ezt a menetet
 *  - turnaround: forda-terv  minden kint lévő busz láncát órákra előre
 *    végigvezetjük (tanult folytatás, ennek híján a végállomásról a sorban
 *    következő menet), így a még messze lévő menetekre is van jóslat
 *
 * A már futó menetnél (amit az MVK élő adata más azonosítóval küld, ezért a
 * megállófigyelő nem köti járműhöz) az illesztő által azonosított buszt adjuk.
 *
 * Fordulóhurkon nem tippelünk: ha a menet a vonal fordulóhurkos végállomásáról
 * indul, és a beérkező menetét már viszi egy busz, rövid fordulóval ugyanaz a
 * busz indul vissza (60 nap adata: ≤ 5 perces fordulónál 99,5%).
 *
 * Önjutalmazás: amikor a menet ténylegesen elindul, kiértékeljük a korábban
 * kiadott jóslatokat. Amelyik jelzés eltalálta, annak nő a súlya (jutalom),
 * amelyik tévedett, annak csökken  a modell így magától javul.
 */
import {
  dayInfo,
  fastDistM,
  feedOfId,
  localMidnightUnix,
  loopTermini,
  nowUnix,
  planRotations,
  type Feed,
  type RotationPlan,
  type RotationSeed,
  type RotationSlot,
  type RunOut,
  type ServiceDay,
} from "@mvk/core";
import { getPool, sql } from "@mvk/db";
import type { Engine } from "./engine.ts";
import { errMsg, log } from "./log.ts";

type Signal = "chain" | "slot" | "turnaround";
const SIGNALS: Signal[] = ["chain", "slot", "turnaround"];
const DEFAULT_WEIGHTS: Record<Signal, number> = { chain: 0.75, slot: 0.35, turnaround: 0.6 };
/** a már futó, illesztett menet „jóslata"  ezt nem számítjuk a pontosságba */
const MATCHED_CONFIDENCE = 0.97;
const LEARNING_RATE = 0.04;
const HORIZONS = [30, 15, 5];
const MIN_CONFIDENCE = 0.15;
/** gyenge bizonyítéknál (kis összpontszám) a bizonyosság ennyihez mérten csökken */
const EVIDENCE_FLOOR = 0.6;
/** a teljes múltból tanulunk, de a régi napok súlya 45 naponta feleződik */
const HISTORY_HALF_LIFE_DAYS = 45;
const PLAN_TTL_S = 30;
const PLAN_HORIZON_S = 4 * 3600;
/** befejezett menet után ennyi ideig számít a busz a végállomáson várakozónak */
const RECENT_END_S = 40 * 60;
const AT_TERMINUS_M = 600;
/** GTFS route_type: villamos (az MVK-nál 900, a busz 704) */
const TRAM_ROUTE_TYPE = "900";
/**
 * Fordulóhurkon eddig a menetrendi állásig viszi biztosan ugyanaz a busz a következő
 * menetet (60 nap: ≤ 5 percnél 99,5%; 6–10 percnél egy kisebb mintán csak ~90%, 11–20
 * percnél 85%: ott cserélnek  ott marad a „~” tipp).
 */
const LOOP_SURE_TURN_S = 5 * 60;
const LOOP_CONFIDENCE = 0.99;
/** ennyi fordulót követünk előre (minden forduló ~99,5%) */
const LOOP_MAX_HOPS = 3;
/** a beérkező menet után ennyi ideig várakozik a busz a fordulóhurkon */
const LOOP_WAIT_S = 15 * 60;

export type VehicleGuess = {
  id: string;
  confidence: number;
  /** loop: nem tipp  a fordulóhurkon ugyanaz a busz indul vissza, ami most a beérkező menetet viszi */
  method: Signal | "matched" | "loop";
  signals: Partial<Record<Signal, string>>;
  /** a forda-tervben hányadik menet a busz mostanitól számítva */
  hops?: number;
};

const runKeyOf = (pattern: string, schedStartS: number) => `${pattern}@${schedStartS}`;

export class VehiclePredictor {
  private chain = new Map<string, Map<string, number>>();
  private next = new Map<string, Map<string, number>>();
  private slot = new Map<string, Map<string, number>>();
  /** járművenként az utoljára vitt vonal (route_id)  ebből tudjuk, busz-e vagy villamos */
  private lastRouteOf = new Map<string, string>();
  private plan: { at: number; iso: string; plan: RotationPlan } | null = null;
  weights: Record<Signal, number> = { ...DEFAULT_WEIGHTS };
  accuracy = { hits: 0, total: 0, byHorizon: {} as Record<number, { hits: number; total: number }> };
  private cache = new Map<string, { at: number; guess: VehicleGuess | null }>();
  /** napi menetrendenként: induló menet → a fordulóhurokra rövid fordulóval beérkező menete */
  private loopPrev = new WeakMap<ServiceDay, Map<string, string>>();
  private engine: Engine;
  private resolved = new Set<string>();

  constructor(engine: Engine) {
    this.engine = engine;
    engine.on("run", (r) => {
      if (r.status === "running" && !this.resolved.has(r.runKey)) {
        // A runKey a napot is tartalmazza: napváltáskor a régiek eldobhatók.
        if (this.resolved.size > 20_000) this.resolved.clear();
        this.resolved.add(r.runKey);
        this.resolve(r).catch((e) => log.warn("predict", "kiértékelés hiba", errMsg(e)));
      }
    });
  }

  /**
   * Tanulás a teljes múltból (indításkor és éjszakánként); a friss napok többet
   * számítanak. A mai nap kimarad: a már lefutott menetekre úgysem jósolunk.
   */
  async learn(): Promise<void> {
    const rows = await sql<{ d: string; age: number; v: string; rid: string; p: string; s: number; e: number }>(
      `SELECT service_date::text AS d, (CURRENT_DATE - service_date)::int AS age, vehicle_id AS v, route_id AS rid,
              pattern AS p, sched_start_s AS s, sched_end_s AS e
         FROM trip_run
        WHERE status IN ('complete', 'partial') AND pattern <> '' AND service_date < $1::date
        ORDER BY vehicle_id, service_date, sched_start_s`,
      [this.engine.today],
    );
    const chain = new Map<string, Map<string, number>>();
    const next = new Map<string, Map<string, number>>();
    const slot = new Map<string, Map<string, number>>();
    const lastRouteOf = new Map<string, string>();
    const bump = (m: Map<string, Map<string, number>>, k: string, sub: string, w: number) => {
      let x = m.get(k);
      if (!x) m.set(k, (x = new Map()));
      x.set(sub, (x.get(sub) ?? 0) + w);
    };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const w = Math.pow(0.5, Math.max(0, r.age) / HISTORY_HALF_LIFE_DAYS);
      const key = runKeyOf(r.p, r.s);
      lastRouteOf.set(r.v, r.rid);
      bump(slot, `${dayInfo(r.d).daytype}|${key}`, r.v, w);
      const prev = rows[i - 1];
      if (prev && prev.v === r.v && prev.d === r.d) {
        const gap = r.s - prev.e;
        if (gap > -600 && gap < 3 * 3600) {
          const prevKey = runKeyOf(prev.p, prev.s);
          bump(chain, key, prevKey, w);
          bump(next, prevKey, key, w);
        }
      }
    }
    this.chain = chain;
    this.next = next;
    this.slot = slot;
    this.lastRouteOf = lastRouteOf;
    this.plan = null;
    const w = await sql<{ signal: string; weight: number }>(`SELECT signal, weight FROM vehicle_model_weight`);
    for (const x of w) if ((SIGNALS as string[]).includes(x.signal)) this.weights[x.signal as Signal] = x.weight;
    const acc = await sql<{ h: number; n: number; ok: number }>(
      `SELECT horizon_min AS h, count(*)::int AS n, count(*) FILTER (WHERE correct)::int AS ok
         FROM vehicle_prediction WHERE correct IS NOT NULL AND service_date >= CURRENT_DATE - 30 GROUP BY horizon_min`,
    );
    this.accuracy = { hits: 0, total: 0, byHorizon: {} };
    for (const a of acc) {
      this.accuracy.byHorizon[a.h] = { hits: a.ok, total: a.n };
      this.accuracy.hits += a.ok;
      this.accuracy.total += a.n;
    }
    log.info("predict", `tanulás: ${rows.length} menetből ${chain.size} forda-kapcsolat, súlyok ${JSON.stringify(this.weights)}`);
  }

  /** Előrejelzés egy menetre (30 mp-es gyorsítótárral). */
  predict(tripId: string): VehicleGuess | null {
    const now = nowUnix();
    const hit = this.cache.get(tripId);
    if (hit && now - hit.at < 30) return hit.guess;
    const guess = this.compute(tripId, now);
    this.cache.set(tripId, { at: now, guess });
    if (this.cache.size > 3000) this.cache.clear();
    return guess;
  }

  private compute(tripId: string, now: number): VehicleGuess | null {
    const iso = this.engine.today;
    const day = this.engine.feeds.cachedDay(iso);
    if (!day) return null;
    const feed = day.feed;
    const trip = feed.trips.get(tripId);
    const stopsOfTrip = feed.tripStops.get(tripId);
    if (!trip || !stopsOfTrip?.length) return null;
    const run = this.engine.todayRuns.get(tripId);
    if (run) {
      // Már fut (vagy lefutott): nem jóslunk, az illesztő tudja, melyik busz viszi.
      return run.status === "running" ? { id: run.vehicleId, confidence: MATCHED_CONFIDENCE, method: "matched", signals: {} } : null;
    }
    const looped = this.loopVehicle(day, tripId, now, LOOP_MAX_HOPS);
    if (looped) return { id: looped.vehicle, confidence: LOOP_CONFIDENCE, method: "loop", signals: {}, hops: looped.hops };
    const startS = stopsOfTrip[0].dep;
    const pattern = feed.patternHash(tripId) ?? "";
    const key = runKeyOf(pattern, startS);
    const daytype = dayInfo(iso).daytype;

    const runs = [...this.engine.todayRuns.values()];
    const byKey = new Map<string, RunOut>();
    const lastRunOfVehicle = new Map<string, RunOut>();
    for (const r of runs) {
      byKey.set(runKeyOf(r.pattern, r.schedStartS), r);
      const prev = lastRunOfVehicle.get(r.vehicleId);
      if (!prev || r.openedTs > prev.openedTs) lastRunOfVehicle.set(r.vehicleId, r);
    }
    const endS = stopsOfTrip[stopsOfTrip.length - 1].arr;
    const plan = this.dayPlan(now);
    // A jármű nem érhet oda, ha a mostani menete jóval az indulás után ér véget,
    // vagy a forda-terv szerint épp egy másik, átfedő menetet visz.
    const busy = (v: string) => {
      const r = lastRunOfVehicle.get(v);
      if (r?.status === "running" && r.schedEndS > startS + 900) return true;
      return plan?.byVehicle.get(v)?.some((s) => s.tripId !== tripId && s.startS < endS && s.endS > startS) ?? false;
    };

    const score = new Map<string, number>();
    const top: Partial<Record<Signal, string>> = {};
    const add = (sig: Signal, v: string, s: number) => {
      if (sig !== "turnaround" && busy(v)) return;
      score.set(v, (score.get(v) ?? 0) + this.weights[sig] * s);
    };

    const rot = plan?.byTrip.get(tripId);
    if (rot) {
      add("turnaround", rot.vehicle, rot.confidence);
      top.turnaround = rot.vehicle;
    }

    const ch = this.chain.get(key);
    if (ch) {
      const total = [...ch.values()].reduce((a, b) => a + b, 0);
      let best: [string, number] | null = null;
      for (const [prevKey, n] of ch) {
        const r = byKey.get(prevKey);
        if (!r) continue;
        add("chain", r.vehicleId, n / total);
        if (!best || n > best[1]) best = [r.vehicleId, n];
      }
      if (best) top.chain = best[0];
    }

    const sl = this.slot.get(`${daytype}|${key}`);
    if (sl) {
      const total = [...sl.values()].reduce((a, b) => a + b, 0);
      let best: [string, number] | null = null;
      for (const [v, n] of sl) {
        add("slot", v, n / total);
        if (!best || n > best[1]) best = [v, n];
      }
      if (best) top.slot = best[0];
    }

    if (!score.size) return null;
    const sorted = [...score.entries()].sort((a, b) => b[1] - a[1]);
    const sum = sorted.reduce((a, [, s]) => a + s, 0);
    const [id, s] = sorted[0];
    const confidence = Math.min(0.99, s / Math.max(sum, EVIDENCE_FLOOR));
    if (confidence < MIN_CONFIDENCE) return null;
    const method = (Object.entries(top).find(([, v]) => v === id)?.[0] as Signal | undefined) ?? "slot";
    const hops = rot?.vehicle === id ? rot.hops : undefined;
    return { id, confidence: Math.round(confidence * 100) / 100, method, signals: top, hops };
  }

  /**
   * Fordulóhurok: melyik busz viszi biztosan a menetet  amelyik a beérkező menetét
   * most viszi (vagy az imént fejezte be, és ott vár, vagy az MVK már kiosztotta rá).
   * Ha a beérkező menet még gazdátlan, annak a beérkező menetét nézzük (legfeljebb
   * `hops` fordulóig).
   */
  private loopVehicle(day: ServiceDay, tripId: string, now: number, hops: number): { vehicle: string; hops: number } | null {
    const prev = this.loopPrevOf(day).get(tripId);
    if (!prev || this.engine.cancelled.ids.has(prev)) return null;
    const run = this.engine.todayRuns.get(prev);
    if (run?.status === "running") return { vehicle: run.vehicleId, hops: 1 };
    if (run) {
      const ended = run.actualEnd ?? run.lastTs ?? 0;
      const waiting = now - ended < LOOP_WAIT_S && this.engine.snapshot.vehicles.some((v) => v.id === run.vehicleId);
      return waiting ? { vehicle: run.vehicleId, hops: 1 } : null;
    }
    // a beérkező menetet az MVK már kiosztotta egy buszra (percekkel az indulása előtt)
    const assigned = this.engine.snapshot.vehicles.find((v) => v.tripId === prev);
    if (assigned) return { vehicle: assigned.id, hops: 1 };
    if (hops <= 1) return null;
    const up = this.loopVehicle(day, prev, now, hops - 1);
    return up ? { vehicle: up.vehicle, hops: up.hops + 1 } : null;
  }

  /**
   * A nap menetei közül: a vonal fordulóhurkos végállomására beérkező menet után
   * ugyanonnan a következő induló menet, ha a menetrendi forduló legfeljebb 10 perc.
   */
  private loopPrevOf(day: ServiceDay): Map<string, string> {
    const hit = this.loopPrev.get(day);
    if (hit) return hit;
    const feed = day.feed;
    const loops = loopTermini(feed);
    const arrivals = new Map<string, { trip: string; arr: number }[]>();
    const departures = new Map<string, { trip: string; dep: number }[]>();
    const push = <T>(m: Map<string, T[]>, k: string, x: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(x);
    for (const t of feed.trips.values()) {
      if (!day.services.has(t.serviceId)) continue;
      const st = feed.tripStops.get(t.id);
      if (!st || st.length < 2) continue;
      const first = st[0].stopId;
      const last = st[st.length - 1].stopId;
      if (first === last) continue;
      if (loops.has(last)) push(arrivals, `${t.routeId}|${last}`, { trip: t.id, arr: st[st.length - 1].arr });
      if (loops.has(first)) push(departures, `${t.routeId}|${first}`, { trip: t.id, dep: st[0].dep });
    }
    const out = new Map<string, string>();
    const gapOf = new Map<string, number>();
    for (const [k, list] of arrivals) {
      const deps = departures.get(k)?.sort((a, b) => a.dep - b.dep);
      if (!deps) continue;
      for (const a of list) {
        // a menetrend szerint a busz akár 2 perccel a beérkezés előtti indulást is viheti
        const next = deps.find((d) => d.dep >= a.arr - 120);
        if (!next) continue;
        const gap = next.dep - a.arr;
        // két beérkező közül a később érkező fordul vissza ezzel a menettel
        if (gap > LOOP_SURE_TURN_S || gap >= (gapOf.get(next.trip) ?? Infinity)) continue;
        out.set(next.trip, a.trip);
        gapOf.set(next.trip, gap);
      }
    }
    this.loopPrev.set(day, out);
    return out;
  }

  /** A forda-terv a forda-táblához (a mostani állapotból, 30 mp-ig gyorsítótárazva). */
  planSnapshot(): RotationPlan | null {
    return this.dayPlan(nowUnix());
  }

  /** A mai forda-terv (30 mp-ig gyorsítótárazva): minden kint lévő busz következő menetei. */
  private dayPlan(now: number): RotationPlan | null {
    const iso = this.engine.today;
    if (this.plan && this.plan.iso === iso && now - this.plan.at < PLAN_TTL_S) return this.plan.plan;
    const day = this.engine.feeds.cachedDay(iso);
    if (!day) return null;
    const midnight = localMidnightUnix(iso);
    const nowS = now - midnight;
    // Forrásonként külön terv: MVK-busz sosem kerül Volán-menetre, és fordítva (a vonat is külön).
    const slots = this.planSlots(day.feed, day.services, nowS);
    const seeds = this.planSeeds(day.feed, now, midnight);
    const plan: RotationPlan = { byTrip: new Map(), byVehicle: new Map() };
    for (const f of ["mvk", "hkir", "rail"] as const) {
      const p = planRotations(slots.filter((s) => feedOfId(s.tripId) === f), seeds.filter((s) => feedOfId(s.vehicle) === f), this.next);
      for (const [k, v] of p.byTrip) plan.byTrip.set(k, v);
      for (const [k, v] of p.byVehicle) plan.byVehicle.set(k, v);
    }
    this.plan = { at: now, iso, plan };
    return plan;
  }

  /** A következő órák még el nem indult menetei. */
  private planSlots(feed: Feed, services: Set<string>, nowS: number): RotationSlot[] {
    const out: RotationSlot[] = [];
    for (const t of feed.trips.values()) {
      if (!services.has(t.serviceId) || this.engine.todayRuns.has(t.id)) continue;
      const st = feed.tripStops.get(t.id);
      if (!st?.length) continue;
      const startS = st[0].dep;
      if (startS < nowS - 900 || startS > nowS + PLAN_HORIZON_S) continue;
      const a = feed.stops.get(st[0].stopId);
      const b = feed.stops.get(st[st.length - 1].stopId);
      if (!a || !b) continue;
      const key = runKeyOf(feed.patternHash(t.id) ?? "", startS);
      const r = feed.routes.get(t.routeId);
      const route = r?.key ?? t.routeId;
      const tram = r?.type === TRAM_ROUTE_TYPE;
      out.push({ tripId: t.id, key, route, tram, startS, endS: st[st.length - 1].arr, lat: a.lat, lon: a.lon, endLat: b.lat, endLon: b.lon });
    }
    return out;
  }

  /** Minden élő jármű: mikor és hol válik szabaddá (a mostani menete végén, vagy már most). */
  private planSeeds(feed: Feed, now: number, midnight: number): RotationSeed[] {
    const lastRun = new Map<string, RunOut>();
    for (const r of this.engine.todayRuns.values()) {
      const prev = lastRun.get(r.vehicleId);
      if (!prev || r.openedTs > prev.openedTs) lastRun.set(r.vehicleId, r);
    }
    const nowS = now - midnight;
    const out: RotationSeed[] = [];
    const isTram = (routeId: string | undefined) => (routeId ? feed.routes.get(routeId)?.type === TRAM_ROUTE_TYPE : false);
    for (const v of this.engine.snapshot.vehicles) {
      const last = lastRun.get(v.id);
      const tram = isTram(last?.routeId ?? (v.routeId || this.lastRouteOf.get(v.id)));
      const st = last ? feed.tripStops.get(last.tripId) : undefined;
      const end = st?.length ? feed.stops.get(st[st.length - 1].stopId) : undefined;
      const key = last ? runKeyOf(last.pattern, last.schedStartS) : null;
      if (last?.status === "running") {
        const availS = last.schedEndS + Math.max(0, last.lastDelayS ?? 0);
        out.push({ vehicle: v.id, availS, lat: end?.lat ?? v.lat, lon: end?.lon ?? v.lon, key, route: last.routeShort, tram, idle: false });
        continue;
      }
      const ended = last?.actualEnd ?? last?.lastTs ?? 0;
      if (last && end && now - ended < RECENT_END_S && fastDistM(v.lat, v.lon, end.lat, end.lon) < AT_TERMINUS_M) {
        out.push({ vehicle: v.id, availS: Math.max(nowS, ended - midnight), lat: end.lat, lon: end.lon, key, route: last.routeShort, tram, idle: false });
        continue;
      }
      out.push({ vehicle: v.id, availS: nowS, lat: v.lat, lon: v.lon, key: null, route: feed.routes.get(v.routeId)?.key ?? null, tram, idle: true });
    }
    return out;
  }

  /** Percenként: jóslatok rögzítése 30/15/5 perccel az indulás előtt (ezekből mérjük a pontosságot). */
  async recordHorizons(): Promise<void> {
    const iso = this.engine.today;
    const day = this.engine.feeds.cachedDay(iso);
    if (!day) return;
    const now = nowUnix();
    const midnight = localMidnightUnix(iso);
    const rows: unknown[][] = [];
    for (const t of day.feed.trips.values()) {
      if (!day.services.has(t.serviceId)) continue;
      const st = day.feed.tripStops.get(t.id);
      if (!st?.length) continue;
      const lead = (midnight + st[0].dep - now) / 60;
      if (lead < 0 || lead > 31) continue;
      const h = HORIZONS.find((x) => lead <= x && lead > x - 1.5);
      if (h == null) continue;
      const g = this.predict(t.id);
      // a futó és a fordulóhurkon visszaforduló busz nem tipp: nem számít a pontosságba
      if (!g || g.method === "matched" || g.method === "loop") continue;
      rows.push([iso, t.id, day.feed.routes.get(t.routeId)?.key ?? t.routeId, st[0].dep, h, g.id, g.confidence, g.method, JSON.stringify(g.signals)]);
    }
    for (const r of rows) {
      await getPool().query(
        `INSERT INTO vehicle_prediction (service_date, trip_id, route_short, sched_start_s, horizon_min, made_at, predicted_vehicle, confidence, method, features)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9) ON CONFLICT (service_date, trip_id, horizon_min) DO NOTHING`,
        r,
      );
    }
  }

  /** Kiértékelés + jutalom, amikor a menet ténylegesen elindul. */
  private async resolve(run: RunOut): Promise<void> {
    const rows = await sql<{ horizon_min: number; predicted_vehicle: string; features: Partial<Record<Signal, string>> }>(
      `UPDATE vehicle_prediction SET actual_vehicle = $3, correct = (predicted_vehicle = $3), resolved_at = now()
        WHERE service_date = $1 AND trip_id = $2 AND correct IS NULL
        RETURNING horizon_min, predicted_vehicle, features`,
      [run.serviceDate, run.tripId, run.vehicleId],
    );
    if (!rows.length) return;
    // A jutalmat a legkorábbi (legnehezebb) horizonton kiadott jóslat jelzései kapják.
    const r = rows.sort((a, b) => b.horizon_min - a.horizon_min)[0];
    for (const sig of SIGNALS) {
      const v = r.features?.[sig];
      if (!v) continue;
      const hit = v === run.vehicleId;
      const w = this.weights[sig];
      this.weights[sig] = Math.min(1, Math.max(0.05, hit ? w + LEARNING_RATE * (1 - w) : w - LEARNING_RATE * w));
      await getPool().query(
        `INSERT INTO vehicle_model_weight (signal, weight, hits, misses) VALUES ($1, $2, $3, $4)
         ON CONFLICT (signal) DO UPDATE SET weight = EXCLUDED.weight, hits = vehicle_model_weight.hits + $3,
           misses = vehicle_model_weight.misses + $4, updated_at = now()`,
        [sig, this.weights[sig], hit ? 1 : 0, hit ? 0 : 1],
      );
    }
    for (const x of rows) {
      const b = (this.accuracy.byHorizon[x.horizon_min] ??= { hits: 0, total: 0 });
      b.total++;
      this.accuracy.total++;
      if (x.predicted_vehicle === run.vehicleId) {
        b.hits++;
        this.accuracy.hits++;
      }
    }
  }

  status() {
    return {
      weights: this.weights,
      chainLinks: this.chain.size,
      plannedTrips: this.plan?.plan.byTrip.size ?? 0,
      accuracyPct: this.accuracy.total ? Math.round((100 * this.accuracy.hits) / this.accuracy.total) : null,
      samples: this.accuracy.total,
      byHorizon: Object.fromEntries(
        Object.entries(this.accuracy.byHorizon).map(([h, v]) => [h, { ...v, pct: v.total ? Math.round((100 * v.hits) / v.total) : null }]),
      ),
    };
  }
}

