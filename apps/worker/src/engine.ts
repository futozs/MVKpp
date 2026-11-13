/**
 * Az élő motor: MVK-pollozás → snapshot → illesztő → adatbázis + események.
 *
 * Egyszálú, egyetlen ciklus: nincs párhuzamos lezáró vagy illesztő folyamat,
 * ami versenyhelyzetet okozhatna. Minden változás eseményként megy tovább a
 * WebSocket-hubnak, így a kliensek a dekódolás pillanatában látják.
 */
import { EventEmitter } from "node:events";
import {
  buildSnapshot,
  isMvkId,
  nowUnix,
  resolveTrip,
  serviceClock,
  TripMatcher,
  type RealtimeSnapshot,
  type RtVehicle,
  type RunOut,
  type StopEventOut,
} from "@mvk/core";
import { getPool } from "@mvk/db";
import { config } from "./config.ts";
import type { FeedManager } from "./feeds.ts";
import { errMsg, log } from "./log.ts";
import { mvkFetch, parseCancelledIds } from "./mvk.ts";
import { Persister } from "./persist.ts";
import type { RegionalRealtime } from "./regional/realtime.ts";
import { SourceManager } from "./sources.ts";
import { tokenStatus } from "./token.ts";

export type EngineEvents = {
  tick: [RealtimeSnapshot];
  run: [RunOut];
  stopEvent: [StopEventOut, RunOut];
  atStop: [RunOut, number, number];
  cancelled: [Set<string>];
  /** egy jármű jele az illesztő után (élesben és az indításkori visszajátszáskor is): jármű, idő (unix), GPS-sebesség */
  fix: [string, number, number | null];
};

/** ennél hosszabb szünet a sikeres pozíció-lekérések között kiesésnek számít (ms) */
const FEED_GAP_MS = 60_000;
/** éjfél után ennyi ideig még a tegnapi törléslista jöhet vissza (mp) */
const CANCELLED_SETTLE_S = 180;
/** a régi MVK-adatot legfeljebb ennyi ideig visszük tovább egy-egy hibás poll után (ms) */
const KEEP_OLD_MS = 60_000;
/** az árnyék-összevetés napi mintájának mérete */
const SHADOW_SAMPLES = 50_000;

const EMPTY: RealtimeSnapshot = {
  fetchedAt: 0,
  header: { version: "", timestamp: 0 },
  decoded: [],
  vehicles: [],
  predByStop: new Map(),
  updatesHeaderTs: 0,
  updatesCount: 0,
  rtError: "még nincs adat",
};

export type WeatherData = { tempC: number | null; feelsLikeC: number | null; windKmh: number | null; code: number; text: string; at: string };

const WMO: Record<number, string> = {
  0: "Derült", 1: "Túlnyomóan derült", 2: "Részben felhős", 3: "Borult", 45: "Köd", 48: "Zúzmarás köd",
  51: "Gyenge szitálás", 53: "Szitálás", 55: "Erős szitálás", 56: "Ónos szitálás", 57: "Erős ónos szitálás",
  61: "Gyenge eső", 63: "Eső", 65: "Erős eső", 66: "Ónos eső", 67: "Erős ónos eső",
  71: "Gyenge havazás", 73: "Havazás", 75: "Erős havazás", 77: "Hószemcsék",
  80: "Záporok", 81: "Erős záporok", 82: "Felhőszakadás", 85: "Hózáporok", 86: "Erős hózáporok",
  95: "Zivatar", 96: "Zivatar jégesővel", 99: "Heves zivatar jégesővel",
};

export class Engine extends EventEmitter<EngineEvents> {
  snapshot: RealtimeSnapshot = EMPTY;
  readonly feeds: FeedManager;
  readonly matcher: TripMatcher;
  readonly persister = new Persister("live");
  /** a MÁV+ OTP2: a Volán és a vasút, és az MVK tartaléka (null = kikapcsolva, pl. tesztben) */
  readonly regional: RegionalRealtime | null;
  /** az MVK-adat forrása (MVK API, vagy tartalékban a MÁV+) */
  readonly sources = new SourceManager();
  /** járművenként a rendszám (Volán, és az MVK-é a tartalékból)  a vehicle táblába */
  private labels = new Map<string, string>();
  /** menetenként a jelek forrása (mvk / otp2) */
  private runSource = new Map<string, string>();
  /** a MÁV+ hívásszámlálók napi nullpontja (a kliens számlálói a futás eleje óta nőnek) */
  private otp2Base = { ok: 0, fail: 0 };
  /** az árnyék-összevetés (natív MVK ↔ OTP2) mai mintái */
  private shadow = { lags: [] as number[], seen: 0, covered: 0, total: 0 };
  /** a mai nap menetei (tripId → legfrissebb run)  a menetrend-napló élő része */
  readonly todayRuns = new Map<string, RunOut>();
  private todayIso = serviceClock().iso;
  /** járművenként az utolsó feldolgozott jel ideje (unix) */
  readonly lastTs = new Map<string, number>();
  cancelled = { ids: new Set<string>(), raw: [] as string[], at: 0, stale: false, error: null as string | null };
  weather: { at: number; data: WeatherData } | null = null;
  poll = { ok: 0, fail: 0, lastOkAt: 0, lastError: null as string | null, lastMs: 0, pingsKept: 0, vehiclesMax: 0 };
  private busy = false;
  private replaying = false;
  /** a legutóbbi SIKERES pozíció- / előrejelzés-lekérés ideje (ms)  ennyi ideig tartjuk meg a régit */
  private positionsOkAt = 0;
  private updatesOkAt = 0;
  /** az MVK saját előrejelzése utoljára (a tartalékra váltáskor 60 mp-ig ezek maradnak) */
  private nativeUpdatesAt = 0;
  /** a mai napon az MVK-kiesésekkel elveszett idő (mp)  a csend miatti lezárás ennyivel később jár */
  private feedGapS = 0;
  /** éjfél után érkezett MVK-törléslista a következő szolgáltatási napra (napváltáskor lesz élő) */
  private nextCancelled: { iso: string; state: Engine["cancelled"] } | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(feeds: FeedManager, regional: RegionalRealtime | null = null) {
    super();
    this.setMaxListeners(50);
    this.feeds = feeds;
    this.regional = regional;
    // a MÁV+ nélkül (OTP2_ENABLED=0) nincs tartalék: kiesésnél az MVK marad, a régi adat 60 mp-ig él
    this.sources.canFallback = Boolean(regional?.enabled);
    this.matcher = new TripMatcher((ts) => feeds.daysAt(ts), {
      // Visszajátszáskor a pontok már az adatbázisban vannak.
      ping: (p) => {
        if (!this.replaying) this.persister.ping(p, this.labels.get(p.vehicleId) ?? null);
      },
      runOpened: (r) => this.onRun(r),
      runUpdated: (r) => this.onRun(r),
      runClosed: (r) => this.onRun(r),
      stopEvent: (e, r) => {
        this.persister.stopEvent(e);
        this.emit("stopEvent", e, r);
      },
      atStop: (r, idx, ts) => this.emit("atStop", r, idx, ts),
    });
  }

  private onRun(r: RunOut) {
    // A jelek forrása: a regionális menet mindig MÁV+; az MVK-é a mostani forrás.
    if (!this.replaying) {
      const src = isMvkId(r.vehicleId) ? this.sources.state : "otp2";
      const prev = this.runSource.get(r.runKey);
      this.runSource.set(r.runKey, prev && prev !== src ? "mixed" : src);
      r.rtSource = this.runSource.get(r.runKey);
      if (r.status !== "running") this.runSource.delete(r.runKey);
    }
    this.persister.run(r);
    if (r.serviceDate === this.todayIso) {
      // Egy menetet egymás után két jármű is vihet (az MVK átosztja): egy másik
      // jármű lezáruló menete ne írja felül a most futót.
      const cur = this.todayRuns.get(r.tripId);
      if (!cur || cur.vehicleId === r.vehicleId || cur.status !== "running" || r.status === "running") this.todayRuns.set(r.tripId, { ...r });
    }
    this.emit("run", r);
  }

  async start(): Promise<void> {
    await this.replayToday();
    // Napközbeni újraindításkor a mai gyűjtés-számlálók folytatódnak (különben a nap egészségét
    // csak az újraindítás utáni szeletből ítélnénk meg).
    const health = await getPool()
      .query<{ polls_ok: number; polls_fail: number; pings_kept: number; vehicles_max: number }>(
        `SELECT polls_ok, polls_fail, pings_kept, vehicles_max FROM feed_health WHERE service_date = $1`,
        [this.todayIso],
      )
      .catch(() => null);
    const h = health?.rows[0];
    if (h) {
      this.poll = { ...this.poll, ok: h.polls_ok, fail: h.polls_fail, pingsKept: h.pings_kept, vehiclesMax: h.vehicles_max };
    }
    // ugyanígy a forrás-egészség: a tartalékban töltött idő és a MÁV+ hívásszámlálói
    const src = await getPool()
      .query<{ source: string; polls_ok: number; polls_fail: number; fallback_s: number }>(
        `SELECT source, polls_ok, polls_fail, fallback_s FROM source_health WHERE service_date = $1`,
        [this.todayIso],
      )
      .catch(() => null);
    for (const row of src?.rows ?? []) {
      if (row.source === "otp2-mvk") this.sources.restoreToday(row.fallback_s);
      else if (row.source === "otp2") this.otp2Base = { ok: row.polls_ok, fail: row.polls_fail };
    }
    const every = (ms: number, fn: () => unknown) => {
      const t = setInterval(() => {
        Promise.resolve(fn()).catch((e) => log.error("engine", "időzített feladat hiba", errMsg(e)));
      }, ms);
      this.timers.push(t);
    };
    if (config.ingest) {
      every(config.pollMs, () => this.pollOnce());
      every(config.cancelledMs, () => this.pollCancelled());
      await this.pollOnce();
      await this.pollCancelled();
    }
    every(3000, () => this.persister.flush());
    every(60_000, () => this.minute());
    every(config.weatherMs, () => this.pollWeather());
    await this.pollWeather();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.persister.flush();
  }

  /**
   * Újraindítás után a mai nap már eltárolt GPS-pontjait visszajátsszuk
   * ugyanazon az illesztőn: az állapot pontosan ott folytatódik, ahol
   * abbahagytuk (az írások idempotensek, nincs duplikáció). A korábbi
   * napokról bennragadt „running” menetek lezárulnak.
   */
  private async replayToday() {
    const pool = getPool();
    await pool.query(`UPDATE trip_run SET status = 'partial', close_reason = 'restart', updated_at = now() WHERE status = 'running' AND service_date < $1`, [this.todayIso]);
    const from = serviceClock().midnightUnix + 3 * 3600;
    const t0 = Date.now();
    const rows = await pool.query<{ v: string; ts: number; lat: number; lon: number; speed: number | null; bearing: number | null; rt: string | null }>(
      `SELECT vehicle_id AS v, extract(epoch FROM ts)::int AS ts, lat, lon, speed, bearing, rt_trip_id AS rt
         FROM veh_ping WHERE ts >= to_timestamp($1) AND ts <= to_timestamp($2) ORDER BY ts, vehicle_id`,
      [from, nowUnix()],
    );
    let last = 0;
    this.replaying = true;
    for (const r of rows.rows) {
      if (r.ts - last > 60) {
        this.matcher.sweep(r.ts);
        last = r.ts;
      }
      this.lastTs.set(r.v, Math.max(this.lastTs.get(r.v) ?? 0, r.ts));
      this.matcher.push({ vehicleId: r.v, ts: r.ts, lat: r.lat, lon: r.lon, speed: r.speed, bearing: r.bearing, rtTripId: r.rt ?? "" });
      // A mozgás- és forgalom-modellek az MVK-ra tanultak: a regionális jelek nem mennek beléjük.
      if (isMvkId(r.v)) this.emit("fix", r.v, r.ts, r.speed);
    }
    this.replaying = false;
    if (rows.rows.length) log.info("engine", `mai nap visszajátszva: ${rows.rows.length} pont → ${this.todayRuns.size} menet (${Date.now() - t0} ms)`);
  }

  async pollOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      const now = nowUnix();
      const clock = serviceClock(now);
      if (clock.iso !== this.todayIso) this.rollDay(clock.iso);
      const tok = tokenStatus();
      const tokenUsable = tok.present && !tok.expired;
      // Lejárt / hiányzó tokennel az MVK úgyis elutasítana: nem terheljük, azonnal a tartalék él.
      if (!tokenUsable) this.sources.tokenUnusable(tok.present ? "lejárt az MVK token" : "nincs MVK token");

      let positions: Buffer | null = null;
      let updates: Buffer | null = null;
      const errs: string[] = [];
      let mvkStatus: number | null = null;
      const polledMvk = this.sources.shouldPollMvk(tokenUsable);
      if (polledMvk) {
        const [pos, upd] = await Promise.allSettled([
          mvkFetch("/api/v1/gtfs/get-positions", { accept: "application/x-protobuf, */*" }),
          mvkFetch("/api/v1/gtfs/get-updates", { accept: "application/x-protobuf, */*" }),
        ]);
        positions = pos.status === "fulfilled" && pos.value.status === 200 ? pos.value.buf : null;
        updates = upd.status === "fulfilled" && upd.value.status === 200 ? upd.value.buf : null;
        mvkStatus = pos.status === "fulfilled" ? pos.value.status : null;
        if (!positions) errs.push(pos.status === "fulfilled" ? `get-positions HTTP ${pos.value.status}` : `get-positions ${errMsg(pos.reason)}`);
        if (!updates) errs.push(upd.status === "fulfilled" ? `get-updates HTTP ${upd.value.status}` : `get-updates ${errMsg(upd.reason)}`);
      }

      const days = this.feeds.daysAt(now).map((d) => d.day);
      const regional = this.regional?.vehicles() ?? [];
      const otpMvk = this.regional?.mvkVehicles() ?? [];
      const extraPreds = this.regional?.extraPreds() ?? [];
      const base = { offset: clock.offset, days, midnightUnix: clock.midnightUnix, now };
      // Egy 200-as, de nem protobuf válasz (karbantartási oldal) is kiesés: a dekódolás dönti el.
      let snap: RealtimeSnapshot | null = null;
      if (positions || updates) {
        try {
          snap = buildSnapshot({
            ...base,
            positions: positions ? new Uint8Array(positions) : null,
            updates: updates ? new Uint8Array(updates) : null,
            rtError: errs.length ? errs.join("; ") : null,
            // mindig a regionálissal: ha ez a kör épp visszaváltás a tartalékról, a Volán és a vasút
            // ne tűnjön el egy körre (tartalékban ezt a pillanatképet úgyis újraépítjük)
            extra: regional,
            extraPreds,
          });
        } catch (e) {
          errs.push(`értelmezhetetlen MVK-válasz: ${errMsg(e)}`);
          positions = null;
          updates = null;
          snap = null;
        }
      }
      if (polledMvk) this.sources.onMvk(positions ? { ok: true } : { ok: false, status: mvkStatus, reason: errs.join("; ") || "nincs adat" });
      const fallback = this.sources.state === "otp2";
      this.regional?.setFallback(fallback);

      const nowMs = Date.now();
      if (fallback) {
        // Tartalék: az MVK járművei a MÁV+-ból, a natív adat (ha éppen jött is egy próbán) nem keveredik bele.
        const fresh = otpMvk.length > 0;
        const why = this.sources.reason ?? "az MVK nem elérhető";
        snap = buildSnapshot({ ...base, positions: null, updates: null, rtError: fresh ? null : this.regional?.enabled ? `${why}, és a MÁV+ sem ad adatot` : why, extra: [...otpMvk, ...regional], extraPreds });
        // a v2-fejléc (az iOS app ebből látja a frissességet): a feed ideje, mint az MVK-nál (helyi idő unixként)
        snap.header = fresh ? { version: this.snapshot.header.version || "2.0", timestamp: now + clock.offset } : this.snapshot.header;
        if (fresh) {
          const gapMs = this.positionsOkAt ? nowMs - this.positionsOkAt : 0;
          if (gapMs > FEED_GAP_MS) this.feedGapS += Math.round(gapMs / 1000);
          this.positionsOkAt = nowMs;
          this.updatesOkAt = nowMs;
        }
        // Az átállás után a MÁV+ MVK-előrejelzése legfeljebb egy kör (30 mp) múlva jön: addig az MVK
        // utolsó saját előrejelzései maradnak (ahol a MÁV+ még nem adott újat), legfeljebb 60 mp-ig.
        if (nowMs - this.nativeUpdatesAt < KEEP_OLD_MS) this.carryMvkPreds(snap);
        this.pushExtra(otpMvk, now);
        this.poll.vehiclesMax = Math.max(this.poll.vehiclesMax, otpMvk.length);
      } else {
        if (!snap) snap = buildSnapshot({ ...base, positions: null, updates: null, rtError: errs.length ? errs.join("; ") : polledMvk ? null : "még nincs adat", extra: regional, extraPreds });
        // Ha a pozíció nem jött le, a korábbit tartjuk meg legfeljebb 60 mp-ig (a megállófigyelő ne ürüljön ki
        // egy hibás pollra)  a `fetchedAt` minden körben frissül, ezért a legutóbbi sikeres lekéréshez mérünk.
        if (positions) {
          // Az MVK-kiesés ideje nem a buszok csendje: a csend miatti lezárás ennyivel később jár
          // (különben egy 20 perces kiesés után minden futó menetet lezárnánk, majd újranyitnánk).
          const gapMs = this.positionsOkAt ? nowMs - this.positionsOkAt : 0;
          if (gapMs > FEED_GAP_MS) this.feedGapS += Math.round(gapMs / 1000);
          this.positionsOkAt = nowMs;
        } else if (nowMs - this.positionsOkAt < KEEP_OLD_MS) {
          const oldMvk = this.snapshot.decoded.filter((v) => isMvkId(v.id) && v.source !== "otp2");
          const oldVeh = this.snapshot.vehicles.filter((v) => isMvkId(v.id) && oldMvk.some((d) => d.id === v.id));
          snap.decoded = [...oldMvk, ...snap.decoded];
          snap.vehicles = [...oldVeh, ...snap.vehicles];
          snap.header = this.snapshot.header;
        }
        if (updates) {
          this.updatesOkAt = nowMs;
          this.nativeUpdatesAt = nowMs;
        } else if (nowMs - this.updatesOkAt < KEEP_OLD_MS) this.carryMvkPreds(snap);
        if (positions) {
          let kept = 0;
          for (const v of snap.decoded) {
            if (v.source === "otp2" || v.lat == null || v.lon == null || !v.timestamp) continue;
            const ts = v.timestamp - clock.offset;
            if (ts > now + 120 || ts < now - 6 * 3600) continue;
            if (ts <= (this.lastTs.get(v.id) ?? 0)) continue;
            this.lastTs.set(v.id, ts);
            kept++;
            this.matcher.push({ vehicleId: v.id, ts, lat: v.lat, lon: v.lon, speed: v.speed, bearing: v.bearing, rtTripId: v.rtTripId ?? v.tripId });
            this.emit("fix", v.id, ts, v.speed);
          }
          this.poll.pingsKept += kept;
          this.poll.vehiclesMax = Math.max(this.poll.vehiclesMax, snap.vehicles.filter((v) => isMvkId(v.id)).length);
          this.compareShadow(snap, otpMvk, clock.offset);
        }
      }
      this.pushExtra(regional, now);
      snap.source = fallback ? "otp2" : "mvk";
      snap.regionalAt = this.regional?.at ?? 0;
      this.snapshot = snap;
      const ok = fallback ? otpMvk.length > 0 : positions != null && errs.length === 0;
      if (!ok) {
        this.poll.fail++;
        this.poll.lastError = errs.join("; ") || snap.rtError || "nincs adat";
      } else {
        this.poll.ok++;
        this.poll.lastOkAt = Date.now();
        this.poll.lastError = null;
      }
      this.emit("tick", snap);
    } catch (e) {
      this.poll.fail++;
      this.poll.lastError = errMsg(e);
      log.warn("poll", "hiba", errMsg(e));
      // tartósan hibás állapotban a 60 mp-nél régebbi pozíciókat nem adjuk tovább élőként
      if (this.snapshot.decoded.length && Date.now() - this.positionsOkAt > KEEP_OLD_MS) {
        this.snapshot = { ...EMPTY, rtError: errMsg(e) };
        this.emit("tick", this.snapshot);
      }
    } finally {
      this.poll.lastMs = Date.now() - t0;
      this.busy = false;
    }
  }

  /**
   * A MÁV+ járművei az illesztőbe (a regionálisak mindig, az MVK-iak tartalékban). A becsült
   * (nem GPS) helyzet nem kerül bele: a térképen látszik, de nem mérünk belőle és nem mentjük.
   */
  private pushExtra(list: RtVehicle[], now: number) {
    for (const v of list) {
      if (v.estimated || !v.rtTripId) continue;
      if (v.ts > now + 120 || v.ts < now - 6 * 3600) continue;
      if (v.ts <= (this.lastTs.get(v.id) ?? 0)) continue;
      this.lastTs.set(v.id, v.ts);
      if (v.label) this.labels.set(v.id, v.label);
      this.matcher.push({ vehicleId: v.id, ts: v.ts, lat: v.lat, lon: v.lon, speed: v.speed, bearing: v.bearing, rtTripId: v.rtTripId });
      if (isMvkId(v.id)) {
        this.poll.pingsKept++;
        this.emit("fix", v.id, v.ts, v.speed);
      }
    }
    if (this.labels.size > 20_000) this.labels.clear();
  }

  /** Árnyék-összevetés: az OTP2 MVK-adata hány járművet fed le, és mennyit késik a natívhoz képest. */
  private compareShadow(snap: RealtimeSnapshot, otpMvk: RtVehicle[], offset: number) {
    if (!otpMvk.length) return;
    const otp = new Map(otpMvk.map((v) => [v.id, v]));
    for (const v of snap.decoded) {
      if (v.source === "otp2" || !isMvkId(v.id) || v.lat == null || !v.timestamp) continue;
      this.shadow.total++;
      const o = otp.get(v.id);
      if (!o) continue;
      this.shadow.covered++;
      // negatív is lehet (a MÁV+ jele frissebb); a 10 percnél nagyobb eltérés nem ugyanaz a jel
      const lag = v.timestamp - offset - o.ts;
      if (Math.abs(lag) >= 600) continue;
      // Egyenletes minta az egész napból (reservoir): a percentilis ne csak a reggelt tükrözze.
      const n = ++this.shadow.seen;
      if (this.shadow.lags.length < SHADOW_SAMPLES) this.shadow.lags.push(lag);
      else {
        const j = Math.floor(Math.random() * n);
        if (j < SHADOW_SAMPLES) this.shadow.lags[j] = lag;
      }
    }
  }

  /** Az előző kör MVK-előrejelzései az újba, ahol az új még nem ad ugyanarra a menetre. */
  private carryMvkPreds(snap: RealtimeSnapshot) {
    for (const [stop, byTrip] of this.snapshot.predByStop) {
      for (const [trip, p] of byTrip) {
        if (!isMvkId(trip)) continue;
        let cur = snap.predByStop.get(stop);
        if (cur?.has(trip)) continue;
        if (!cur) snap.predByStop.set(stop, (cur = new Map()));
        cur.set(trip, p);
      }
    }
  }

  /** A mai nap forrás-egészsége (a hubnak is). */
  shadowStats() {
    const a = [...this.shadow.lags].sort((x, y) => x - y);
    const q = (p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
    return { samples: this.shadow.seen, lagP50: q(0.5), lagP95: q(0.95), coverage: this.shadow.total ? Math.round((1000 * this.shadow.covered) / this.shadow.total) / 1000 : null };
  }

  private rollDay(iso: string) {
    log.info("engine", `új szolgáltatási nap: ${iso}`);
    this.todayIso = iso;
    this.todayRuns.clear();
    // éjfél után már megjött az új nap MVK-listája: azt vesszük át
    const next = this.nextCancelled?.iso === iso ? this.nextCancelled.state : null;
    this.cancelled = next ?? { ids: new Set(), raw: [], at: 0, stale: false, error: null };
    this.nextCancelled = null;
    this.poll = { ...this.poll, ok: 0, fail: 0, pingsKept: 0, vehiclesMax: 0 };
    this.feedGapS = 0;
    this.shadow = { lags: [], seen: 0, covered: 0, total: 0 };
    this.sources.rollDay();
    // az új nap számlálói nulláról: a kliens eddigi hívásai az előző napé
    const c = this.regional?.status().client;
    this.otp2Base = c ? { ok: -c.ok, fail: -c.fail } : { ok: 0, fail: 0 };
    this.regional?.rollDay();
    if (next) this.emit("cancelled", next.ids);
  }

  get today() {
    return this.todayIso;
  }

  async pollCancelled(): Promise<void> {
    if (!tokenStatus().present) return;
    try {
      const res = await mvkFetch("/api/v1/gtfs/list-cancelled-trips");
      if (res.status !== 200) throw new Error(`list-cancelled-trips HTTP ${res.status}`);
      const raw = parseCancelledIds(JSON.parse(res.buf.toString("utf8").trim() || "[]"));
      // Az MVK listája naptári napra szól (éjfélkor vált), a szolgáltatási nap 03:00-kor:
      // éjfél után már a holnapi lista jön  azt félretesszük a napváltásig, nem a mainak mutatjuk.
      const clock = serviceClock(nowUnix());
      const listIso = clock.calendarIso;
      const early = listIso !== this.todayIso;
      // éjfél utáni első percekben még a tegnapi lista jöhet vissza: azt nem tesszük el holnapinak
      if (early && clock.secOfDay - 86_400 < CANCELLED_SETTLE_S) return;
      const day = this.feeds.cachedDay(listIso) ?? this.feeds.cachedDay(this.todayIso);
      const ids = new Set<string>();
      for (const id of raw) ids.add((day && resolveTrip(day, id)?.id) || id);
      const state = { ids, raw, at: Date.now(), stale: false, error: null };
      if (early) this.nextCancelled = { iso: listIso, state };
      else this.cancelled = state;
      if (ids.size) {
        const list = [...ids];
        await getPool().query(
          `INSERT INTO cancelled_trip (service_date, trip_id, first_seen, last_seen, samples)
           SELECT $1::date, t, now(), now(), 1 FROM unnest($2::text[]) AS t
           ON CONFLICT (service_date, trip_id) DO UPDATE SET last_seen = now(), samples = cancelled_trip.samples + 1`,
          [listIso, list],
        );
      }
      if (!early) this.emit("cancelled", ids);
    } catch (e) {
      this.cancelled = { ...this.cancelled, stale: true, error: errMsg(e) };
    }
  }

  private async minute() {
    const now = nowUnix();
    // Kiesés közben nem zárunk csend miatt (nem a buszok hallgatnak, hanem az adatforrás).
    if (Date.now() - this.positionsOkAt < FEED_GAP_MS) this.matcher.sweep(now - this.feedGapS);
    await this.feeds.warmToday();
    await getPool().query(
      `INSERT INTO feed_health (service_date, polls_ok, polls_fail, pings_kept, vehicles_max) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (service_date) DO UPDATE SET polls_ok = EXCLUDED.polls_ok, polls_fail = EXCLUDED.polls_fail,
         pings_kept = EXCLUDED.pings_kept, vehicles_max = GREATEST(feed_health.vehicles_max, EXCLUDED.vehicles_max)`,
      [this.todayIso, this.poll.ok, this.poll.fail, this.poll.pingsKept, this.poll.vehiclesMax],
    );
    if (this.regional?.enabled) {
      const sh = this.shadowStats();
      const r = this.regional.status();
      await getPool()
        .query(
          `INSERT INTO source_health (service_date, source, polls_ok, polls_fail, vehicles_max, lag_p50_s, lag_p95_s, coverage, fallback_s, updated_at)
           VALUES ($1, 'otp2-mvk', 0, 0, $9, $2, $3, $4, $5, now()), ($1, 'otp2', $6, $7, $8, NULL, NULL, NULL, 0, now())
           ON CONFLICT (service_date, source) DO UPDATE SET polls_ok = EXCLUDED.polls_ok, polls_fail = EXCLUDED.polls_fail,
             vehicles_max = GREATEST(source_health.vehicles_max, EXCLUDED.vehicles_max), lag_p50_s = EXCLUDED.lag_p50_s,
             lag_p95_s = EXCLUDED.lag_p95_s, coverage = EXCLUDED.coverage, fallback_s = EXCLUDED.fallback_s, updated_at = now()`,
          // otp2-mvk: az MVK a MÁV+ felől (árnyék-összevetés, tartalék-idő, az ott látott MVK-járművek)
          [this.todayIso, sh.lagP50, sh.lagP95, sh.coverage, this.sources.fallbackSecToday(), this.otp2Base.ok + r.client.ok, this.otp2Base.fail + r.client.fail, r.vehicles, r.mvkVehicles],
        )
        .catch((e) => log.warn("engine", "forrás-egészség mentése sikertelen", errMsg(e)));
    }
  }

  async pollWeather(): Promise<void> {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${config.weather.lat}&longitude=${config.weather.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as { current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number } };
      const code = raw.current?.weather_code ?? -1;
      const data: WeatherData = {
        tempC: raw.current?.temperature_2m ?? null,
        feelsLikeC: raw.current?.apparent_temperature ?? null,
        windKmh: raw.current?.wind_speed_10m ?? null,
        code,
        text: WMO[code] ?? "Ismeretlen",
        at: new Date().toISOString(),
      };
      this.weather = { at: Date.now(), data };
      await getPool().query(
        `INSERT INTO weather_hour (hour, temp_c, feels_c, wind_kmh, wmo_code) VALUES (date_trunc('hour', now()), $1, $2, $3, $4)
         ON CONFLICT (hour) DO UPDATE SET temp_c = EXCLUDED.temp_c, feels_c = EXCLUDED.feels_c, wind_kmh = EXCLUDED.wind_kmh, wmo_code = EXCLUDED.wmo_code`,
        [data.tempC, data.feelsLikeC, data.windKmh, code >= 0 && code < 256 ? code : null],
      );
    } catch (e) {
      log.warn("weather", "lekérés sikertelen", errMsg(e));
    }
  }
}
