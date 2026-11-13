/**
 * A regionális (Volán + vasút) valós idő a MÁV+ OTP2-ből, és az MVK tartaléka.
 *
 *   járművek  ── 15 mp (tartalékban 10 mp) ── egy kérés: a megye körüli doboz buszai
 *                                            + az ország vonatai (a megyét érintők végig)
 *   kiért buszok ── 30 mp ── mintánként (a dobozból kiért, még futó menetek)
 *   zavarok   ── 2 perc ── késésok, kocsiösszeállítás, pótlóbusz menetenként
 *   táblák    ── 1 perc ── a figyelt állomások: vágány, a még el nem indult vonat késése, törlés
 *   MVK-menetek ── 30 mp, csak tartalékban ── megállónkénti előrejelzés a get-updates helyett
 *
 * Minden kérés a kliens egyetlen során megy (a MÁV+ korlátja miatt), az élő
 * pozíció a legmagasabb prioritással.
 */
import { getPool, sql } from "@mvk/db";
import {
  bumpPlatform,
  isMvkId,
  LINE_PLATFORM,
  OWN_PLATFORM,
  pickPlatform,
  platformLineKey,
  isoToYmd,
  localMidnightUnix,
  NATIONAL_BBOX,
  nowUnix,
  type OtpVehiclePosition,
  plainText,
  POLL_BBOX,
  isRailTrip,
  rtFromOtp,
  type RtVehicle,
  trainParts,
  SERVICE_DAY_CUTOFF_SEC,
  serviceClock,
  shiftIso,
  stationKeyOf,
} from "@mvk/core";
import { config } from "../config.ts";
import type { FeedManager } from "../feeds.ts";
import { errMsg, log } from "../log.ts";
import { otp2 } from "../otp2/client.ts";
import { ALERTS, boards, patternVehicles, tripsRealtime, VEHICLES } from "../otp2/queries.ts";

const ESCAPED_MS = 30_000;
const ESCAPED_BATCH = 20;
const BOARD_BATCH = 10;
/** a táblák időablaka (mp): ennyi időre előre kérünk */
const BOARD_RANGE_S = 3 * 3600;
const TRIP_RT_MS = 30_000;
const TRIP_RT_BATCH = 25;
/** az élő adat ennyi idő után már nem élő (ms) */
const STALE_MS = 3 * 60_000;
/** a doboz szélétől ennyin belül eltűnő busz számít „kiszököttnek” (fok, ~5 km) */
const EDGE_DEG = 0.05;
/** ennyi üres válasz után a kiszökött menetet elengedjük (beért, vagy már nem jelez) */
const ESCAPED_MISSES = 4;
/** a menetrendi érkezés után legfeljebb eddig keressük (késés) */
const ESCAPED_GRACE_S = 45 * 60;
/** egyszerre legfeljebb ennyi figyelt állomás tábláját frissítjük (a kérések védelme) */
const HOT_MAX = 60;
/** ennyivel a kezdete előtt már a menethez kötjük a közleményt (mp) */
const NOTICE_LEAD_S = 3 * 3600;
/** egy figyelt állomás ennyi ideig marad „forró” az utolsó kérés után (ms) */
const HOT_TTL_MS = 15 * 60_000;
/** új figyelt állomás táblája ennyi után (több egyszerre érkező kérés egy lekérésbe fut) */
const BOARD_KICK_MS = 1500;
/** a vágány-jósláshoz ennyi nap előzménye */
const PLATFORM_HISTORY_DAYS = 42;
const LINE_PLATFORM_TTL_MS = 5 * 60_000;

export type NoticeKind = "cause" | "composition" | "replacement" | "other";
export type Notice = { text: string; kind: NoticeKind };
export type TransitAlert = { feed: string; header: string; text: string; start: number | null; end: number | null; trips: string[]; routes: string[]; stops: string[] };
type BoardRow = { delay: number; stopId: string; platform: string | null; state: string; at: number };

type RawStoptime = {
  serviceDay: number;
  scheduledDeparture: number;
  realtimeDeparture: number;
  departureDelay: number;
  realtime: boolean;
  realtimeState: string;
  stop: { gtfsId: string; platformCode: string | null } | null;
  trip: { gtfsId: string } | null;
};

export function noticeKind(text: string): NoticeKind {
  if (/pótló/i.test(text)) return "replacement";
  if (/kocsi|lezárva|szerelvény/i.test(text)) return "composition";
  if (/késés|késik|késéssel/i.test(text)) return "cause";
  return "other";
}

const MVK = "mvkzrt:";
const strip = (id: string) => (id.startsWith(MVK) ? id.slice(MVK.length) : id);

/** A jármű a lekérdezett terület széle közelében van-e (onnan szökhet ki). */
function nearEdge(lat: number, lon: number): boolean {
  const b = POLL_BBOX;
  return lat - b.minLat < EDGE_DEG || b.maxLat - lat < EDGE_DEG || lon - b.minLon < EDGE_DEG || b.maxLon - lon < EDGE_DEG;
}

export class RegionalRealtime {
  private feeds: FeedManager;
  /** a regionális (Volán, vasút) járművek  csak a menetrendünkben ismert menetekkel */
  regional: RtVehicle[] = [];
  /** az MVK járművei az OTP2-ből (tartalék, árnyék-összevetés) */
  mvk: RtVehicle[] = [];
  at = 0;
  mvkAt = 0;
  error: string | null = null;
  /** a dobozból kiért, még futó menetek: tripId → minta, utolsó jel */
  private escaped = new Map<string, { pattern: string; lastSeen: number; misses: number }>();
  private escapedVehicles = new Map<string, RtVehicle>();
  /** menet → (megálló → élő vágány) */
  private platforms = new Map<string, Map<string, string>>();
  /** menet → az állomástáblából: késés (jármű nélkül is), vágány, állapot */
  private board = new Map<string, BoardRow>();
  /** törölt regionális menetek (a mai napra) */
  cancelled = new Set<string>();
  private notices = new Map<string, Notice[]>();
  alerts: TransitAlert[] = [];
  alertsAt = 0;
  /** tartalék üzemben: MVK-menet → megállónkénti késés */
  private mvkTripRt = new Map<string, { stopId: string; delay: number }[]>();
  private hot = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private polling = false;
  private fallback = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private persistedPlatform = new Map<string, string>();
  /** a korábbi napok vágányai: `menet|állomás` → vágány → hány napon (lásd `predictedPlatform`) */
  private platformHistory = new Map<string, Map<string, number>>();
  /** vonal-szintű vágányok (`vonal|végállomás|állomás`), 5 percig gyorsítótárazva */
  private linePlatformCache: { at: number; iso: string; map: Map<string, Map<string, number>> } | null = null;
  /** új figyelt állomás: a táblája hamarabb jön, nem a következő percben */
  private boardKick: NodeJS.Timeout | null = null;
  private boardsRunning = false;
  private persistedNotice = new Set<string>();
  stats = { polls: 0, vehicles: 0, rail: 0, escaped: 0, boards: 0, alerts: 0 };

  constructor(feeds: FeedManager) {
    this.feeds = feeds;
  }

  get enabled(): boolean {
    return config.otp2.enabled && config.ingest;
  }

  start() {
    if (!this.enabled) return;
    this.schedulePoll(0);
    const every = (ms: number, fn: () => Promise<void>) => {
      const t = setInterval(() => void fn().catch((e) => log.warn("otp2", "időzített lekérés hiba", errMsg(e))), ms);
      t.unref();
      this.timers.push(t);
    };
    if (config.otp2.regional) {
      every(ESCAPED_MS, () => this.pollEscaped());
      every(config.otp2.alertsMs, () => this.pollAlerts());
      every(config.otp2.boardsMs, () => this.pollBoards());
      void this.pollAlerts().catch(() => {});
      void this.loadPlatformHistory().catch((e) => log.warn("otp2", "a vágány-előzmények betöltése sikertelen", errMsg(e)));
    }
    every(TRIP_RT_MS, () => this.pollMvkTrips());
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  /** Tartalék üzem: sűrűbb poll és megállónkénti MVK-előrejelzés. */
  setFallback(on: boolean) {
    if (this.fallback === on) return;
    this.fallback = on;
    if (!on) return;
    this.schedulePoll(0);
    // a megállónkénti MVK-előrejelzés azonnal (ne a következő 30 mp-es körben)
    void this.pollMvkTrips().catch((e) => log.warn("otp2", "MVK-menetek lekérése sikertelen", errMsg(e)));
  }

  private schedulePoll(ms: number) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.pollVehicles().finally(() => this.schedulePoll(this.fallback ? config.otp2.fallbackPollMs : config.otp2.pollMs)), ms);
    this.pollTimer.unref();
  }

  /**
   * Egy állomás / megálló táblája érdekel valakit (WebSocket, push, kérés)  a táblák között frissül.
   * Csak a menetrendben létező megálló számít (egy kitalált azonosító ne menjen ki a MÁV+-hoz),
   * és legfeljebb HOT_MAX: ilyenkor a legrégebben kért esik ki.
   */
  touch(stopId: string) {
    if (isMvkId(stopId) && !this.fallback) return;
    if (!this.hot.has(stopId) && !this.knownStop(stopId)) return;
    const isNew = !this.hot.has(stopId);
    this.hot.delete(stopId);
    this.hot.set(stopId, Date.now());
    while (this.hot.size > HOT_MAX) this.hot.delete(this.hot.keys().next().value as string);
    // Először nézik: a vágány ne a következő percben jöjjön (a tábla addig üres lenne).
    if (isNew && !isMvkId(stopId) && config.otp2.regional && !this.boardKick) {
      this.boardKick = setTimeout(() => {
        this.boardKick = null;
        void this.pollBoards().catch((e) => log.warn("otp2", "állomástábla lekérése sikertelen", errMsg(e)));
      }, BOARD_KICK_MS);
      this.boardKick.unref();
    }
  }

  private knownStop(id: string): boolean {
    for (const { day } of this.feeds.daysAt(nowUnix())) if (day.feed.stops.has(id)) return true;
    return false;
  }

  /** A menet menetrendi vége (unix), ha ismerjük. */
  private tripEnd(id: string): number | null {
    for (const { day, midnightUnix } of this.feeds.daysAt(nowUnix())) {
      const st = day.feed.tripStops.get(id);
      if (st?.length) return midnightUnix + st[st.length - 1].arr;
    }
    return null;
  }

  private knownTrip(id: string): boolean {
    const now = nowUnix();
    for (const { day } of this.feeds.daysAt(now)) if (day.feed.trips.has(id)) return true;
    return false;
  }

  private async pollVehicles(): Promise<void> {
    if (this.polling) return;
    // Ha a sor tele van élő kéréssel (a szerver lassú), nem teszünk be még egyet.
    if (otp2.pending("high") > 2) return;
    this.polling = true;
    try {
      const a = POLL_BBOX;
      const n = NATIONAL_BBOX;
      const data = await otp2.query<{ road: OtpVehiclePosition[]; rail: OtpVehiclePosition[] }>("vehicles", VEHICLES, {
        b: a.minLat, l: a.minLon, t: a.maxLat, r: a.maxLon, nb: n.minLat, nl: n.minLon, nt: n.maxLat, nr: n.maxLon,
      }, { timeoutMs: 12_000, priority: "high" });
      const mvk: RtVehicle[] = [];
      const regional: RtVehicle[] = [];
      const seenTrips = new Set<string>();
      for (const raw of [...(data.road ?? []), ...(data.rail ?? [])]) {
        const v = rtFromOtp(raw);
        if (!v) continue;
        if (raw.vehicleId.startsWith(MVK)) {
          mvk.push(v);
          continue;
        }
        if (!config.otp2.regional || !v.rtTripId || !this.knownTrip(v.rtTripId)) continue;
        regional.push(v);
        seenTrips.add(v.rtTripId);
        // Csak a doboz széle közelében lévő busz szökhet ki (ami bent ér véget, azt nem keressük tovább).
        if (v.pattern && !v.rtTripId.startsWith("1:") && nearEdge(v.lat, v.lon)) this.escaped.set(v.rtTripId, { pattern: v.pattern, lastSeen: Date.now(), misses: 0 });
      }
      // A dobozban újra látott menet nem „kiért”; a kiértek közül a friss jelűek hozzáadódnak.
      for (const id of seenTrips) this.escapedVehicles.delete(id);
      for (const [trip, v] of this.escapedVehicles) if (!seenTrips.has(trip) && Date.now() - v.ts * 1000 < STALE_MS) regional.push(v);
      this.mvk = mvk;
      this.mvkAt = Date.now();
      if (config.otp2.regional) {
        this.regional = regional;
        this.at = Date.now();
      }
      this.error = null;
      this.stats.polls++;
      this.stats.vehicles = regional.length;
      this.stats.rail = regional.filter((v) => v.rtTripId.startsWith("1:")).length;
    } catch (e) {
      this.error = errMsg(e);
    } finally {
      this.polling = false;
    }
  }

  /** A dobozból kiért helyközi buszok: amíg a menetük fut, mintánként lekérdezzük őket. */
  private async pollEscaped(): Promise<void> {
    const now = Date.now();
    const visible = new Set(this.regional.filter((v) => !this.escapedVehicles.has(v.rtTripId)).map((v) => v.rtTripId));
    const want = new Map<string, string[]>();
    for (const [trip, e] of this.escaped) {
      const end = this.tripEnd(trip);
      const over = end != null ? now / 1000 > end + ESCAPED_GRACE_S : now - e.lastSeen > 3 * 3600_000;
      if (over || e.misses >= ESCAPED_MISSES) {
        this.escaped.delete(trip);
        this.escapedVehicles.delete(trip);
        continue;
      }
      if (!visible.has(trip) && now - e.lastSeen > 45_000) want.set(e.pattern, [...(want.get(e.pattern) ?? []), trip]);
    }
    // a kiesett menetek járművei se ragadjanak bent
    for (const [trip, v] of this.escapedVehicles) if (!this.escaped.has(trip) || now - v.ts * 1000 > STALE_MS * 10) this.escapedVehicles.delete(trip);
    this.stats.escaped = this.escapedVehicles.size;
    if (!want.size) return;
    const codes = [...want.keys()];
    for (let i = 0; i < codes.length; i += ESCAPED_BATCH) {
      const batch = codes.slice(i, i + ESCAPED_BATCH);
      const data = await otp2.query<Record<string, { vehiclePositions: OtpVehiclePosition[] } | null>>("patternVehicles", patternVehicles(batch), {}, { priority: "low" });
      const found = new Set<string>();
      for (const p of Object.values(data)) {
        for (const raw of p?.vehiclePositions ?? []) {
          const v = rtFromOtp(raw);
          if (!v || !this.escaped.has(v.rtTripId)) continue;
          this.escapedVehicles.set(v.rtTripId, v);
          this.escaped.get(v.rtTripId)!.lastSeen = Date.now();
          found.add(v.rtTripId);
        }
      }
      // amelyik keresett menetre nem jött jármű, az egy „üres” kör
      for (const code of batch) for (const trip of want.get(code) ?? []) {
        const e = this.escaped.get(trip);
        if (e) e.misses = found.has(trip) ? 0 : e.misses + 1;
      }
    }
    this.stats.escaped = this.escapedVehicles.size;
  }

  private async pollAlerts(): Promise<void> {
    type Raw = { feed: string; alertHeaderText: string | null; alertDescriptionText: string | null; effectiveStartDate: number | null; effectiveEndDate: number | null; entities: { __typename: string; gtfsId?: string }[] | null };
    const data = await otp2.query<{ alerts: Raw[] }>("alerts", ALERTS, {}, { priority: "low" });
    const notices = new Map<string, Notice[]>();
    const alerts: TransitAlert[] = [];
    const now = nowUnix();
    for (const a of data.alerts ?? []) {
      if (a.effectiveEndDate && a.effectiveEndDate < now - 600) continue;
      const text = plainText(a.alertDescriptionText) || plainText(a.alertHeaderText);
      if (!text) continue;
      const trips: string[] = [];
      const routes: string[] = [];
      const stops: string[] = [];
      for (const e of a.entities ?? []) {
        if (!e.gtfsId) continue;
        if (e.__typename === "Trip") trips.push(e.gtfsId);
        else if (e.__typename === "Route") routes.push(e.gtfsId);
        else if (e.__typename === "Stop") stops.push(strip(e.gtfsId));
      }
      // A jövőbeli (pl. holnapi, tervezett) közlemény a listába kerül, de a mai menethez nem:
      // a menetazonosító naponta ismétlődik, és a megjegyzés a mai napra mentődne.
      const upcoming = a.effectiveStartDate != null && a.effectiveStartDate > now + NOTICE_LEAD_S;
      if (!upcoming) for (const t of trips) {
        const list = notices.get(t) ?? [];
        if (!list.some((n) => n.text === text)) list.push({ text, kind: noticeKind(text) });
        notices.set(t, list);
      }
      alerts.push({ feed: a.feed, header: plainText(a.alertHeaderText), text, start: a.effectiveStartDate, end: a.effectiveEndDate, trips, routes, stops });
    }
    this.notices = notices;
    this.alerts = alerts;
    this.alertsAt = Date.now();
    this.stats.alerts = alerts.length;
    await this.persistNotices().catch((e) => log.warn("otp2", "megjegyzések mentése sikertelen", errMsg(e)));
  }

  /** A figyelt állomások táblái: a még el nem indult vonat késése, vágány, törlés. */
  private async pollBoards(): Promise<void> {
    if (this.boardsRunning) return;
    this.boardsRunning = true;
    try {
      await this.pollBoardsOnce();
    } finally {
      this.boardsRunning = false;
    }
  }

  private async pollBoardsOnce(): Promise<void> {
    const now = Date.now();
    const ids: { id: string; station: boolean }[] = [];
    const feed = this.feeds.cachedDay(serviceClock().iso)?.feed;
    for (const [id, at] of this.hot) {
      if (now - at > HOT_TTL_MS) {
        this.hot.delete(id);
        continue;
      }
      if (isMvkId(id)) continue;
      ids.push({ id, station: Boolean(feed?.stops.get(id)?.station || feed?.stationChildren.has(id)) });
    }
    for (let i = 0; i < ids.length; i += BOARD_BATCH) {
      const batch = ids.slice(i, i + BOARD_BATCH);
      const data = await otp2.query<Record<string, { stoptimesWithoutPatterns: RawStoptime[] } | null>>("boards", boards(batch, BOARD_RANGE_S), {}, { priority: "low" });
      for (const b of Object.values(data)) for (const st of b?.stoptimesWithoutPatterns ?? []) this.noteStoptime(st);
    }
    this.stats.boards = ids.length;
    await this.persistPlatforms().catch((e) => log.warn("otp2", "vágányok mentése sikertelen", errMsg(e)));
  }

  private noteStoptime(st: RawStoptime) {
    const trip = st.trip?.gtfsId;
    const stopId = st.stop?.gtfsId ? strip(st.stop.gtfsId) : null;
    if (!trip || !stopId) return;
    // Csak a mai szolgáltatási napunk példánya (a holnapi ugyanazzal az azonosítóval is jöhet): az OTP-dátum
    // ma, vagy holnap 03:00 előtt (az éjszakai menet a mi napunk végéhez tartozik).
    const today = serviceClock().iso;
    const m0 = localMidnightUnix(today);
    const m1 = localMidnightUnix(shiftIso(today, 1));
    const ours = st.serviceDay === m0 ? st.scheduledDeparture >= SERVICE_DAY_CUTOFF_SEC : st.serviceDay === m1 && st.scheduledDeparture < SERVICE_DAY_CUTOFF_SEC;
    if (!ours) return;
    if (st.realtimeState === "CANCELED") this.cancelled.add(trip);
    if (st.stop?.platformCode) {
      let m = this.platforms.get(trip);
      if (!m) this.platforms.set(trip, (m = new Map()));
      // az állomás kulcsán: a menetrend az állomásszintű megállót (…_0) ismeri, nem a vágányt (…_3)
      m.set(stationKeyOf(stopId), st.stop.platformCode);
    }
    if (st.realtime) this.board.set(trip, { delay: st.departureDelay ?? 0, stopId, platform: st.stop?.platformCode ?? null, state: st.realtimeState, at: Date.now() });
  }

  /** Tartalék üzemben az MVK-menetek megállónkénti ideje (a natív get-updates helyett). */
  private async pollMvkTrips(): Promise<void> {
    if (!this.fallback || !this.mvk.length) {
      if (!this.fallback) this.mvkTripRt.clear();
      return;
    }
    const ids = [...new Set(this.mvk.map((v) => v.rtTripId).filter(Boolean))].map((id) => `${MVK}${id}`);
    const ymd = isoToYmd(serviceClock().iso);
    const out = new Map<string, { stopId: string; delay: number }[]>();
    for (let i = 0; i < ids.length; i += TRIP_RT_BATCH) {
      type Raw = { gtfsId: string; stoptimesForDate: { stop: { gtfsId: string } | null; departureDelay: number; realtime: boolean }[] | null } | null;
      const data = await otp2.query<Record<string, Raw>>("mvkTrips", tripsRealtime(ids.slice(i, i + TRIP_RT_BATCH), ymd), {}, { priority: "high" });
      for (const t of Object.values(data)) {
        if (!t) continue;
        const list = (t.stoptimesForDate ?? []).filter((x) => x.realtime && x.stop).map((x) => ({ stopId: strip(x.stop!.gtfsId), delay: x.departureDelay ?? 0 }));
        if (list.length) out.set(strip(t.gtfsId), list);
      }
    }
    this.mvkTripRt = out;
  }

  // ── a motornak ──────────────────────────────────────────────────────────

  /** Jármű nélküli előrejelzések a snapshotnak (állomástábla; tartalékban az MVK-menetek). */
  extraPreds(): { tripId: string; stopId: string; delay: number; exact?: boolean }[] {
    const out: { tripId: string; stopId: string; delay: number; exact?: boolean }[] = [];
    const now = Date.now();
    const withVehicle = new Set(this.regional.map((v) => v.rtTripId));
    for (const [trip, b] of this.board) {
      if (now - b.at > STALE_MS * 3) {
        this.board.delete(trip);
        continue;
      }
      if (!withVehicle.has(trip)) out.push({ tripId: trip, stopId: b.stopId, delay: b.delay });
    }
    if (this.fallback) for (const [trip, list] of this.mvkTripRt) for (const x of list) out.push({ tripId: trip, stopId: x.stopId, delay: x.delay, exact: true });
    return out;
  }

  /** A regionális járművek (frissek). */
  vehicles(): RtVehicle[] {
    return Date.now() - this.at < STALE_MS ? this.regional : [];
  }

  /** Az MVK járművei az OTP2-ből (frissek)  tartalékhoz és összevetéshez. */
  mvkVehicles(): RtVehicle[] {
    return Date.now() - this.mvkAt < STALE_MS ? this.mvk : [];
  }

  platform(tripId: string, stopId: string): string | null {
    return this.platforms.get(tripId)?.get(stationKeyOf(stopId)) ?? null;
  }

  /**
   * Várható vágány, amíg a MÁV nem adta ki: ugyanez a menet a korábbi napokon, különben a vonal
   * ugyanabba az irányba induló menetei (a mai kiadottakkal együtt). Csak egyértelmű többségnél.
   */
  predictedPlatform(tripId: string, stopId: string): string | null {
    const station = stationKeyOf(stopId);
    const own = pickPlatform(this.platformHistory.get(`${tripId}|${station}`), OWN_PLATFORM);
    if (own) return own;
    const feed = this.feeds.cachedDay(serviceClock().iso)?.feed;
    const key = feed ? platformLineKey(feed, tripId, station) : null;
    return key ? pickPlatform(this.linePlatforms()?.get(key), LINE_PLATFORM) : null;
  }

  /** A vonal-szintű vágány-számlálók: az előzmények és a mai kiadott vágányok a mai menetrendre vetítve. */
  private linePlatforms(): Map<string, Map<string, number>> | null {
    const iso = serviceClock().iso;
    const c = this.linePlatformCache;
    if (c && c.iso === iso && Date.now() - c.at < LINE_PLATFORM_TTL_MS) return c.map;
    const feed = this.feeds.cachedDay(iso)?.feed;
    if (!feed) return null;
    const map = new Map<string, Map<string, number>>();
    for (const [k, counts] of this.platformHistory) {
      const [trip, station] = k.split("|");
      const key = platformLineKey(feed, trip, station);
      if (key) for (const [p, n] of counts) bumpPlatform(map, key, p, n);
    }
    for (const [trip, m] of this.platforms) {
      for (const [station, p] of m) {
        const key = platformLineKey(feed, trip, station);
        if (key) bumpPlatform(map, key, p);
      }
    }
    this.linePlatformCache = { at: Date.now(), iso, map };
    return map;
  }

  /** A korábbi napok kiadott vágányai (az elmúlt 6 hét, a mai nap nélkül)  induláskor és napváltáskor. */
  async loadPlatformHistory(): Promise<void> {
    const rows = await sql<{ t: string; s: string; p: string; n: number }>(
      `SELECT trip_id AS t, regexp_replace(stop_id, '_[^_:]+$', '') AS s, platform AS p, count(DISTINCT service_date)::int AS n
         FROM transit_platform
        WHERE service_date >= CURRENT_DATE - $1::int AND service_date < CURRENT_DATE
        GROUP BY 1, 2, 3`,
      [PLATFORM_HISTORY_DAYS],
    );
    const history = new Map<string, Map<string, number>>();
    for (const r of rows) bumpPlatform(history, `${r.t}|${r.s}`, r.p, r.n);
    this.platformHistory = history;
    this.linePlatformCache = null;
    log.info("otp2", `vágány-előzmények: ${history.size} menet–állomás pár (${PLATFORM_HISTORY_DAYS} nap)`);
  }

  noticesOf(tripId: string): string[] | null {
    const n = this.notices.get(tripId);
    return n?.length ? n.map((x) => x.text) : null;
  }

  noticeList(tripId: string): Notice[] {
    return this.notices.get(tripId) ?? [];
  }

  /** Napváltáskor a mai nap állapota törlődik. */
  rollDay() {
    this.cancelled.clear();
    this.platforms.clear();
    this.linePlatformCache = null;
    if (this.enabled && config.otp2.regional) void this.loadPlatformHistory().catch((e) => log.warn("otp2", "a vágány-előzmények betöltése sikertelen", errMsg(e)));
    this.board.clear();
    this.persistedPlatform.clear();
    this.persistedNotice.clear();
  }

  private async persistNotices() {
    const day = serviceClock().iso;
    const feed = this.feeds.cachedDay(day)?.feed;
    const rows: [string, string, string | null, string | null, string, NoticeKind][] = [];
    for (const [trip, list] of this.notices) {
      const t = feed?.trips.get(trip);
      if (!t) continue;
      for (const n of list) {
        const k = `${trip}|${n.text}`;
        rows.push([day, trip, feed?.routes.get(t.routeId)?.key ?? null, isRailTrip(t) ? trainParts(t.shortName).no : null, n.text, n.kind]);
        this.persistedNotice.add(k);
      }
    }
    if (!rows.length) return;
    await getPool().query(
      `INSERT INTO transit_notice (service_date, trip_id, route_short, train_no, text, kind, first_seen, last_seen)
       SELECT d::date, t, r, n, x, k, now(), now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u(d, t, r, n, x, k)
       ON CONFLICT (service_date, trip_id, text) DO UPDATE SET last_seen = now()`,
      [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3]), rows.map((r) => r[4]), rows.map((r) => r[5])],
    );
  }

  private async persistPlatforms() {
    const day = serviceClock().iso;
    const feed = this.feeds.cachedDay(day)?.feed;
    const rows: [string, string, string, string | null][] = [];
    for (const [trip, m] of this.platforms) {
      for (const [stop, plat] of m) {
        const k = `${trip}|${stop}`;
        if (this.persistedPlatform.get(k) === plat) continue;
        this.persistedPlatform.set(k, plat);
        // a menetrendi vágány / kocsiállás: a menet ezen az állomáson álló megállójáé
        const sched = feed?.tripStops.get(trip)?.find((x) => stationKeyOf(x.stopId) === stop);
        rows.push([trip, stop, plat, (sched ? feed?.stops.get(sched.stopId)?.platform : null) ?? null]);
      }
    }
    if (rows.length) {
      await getPool().query(
        `INSERT INTO transit_platform (service_date, trip_id, stop_id, platform, sched_platform, first_seen, last_seen)
         SELECT $1::date, t, s, p, sp, now(), now() FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS u(t, s, p, sp)
         ON CONFLICT (service_date, trip_id, stop_id) DO UPDATE SET platform = EXCLUDED.platform, last_seen = now()`,
        [day, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3])],
      );
    }
    if (this.cancelled.size) {
      await getPool().query(
        `INSERT INTO cancelled_trip (service_date, trip_id, first_seen, last_seen, samples)
         SELECT $1::date, t, now(), now(), 1 FROM unnest($2::text[]) AS t
         ON CONFLICT (service_date, trip_id) DO UPDATE SET last_seen = now(), samples = cancelled_trip.samples + 1`,
        [day, [...this.cancelled]],
      );
    }
  }

  status() {
    return {
      enabled: this.enabled,
      regional: config.otp2.regional,
      fallback: this.fallback,
      at: this.at ? new Date(this.at).toISOString() : null,
      mvkAt: this.mvkAt ? new Date(this.mvkAt).toISOString() : null,
      error: this.error,
      vehicles: this.regional.length,
      mvkVehicles: this.mvk.length,
      hotStations: this.hot.size,
      cancelled: this.cancelled.size,
      alerts: this.alerts.length,
      client: otp2.stats,
      stats: this.stats,
    };
  }
}
