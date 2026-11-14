/**
 * Élő tevékenység (iOS Live Activity) a követett menethez: az app az ActivityKit
 * push-tokenjét a menettel együtt elküldi (/push/live-activity), innen a worker
 * a menet haladásakor APNs-frissítést küld  így a zárolt képernyő és a
 * Dynamic Island akkor is friss, ha az app háttérben van vagy be van zárva.
 *
 * Az állapot ugyanabból jön, mint a /live/trip-progress: a jármű helye a menet
 * megállói mentén, a mért késés, a következő megálló menetrendi ideje.
 */
import {
  liveActivityPayload,
  nowUnix,
  progressOnTrip,
  sameActivityState,
  serviceClock,
  tripStopRows,
  type ApnsEnv,
  type LiveActivityState,
  type TripStopRow,
} from "@mvk/core";
import { getPool, sql } from "@mvk/db";
import { type ApnsClient, isGone } from "./apns.ts";
import type { Engine } from "./engine.ts";
import { errMsg, log } from "./log.ts";

const TICK_MS = 5_000;
/** két frissítés között legalább ennyi idő (mp)  az Apple a sűrű live activity pusht korlátozza */
const MIN_GAP_S = 15;
/** változás nélkül is ennyi időnként frissítünk, hogy ne avuljon el a kijelzés (mp) */
const KEEPALIVE_S = 5 * 60;
/** a frissítés ennyi idő után számít elavultnak a telefonon (mp) */
const STALE_AFTER_S = 10 * 60;
/** a követés legfeljebb ennyi ideig él (mp) */
const MAX_AGE_S = 3 * 3600;
/** a jármű nélküli menet ennyivel az utolsó megálló után ér véget (mp) */
const END_GRACE_S = 15 * 60;
/** beért menetnél ennyi ideig marad a zárolt képernyőn a végállapot (mp) */
const DISMISS_AFTER_S = 15 * 60;
const MAX_FAILS = 10;

type TokenRow = {
  token: string;
  env: ApnsEnv;
  trip_id: string;
  vehicle_id: string | null;
  stop_id: string | null;
  from_stop_id: string | null;
  created_at: Date;
  end_requested: boolean;
  last_sent_at: Date | null;
  last_state: LiveActivityState | null;
  fail_count: number;
};

export type ActivityInput = {
  tripId: string;
  stops: TripStopRow[];
  /** a menetet most vivő jármű, ha látjuk */
  vehicle: { id: string; speed: number | null } | null;
  /** a jármű helye a menet megállói mentén (progressOnTrip) */
  progress: { segmentIndex: number; progress: number; scheduleDeviationSec: number | null } | null;
  /** a mért késés most (mp), ha van */
  measuredDelaySec: number | null;
  /** a menetet a matcher lezárta (beért) */
  complete: boolean;
  /** a szolgáltatási nap éjfele (unix)  a megállók `dep` ideje ehhez képest mp */
  midnightUnix: number;
  now: number;
  /** a feliratkozáskor megadott megálló (az iOS-utazásnál a leszállóhely) */
  stopId: string | null;
  /** a felszállás megállója: a haladás innen számít a megadott megállóig */
  fromStopId: string | null;
  /** a feliratkozáskor megadott jármű (ha a menet még nem indult el) */
  vehicleId: string | null;
};

/** A Live Activity állapota a menet haladásából. */
export function activityState(i: ActivityInput): LiveActivityState {
  const last = i.stops[i.stops.length - 1];
  const delaySec = i.measuredDelaySec ?? i.progress?.scheduleDeviationSec ?? null;
  const at = (dep: number) => i.midnightUnix + dep + (delaySec ?? 0);
  // a jármű nélkül: még nem indult el (az első megálló a következő), vagy már régen beért
  const nextIdx = i.progress ? Math.min(i.stops.length - 1, i.progress.segmentIndex + 1) : 0;
  const next = i.stops[nextIdx] ?? null;
  const ended = i.complete || (!i.vehicle && last != null && i.now > i.midnightUnix + last.dep + END_GRACE_S);
  const targetIdx = i.stopId ? i.stops.findIndex((s) => s.id === i.stopId) : -1;
  const target = targetIdx >= 0 ? i.stops[targetIdx] : undefined;
  // Megadott megállónál a haladás és a hátralévő megállók odáig (a felszállástól) számítanak,
  // ahogy az app is mutatja  a push így nem ugratja a zárolt képernyőt.
  const fromIdx = Math.max(0, i.fromStopId ? i.stops.findIndex((s) => s.id === i.fromStopId) : 0);
  const span = target && targetIdx > fromIdx ? targetIdx - fromIdx : null;
  const progress = !i.progress
    ? null
    : span == null
      ? i.progress.progress
      : Math.min(1, Math.max(0, (i.progress.progress * Math.max(1, i.stops.length - 1) - fromIdx) / span));
  return {
    tripId: i.tripId,
    vehicleId: i.vehicle?.id ?? i.vehicleId,
    live: i.vehicle != null,
    progress: ended ? 1 : progress == null ? null : Math.round(progress * 1000) / 1000,
    delaySec: delaySec == null ? null : Math.round(delaySec),
    nextStopId: ended ? null : (next?.id ?? null),
    nextStopName: ended ? null : (next?.name ?? null),
    nextStopEtaUnix: ended || !next ? null : Math.round(at(next.dep)),
    stopsLeft: ended ? 0 : Math.max(0, (target ? targetIdx + 1 : i.stops.length) - nextIdx),
    stopEtaUnix: target ? Math.round(at(target.dep)) : null,
    destName: target?.name ?? null,
    speedKmh: i.vehicle?.speed != null ? Math.round(i.vehicle.speed * 3.6) : null,
    ended,
    updatedAt: i.now,
  };
}

/** Jelentős-e a változás (késés legalább egy percet, vagy új következő megálló): akkor azonnali prioritással. */
function significant(prev: LiveActivityState | null, next: LiveActivityState): boolean {
  if (!prev) return true;
  return prev.nextStopId !== next.nextStopId || prev.ended !== next.ended || Math.abs((prev.delaySec ?? 0) - (next.delaySec ?? 0)) >= 60;
}

export class LiveActivityPusher {
  private rows: TokenRow[] = [];
  private running = false;

  constructor(
    private readonly engine: Engine,
    private readonly apns: ApnsClient,
  ) {}

  async start(): Promise<void> {
    if (!this.apns.configured) return;
    await this.reload();
    setInterval(() => this.reload().catch(() => {}), 60_000).unref();
    setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((e) => log.warn("activity", "frissítés hiba", errMsg(e)))
        .finally(() => (this.running = false));
    }, TICK_MS).unref();
    log.info("activity", `aktív  ${this.rows.length} élő tevékenység`);
  }

  async reload(): Promise<void> {
    if (!this.apns.configured) return;
    this.rows = await sql<TokenRow>(
      `SELECT token, env, trip_id, vehicle_id, stop_id, from_stop_id, created_at, end_requested, last_sent_at, last_state, fail_count FROM live_activity_token`,
    );
  }

  private async tick(): Promise<void> {
    if (!this.rows.length) return;
    const now = nowUnix();
    const clock = serviceClock(now);
    const feed = this.engine.feeds.cachedDay(this.engine.today)?.feed;
    for (const row of [...this.rows]) {
      if (row.end_requested) {
        await this.finish(row, now, now);
        continue;
      }
      const stops = feed ? tripStopRows(feed, row.trip_id) : null;
      const tooOld = now - Math.floor(row.created_at.getTime() / 1000) > MAX_AGE_S;
      if (!feed || !stops?.length) {
        // ismeretlen menet (pl. másik nap, vagy a menetrend még töltődik): csak a korhatár zárja
        if (tooOld) await this.finish(row, now, now);
        continue;
      }
      const v = this.engine.snapshot.vehicles.find((x) => x.tripId === row.trip_id) ?? null;
      const prog = v ? progressOnTrip(feed, row.trip_id, v, clock.secOfDay) : null;
      const state = activityState({
        tripId: row.trip_id,
        stops,
        vehicle: v ? { id: v.id, speed: v.speed ?? null } : null,
        progress: prog,
        measuredDelaySec: this.engine.matcher.liveDelay(row.trip_id, now),
        complete: this.engine.todayRuns.get(row.trip_id)?.status === "complete",
        midnightUnix: clock.midnightUnix,
        now,
        stopId: row.stop_id,
        fromStopId: row.from_stop_id,
        vehicleId: row.vehicle_id,
      });
      if (state.ended || tooOld) {
        await this.finish(row, now, state.ended ? now + DISMISS_AFTER_S : now, state);
        continue;
      }
      const lastAt = row.last_sent_at ? Math.floor(row.last_sent_at.getTime() / 1000) : 0;
      const changed = !sameActivityState(row.last_state, state);
      if (now - lastAt < MIN_GAP_S) continue;
      if (!changed && now - lastAt < KEEPALIVE_S) continue;
      await this.push(row, "update", state, now, { priority: significant(row.last_state, state) ? 10 : 5 });
    }
  }

  /** „end” a telefonnak, aztán a token törlése. */
  private async finish(row: TokenRow, now: number, dismissalUnix: number, state?: LiveActivityState): Promise<void> {
    const final: LiveActivityState = { ...(state ?? row.last_state ?? emptyState(row.trip_id, now)), ended: true, updatedAt: now };
    await this.push(row, "end", final, now, { priority: 10, dismissalUnix }).catch(() => {});
    await getPool().query(`DELETE FROM live_activity_token WHERE token = $1`, [row.token]);
    this.rows = this.rows.filter((r) => r.token !== row.token);
  }

  private async push(
    row: TokenRow,
    event: "update" | "end",
    state: LiveActivityState,
    now: number,
    opts: { priority: 5 | 10; dismissalUnix?: number },
  ): Promise<void> {
    try {
      const r = await this.apns.send({
        env: row.env,
        token: row.token,
        pushType: "liveactivity",
        payload: liveActivityPayload(event, state, now, { staleAfterS: STALE_AFTER_S, dismissalUnix: opts.dismissalUnix }),
        expiration: now + STALE_AFTER_S,
        priority: opts.priority,
      });
      if (r.status === 200) {
        row.last_state = state;
        row.last_sent_at = new Date(now * 1000);
        row.fail_count = 0;
        await getPool().query(`UPDATE live_activity_token SET last_state = $2, last_sent_at = to_timestamp($3), fail_count = 0 WHERE token = $1`, [
          row.token,
          JSON.stringify(state),
          now,
        ]);
        return;
      }
      if (isGone(r)) {
        await getPool().query(`DELETE FROM live_activity_token WHERE token = $1`, [row.token]);
        this.rows = this.rows.filter((x) => x.token !== row.token);
        return;
      }
      throw new Error(`APNs: ${r.reason ?? r.status}`);
    } catch (e) {
      row.fail_count++;
      if (row.fail_count >= MAX_FAILS) {
        await getPool().query(`DELETE FROM live_activity_token WHERE token = $1`, [row.token]);
        this.rows = this.rows.filter((x) => x.token !== row.token);
      } else {
        await getPool().query(`UPDATE live_activity_token SET fail_count = $2 WHERE token = $1`, [row.token, row.fail_count]);
      }
      log.warn("activity", "küldés sikertelen", errMsg(e));
    }
  }
}

function emptyState(tripId: string, now: number): LiveActivityState {
  return {
    tripId,
    vehicleId: null,
    live: false,
    progress: null,
    delaySec: null,
    nextStopId: null,
    nextStopName: null,
    nextStopEtaUnix: null,
    stopsLeft: null,
    stopEtaUnix: null,
    destName: null,
    speedKmh: null,
    ended: true,
    updatedAt: now,
  };
}
