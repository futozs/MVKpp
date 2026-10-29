/**
 * GTFS-kezelés fallbackkel.
 *
 * - Félóránként letölti az MVK feedet; ha új, érvényesíti (üres / csonka feed
 *   → 'rejected', a régi marad érvényben), és eltárolja a zippel együtt.
 * - Napra pontosan feljegyzi, melyik menetrend volt érvényben (service_day),
 *   fallback esetén a sablon-nappal együtt.
 * - Ha egy napra nincs feed, a legfrissebb érvényes feed leghasonlóbb
 *   naptípusú napja lép életbe — így az app sosem áll le az MVK mulasztása
 *   miatt.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type Feed,
  type ServiceDay,
  feedFromFiles,
  feedFromZip,
  localMidnightUnix,
  resolveServiceDay,
  serviceClock,
  shiftIso,
  ymdToIso,
  dayInfo,
} from "@mvk/core";
import { getPool, sql } from "@mvk/db";
import { config } from "./config.ts";
import { errMsg, log } from "./log.ts";

type FeedRow = { id: number; version: string; sha256: string; fetched_at: Date };

const LOADED_MAX = 4;

export class FeedManager {
  /** betöltött, érvényes feedek (id → Feed) */
  private loaded = new Map<number, Feed>();
  private meta: FeedRow[] = [];
  private dayCache = new Map<string, ServiceDay | null>();
  private recorded = new Set<string>();
  lastCheck: { at: string; result: string } | null = null;

  async init(): Promise<void> {
    await this.reloadMeta();
    if (!this.meta.length) await this.bootstrap();
    // A két legfrissebb mindig a memóriában van (ma + fallback).
    for (const m of this.meta.slice(0, 2)) await this.load(m.id);
    const latest = this.latest();
    if (latest) log.info("gtfs", `aktív feed: ${latest.version} (${latest.trips.size} menet, ${latest.stops.size} megálló)`);
    else log.warn("gtfs", "nincs érvényes GTFS — az élő illesztés addig szünetel");
  }

  private async reloadMeta() {
    this.meta = await sql<FeedRow>(`SELECT id, version, sha256, fetched_at FROM gtfs_feed WHERE status = 'ok' ORDER BY version DESC, fetched_at DESC`);
  }

  private async load(id: number): Promise<Feed | null> {
    const hit = this.loaded.get(id);
    if (hit) return hit;
    const row = await sql<{ zip: Buffer }>(`SELECT zip FROM gtfs_feed WHERE id = $1`, [id]);
    if (!row[0]) return null;
    const feed = feedFromZip(new Uint8Array(row[0].zip));
    this.loaded.set(id, feed);
    // A legrégebben betöltött (de nem a két legfrissebb) feedet dobjuk.
    const keep = new Set(this.meta.slice(0, 2).map((m) => m.id));
    while (this.loaded.size > LOADED_MAX) {
      const victim = [...this.loaded.keys()].find((k) => !keep.has(k));
      if (victim == null) break;
      this.loaded.delete(victim);
    }
    return feed;
  }

  /** A legfrissebb érvényes feed. */
  latest(): Feed | null {
    const m = this.meta[0];
    return m ? (this.loaded.get(m.id) ?? null) : null;
  }

  latestMeta(): FeedRow | null {
    return this.meta[0] ?? null;
  }

  private async bootstrap() {
    const src = config.bootstrapGtfs;
    if (src && existsSync(src)) {
      const buf = statSync(src).isDirectory() ? null : readFileSync(src);
      const feed = buf ? feedFromZip(new Uint8Array(buf)) : feedFromDir(src);
      const zip = buf ?? Buffer.alloc(0);
      log.info("gtfs", `kezdő feed betöltése: ${src} (${feed.version})`);
      await this.store(feed, zip);
      await this.reloadMeta();
      return;
    }
    await this.refresh();
  }

  /** Letöltés + érvényesítés + tárolás. */
  async refresh(): Promise<string> {
    let result: string;
    try {
      const res = await fetch(config.gtfsUrl, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const zip = Buffer.from(await res.arrayBuffer());
      const feed = feedFromZip(new Uint8Array(zip));
      const known = await sql<{ id: number; status: string }>(`SELECT id, status FROM gtfs_feed WHERE sha256 = $1`, [feed.hash]);
      if (known[0]) result = `változatlan (${feed.version}, ${known[0].status})`;
      else {
        const status = await this.store(feed, zip);
        result = `új feed ${feed.version}: ${status}`;
        if (status === "ok") {
          await this.reloadMeta();
          this.loaded.set(this.meta.find((m) => m.sha256 === feed.hash)!.id, feed);
          this.dayCache.clear();
          this.recorded.clear();
          await this.warmToday();
        }
      }
    } catch (e) {
      result = `letöltés sikertelen: ${errMsg(e)}`;
      log.warn("gtfs", result);
    }
    this.lastCheck = { at: new Date().toISOString(), result };
    return result;
  }

  private async store(feed: Feed, zip: Buffer): Promise<"ok" | "rejected"> {
    const v = feed.validate(this.latest());
    const range = feed.serviceRange();
    const status = v.ok ? "ok" : "rejected";
    await getPool().query(
      `INSERT INTO gtfs_feed (version, sha256, start_date, end_date, first_service, last_service, n_stops, n_routes, n_trips, n_stop_times, status, validation, zip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (sha256) DO NOTHING`,
      [
        feed.version,
        feed.hash,
        feed.info.startDate ? ymdToIso(feed.info.startDate) : null,
        feed.info.endDate ? ymdToIso(feed.info.endDate) : null,
        range ? ymdToIso(range.from) : null,
        range ? ymdToIso(range.to) : null,
        v.counts.stops,
        v.counts.routes,
        v.counts.trips,
        v.counts.stopTimes,
        status,
        JSON.stringify(v),
        zip,
      ],
    );
    if (v.ok) await syncDimensions(feed);
    if (!v.ok) log.warn("gtfs", `ELUTASÍTOTT feed ${feed.version}: ${v.errors.join("; ")} — a korábbi menetrend marad érvényben`);
    else log.info("gtfs", `új érvényes feed ${feed.version} (${v.counts.trips} menet)`);
    return status;
  }

  /**
   * Az adott nap érvényes menetrendje. Múltbeli napra a service_day-ben
   * rögzített döntést veszi elő (ugyanaz a feed, ugyanaz a sablon-nap).
   */
  async serviceDay(iso: string): Promise<ServiceDay | null> {
    if (this.dayCache.has(iso)) return this.dayCache.get(iso)!;
    const today = serviceClock().iso;
    let day: ServiceDay | null = null;
    if (iso < today) {
      const rec = await sql<{ feed_id: number | null; fallback_template: string | null }>(
        `SELECT feed_id, fallback_template FROM service_day WHERE service_date = $1`,
        [iso],
      );
      if (rec[0]?.feed_id) {
        const feed = await this.load(rec[0].feed_id);
        if (feed) day = resolveServiceDay([feed], iso);
      }
    }
    if (!day) {
      const feeds: Feed[] = [];
      for (const m of this.meta.slice(0, LOADED_MAX)) {
        const f = await this.load(m.id);
        if (f) feeds.push(f);
      }
      day = resolveServiceDay(feeds, iso);
    }
    this.dayCache.set(iso, day);
    if (this.dayCache.size > 40) this.dayCache.delete(this.dayCache.keys().next().value!);
    if (day && iso >= today && !this.recorded.has(iso)) await this.record(day);
    return day;
  }

  /** Szinkron változat a forró úthoz (csak a már feloldott napokra). */
  cachedDay(iso: string): ServiceDay | null {
    return this.dayCache.get(iso) ?? null;
  }

  private async record(day: ServiceDay) {
    this.recorded.add(day.iso);
    const id = this.meta.find((m) => this.loaded.get(m.id) === day.feed)?.id ?? null;
    let nTrips = 0;
    for (const t of day.feed.trips.values()) if (day.services.has(t.serviceId)) nTrips++;
    await getPool().query(
      `INSERT INTO service_day (service_date, feed_id, feed_version, fallback_template, fallback_reason, n_trips)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (service_date) DO UPDATE SET feed_id = EXCLUDED.feed_id, feed_version = EXCLUDED.feed_version,
         fallback_template = EXCLUDED.fallback_template, fallback_reason = EXCLUDED.fallback_reason,
         n_trips = EXCLUDED.n_trips, decided_at = now()`,
      [day.iso, id, day.feed.version, day.fallback?.templateIso ?? null, day.fallback?.reason ?? null, nTrips],
    );
    if (day.fallback) log.warn("gtfs", `${day.iso}: nincs rá MVK-menetrend → FALLBACK a ${day.feed.version} feed ${day.fallback.templateIso}-i napjával`);
  }

  /** Az élő úthoz: a most érvényes szolgáltatási nap(ok) a referencia-éjféllel. */
  async warmToday(): Promise<void> {
    const c = serviceClock();
    for (const iso of [shiftIso(c.iso, -1), c.iso, shiftIso(c.iso, 1)]) await this.serviceDay(iso);
  }

  /** Illesztőnek: az időponthoz tartozó szolgáltatási nap + az előző (éjfél utáni menetek). */
  daysAt(ts: number): { day: ServiceDay; midnightUnix: number }[] {
    const iso = serviceClock(ts).iso;
    const out: { day: ServiceDay; midnightUnix: number }[] = [];
    for (const d of [iso, shiftIso(iso, -1)]) {
      const day = this.cachedDay(d);
      if (day) out.push({ day, midnightUnix: localMidnightUnix(d) });
    }
    return out;
  }

  /** Megállófigyelőnek: a mostani és a következő szolgáltatási nap. */
  arrivalDays(ts: number): { day: ServiceDay; midnightUnix: number }[] {
    const iso = serviceClock(ts).iso;
    const out: { day: ServiceDay; midnightUnix: number }[] = [];
    for (const d of [iso, shiftIso(iso, 1)]) {
      const day = this.cachedDay(d);
      if (day) out.push({ day, midnightUnix: localMidnightUnix(d) });
    }
    return out;
  }

  status() {
    const f = this.latest();
    return {
      feedVersion: f?.version ?? null,
      feeds: this.meta.length,
      loaded: [...this.loaded.values()].map((x) => x.version),
      lastCheck: this.lastCheck,
      today: (() => {
        const d = this.cachedDay(serviceClock().iso);
        return d ? { feedVersion: d.feed.version, fallback: d.fallback } : null;
      })(),
    };
  }

  /** A zip nyersen (a /MVK_mobilapp/GTFS/MVK_GTFS.zip kompatibilitási útvonalhoz). */
  async latestZip(): Promise<Buffer | null> {
    const m = this.meta[0];
    if (!m) return null;
    const r = await sql<{ zip: Buffer }>(`SELECT zip FROM gtfs_feed WHERE id = $1`, [m.id]);
    return r[0]?.zip?.length ? r[0].zip : null;
  }
}

function feedFromDir(dir: string): Feed {
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.endsWith(".txt")) files[f] = readFileSync(join(dir, f), "utf8");
  return feedFromFiles(files);
}

/** A stabil dimenziótáblák (stop, route, calendar_day) frissítése egy feedből. */
export async function syncDimensions(feed: Feed): Promise<void> {
  const range = feed.serviceRange();
  const from = range ? ymdToIso(range.from) : serviceClock().iso;
  const to = range ? ymdToIso(range.to) : from;
  const stops = [...feed.stops.values()];
  if (stops.length) {
    await getPool().query(
      `INSERT INTO stop (stop_id, code, name, lat, lon, first_seen, last_seen)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::float8[], $6::date[], $7::date[])
       ON CONFLICT (stop_id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
         last_seen = GREATEST(stop.last_seen, EXCLUDED.last_seen), first_seen = LEAST(stop.first_seen, EXCLUDED.first_seen)`,
      [stops.map((s) => s.id), stops.map((s) => s.code || null), stops.map((s) => s.name), stops.map((s) => s.lat), stops.map((s) => s.lon), stops.map(() => from), stops.map(() => to)],
    );
  }
  const routes = [...feed.routes.values()];
  if (routes.length) {
    await getPool().query(
      `INSERT INTO route (route_short, gtfs_route_id, long_name, kind, color, text_color, first_seen, last_seen)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::date[], $8::date[])
       ON CONFLICT (route_short) DO UPDATE SET gtfs_route_id = EXCLUDED.gtfs_route_id, long_name = EXCLUDED.long_name,
         kind = EXCLUDED.kind, color = EXCLUDED.color, text_color = EXCLUDED.text_color,
         last_seen = GREATEST(route.last_seen, EXCLUDED.last_seen), first_seen = LEAST(route.first_seen, EXCLUDED.first_seen)`,
      [
        routes.map((r) => r.short),
        routes.map((r) => r.id),
        routes.map((r) => r.long || null),
        routes.map((r) => (feed.isTram(r.id) ? "TRAM" : "BUS")),
        routes.map((r) => r.color),
        routes.map((r) => r.text),
        routes.map(() => from),
        routes.map(() => to),
      ],
    );
  }
  await ensureCalendar(shiftIso(from, -400), 800);
}

export async function ensureCalendar(fromIso: string, days: number): Promise<void> {
  const rows = Array.from({ length: days }, (_, i) => dayInfo(shiftIso(fromIso, i)));
  await getPool().query(
    `INSERT INTO calendar_day (service_date, dow, daytype, school, holiday)
     SELECT * FROM unnest($1::date[], $2::int2[], $3::int2[], $4::bool[], $5::text[])
     ON CONFLICT (service_date) DO UPDATE SET dow = EXCLUDED.dow, daytype = EXCLUDED.daytype, school = EXCLUDED.school, holiday = EXCLUDED.holiday`,
    [rows.map((r) => r.iso), rows.map((r) => r.dow), rows.map((r) => r.daytype), rows.map((r) => r.school), rows.map((r) => r.holiday)],
  );
}
