/**
 * Késés-előrejelzés élő menetekre.
 *
 * Alap: a core `forecastDelays` képlete a szakaszprofilokkal (segment_daily,
 * az elmúlt 8 hét, naptípus és óra szerint). Erre épül a tanított modell
 * (kvantilis gradient boosting, lásd `ml/`): a mostani forgalmat, az előtte
 * járó buszt, a busz saját késés-trendjét és az időjárást is figyelembe veszi.
 * A modellt horizontonként csak ott használjuk, ahol a visszamérés szerint
 * jobb; bármilyen hiánynál vagy hibánál a képlet marad.
 *
 * A profilokat és a modellt induláskor és éjszakánként töltjük be; menetenként
 * 15 mp-ig gyorsítótárazzuk az eredményt.
 */
import {
  dayInfo,
  delayFeatureVector,
  DELAY_FEATURES,
  forecastDelays,
  gateCell,
  horizonBucket,
  localMidnightUnix,
  nowUnix,
  precipClass,
  predictGbdt,
  profileAhead,
  RECENT_SEGMENTS,
  RecentTraffic,
  RunHistory,
  type ForecastStop,
  type ProfileFn,
  type RunOut,
  type SegmentProfile,
  type StopEventOut,
  type VehicleMotion,
} from "@mvk/core";
import { sql } from "@mvk/db";
import type { Engine } from "./engine.ts";
import { errMsg, log } from "./log.ts";
import { loadLatestBundle } from "./ml/store.ts";
import type { DelayModelBundle } from "./ml/train.ts";

const HISTORY_DAYS = 56;
const MIN_SAMPLES = 4;
const CACHE_S = 15;
/** a 15 perces tod_bucket-ekből órák */
const BUCKETS_PER_HOUR = 4;
/** a modellt ennyi megállóig tanítottuk — azon túl a képlet */
const MODEL_MAX_AHEAD = 30;
/** a modell becslése legfeljebb ennyit térhet el a mostani késéstől (mp) — védőkorlát */
const MAX_CHANGE_DOWN_S = 20 * 60;
const MAX_CHANGE_UP_S = 60 * 60;
/** a közelmúlt forgalmából ennyi ideig tartunk meg méréseket (mp) */
const TRAFFIC_KEEP_S = 3600;

export type TripForecast = {
  tripId: string;
  fromIdx: number;
  currentDelayS: number;
  stops: ForecastStop[];
  /** a becslés forrása: tanított modell vagy a képlet */
  source: "model" | "formula";
};

type DayState = { history: RunHistory; traffic: RecentTraffic; last: Map<string, StopEventOut> };

export class DelayForecaster {
  private engine: Engine;
  private profiles = new Map<string, SegmentProfile>();
  private cache = new Map<string, { at: number; value: TripForecast | null }>();
  private model: DelayModelBundle | null = null;
  /** szolgáltatási naponként az élő előzmények (a mai és — éjfél körül — a tegnapi) */
  private days = new Map<string, DayState>();
  private lastPrune = 0;
  private featureBuf = new Float32Array(DELAY_FEATURES.length);
  /** óránkénti időjárás ugyanabból a táblából, amiből a modell tanult (a worker tölti) */
  private weatherHours = new Map<number, { temp: number | null; precip: number | null }>();
  private weatherLoading = false;
  private weatherTried = new Map<number, number>();
  stats = { model: 0, formula: 0, errors: 0 };

  constructor(engine: Engine) {
    this.engine = engine;
    // Az élő megálló-eseményekből: az előtte járó buszok és a közelmúlt forgalma.
    // Újraindításkor a motor a mai napot visszajátssza, így ez is újraépül.
    engine.on("stopEvent", (e, run) => {
      try {
        this.onStopEvent(e, run);
      } catch (err) {
        this.stats.errors++;
        if (this.stats.errors < 5) log.warn("forecast", "esemény-feldolgozási hiba", errMsg(err));
      }
    });
  }

  async load(): Promise<void> {
    const iso = this.engine.today;
    const t0 = Date.now();
    const rows = await sql<{ f: string; t: string; d: number; h: number; p50: number; p85: number }>(
      `SELECT from_stop AS f, to_stop AS t, daytype AS d, (tod_bucket / $4)::int AS h,
              approx_percentile(0.5, rollup(travel_pct)) AS p50, approx_percentile(0.85, rollup(travel_pct)) AS p85
         FROM segment_daily WHERE bucket >= $1::date - $2::int AND bucket < $1::date
        GROUP BY 1, 2, 3, 4 HAVING sum(n) >= $3`,
      [iso, HISTORY_DAYS, MIN_SAMPLES, BUCKETS_PER_HOUR],
    );
    const profiles = new Map<string, SegmentProfile>();
    for (const r of rows) profiles.set(`${r.f}|${r.t}|${r.d}|${r.h}`, { p50: r.p50, p85: r.p85 });
    this.profiles = profiles;
    this.cache.clear();
    log.info("forecast", `${profiles.size} szakaszprofil betöltve (${Date.now() - t0} ms)`);
    await this.loadModel();
  }

  /** A legfrissebb elfogadott modell betöltése (hiba esetén a képlet marad). */
  async loadModel(): Promise<void> {
    try {
      const m = await loadLatestBundle();
      this.model = m;
      this.cache.clear();
      if (m) {
        const used = Object.entries(m.report.buckets)
          .filter(([, r]) => r.useMedian)
          .map(([id]) => id);
        log.info("forecast", `késés-modell betöltve (${m.trainedAt}, ${m.report.overall.improvement}% javulás; modell a(z) ${used.join(", ") || "—"} horizonton)`);
      } else log.info("forecast", "nincs elfogadott késés-modell — a képlet becsül");
    } catch (e) {
      log.warn("forecast", "a késés-modell nem töltődött be — a képlet becsül", errMsg(e));
      this.model = null;
    }
  }

  hasModel(): boolean {
    return this.model != null;
  }

  modelInfo() {
    return this.model ? { trainedAt: this.model.trainedAt, report: this.model.report, stats: this.stats } : { trainedAt: null, report: null, stats: this.stats };
  }

  /** Egy szakasz szokásos (medián) menetideje az adott naptípuson és órában (mp), ha ismert. */
  typicalTravel(fromStop: string, toStop: string, serviceDate: string, secOfDay: number): number | null {
    const hour = Math.floor((((secOfDay % 86_400) + 86_400) % 86_400) / 3600);
    const p = this.profileFn(serviceDate)(fromStop, toStop, hour);
    return p && p.p50 > 0 ? p.p50 : null;
  }

  private profileFn(serviceDate: string): ProfileFn {
    const daytype = dayInfo(serviceDate).daytype;
    return (f, t, h) => this.profiles.get(`${f}|${t}|${daytype}|${h}`);
  }

  private dayState(serviceDate: string): DayState {
    let d = this.days.get(serviceDate);
    if (!d) {
      d = { history: new RunHistory(), traffic: new RecentTraffic(), last: new Map() };
      this.days.set(serviceDate, d);
      // csak a legutóbbi két szolgáltatási nap kell (éjfél után a tegnapi menetek még futnak)
      const keep = [...this.days.keys()].sort().slice(-2);
      for (const k of this.days.keys()) if (!keep.includes(k)) this.days.delete(k);
    }
    return d;
  }

  private onStopEvent(e: StopEventOut, run: RunOut) {
    if (e.src === "final") return; // becsült beérkezés: nem mérés
    const d = this.dayState(e.serviceDate);
    const shape = this.engine.feeds.cachedDay(e.serviceDate)?.feed.trips.get(e.tripId)?.shapeId ?? e.tripId.split("_")[1] ?? e.tripId;
    d.history.add(shape, e.runKey, e.stopIdx, e.arrTs, e.delayS);
    const prev = d.last.get(e.runKey);
    if (prev && prev.stopIdx === e.stopIdx - 1) {
      const p = this.profileFn(e.serviceDate)(prev.stopId, e.stopId, Math.floor((((prev.schedDepS % 86_400) + 86_400) % 86_400) / 3600));
      if (p) d.traffic.add(prev.stopId, e.stopId, e.arrTs, e.arrTs - (prev.depTs ?? prev.arrTs) - p.p50);
    }
    if (e.isLast || run.status !== "running") d.last.delete(e.runKey);
    else d.last.set(e.runKey, e);
    if (e.arrTs - this.lastPrune > 600) {
      this.lastPrune = e.arrTs;
      d.traffic.prune(e.arrTs - TRAFFIC_KEEP_S);
    }
  }

  /**
   * A busz várható sebessége (m/s) a mostani szakaszán, a térképi becsléshez:
   * a szakasz hossza a múltbeli menetidő mediánjával (megállás, gyorsítás benne),
   * ennek híján a menetrendi idővel. `null`, ha egyik sem ismert.
   */
  segmentSpeed(m: VehicleMotion, serviceDate: string): number | null {
    const len = m.toAlongM - m.fromAlongM;
    if (len <= 0) return null;
    const hour = Math.floor((((m.segDepS % 86_400) + 86_400) % 86_400) / 3600);
    const p = m.fromStopId ? this.profiles.get(`${m.fromStopId}|${m.toStopId}|${dayInfo(serviceDate).daytype}|${hour}`) : undefined;
    const secs = p?.p50 ?? m.schedSegS;
    return secs && secs > 0 ? len / secs : null;
  }

  /** Egy élő menet hátralévő megállói várható és legrosszabb esetben várható késéssel. */
  forTrip(tripId: string, now = nowUnix()): TripForecast | null {
    const hit = this.cache.get(tripId);
    if (hit && now - hit.at < CACHE_S) return hit.value;
    const value = this.compute(tripId, now);
    this.cache.set(tripId, { at: now, value });
    if (this.cache.size > 2000) this.cache.clear();
    return value;
  }

  /**
   * Az adott óra időjárása a weather_hour táblából (ahogy a tanításkor), a
   * hiányzó órát a háttérben betöltve; addig az előző óra, végül a legutóbbi lekérés.
   */
  private weatherAt(now: number): { temp: number | null; precip: number | null } | null {
    const h = Math.floor(now / 3600);
    const hit = this.weatherHours.get(h) ?? this.weatherHours.get(h - 1);
    // Óránként legfeljebb 5 percenként próbáljuk (az óra eleji sor csak az első lekérés után kerül be).
    if (!this.weatherHours.has(h) && !this.weatherLoading && Date.now() - (this.weatherTried.get(h) ?? 0) > 300_000) {
      this.weatherLoading = true;
      this.weatherTried.set(h, Date.now());
      if (this.weatherTried.size > 48) this.weatherTried.clear();
      sql<{ h: number; temp: number | null; wmo: number | null }>(
        `SELECT (extract(epoch FROM hour) / 3600)::int AS h, temp_c AS temp, wmo_code AS wmo FROM weather_hour WHERE hour BETWEEN to_timestamp($1) - interval '3 hours' AND to_timestamp($1)`,
        [h * 3600],
      )
        .then((rows) => {
          for (const r of rows) this.weatherHours.set(r.h, { temp: r.temp, precip: precipClass(r.wmo) });
          if (this.weatherHours.size > 48) for (const k of [...this.weatherHours.keys()].sort((a, b) => a - b).slice(0, this.weatherHours.size - 48)) this.weatherHours.delete(k);
        })
        .catch(() => {})
        .finally(() => (this.weatherLoading = false));
    }
    if (hit) return hit;
    const live = this.engine.weather && Date.now() - this.engine.weather.at < 3 * 3600_000 ? this.engine.weather.data : null;
    return live ? { temp: live.tempC, precip: precipClass(live.code) } : null;
  }

  /** Csak a képlet (összevetéshez / ellenőrzéshez): `/engine/trip?forecast=formula`. */
  formulaFor(tripId: string, now = nowUnix()): TripForecast | null {
    const run = this.engine.todayRuns.get(tripId);
    if (!run || run.status !== "running") return null;
    const current = this.engine.matcher.liveDelay(tripId, now) ?? run.lastDelayS;
    const stops = this.engine.feeds.cachedDay(run.serviceDate)?.feed.tripStopsAlong(tripId);
    if (current == null || !stops?.length) return null;
    const fromIdx = Math.max(0, run.lastStopIdx ?? 0);
    return { tripId, fromIdx, currentDelayS: current, stops: forecastDelays(stops, fromIdx, current, this.profileFn(run.serviceDate)), source: "formula" };
  }

  /**
   * Még el nem indult menet: a képlet a kiinduló megállótól, a várható kezdő
   * késéssel (0, vagy ha a busza még az előző menetén késik, annyi).
   */
  plannedFor(tripId: string, startDelayS: number, serviceDate = this.engine.today): TripForecast | null {
    const stops = this.engine.feeds.cachedDay(serviceDate)?.feed.tripStopsAlong(tripId);
    if (!stops?.length) return null;
    return { tripId, fromIdx: 0, currentDelayS: startDelayS, stops: forecastDelays(stops, 0, startDelayS, this.profileFn(serviceDate)), source: "formula" };
  }

  /** Egy megálló várható késése a menetben (a következő előfordulása a busz előtt). */
  forStop(tripId: string, stopId: string, now = nowUnix()): { delayS: number; upperS: number } | null {
    const f = this.forTrip(tripId, now);
    const s = f?.stops.find((x) => x.stopId === stopId);
    return s ? { delayS: s.delayS, upperS: s.upperS } : null;
  }

  private compute(tripId: string, now: number): TripForecast | null {
    const run = this.engine.todayRuns.get(tripId);
    if (!run || run.status !== "running") return null;
    const current = this.engine.matcher.liveDelay(tripId, now) ?? run.lastDelayS;
    if (current == null) return null;
    const stops = this.engine.feeds.cachedDay(run.serviceDate)?.feed.tripStopsAlong(tripId);
    if (!stops?.length) return null;
    const profile = this.profileFn(run.serviceDate);
    const fromIdx = Math.max(0, run.lastStopIdx ?? 0);
    const base = forecastDelays(stops, fromIdx, current, profile);
    if (this.model) {
      try {
        const out = this.withModel(this.model, run, stops, fromIdx, current, base, profile, now);
        this.stats.model++;
        return { tripId, fromIdx, currentDelayS: current, stops: out, source: "model" };
      } catch (e) {
        this.stats.errors++;
        if (this.stats.errors < 5) log.warn("forecast", "a modell nem tudott becsülni — a képlet marad", errMsg(e));
      }
    }
    this.stats.formula++;
    return { tripId, fromIdx, currentDelayS: current, stops: base, source: "formula" };
  }

  private withModel(
    m: DelayModelBundle,
    run: RunOut,
    stops: readonly { stopId: string; arr: number; dep: number }[],
    fromIdx: number,
    current: number,
    base: ForecastStop[],
    profile: ProfileFn,
    now: number,
  ): ForecastStop[] {
    const d = this.dayState(run.serviceDate);
    const info = dayInfo(run.serviceDate);
    const midnight = localMidnightUnix(run.serviceDate);
    const shape = this.engine.feeds.cachedDay(run.serviceDate)?.feed.trips.get(run.tripId)?.shapeId ?? run.tripId.split("_")[1] ?? run.tripId;
    const ahead = profileAhead(stops, fromIdx, profile);
    const trend = d.history.trend(run.runKey, fromIdx);
    const w = this.weatherAt(now);
    const origin = stops[fromIdx];
    return base.map((b, k) => {
      const j = fromIdx + k + 1;
      const n = j - fromIdx;
      if (n > MODEL_MAX_AHEAD) return b;
      const bucket = m.report.buckets[horizonBucket(n)];
      if (!bucket || (!bucket.useMedian && !bucket.useUpper)) return b;
      // A medián kapuja horizont × napszak cellánként (pl. a reggeli csúcsban, messzire előre a képlet marad).
      const cell = m.report.cells[gateCell(n, (now - midnight) / 3600)];
      const useMedian = bucket.useMedian && (cell ? cell.useMedian : true);
      const segs: [string, string][] = [];
      for (let s = fromIdx; s < Math.min(j, fromIdx + RECENT_SEGMENTS); s++) segs.push([stops[s].stopId, stops[s + 1].stopId]);
      const x = delayFeatureVector(
        {
          d0: current,
          ahead: n,
          schedAhead: stops[j].arr - origin.dep,
          gain: ahead.gain[k],
          spread: ahead.spread[k],
          baseline: b.delayS - current,
          hour: (now - midnight) / 3600,
          daytype: info.daytype,
          school: info.school,
          trend,
          leader: d.history.leader(shape, run.runKey, fromIdx, j, now),
          recent: d.traffic.query(segs, now),
          precip: w?.precip ?? null,
          temp: w?.temp ?? null,
          progress: fromIdx / Math.max(1, stops.length - 1),
        },
        this.featureBuf,
      );
      const med = predictGbdt(m.median, x);
      const up = predictGbdt(m.upper, x) + (m.upperShift[horizonBucket(n)] ?? 0);
      if (!Number.isFinite(med) || !Number.isFinite(up)) return b;
      const clamp = (v: number) => Math.min(current + MAX_CHANGE_UP_S, Math.max(current - MAX_CHANGE_DOWN_S, v));
      const delayS = useMedian ? Math.round(clamp(current + med)) : b.delayS;
      const upperS = bucket.useUpper ? Math.round(clamp(current + Math.max(up, med))) : b.upperS;
      return { ...b, delayS, upperS: Math.max(upperS, delayS) };
    });
  }
}
