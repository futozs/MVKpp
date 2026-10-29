/**
 * Rendszám-előrejelzés: melyik busz fogja vinni a még el nem indult menetet.
 *
 * A GTFS-ben nincs forda (block_id), ezért a múltból tanuljuk:
 *  - chain:    melyik menet után melyik jön UGYANAZZAL a járművel (forda-lánc)
 *  - slot:     azonos naptípuson ki szokta vinni ezt a menetet
 *  - turnaround: forda-terv — minden kint lévő busz láncát órákra előre
 *    végigvezetjük (tanult folytatás, ennek híján a végállomásról a sorban
 *    következő menet), így a még messze lévő menetekre is van jóslat
 *
 * A már futó menetnél (amit az MVK élő adata más azonosítóval küld, ezért a
 * megállófigyelő nem köti járműhöz) az illesztő által azonosított buszt adjuk.
 *
 * Önjutalmazás: amikor a menet ténylegesen elindul, kiértékeljük a korábban
 * kiadott jóslatokat. Amelyik jelzés eltalálta, annak nő a súlya (jutalom),
 * amelyik tévedett, annak csökken — a modell így magától javul.
 */
import {
  dayInfo,
  fastDistM,
  localMidnightUnix,
  nowUnix,
  planRotations,
  type Feed,
  type RotationPlan,
  type RotationSeed,
  type RotationSlot,
  type RunOut,
} from "@mvk/core";
import { getPool, sql } from "@mvk/db";
import type { Engine } from "./engine.ts";
import { errMsg, log } from "./log.ts";

type Signal = "chain" | "slot" | "turnaround";
const SIGNALS: Signal[] = ["chain", "slot", "turnaround"];
const DEFAULT_WEIGHTS: Record<Signal, number> = { chain: 0.75, slot: 0.35, turnaround: 0.6 };
/** a már futó, illesztett menet „jóslata" — ezt nem számítjuk a pontosságba */
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

export type VehicleGuess = {
  id: string;
  confidence: number;
  method: Signal | "matched";
  signals: Partial<Record<Signal, string>>;
  /** a forda-tervben hányadik menet a busz mostanitól számítva */
  hops?: number;
};

const runKeyOf = (pattern: string, schedStartS: number) => `${pattern}@${schedStartS}`;

export class VehiclePredictor {
  private chain = new Map<string, Map<string, number>>();
  private next = new Map<string, Map<string, number>>();
  private slot = new Map<string, Map<string, number>>();
  /** járművenként az utoljára vitt vonal (route_id) — ebből tudjuk, busz-e vagy villamos */
  private lastRouteOf = new Map<string, string>();
  private plan: { at: number; iso: string; plan: RotationPlan } | null = null;
  weights: Record<Signal, number> = { ...DEFAULT_WEIGHTS };
  accuracy = { hits: 0, total: 0, byHorizon: {} as Record<number, { hits: number; total: number }> };
  private cache = new Map<string, { at: number; guess: VehicleGuess | null }>();
  private engine: Engine;
  private resolved = new Set<string>();

  constructor(engine: Engine) {
    this.engine = engine;
    engine.on("run", (r) => {
      if (r.status === "running" && !this.resolved.has(r.runKey)) {
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

  /** A mai forda-terv (30 mp-ig gyorsítótárazva): minden kint lévő busz következő menetei. */
  private dayPlan(now: number): RotationPlan | null {
    const iso = this.engine.today;
    if (this.plan && this.plan.iso === iso && now - this.plan.at < PLAN_TTL_S) return this.plan.plan;
    const day = this.engine.feeds.cachedDay(iso);
    if (!day) return null;
    const midnight = localMidnightUnix(iso);
    const nowS = now - midnight;
    const plan = planRotations(this.planSlots(day.feed, day.services, nowS), this.planSeeds(day.feed, now, midnight), this.next);
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
      const route = r?.short ?? t.routeId;
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
      out.push({ vehicle: v.id, availS: nowS, lat: v.lat, lon: v.lon, key: null, route: feed.routes.get(v.routeId)?.short ?? null, tram, idle: true });
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
      if (!g || g.method === "matched") continue;
      rows.push([iso, t.id, day.feed.routes.get(t.routeId)?.short ?? t.routeId, st[0].dep, h, g.id, g.confidence, g.method, JSON.stringify(g.signals)]);
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

