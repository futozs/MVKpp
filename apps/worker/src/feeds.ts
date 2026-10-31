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
  Feed,
  type ServiceDay,
  isMvkId,
  modeOfRoute,
  operatorLabel,
  feedFromFiles,
  feedFromZip,
  localMidnightUnix,
  resolveServiceDay,
  serviceClock,
  shiftIso,
  ymdToIso,
  dayInfo,
  isoToYmd,
} from "@mvk/core";
import { getPool, sql } from "@mvk/db";
import { config } from "./config.ts";
import { errMsg, log } from "./log.ts";
import type { RegionalFeeds } from "./regional/feeds.ts";

type FeedRow = { id: number; version: string; sha256: string; fetched_at: Date };

const LOADED_MAX = 4;
const COMPOSED_MAX = 8;

export class FeedManager {
  /** betöltött, érvényes feedek (id → Feed) */
  private loaded = new Map<number, Feed>();
  private meta: FeedRow[] = [];
  private dayCache = new Map<string, ServiceDay | null>();
  /** új feed betöltése közben a korábbi napok (hogy addig se maradjon üresen az élő motor) */
  private warming: Map<string, ServiceDay | null> | null = null;
  private recorded = new Set<string>();
  /** MVK + regionális kompozitok (`mvkHash|regHash` → Feed): a napok ugyanazt a példányt kapják */
  private composed = new Map<string, Feed>();
  readonly regional: RegionalFeeds | null;
  lastCheck: { at: string; result: string } | null = null;

  constructor(regional: RegionalFeeds | null = null) {
    this.regional = regional;
    // Új regionális nap: azt az egy napot fésüljük újra (csere, nem ürítés — közben a régi él).
    regional?.onUpdate((iso) => {
      if (!this.dayCache.has(iso)) return;
      this.dayCache.delete(iso);
      this.recorded.delete(iso);
      void this.serviceDay(iso).catch((e) => log.warn("gtfs", `${iso}: újrafésülés sikertelen`, errMsg(e)));
    });
  }

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
    this.meta = await sql<FeedRow>(`SELECT id, version, sha256, fetched_at FROM gtfs_feed WHERE status = 'ok' AND source = 'mvk' ORDER BY version DESC, fetched_at DESC`);
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
          // Csere, nem ürítés: a betöltés alatt az illesztő és a megállófigyelő a régi napokkal dolgozik tovább.
          const prev = this.dayCache;
          this.dayCache = new Map();
          this.recorded.clear();
          this.warming = prev;
          try {
            await this.warmToday();
          } finally {
            this.warming = null;
          }
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
    let regionalId: number | null = null;
    if (iso < today) {
      const rec = await sql<{ feed_id: number | null; fallback_template: string | null; regional_feed_id: number | null }>(
        `SELECT feed_id, fallback_template, regional_feed_id FROM service_day WHERE service_date = $1`,
        [iso],
      );
      regionalId = rec[0]?.regional_feed_id ?? null;
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
    day = await this.withRegional(day, iso, regionalId);
    this.dayCache.set(iso, day);
    // A tegnap/ma/holnap sosem eshet ki: a menetrend-lekérdezések (?date=) nem szoríthatják ki az élő motor napjait.
    if (this.dayCache.size > 40) {
      const pinned = new Set([shiftIso(today, -1), today, shiftIso(today, 1)]);
      const victim = [...this.dayCache.keys()].find((k) => !pinned.has(k));
      if (victim) this.dayCache.delete(victim);
    }
    // Csak a mai és a holnapi döntést rögzítjük (egy távoli jövőbeli kérés ne írjon a service_day-be).
    if (day && (iso === today || iso === shiftIso(today, 1)) && !this.recorded.has(iso)) await this.record(day);
    return day;
  }

  /**
   * Az MVK-nap + a regionális (Volán, vasút) nap egy közös nézetben. A régi napot
   * a service_day-ben rögzített regionális feeddel; a mostaniakat a legfrissebbel.
   * Ha nincs regionális adat (kikapcsolva, még épül), a nap MVK-only — mint eddig.
   */
  private async withRegional(day: ServiceDay | null, iso: string, feedId: number | null): Promise<ServiceDay | null> {
    const reg = this.regional ? await this.regional.feedFor(iso, { feedId }).catch(() => null) : null;
    if (!reg) return day;
    const ymd = isoToYmd(iso);
    if (!day) {
      const only = resolveServiceDay([reg], iso);
      return only && !only.fallback ? only : null;
    }
    const key = `${day.feed.hash}|${reg.hash}`;
    let feed = this.composed.get(key);
    if (!feed) {
      feed = Feed.compose([day.feed, reg]);
      this.composed.set(key, feed);
      while (this.composed.size > COMPOSED_MAX) this.composed.delete(this.composed.keys().next().value as string);
    }
    return { ...day, feed, services: new Set([...day.services, ...reg.activeServices(ymd)]) };
  }

  /** Szinkron változat a forró úthoz (csak a már feloldott napokra). */
  cachedDay(iso: string): ServiceDay | null {
    return this.dayCache.get(iso) ?? this.warming?.get(iso) ?? null;
  }

  private async record(day: ServiceDay) {
    this.recorded.add(day.iso);
    const mvkVersion = day.feed.version.split("+")[0];
    const id = this.meta.find((m) => m.version === mvkVersion && this.loaded.has(m.id))?.id ?? null;
    let nTrips = 0;
    let nRegional = 0;
    for (const t of day.feed.trips.values()) {
      if (!day.services.has(t.serviceId)) continue;
      if (isMvkId(t.id)) nTrips++;
      else nRegional++;
    }
    const reg = this.regional?.cachedEntry(day.iso) ?? null;
    await getPool().query(
      `INSERT INTO service_day (service_date, feed_id, feed_version, fallback_template, fallback_reason, n_trips, regional_feed_id, regional_trips)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (service_date) DO UPDATE SET feed_id = EXCLUDED.feed_id, feed_version = EXCLUDED.feed_version,
         fallback_template = EXCLUDED.fallback_template, fallback_reason = EXCLUDED.fallback_reason,
         n_trips = EXCLUDED.n_trips, regional_feed_id = COALESCE(EXCLUDED.regional_feed_id, service_day.regional_feed_id),
         regional_trips = COALESCE(EXCLUDED.regional_trips, service_day.regional_trips), decided_at = now()`,
      [day.iso, id, mvkVersion, day.fallback?.templateIso ?? null, day.fallback?.reason ?? null, nTrips, reg?.id ?? null, reg ? nRegional : null],
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
  // A regionális feedben a közös MVK-megállók is benne vannak (a Volán ott is megáll): azokat az MVK feedje írja.
  const regional = feed.version.startsWith("R");
  const stops = [...feed.stops.values()].filter((s) => !regional || !isMvkId(s.id));
  const stopMode = (id: string) => (isMvkId(id) ? null : id.startsWith("1:") ? "rail" : "coach");
  if (stops.length) {
    await getPool().query(
      `INSERT INTO stop (stop_id, code, name, lat, lon, first_seen, last_seen, parent_station, platform, mode)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::float8[], $6::date[], $7::date[], $8::text[], $9::text[], $10::text[])
       ON CONFLICT (stop_id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
         parent_station = EXCLUDED.parent_station, platform = EXCLUDED.platform, mode = EXCLUDED.mode,
         last_seen = GREATEST(stop.last_seen, EXCLUDED.last_seen), first_seen = LEAST(stop.first_seen, EXCLUDED.first_seen)`,
      [
        stops.map((s) => s.id),
        stops.map((s) => s.code || null),
        stops.map((s) => s.name),
        stops.map((s) => s.lat),
        stops.map((s) => s.lon),
        stops.map(() => from),
        stops.map(() => to),
        stops.map((s) => s.parent ?? null),
        stops.map((s) => s.platform ?? null),
        stops.map((s) => stopMode(s.id)),
      ],
    );
  }
  const routes = [...feed.routes.values()];
  if (routes.length) {
    await getPool().query(
      `INSERT INTO route (route_short, gtfs_route_id, long_name, kind, color, text_color, first_seen, last_seen, short_name, operator)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::date[], $8::date[], $9::text[], $10::text[])
       ON CONFLICT (route_short) DO UPDATE SET gtfs_route_id = EXCLUDED.gtfs_route_id, long_name = EXCLUDED.long_name,
         kind = EXCLUDED.kind, color = EXCLUDED.color, text_color = EXCLUDED.text_color,
         short_name = EXCLUDED.short_name, operator = EXCLUDED.operator,
         last_seen = GREATEST(route.last_seen, EXCLUDED.last_seen), first_seen = LEAST(route.first_seen, EXCLUDED.first_seen)`,
      [
        routes.map((r) => r.key),
        routes.map((r) => r.id),
        routes.map((r) => r.long || null),
        routes.map((r) => modeOfRoute(r.id, r.type).toUpperCase()),
        routes.map((r) => r.color),
        routes.map((r) => r.text),
        routes.map(() => from),
        routes.map(() => to),
        routes.map((r) => r.short),
        routes.map((r) => operatorLabel(r.agencyName)),
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
