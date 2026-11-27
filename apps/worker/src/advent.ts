/**
 * Az adventi villamos felvevője és elemzője.
 *
 * Minden pollnál megnézi, benne van-e a szerelvény (pályaszám, ADV vonal vagy
 * ADV-nyomvonalú menet), és minden új GPS-jelét elmenti az advent_ping táblába
 * (évadon kívül is). Percenként jelenléti sort ír az üzemidő körül. A nap
 * elemzése (core/advent/day.ts) mindig a pontokból készül; a lezárt nap
 * összegzése az advent_day táblába kerül.
 */
import {
  budapestOffsetSec,
  fastDistM,
  isMvkId,
  nowUnix,
  ProjectedShape,
  serviceClock,
  type DecodedVehicle,
  type Feed,
  type RealtimeSnapshot,
  type VehicleMotion,
} from "@mvk/core";
import { adventDay, type AdventDay, type LineTram } from "@mvk/core/advent/day";
import { buildAdventLine, placeFix, type AdventLine } from "@mvk/core/advent/line";
import { dayPlan, isAdventVehicle, latestSeason, seasonDays, seasonOf, seasonOn, stopOrder, type AdventSeason } from "@mvk/core/advent/season";
import { replayDay, type DayReplay } from "@mvk/core/advent/replay";
import { trackDay, type AdventPing } from "@mvk/core/advent/track";
import { sql } from "@mvk/db";
import type { Engine } from "./engine.ts";
import type { FeedManager } from "./feeds.ts";
import { errMsg, log } from "./log.ts";

/** az elemzés változata: ha változik, a lezárt napok újraszámolódnak */
export const ADVENT_ALGO = "2026.1";

/** ennyi jármű egy menetazonosítón: hibás pillanat (2026-09-15-én az egész flotta egyen ült) */
const GLITCH_SHARE = 10;
/** a jelenléti napló az első indulás előtt és az utolsó érkezés után ennyivel (mp) */
const PRESENCE_PAD_S = 3600;
/** a többi villamos helyzete ennél régebbi jellel már nem számít (mp) */
const TRAM_FRESH_S = 120;

type PendingPing = AdventPing & {
  vehicleId: string;
  bearing: number | null;
  serviceDate: string;
  season: number | null;
  polledAt: number;
  source: "mvk" | "otp2";
  label: string | null;
  rtTripId: string | null;
  rtRoute: string | null;
  routeShort: string | null;
  headsign: string | null;
  glitch: boolean;
};

type Presence = { minute: number; serviceDate: string; ok: number; fail: number; seen: number; trams: number; fixAgeS: number | null };

type DirShape = { id: string; shape: ProjectedShape; stopAlong: number[] };

export class AdventTracker {
  private readonly engine: Engine;
  private readonly feeds: FeedManager;
  private pending: PendingPing[] = [];
  private presence: Presence | null = null;
  /** a mai (szolgáltatási) nap pontjai, járművenként egy sorban (a 202 és egy esetleges másik) */
  private today: { iso: string; pings: AdventPing[] } = { iso: "", pings: [] };
  private lastFix = new Map<string, number>();
  private lineCache: { feedHash: string; line: AdventLine; out: DirShape; back: DirShape } | null = null;
  /** a többi villamos: mióta áll egy helyben, merre megy */
  private trams = new Map<string, { lat: number; lon: number; since: number; ts: number; m: number; dir: "out" | "back" | null }>();
  private liveCache: { key: string; day: AdventDay } | null = null;
  /** az MVK mai törlés-listájából az évad menetei (T1022 / M1105) */
  private cancelledToday = new Set<string>();
  private dayCache = new Map<string, { at: number; day: AdventDay }>();
  private replayCache = new Map<string, { at: number; pings: number; closed: boolean; replay: DayReplay }>();
  readonly stats = { pings: 0, glitches: 0, errors: 0, lastPingAt: 0 };

  constructor(engine: Engine, feeds: FeedManager) {
    this.engine = engine;
    this.feeds = feeds;
  }

  async start(): Promise<void> {
    await this.loadToday(serviceClock().iso);
    this.engine.on("tick", (snap) => {
      try {
        this.onTick(snap);
      } catch (e) {
        this.stats.errors++;
        if (this.stats.errors < 5) log.warn("advent", "tick hiba", errMsg(e));
      }
    });
    this.engine.on("cancelled", (ids) => {
      const keys = cancelledKeys(this.season(), ids);
      if (keys.size !== this.cancelledToday.size || [...keys].some((k) => !this.cancelledToday.has(k))) this.liveCache = null;
      this.cancelledToday = keys;
    });
    setInterval(() => void this.flush(), 5000).unref();
  }

  /** egy nap hivatalos törlései a tárolt listából */
  private async cancelledOn(iso: string, season: AdventSeason): Promise<Set<string>> {
    const rows = await sql<{ trip_id: string }>(`SELECT trip_id FROM cancelled_trip WHERE service_date = $1 AND split_part(trip_id, '_', 2) = ANY($2)`, [
      iso,
      [season.shapeIds.out, season.shapeIds.back],
    ]);
    return cancelledKeys(season, rows.map((r) => r.trip_id));
  }

  /** a mostani vagy a legutóbbi évad (a nézet ezt mutatja alapból) */
  season(iso = serviceClock().iso): AdventSeason {
    return seasonOn(iso) ?? latestSeason(iso);
  }

  /** a vonal a mostani feedből: a Tiszai → Felső-Majláth és a visszafelé nyomvonal, megállókkal */
  line(): { line: AdventLine; out: DirShape; back: DirShape } | null {
    const feed = this.feeds.latest();
    if (!feed) return null;
    if (this.lineCache?.feedHash === feed.hash) return this.lineCache;
    const season = this.season();
    const out = dirShape(feed, season, "out");
    const back = dirShape(feed, season, "back");
    if (!out || !back) {
      log.warn("advent", "a vonal nyomvonala nincs a feedben");
      return null;
    }
    const line = buildAdventLine(season, out.shape.points, (id) => feed.stops.get(id));
    if (!line) return null;
    this.lineCache = { feedHash: feed.hash, line, out, back };
    return this.lineCache;
  }

  private async loadToday(iso: string) {
    const season = this.season(iso);
    const rows = await sql<{ t: number; lat: number; lon: number; speed: number | null; v: string }>(
      `SELECT extract(epoch FROM ts)::float8 AS t, lat, lon, speed, vehicle_id AS v FROM advent_ping
        WHERE service_date = $1 AND vehicle_id = ANY($2) AND NOT glitch ORDER BY ts`,
      [iso, season.vehicleIds],
    ).catch((e) => {
      log.warn("advent", "a mai pontok betöltése sikertelen", errMsg(e));
      return [];
    });
    const pings = rows.map((r) => ({ ts: Math.round(r.t), lat: r.lat, lon: r.lon, speed: r.speed }));
    this.today = { iso, pings };
    for (const r of rows) this.lastFix.set(r.v, Math.max(this.lastFix.get(r.v) ?? 0, Math.round(r.t)));
    if (pings.length) log.info("advent", `${iso}: ${pings.length} pont betöltve`);
  }

  private onTick(snap: RealtimeSnapshot) {
    const now = nowUnix();
    const clock = serviceClock(now);
    if (clock.iso !== this.today.iso) {
      this.today = { iso: clock.iso, pings: [] };
      this.liveCache = null;
    }
    const offset = budapestOffsetSec(now);
    const season = seasonOn(clock.iso) ?? this.season(clock.iso);
    const inSeason = seasonOn(clock.iso) != null;
    const byTrip = new Map<string, number>();
    for (const v of snap.decoded) if (v.tripId) byTrip.set(v.tripId, (byTrip.get(v.tripId) ?? 0) + 1);

    let seen = false;
    let tramCount = 0;
    const lc = this.line();
    for (const v of snap.decoded) {
      // a MÁV+ menetrendből becsült helye nem GPS: nem tároljuk, nem számolunk vele
      if (!isMvkId(v.id) || v.lat == null || v.lon == null || !v.timestamp || v.estimated) continue;
      const ts = v.timestamp - offset;
      const advent = isAdventVehicle(season, { id: v.id, routeShort: v.routeShort, rtTripId: v.rtTripId ?? v.tripId });
      if (!advent) {
        if (v.mode === "tram" || ["1V", "1AV", "2V"].includes(v.routeShort)) {
          tramCount++;
          if (lc) this.trackTram(lc.line, v, ts);
        }
        continue;
      }
      seen = true;
      if (ts > now + 120 || ts < now - 6 * 3600 || ts <= (this.lastFix.get(v.id) ?? 0)) continue;
      this.lastFix.set(v.id, ts);
      const glitch = (byTrip.get(v.tripId) ?? 0) >= GLITCH_SHARE;
      const p: PendingPing = {
        ts,
        lat: v.lat,
        lon: v.lon,
        speed: v.speed,
        vehicleId: v.id,
        bearing: v.bearing,
        serviceDate: serviceClock(ts).iso,
        season: inSeason ? season.year : null,
        polledAt: now,
        source: v.source === "otp2" ? "otp2" : "mvk",
        label: v.label || null,
        rtTripId: v.rtTripId ?? (v.tripId || null),
        rtRoute: v.routeId || null,
        routeShort: v.routeShort || null,
        headsign: v.headsign || null,
        glitch,
      };
      this.pending.push(p);
      this.stats.pings++;
      this.stats.lastPingAt = now;
      if (glitch) this.stats.glitches++;
      else if (p.serviceDate === this.today.iso && season.vehicleIds.includes(v.id)) {
        this.today.pings.push({ ts, lat: v.lat, lon: v.lon, speed: v.speed });
        this.liveCache = null;
      }
    }
    if (inSeason) this.notePresence(season, clock.iso, now, snap, seen, tramCount);
  }

  private trackTram(line: AdventLine, v: DecodedVehicle, ts: number) {
    const f = placeFix(line, { ts, lat: v.lat!, lon: v.lon!, speed: v.speed });
    if (f.place === "off") {
      this.trams.delete(v.id);
      return;
    }
    const prev = this.trams.get(v.id);
    if (!prev || ts - prev.ts > 30 * 60) {
      this.trams.set(v.id, { lat: f.lat, lon: f.lon, since: ts, ts, m: f.m, dir: null });
      return;
    }
    if (ts <= prev.ts) return;
    const moved = fastDistM(prev.lat, prev.lon, f.lat, f.lon) > 60;
    const dir = Math.abs(f.m - prev.m) >= 30 ? (f.m > prev.m ? "out" : "back") : prev.dir;
    this.trams.set(v.id, moved ? { lat: f.lat, lon: f.lon, since: ts, ts, m: f.m, dir } : { ...prev, ts, m: Math.abs(f.m - prev.m) >= 30 ? f.m : prev.m, dir });
  }

  private lineTrams(now: number): LineTram[] {
    const out: LineTram[] = [];
    for (const [id, t] of this.trams) {
      if (now - t.ts > TRAM_FRESH_S * 5) {
        this.trams.delete(id);
        continue;
      }
      out.push({ id, m: t.m, dir: t.dir, stillS: t.ts - t.since, ageS: now - t.ts });
    }
    return out;
  }

  private notePresence(season: AdventSeason, iso: string, now: number, snap: RealtimeSnapshot, seen: boolean, trams: number) {
    const plan = dayPlan(season, iso);
    if (!plan?.trips.length) return;
    if (now < plan.trips[0].dep - PRESENCE_PAD_S || now > plan.trips[plan.trips.length - 1].arr + PRESENCE_PAD_S) return;
    const minute = Math.floor(now / 60) * 60;
    if (this.presence && this.presence.minute !== minute) this.flushPresence();
    const p = this.presence ?? { minute, serviceDate: iso, ok: 0, fail: 0, seen: 0, trams: 0, fixAgeS: null };
    // az MVK pozíció-lekérése sikerült-e most (a regionális járművek nem számítanak)
    const ok = Date.now() - this.engine.positionsAt() < 10_000;
    if (ok) p.ok++;
    else p.fail++;
    if (seen) p.seen++;
    p.trams = Math.max(p.trams, trams);
    const last = Math.max(0, ...season.vehicleIds.map((id) => this.lastFix.get(id) ?? 0));
    p.fixAgeS = last ? now - last : null;
    this.presence = p;
  }

  private flushPresence() {
    const p = this.presence;
    this.presence = null;
    if (!p) return;
    sql(
      `INSERT INTO advent_presence (minute, service_date, polls_ok, polls_fail, seen_polls, trams, fix_age_s)
       VALUES (to_timestamp($1), $2, $3, $4, $5, $6, $7)
       ON CONFLICT (minute) DO UPDATE SET polls_ok = advent_presence.polls_ok + EXCLUDED.polls_ok, polls_fail = advent_presence.polls_fail + EXCLUDED.polls_fail,
         seen_polls = advent_presence.seen_polls + EXCLUDED.seen_polls, trams = GREATEST(advent_presence.trams, EXCLUDED.trams), fix_age_s = EXCLUDED.fix_age_s`,
      [p.minute, p.serviceDate, p.ok, p.fail, p.seen, p.trams, p.fixAgeS],
    ).catch((e) => log.warn("advent", "jelenlét írása sikertelen", errMsg(e)));
  }

  async flush(): Promise<void> {
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    try {
      await sql(
        `INSERT INTO advent_ping (ts, vehicle_id, lat, lon, speed, bearing, service_date, season, polled_at, source, label, rt_trip_id, rt_route, route_short, headsign, glitch)
         SELECT to_timestamp(x.ts), x.v, x.lat, x.lon, x.speed, x.bearing, x.d::date, x.season, to_timestamp(x.polled), x.src, x.label, x.trip, x.rroute, x.route, x.head, x.glitch
           FROM unnest($1::float8[], $2::text[], $3::float8[], $4::float8[], $5::real[], $6::int2[], $7::text[], $8::int2[], $9::float8[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::bool[])
             AS x(ts, v, lat, lon, speed, bearing, d, season, polled, src, label, trip, rroute, route, head, glitch)
         ON CONFLICT DO NOTHING`,
        [
          batch.map((p) => p.ts),
          batch.map((p) => p.vehicleId),
          batch.map((p) => p.lat),
          batch.map((p) => p.lon),
          batch.map((p) => p.speed),
          batch.map((p) => (p.bearing == null ? null : Math.round(p.bearing))),
          batch.map((p) => p.serviceDate),
          batch.map((p) => p.season),
          batch.map((p) => p.polledAt),
          batch.map((p) => p.source),
          batch.map((p) => p.label),
          batch.map((p) => p.rtTripId),
          batch.map((p) => p.rtRoute),
          batch.map((p) => p.routeShort),
          batch.map((p) => p.headsign),
          batch.map((p) => p.glitch),
        ],
      );
    } catch (e) {
      this.stats.errors++;
      log.error("advent", `${batch.length} pont írása sikertelen  újrapróbálom`, errMsg(e));
      this.pending = batch.concat(this.pending).slice(-50_000);
    }
  }

  /** a mai nap élő elemzése (a többi villamossal és az adatforrás állapotával) */
  live(now = nowUnix()): AdventDay | null {
    const lc = this.line();
    if (!lc) return null;
    const iso = serviceClock(now).iso;
    const season = this.season(iso);
    const key = `${iso}|${this.today.pings.length}|${Math.floor(now / 5)}`;
    if (this.liveCache?.key === key) return this.liveCache.day;
    const feedOk = Date.now() - this.engine.positionsAt() < 60_000;
    const day = adventDay(season, dayPlan(season, iso), iso, lc.line, iso === this.today.iso ? this.today.pings : [], now, {
      feedOk,
      trams: this.lineTrams(now),
      cancelled: this.cancelledToday,
    });
    this.liveCache = { key, day };
    return day;
  }

  /** egy nap elemzése a tárolt pontokból (a mai napé élő) */
  async day(iso: string, now = nowUnix()): Promise<AdventDay | null> {
    if (iso === serviceClock(now).iso) return this.live(now);
    const lc = this.line();
    if (!lc) return null;
    const hit = this.dayCache.get(iso);
    if (hit && (hit.day.closed || now - hit.at < 60)) return hit.day;
    const season = seasonOn(iso) ?? this.season(iso);
    const [pings, cancelled] = await Promise.all([this.pingsOf(iso, season), this.cancelledOn(iso, season)]);
    const day = adventDay(season, dayPlan(season, iso), iso, lc.line, pings, now, { feedOk: null, cancelled });
    this.dayCache.set(iso, { at: now, day });
    if (this.dayCache.size > 120) this.dayCache.delete(this.dayCache.keys().next().value!);
    return day;
  }

  /** a nap pontjai: az advent_ping, és ha abban nincs semmi, a nyers veh_ping (a felvevő előtti napokra) */
  async pingsOf(iso: string, season: AdventSeason): Promise<AdventPing[]> {
    const rows = await sql<{ t: number; lat: number; lon: number; speed: number | null }>(
      `SELECT extract(epoch FROM ts)::float8 AS t, lat, lon, speed FROM advent_ping WHERE service_date = $1 AND vehicle_id = ANY($2) AND NOT glitch ORDER BY ts`,
      [iso, season.vehicleIds],
    );
    if (rows.length) return rows.map((r) => ({ ts: Math.round(r.t), lat: r.lat, lon: r.lon, speed: r.speed }));
    const from = serviceClock(Date.parse(`${iso}T12:00:00Z`) / 1000).midnightUnix + 3 * 3600;
    const raw = await sql<{ t: number; lat: number; lon: number; speed: number | null }>(
      `SELECT extract(epoch FROM ts)::float8 AS t, lat, lon, speed FROM veh_ping
        WHERE vehicle_id = ANY($1) AND ts >= to_timestamp($2) AND ts < to_timestamp($3) ORDER BY ts`,
      [season.vehicleIds, from, from + 86400],
    );
    return raw.map((r) => ({ ts: Math.round(r.t), lat: r.lat, lon: r.lon, speed: r.speed }));
  }

  /**
   * A nap visszajátszása: menetenként a menet irányának nyomvonalára vetített,
   * sosem visszalépő helyek (a menetek indexe a day.legs-szel azonos).
   */
  async replay(iso: string, now = nowUnix()): Promise<{ replay: DayReplay; closed: boolean } | null> {
    const lc = this.line();
    if (!lc) return null;
    const today = serviceClock(now).iso;
    // a lezárt nap pontjai már nem változnak; a mai a memóriában gyűlik
    const closed = iso < today;
    const hit = this.replayCache.get(iso);
    if (hit && (closed ? hit.closed : iso === today && hit.pings === this.today.pings.length && now - hit.at < 10)) return hit;
    const season = seasonOn(iso) ?? this.season(iso);
    const pings = iso !== today ? await this.pingsOf(iso, season) : iso === this.today.iso ? this.today.pings : [];
    const replay = replayDay(trackDay(lc.line, pings, now), { out: lc.out.shape, back: lc.back.shape });
    const entry = { at: now, pings: pings.length, closed, replay };
    this.replayCache.set(iso, entry);
    if (this.replayCache.size > 40) this.replayCache.delete(this.replayCache.keys().next().value!);
    return entry;
  }

  /** a nap nyers pontjai (visszanézéshez, exporthoz) */
  async track(iso: string) {
    return sql<{ t: number; v: string; lat: number; lon: number; speed: number | null; bearing: number | null; trip: string | null; route: string | null; label: string | null; glitch: boolean }>(
      `SELECT extract(epoch FROM ts)::float8 AS t, vehicle_id AS v, lat, lon, speed, bearing, rt_trip_id AS trip, route_short AS route, label, glitch
         FROM advent_ping WHERE service_date = $1 ORDER BY ts`,
      [iso],
    );
  }

  /** az évad napjai: a lezárt napok a tárolt összegzésből, a többi újraszámolva */
  async seasonDays(year: number, now = nowUnix()): Promise<{ season: AdventSeason; days: AdventDay[] } | null> {
    const season = seasonOf(year);
    if (!season) return null;
    const today = serviceClock(now).iso;
    const days: AdventDay[] = [];
    for (const iso of seasonDays(season)) {
      if (iso > today) break;
      const d = await this.day(iso, now);
      if (d) days.push(d);
    }
    return { season, days };
  }

  /** a lezárt napok összegzése az advent_day táblába (percenként hívva: csak az új vagy elavult napokat írja) */
  async finalize(now = nowUnix()): Promise<number> {
    const season = this.season();
    const today = serviceClock(now).iso;
    const stored = await sql<{ d: string; final: boolean; algo: string }>(`SELECT service_date::text AS d, final, algo FROM advent_day WHERE season = $1`, [season.year]);
    const done = new Map(stored.map((r) => [r.d, r]));
    let n = 0;
    for (const iso of seasonDays(season)) {
      if (iso > today) break;
      const prev = done.get(iso);
      if (prev?.final && prev.algo === ADVENT_ALGO) continue;
      const day = await this.day(iso, now);
      if (!day) continue;
      if (!day.closed && iso === today) continue;
      await sql(
        `INSERT INTO advent_day (service_date, season, verdict, summary, final, algo, computed_at) VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (service_date) DO UPDATE SET verdict = EXCLUDED.verdict, summary = EXCLUDED.summary, final = EXCLUDED.final, algo = EXCLUDED.algo, computed_at = now()`,
        [iso, season.year, day.verdict, JSON.stringify(summaryOf(day)), day.closed && iso < today, ADVENT_ALGO],
      );
      n++;
    }
    return n;
  }

  /**
   * A szerelvény mozgásállapota a térképi becsléshez, ha az illesztőnek nincs rá menete
   * (az ADV-menet nincs a betöltött feedben). Így a térkép ugyanazzal a sosem visszalépő
   * becsléssel viszi, mint a többi járművet.
   */
  motion(vehicleId: string, now = nowUnix()): VehicleMotion | null {
    const season = this.season();
    if (!season.vehicleIds.includes(vehicleId)) return null;
    const day = this.live(now);
    const lc = this.line();
    const last = this.today.pings[this.today.pings.length - 1];
    if (!day || !lc || !last || now - last.ts > 120) return null;
    // csak menet közben: álltában (végállomás, remíz) a valós helye a pontos, a becslés elvinné
    const trip = day.trips.find((t) => t.verdict === "running");
    const leg = trip?.leg != null ? day.legs[trip.leg] : null;
    if (!trip || !leg) return null;
    const dir = leg.dir;
    const ds = dir === "out" ? lc.out : lc.back;
    const proj = ds.shape.project(last.lat, last.lon);
    if (!proj || proj.distM > 80) return null;
    const order = stopOrder(season, trip.from);
    let k = 0;
    while (k < order.length && ds.stopAlong[order[k]] <= proj.alongM + 5) k++;
    if (k >= order.length || k === 0) return null;
    const a = order[k - 1];
    const b = order[k];
    const ids = (i: number) => (dir === "out" ? season.stops[i].out : season.stops[i].back);
    const sched = trip.stops;
    const midnight = serviceClock(trip.sched.dep).midnightUnix;
    const segS = sched[k].sched - sched[k - 1].sched;
    return {
      tripId: `advent:${day.iso}:${trip.key}`,
      shapeId: ds.id,
      alongM: Math.round(proj.alongM),
      ts: last.ts,
      fromStopId: ids(a),
      toStopId: ids(b),
      fromAlongM: Math.round(ds.stopAlong[a]),
      toAlongM: Math.round(ds.stopAlong[b]),
      schedSegS: segS > 0 ? segS : null,
      segDepS: sched[k - 1].sched - midnight,
      stopped: last.speed != null && last.speed <= 1,
    };
  }

  status() {
    return { ...this.stats, todayPings: this.today.pings.length, pending: this.pending.length, line: Boolean(this.lineCache) };
  }
}

/** a lezárt nap tárolt összegzése: minden, ami a nézetekhez kell, a GPS-pontok nélkül */
export function summaryOf(day: AdventDay) {
  return {
    ...day,
    legs: day.legs.map(({ fixes, ...l }) => ({ ...l, fixes: fixes.length })),
    etas: [],
  };
}

/** az MVK törölt menetei (valós idejű trip_id-k) → az évad menetkulcsai: az ADV-nyomvonalból az irány, az időből a perc */
function cancelledKeys(season: AdventSeason, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const [, shape, hms] = id.split("_");
    if (!hms || hms.length < 4) continue;
    if (shape === season.shapeIds.out) out.add(`T${hms.slice(0, 4)}`);
    else if (shape === season.shapeIds.back) out.add(`M${hms.slice(0, 4)}`);
  }
  return out;
}

/** az irány nyomvonala a feedből: az ADV-menet, ha van, különben az 1-es villamos teljes menete */
function dirShape(feed: Feed, season: AdventSeason, dir: "out" | "back"): DirShape | null {
  const first = dir === "out" ? season.stops[0].out : season.stops[season.stops.length - 1].back;
  const last = dir === "out" ? season.stops[season.stops.length - 1].out : season.stops[0].back;
  const own = dir === "out" ? season.shapeIds.out : season.shapeIds.back;
  let shapeId: string | null = feed.shapes.has(own) ? own : null;
  if (!shapeId)
    for (const [tripId, t] of feed.trips) {
      const st = feed.tripStops.get(tripId);
      if (!st?.length || st[0].stopId !== first || st[st.length - 1].stopId !== last || !feed.shapes.has(t.shapeId)) continue;
      shapeId = t.shapeId;
      break;
    }
  if (!shapeId) return null;
  const shape = feed.shapes.get(shapeId)!;
  const stopAlong = season.stops.map((s) => {
    const st = feed.stops.get(dir === "out" ? s.out : s.back);
    return st ? (shape.project(st.lat, st.lon)?.alongM ?? 0) : 0;
  });
  return { id: shapeId, shape, stopAlong };
}

