/**
 * A regionális (Volán + vasút) menetrend szolgáltatási naponként.
 *
 * Az OTP2-ből GTFS-t építünk (core `regionalGtfsForDay`), zipként eltesszük a
 * `gtfs_feed` táblába (`source = 'regional'`, `service_date`), és ugyanaz a
 * `Feed` olvassa be, mint az MVK-ét. A FeedManager szolgáltatási naponként
 * összefésüli a kettőt, így az illesztő, a megállófigyelő, a menetrend és a
 * statisztika egy feedet lát.
 *
 * Kíméletesen kérdezünk: a megyét érintő mintákat naponta egyszer derítjük fel,
 * a minták adatát (nyomvonal, megállók) az `otp_pattern` táblában tartjuk, és
 * csak az újakat kérjük le; a menetek mintánként 60-as kötegekben jönnek.
 */
import { strToU8, zipSync } from "fflate";
import {
  type Feed,
  feedFromZip,
  inRegion,
  isoToYmd,
  type OtpDayTrips,
  type OtpPattern,
  type OtpTrip,
  REGION_BBOX,
  regionalGtfsForDay,
  stalePatterns,
  serviceClock,
  shiftIso,
} from "@mvk/core";
import { getPool, sql } from "@mvk/db";
import { config } from "../config.ts";
import { errMsg, log } from "../log.ts";
import { otp2 } from "../otp2/client.ts";
import { patternDetails, patternTrips, STOPS_IN_BBOX } from "../otp2/queries.ts";

const DETAIL_BATCH = 30;
const TRIPS_BATCH = 60;
/** a kliens úgyis sorban küld (a MÁV+ korlátja miatt): ennyi kérés vár egyszerre a sorban */
const PARALLEL = 2;
/** a minták adatát ennyi nap után frissítjük */
const PATTERN_TTL_DAYS = 7;
/** egy nap letöltött menetei ennyi ideig jók (a MÁV napközben is ad hozzá vonatot, terelést) */
const OTP_DAY_TTL_MS = 6 * 3600_000;
/** a megye mintáinak felderítése ennyi ideig jó */
const DISCOVER_TTL_MS = 20 * 3600_000;
const LOADED_MAX = 6;
/** állandó dátum a zipben: ugyanaz a menetrend ugyanazt a hash-t adja (nem tároljuk kétszer) */
const ZIP_MTIME = new Date(Date.UTC(2000, 0, 1));

type DayEntry = { id: number; feed: Feed; version: string };

export type RegionalBuildInfo = { iso: string; at: string; ok: boolean; result: string; ms: number; counts?: Record<string, number> };

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export class RegionalFeeds {
  private loaded = new Map<string, DayEntry>();
  private building = new Map<string, Promise<DayEntry | null>>();
  private patternCodes: { at: number; codes: string[] } | null = null;
  private otpDays = new Map<string, { at: number; day: OtpDayTrips }>();
  private listeners: ((iso: string) => void)[] = [];
  lastBuild: RegionalBuildInfo | null = null;
  builds: RegionalBuildInfo[] = [];

  get enabled(): boolean {
    return config.otp2.enabled && config.otp2.regional;
  }

  /** Új regionális nap lett érvényes (a FeedManager ilyenkor újrafésüli azt a napot). */
  onUpdate(fn: (iso: string) => void) {
    this.listeners.push(fn);
  }

  /** Indításkor: a tegnapi, mai, holnapi nap az adatbázisból; ami hiányzik, a háttérben épül. */
  async init(): Promise<void> {
    if (!this.enabled) return;
    const c = serviceClock();
    for (const iso of [shiftIso(c.iso, -1), c.iso, shiftIso(c.iso, 1)]) await this.load(iso);
    void this.ensureAhead().catch((e) => log.warn("regional", "kezdő építés sikertelen", errMsg(e)));
  }

  /** A már betöltött nap (forró úthoz, szinkron). */
  cached(iso: string): Feed | null {
    return this.loaded.get(iso)?.feed ?? null;
  }

  cachedEntry(iso: string): { id: number; version: string } | null {
    const e = this.loaded.get(iso);
    return e ? { id: e.id, version: e.version } : null;
  }

  /** Egy nap feedje: memóriából, adatbázisból, vagy (ha kell és lehet) építve. */
  async feedFor(iso: string, opts: { build?: boolean; feedId?: number | null } = {}): Promise<Feed | null> {
    if (!this.enabled) return null;
    const hit = this.loaded.get(iso);
    if (hit && (!opts.feedId || hit.id === opts.feedId)) return hit.feed;
    const fromDb = await this.load(iso, opts.feedId ?? null);
    if (fromDb) return fromDb;
    if (!opts.build) return null;
    const built = await this.build(iso);
    return built?.feed ?? null;
  }

  private async load(iso: string, feedId: number | null = null): Promise<Feed | null> {
    const row = feedId
      ? await sql<{ id: number; version: string; zip: Buffer }>(`SELECT id, version, zip FROM gtfs_feed WHERE id = $1 AND source = 'regional'`, [feedId])
      : await sql<{ id: number; version: string; zip: Buffer }>(
          `SELECT id, version, zip FROM gtfs_feed WHERE source = 'regional' AND status = 'ok' AND service_date = $1 ORDER BY fetched_at DESC LIMIT 1`,
          [iso],
        );
    if (!row[0]) return null;
    try {
      const feed = feedFromZip(new Uint8Array(row[0].zip));
      this.remember(iso, { id: row[0].id, feed, version: row[0].version });
      return feed;
    } catch (e) {
      log.warn("regional", `${iso}: a tárolt feed nem olvasható`, errMsg(e));
      return null;
    }
  }

  private remember(iso: string, e: DayEntry) {
    this.loaded.set(iso, e);
    // A tegnap/ma/holnap mindig bent marad; a menetrend-böngészés napjai közül a legrégebbi megy.
    const today = serviceClock().iso;
    const pinned = new Set([shiftIso(today, -1), today, shiftIso(today, 1)]);
    while (this.loaded.size > LOADED_MAX) {
      const victim = [...this.loaded.keys()].find((k) => !pinned.has(k));
      if (!victim) break;
      this.loaded.delete(victim);
    }
  }

  /** A mai naptól `daysAhead` napig: ami nincs meg, felépül. Éjszaka és indításkor fut. */
  async ensureAhead(force = false): Promise<void> {
    if (!this.enabled) return;
    const today = serviceClock().iso;
    // Kényszerített újraépítés (éjszaka, a hubból): friss felderítés és friss menetek, nem a gyorsítótár.
    if (force) {
      this.patternCodes = null;
      this.otpDays.clear();
    }
    for (let i = 0; i <= config.otp2.daysAhead; i++) {
      const iso = shiftIso(today, i);
      const have = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM gtfs_feed WHERE source = 'regional' AND status = 'ok' AND service_date = $1`, [iso]);
      if (!force && (have[0]?.n ?? 0) > 0 && this.loaded.has(iso)) continue;
      if (!force && (have[0]?.n ?? 0) > 0) {
        await this.load(iso);
        continue;
      }
      await this.build(iso);
    }
    // a következő napok OTP-meneteire már nincs szükség
    for (const ymd of this.otpDays.keys()) if (ymd < isoToYmd(shiftIso(today, -1))) this.otpDays.delete(ymd);
    await this.pruneSuperseded();
  }

  /**
   * Napi kétszeri frissítésnél egy napnak több változata is születhet (~6 MB zip mindegyik):
   * a napból a legújabb marad, és amelyikre a service_day hivatkozik (a múltbeli napok menetrendje).
   */
  private async pruneSuperseded(): Promise<void> {
    const gone = await sql<{ id: number }>(
      `DELETE FROM gtfs_feed g
        WHERE g.source = 'regional'
          AND EXISTS (SELECT 1 FROM gtfs_feed n WHERE n.source = 'regional' AND n.service_date = g.service_date AND n.id > g.id)
          AND NOT EXISTS (SELECT 1 FROM service_day d WHERE d.regional_feed_id = g.id)
        RETURNING id`,
    ).catch((e) => {
      log.warn("regional", "a régi változatok törlése sikertelen", errMsg(e));
      return [];
    });
    if (gone.length) log.info("regional", `${gone.length} felülírt regionális menetrend-változat törölve`);
  }

  /** Egy szolgáltatási nap felépítése (párhuzamos kérésre ugyanazt az ígéretet adja). */
  build(iso: string): Promise<DayEntry | null> {
    const cur = this.building.get(iso);
    if (cur) return cur;
    const p = this.doBuild(iso).finally(() => this.building.delete(iso));
    this.building.set(iso, p);
    return p;
  }

  private async doBuild(iso: string): Promise<DayEntry | null> {
    const t0 = Date.now();
    const info: RegionalBuildInfo = { iso, at: new Date().toISOString(), ok: false, result: "", ms: 0 };
    try {
      const codes = await this.discover();
      const patterns = await this.patterns(codes);
      const ymd = isoToYmd(iso);
      const nextYmd = isoToYmd(shiftIso(iso, 1));
      const same = await this.otpDay(ymd, [...patterns.keys()]);
      const next = await this.otpDay(nextYmd, [...patterns.keys()]);
      // A mintakód sorszám: egy menetrend-frissítés után a tárolt minta már más megállósort
      // írhat le (így tűntek el a 3765 expresszjáratai). Amire a nap menetei nem illenek, újra letöltjük.
      const stale = stalePatterns(patterns, [same, next]);
      if (stale.length) {
        log.info("regional", `${iso}: ${stale.length} elavult minta újratöltése (${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", …" : ""})`);
        await this.fetchPatterns(stale, patterns);
      }
      const n = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM gtfs_feed WHERE source = 'regional' AND service_date = $1`, [iso]))[0]?.n ?? 0;
      const version = `R${ymd}-${n + 1}`;
      const gtfs = regionalGtfsForDay(iso, patterns, same, next, version);
      info.counts = gtfs.counts;
      if (!gtfs.counts.trips) throw new Error("egyetlen menet sem jött az OTP2-től erre a napra");
      const zip = Buffer.from(zipSync(Object.fromEntries(Object.entries(gtfs.files).map(([k, v]) => [k, strToU8(v)])), { level: 6, mtime: ZIP_MTIME }));
      const feed = feedFromZip(new Uint8Array(zip));
      const v = feed.validate();
      // Ugyanaz a tartalom (a hash a zipé): nem tároljuk újra, a meglévő marad  de egy korábban
      // elutasított tartalom most sem mehet át csendben.
      const known = await sql<{ id: number; status: string }>(`SELECT id, status FROM gtfs_feed WHERE sha256 = $1`, [feed.hash]);
      if (known[0] && known[0].status !== "ok") throw new Error(`elutasítva (ugyanez a tartalom korábban is): ${v.errors.join("; ") || "érvénytelen"}`);
      let id = known[0]?.id ?? 0;
      if (!id) {
        const range = feed.serviceRange();
        const ins = await sql<{ id: number }>(
          `INSERT INTO gtfs_feed (version, sha256, start_date, end_date, first_service, last_service, n_stops, n_routes, n_trips, n_stop_times, status, validation, zip, source, service_date)
           VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, 'regional', $3) RETURNING id`,
          [version, feed.hash, iso, range ? iso : null, v.counts.stops, v.counts.routes, v.counts.trips, v.counts.stopTimes, v.ok ? "ok" : "rejected", JSON.stringify(v), zip],
        );
        id = ins[0].id;
        if (!v.ok) throw new Error(`elutasítva: ${v.errors.join("; ")}`);
        const { syncDimensions } = await import("../feeds.ts");
        await syncDimensions(feed);
      }
      const entry = { id, feed, version: known[0] ? (this.loaded.get(iso)?.version ?? version) : version };
      this.remember(iso, entry);
      info.ok = true;
      info.result = `${gtfs.counts.trips} menet, ${gtfs.counts.routes} vonal, ${gtfs.counts.stops} megálló${known[0] ? " (változatlan)" : ""}`;
      log.info("regional", `${iso}: ${info.result} (${Math.round((Date.now() - t0) / 1000)} mp)`);
      for (const fn of this.listeners) fn(iso);
      return entry;
    } catch (e) {
      info.result = errMsg(e);
      log.warn("regional", `${iso}: építés sikertelen  ${info.result}`);
      return null;
    } finally {
      info.ms = Date.now() - t0;
      this.lastBuild = info;
      this.builds = [info, ...this.builds].slice(0, 20);
    }
  }

  /** A megyét érintő minták kódjai (naponta egyszer). */
  private async discover(): Promise<string[]> {
    if (this.patternCodes && Date.now() - this.patternCodes.at < DISCOVER_TTL_MS) return this.patternCodes.codes;
    const b = REGION_BBOX;
    const data = await otp2.query<{ stopsByBbox: { gtfsId: string; lat: number; lon: number; patterns: { code: string }[] | null }[] }>(
      "stopsByBbox",
      STOPS_IN_BBOX,
      { a: b.minLat, b: b.minLon, c: b.maxLat, d: b.maxLon },
      { timeoutMs: 60_000, priority: "low" },
    );
    const codes = new Set<string>();
    for (const s of data.stopsByBbox) {
      if (!inRegion(s.lat, s.lon)) continue;
      // Az MVK a saját GTFS-éből jön; a `::rt#…` minták a valós idejű módosításokból születnek
      // (kódjuk alapján nem kérdezhetők le, a menetük a menetrendi mintán megvan).
      for (const p of s.patterns ?? []) if (!p.code.startsWith("mvkzrt:") && !p.code.includes("rt#")) codes.add(p.code);
    }
    this.patternCodes = { at: Date.now(), codes: [...codes].sort() };
    return this.patternCodes.codes;
  }

  /** A minták adata: az adatbázisból, a hiányzókat / régieket az OTP2-ből. */
  private async patterns(codes: string[]): Promise<Map<string, OtpPattern>> {
    const out = new Map<string, OtpPattern>();
    const rows = await sql<{ code: string; data: OtpPattern; fresh: boolean }>(
      `SELECT code, data, fetched_at > now() - make_interval(days => $2) AS fresh FROM otp_pattern WHERE code = ANY($1::text[])`,
      [codes, PATTERN_TTL_DAYS],
    );
    for (const r of rows) out.set(r.code, r.data);
    const missing = codes.filter((c) => !rows.some((r) => r.code === c && r.fresh));
    if (missing.length) {
      log.info("regional", `minták letöltése: ${missing.length} (${codes.length} közül)`);
      await this.fetchPatterns(missing, out);
    }
    // A régióból kikerült minták nem kellenek (a kódlista a mai felderítés).
    for (const c of [...out.keys()]) if (!codes.includes(c)) out.delete(c);
    return out;
  }

  /** A minták adata az OTP2-ből (a `into` térképbe és az adatbázisba). */
  private async fetchPatterns(codes: string[], into: Map<string, OtpPattern>): Promise<void> {
    await pool(chunks(codes, DETAIL_BATCH), PARALLEL, async (batch) => {
      type Raw = Omit<OtpPattern, "points"> & { patternGeometry?: { points: string } | null };
      const data = await otp2.query<Record<string, Raw | null>>("patternDetails", patternDetails(batch), {}, { timeoutMs: 60_000, priority: "low" });
      const fresh: OtpPattern[] = [];
      for (const raw of Object.values(data)) {
        if (!raw) continue;
        const { patternGeometry, ...rest } = raw;
        const p: OtpPattern = { ...rest, points: patternGeometry?.points ?? null };
        into.set(p.code, p);
        fresh.push(p);
      }
      if (fresh.length) {
        await getPool().query(
          `INSERT INTO otp_pattern (code, data, fetched_at) SELECT c, d, now() FROM unnest($1::text[], $2::jsonb[]) AS x(c, d)
           ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`,
          [fresh.map((p) => p.code), fresh.map((p) => JSON.stringify(p))],
        );
      }
    });
  }

  /** Egy OTP-szolgáltatási nap menetei mintánként (memóriában, a szomszédos napok építése újrahasználja). */
  private async otpDay(ymd: string, codes: string[]): Promise<OtpDayTrips> {
    const hit = this.otpDays.get(ymd);
    if (hit && Date.now() - hit.at < OTP_DAY_TTL_MS) return hit.day;
    const byPattern: Record<string, OtpTrip[]> = {};
    await pool(chunks(codes, TRIPS_BATCH), PARALLEL, async (batch) => {
      const data = await otp2.query<Record<string, { code: string; tripsForDate: OtpTrip[] | null } | null>>("patternTrips", patternTrips(batch, ymd), {}, {
        timeoutMs: 60_000,
        priority: "low",
      });
      for (const p of Object.values(data)) if (p?.tripsForDate?.length) byPattern[p.code] = p.tripsForDate;
    });
    const day = { ymd, byPattern };
    this.otpDays.set(ymd, { at: Date.now(), day });
    return day;
  }

  status() {
    return {
      enabled: this.enabled,
      patterns: this.patternCodes?.codes.length ?? null,
      loaded: [...this.loaded.entries()].map(([iso, e]) => ({ iso, version: e.version, trips: e.feed.trips.size })),
      building: [...this.building.keys()],
      lastBuild: this.lastBuild,
    };
  }
}
