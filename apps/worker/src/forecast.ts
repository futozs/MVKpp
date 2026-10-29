/**
 * Késés-előrejelzés élő menetekre: a core `forecastDelays` modellje a
 * szakaszprofilokkal (segment_daily, az elmúlt 8 hét, naptípus és óra szerint).
 * A profilokat induláskor és éjszakánként töltjük be; menetenként 15 mp-ig
 * gyorsítótárazzuk az eredményt.
 */
import { dayInfo, forecastDelays, nowUnix, type ForecastStop, type SegmentProfile, type VehicleMotion } from "@mvk/core";
import { sql } from "@mvk/db";
import type { Engine } from "./engine.ts";
import { log } from "./log.ts";

const HISTORY_DAYS = 56;
const MIN_SAMPLES = 4;
const CACHE_S = 15;
/** a 15 perces tod_bucket-ekből órák */
const BUCKETS_PER_HOUR = 4;

export type TripForecast = { tripId: string; fromIdx: number; currentDelayS: number; stops: ForecastStop[] };

export class DelayForecaster {
  private engine: Engine;
  private profiles = new Map<string, SegmentProfile>();
  private cache = new Map<string, { at: number; value: TripForecast | null }>();

  constructor(engine: Engine) {
    this.engine = engine;
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
    const daytype = dayInfo(run.serviceDate).daytype;
    const fromIdx = Math.max(0, run.lastStopIdx ?? 0);
    const out = forecastDelays(stops, fromIdx, current, (f, t, h) => this.profiles.get(`${f}|${t}|${daytype}|${h}`));
    return { tripId, fromIdx, currentDelayS: current, stops: out };
  }
}
