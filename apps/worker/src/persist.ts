/**
 * Kötegelt adatbázis-írás az illesztő kimenetéhez. Ugyanezt használja az élő
 * worker és a visszamenőleges újraszámolás (replay), így a kettő azonos.
 *
 * Minden írás idempotens (ON CONFLICT), ezért egy újraindítás vagy egy
 * újrafuttatott replay nem duplikál.
 */
import { dayInfo, feedOfId, todBucket, trainParts, type PingOut, type RunOut, type StopEventOut } from "@mvk/core";
import { getPool } from "@mvk/db";
import { errMsg, log } from "./log.ts";

const SRC: Record<StopEventOut["src"], number> = { dwell: 1, pass: 2, final: 3 };

type SegmentRow = {
  ts: number;
  serviceDate: string;
  from: string;
  to: string;
  route: string;
  runKey: string;
  travel: number;
  sched: number;
  dwell: number | null;
  entryDelay: number;
};

/** A menet rövid neve a statisztikához: vonatnál csak a vonatszám („6612 személyvonat” → „6612”). */
function tripShortOf(r: RunOut): string | null {
  if (!r.tripShort) return null;
  return feedOfId(r.tripId) === "rail" ? (trainParts(r.tripShort).no ?? r.tripShort) : r.tripShort;
}

export class Persister {
  private pings: PingOut[] = [];
  private events: (StopEventOut & { headway: number | null; schedHeadway: number | null })[] = [];
  private segments: SegmentRow[] = [];
  private runs = new Map<string, RunOut>();
  private vehicles = new Map<string, { first: number; last: number; label: string | null }>();
  /** runKey → előző megálló-esemény (szakaszidőhöz) */
  private lastEventOfRun = new Map<string, StopEventOut>();
  /** `${stop}|${route}` → előző érkezés (követési időhöz) */
  private lastArrival = new Map<string, { ts: number; sched: number }>();
  private flushing: Promise<void> | null = null;
  readonly source: "live" | "replay";
  stats = { pings: 0, events: 0, runs: 0, segments: 0, errors: 0 };

  constructor(source: "live" | "replay") {
    this.source = source;
  }

  ping(p: PingOut, label?: string | null) {
    this.pings.push(p);
    const v = this.vehicles.get(p.vehicleId);
    if (v) {
      v.last = Math.max(v.last, p.ts);
      if (label) v.label = label;
    } else this.vehicles.set(p.vehicleId, { first: p.ts, last: p.ts, label: label ?? null });
  }

  run(r: RunOut) {
    this.runs.set(r.runKey, { ...r });
  }

  stopEvent(e: StopEventOut) {
    const key = `${e.stopId}|${e.routeShort}`;
    const prevArr = this.lastArrival.get(key);
    const headway = prevArr && e.arrTs > prevArr.ts && e.arrTs - prevArr.ts < 4 * 3600 ? e.arrTs - prevArr.ts : null;
    const schedHeadway = prevArr && headway != null ? e.schedArrS - prevArr.sched : null;
    this.lastArrival.set(key, { ts: e.arrTs, sched: e.schedArrS });
    this.events.push({ ...e, headway, schedHeadway: schedHeadway != null && schedHeadway > 0 ? schedHeadway : null });

    const prev = this.lastEventOfRun.get(e.runKey);
    if (prev && e.stopIdx > prev.stopIdx && e.src !== "final") {
      const from = prev.depTs ?? prev.arrTs;
      const travel = e.arrTs - from;
      const sched = e.schedArrS - prev.schedDepS;
      if (travel > 0 && travel < 3600 && sched > 0 && sched < 3600 && e.stopIdx === prev.stopIdx + 1) {
        this.segments.push({
          ts: from,
          serviceDate: e.serviceDate,
          from: prev.stopId,
          to: e.stopId,
          route: e.routeShort,
          runKey: e.runKey,
          travel,
          sched,
          dwell: prev.dwellS,
          entryDelay: prev.delayS,
        });
      }
    }
    this.lastEventOfRun.set(e.runKey, e);
    if (e.isLast) this.lastEventOfRun.delete(e.runKey);
  }

  pending(): number {
    return this.pings.length + this.events.length + this.runs.size + this.segments.length;
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const pings = this.pings.splice(0);
    const events = this.events.splice(0);
    const segments = this.segments.splice(0);
    const runs = [...this.runs.values()];
    this.runs.clear();
    const vehicles = [...this.vehicles.entries()];
    this.vehicles.clear();
    const pool = getPool();
    try {
      for (let i = 0; i < pings.length; i += 5000) {
        const b = pings.slice(i, i + 5000);
        await pool.query(
          `INSERT INTO veh_ping (ts, vehicle_id, lat, lon, speed, bearing, rt_trip_id, trip_id, route_short, service_date)
           SELECT to_timestamp(t), v, la, lo, s, b, rt, tr, rs, sd
             FROM unnest($1::float8[], $2::text[], $3::float8[], $4::float8[], $5::real[], $6::int2[], $7::text[], $8::text[], $9::text[], $10::date[])
                  AS x(t, v, la, lo, s, b, rt, tr, rs, sd)
           ON CONFLICT (vehicle_id, ts) DO NOTHING`,
          [
            b.map((p) => p.ts),
            b.map((p) => p.vehicleId),
            b.map((p) => p.lat),
            b.map((p) => p.lon),
            b.map((p) => (p.speed == null ? null : p.speed)),
            b.map((p) => (p.bearing == null ? null : Math.round(p.bearing) % 360)),
            b.map((p) => p.rtTripId || null),
            b.map((p) => p.tripId),
            b.map((p) => (p.tripId ? (p.routeId ?? null) : null)),
            b.map((p) => p.serviceDate),
          ],
        );
      }
      if (vehicles.length) {
        await pool.query(
          `INSERT INTO vehicle (vehicle_id, label, first_seen, last_seen)
           SELECT v, l, to_timestamp(f), to_timestamp(t) FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[]) AS x(v, l, f, t)
           ON CONFLICT (vehicle_id) DO UPDATE SET last_seen = GREATEST(vehicle.last_seen, EXCLUDED.last_seen),
             first_seen = LEAST(vehicle.first_seen, EXCLUDED.first_seen), label = COALESCE(EXCLUDED.label, vehicle.label)`,
          [vehicles.map(([k]) => k), vehicles.map(([, v]) => v.label), vehicles.map(([, v]) => v.first), vehicles.map(([, v]) => v.last)],
        );
      }
      for (let i = 0; i < runs.length; i += 1000) await this.writeRuns(runs.slice(i, i + 1000));
      for (let i = 0; i < events.length; i += 3000) {
        const b = events.slice(i, i + 3000);
        await pool.query(
          `INSERT INTO stop_event (ts, service_date, run_key, trip_id, vehicle_id, route_short, stop_id, stop_seq, stop_idx,
                                   is_first, is_last, sched_arr_s, sched_dep_s, dep_ts, delay_s, dwell_s, headway_s, sched_headway_s, src)
           SELECT to_timestamp(a), sd, rk, tr, v, r, s, sq, si, f, l, sa, sp, to_timestamp(d), dl, dw, hw, shw, src
             FROM unnest($1::float8[], $2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int2[], $9::int2[],
                         $10::bool[], $11::bool[], $12::int4[], $13::int4[], $14::float8[], $15::int4[], $16::int4[], $17::int4[], $18::int4[], $19::int2[])
                  AS x(a, sd, rk, tr, v, r, s, sq, si, f, l, sa, sp, d, dl, dw, hw, shw, src)
           ON CONFLICT (run_key, stop_idx, ts) DO NOTHING`,
          [
            b.map((e) => e.arrTs),
            b.map((e) => e.serviceDate),
            b.map((e) => e.runKey),
            b.map((e) => e.tripId),
            b.map((e) => e.vehicleId),
            b.map((e) => e.routeShort),
            b.map((e) => e.stopId),
            b.map((e) => Math.min(e.stopSeq, 32767)),
            b.map((e) => e.stopIdx),
            b.map((e) => e.isFirst),
            b.map((e) => e.isLast),
            b.map((e) => e.schedArrS),
            b.map((e) => e.schedDepS),
            b.map((e) => e.depTs),
            b.map((e) => e.delayS),
            b.map((e) => e.dwellS),
            b.map((e) => e.headway),
            b.map((e) => e.schedHeadway),
            b.map((e) => SRC[e.src]),
          ],
        );
      }
      for (let i = 0; i < segments.length; i += 3000) {
        const b = segments.slice(i, i + 3000);
        await pool.query(
          `INSERT INTO segment_run (ts, service_date, from_stop, to_stop, route_short, run_key, travel_s, sched_s, dwell_s, entry_delay_s, tod_bucket, daytype, school)
           SELECT to_timestamp(t), sd, f, s, r, rk, tr, sc, dw, ed, tb, dt, sch
             FROM unnest($1::float8[], $2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int4[], $8::int4[], $9::int4[], $10::int4[], $11::int2[], $12::int2[], $13::bool[])
                  AS x(t, sd, f, s, r, rk, tr, sc, dw, ed, tb, dt, sch)
           ON CONFLICT (run_key, from_stop, ts) DO NOTHING`,
          [
            b.map((s) => s.ts),
            b.map((s) => s.serviceDate),
            b.map((s) => s.from),
            b.map((s) => s.to),
            b.map((s) => s.route),
            b.map((s) => s.runKey),
            b.map((s) => s.travel),
            b.map((s) => s.sched),
            b.map((s) => s.dwell),
            b.map((s) => s.entryDelay),
            b.map((s) => todBucket(s.ts)),
            b.map((s) => dayInfo(s.serviceDate).daytype),
            b.map((s) => dayInfo(s.serviceDate).school),
          ],
        );
      }
      this.stats.pings += pings.length;
      this.stats.events += events.length;
      this.stats.runs += runs.length;
      this.stats.segments += segments.length;
    } catch (e) {
      this.stats.errors++;
      log.error("persist", `írás sikertelen (${pings.length} pont, ${events.length} esemény) — újrapróbálom`, errMsg(e));
      // Vissza a sorba, a következő körben újra próbáljuk.
      // concat, nem unshift(...): hosszú kiesésnél a több százezres sor szétterítése veremtúlcsordulást okozna.
      this.pings = pings.concat(this.pings);
      this.events = events.concat(this.events);
      this.segments = segments.concat(this.segments);
      for (const r of runs) if (!this.runs.has(r.runKey)) this.runs.set(r.runKey, r);
      for (const [k, v] of vehicles) if (!this.vehicles.has(k)) this.vehicles.set(k, v);
      if (this.pings.length > 200_000) this.pings.splice(0, this.pings.length - 200_000);
    }
  }

  private async writeRuns(b: RunOut[]) {
    await getPool().query(
      `INSERT INTO trip_run (run_key, service_date, trip_id, vehicle_id, route_short, route_id, direction, pattern, headsign, feed_version,
                             sched_start_s, sched_end_s, stops_total, stops_seen, opened_at, last_seen_at, actual_start, actual_end,
                             start_delay_s, end_delay_s, last_delay_s, last_stop_idx, dist_m, max_speed, status, close_reason, source, updated_at,
                             trip_short, rt_source)
       SELECT rk, sd::date, tr, v, rs, ri, dir, pat, hs, fv, ss, se, st, sn, to_timestamp(op), to_timestamp(ls), to_timestamp(a0), to_timestamp(a1),
              sdl, edl, ldl, lsi, dm, ms, stt, cr, $27, now(), tsh, rts
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int2[], $8::text[], $9::text[], $10::text[],
                     $11::int4[], $12::int4[], $13::int2[], $14::int2[], $15::float8[], $16::float8[], $17::float8[], $18::float8[],
                     $19::int4[], $20::int4[], $21::int4[], $22::int2[], $23::int4[], $24::real[], $25::text[], $26::text[], $28::text[], $29::text[])
              AS x(rk, sd, tr, v, rs, ri, dir, pat, hs, fv, ss, se, st, sn, op, ls, a0, a1, sdl, edl, ldl, lsi, dm, ms, stt, cr, tsh, rts)
       ON CONFLICT (run_key) DO UPDATE SET
         stops_seen = EXCLUDED.stops_seen, last_seen_at = EXCLUDED.last_seen_at,
         actual_start = COALESCE(EXCLUDED.actual_start, trip_run.actual_start), actual_end = COALESCE(EXCLUDED.actual_end, trip_run.actual_end),
         start_delay_s = COALESCE(EXCLUDED.start_delay_s, trip_run.start_delay_s), end_delay_s = COALESCE(EXCLUDED.end_delay_s, trip_run.end_delay_s),
         last_delay_s = EXCLUDED.last_delay_s, last_stop_idx = EXCLUDED.last_stop_idx, dist_m = EXCLUDED.dist_m, max_speed = EXCLUDED.max_speed,
         status = EXCLUDED.status, close_reason = EXCLUDED.close_reason, source = EXCLUDED.source, updated_at = now(),
         trip_short = COALESCE(EXCLUDED.trip_short, trip_run.trip_short),
         rt_source = CASE WHEN EXCLUDED.rt_source IS NULL THEN trip_run.rt_source
                          WHEN trip_run.rt_source IS NULL OR trip_run.rt_source = EXCLUDED.rt_source THEN EXCLUDED.rt_source ELSE 'mixed' END`,
      [
        b.map((r) => r.runKey),
        b.map((r) => r.serviceDate),
        b.map((r) => r.tripId),
        b.map((r) => r.vehicleId),
        b.map((r) => r.routeShort),
        b.map((r) => r.routeId),
        b.map((r) => r.dir),
        b.map((r) => r.pattern),
        b.map((r) => r.headsign || null),
        b.map((r) => r.feedVersion),
        b.map((r) => r.schedStartS),
        b.map((r) => r.schedEndS),
        b.map((r) => Math.min(r.stopsTotal, 32767)),
        b.map((r) => Math.min(r.stopsSeen, 32767)),
        b.map((r) => r.openedTs),
        b.map((r) => r.lastTs),
        b.map((r) => r.actualStart),
        b.map((r) => r.actualEnd),
        b.map((r) => r.startDelayS),
        b.map((r) => r.endDelayS),
        b.map((r) => r.lastDelayS),
        b.map((r) => r.lastStopIdx),
        b.map((r) => Math.round(r.distM)),
        b.map((r) => r.maxSpeed || null),
        b.map((r) => r.status),
        b.map((r) => r.closeReason),
        this.source,
        b.map(tripShortOf),
        b.map((r) => r.rtSource ?? null),
      ],
    );
  }
}
