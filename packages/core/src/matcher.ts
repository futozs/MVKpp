/**
 * Folyamatos menet-illesztő: GPS-pontokból valós időben megálló-események.
 *
 * Miért nem batch, mint a régi worker?
 *  - A régi rendszerben a closer és a matcher két külön időzítőn futott, és
 *    a closer lezárta a frissen nyitott menetet, mielőtt a pontjai megkapták
 *    volna a run_id-t (2693 hamis „menet közben elhallgatott” két hónap alatt).
 *  - Az indulási idő csak a lezáráskor (10+ perc csend után) lett ismert.
 *
 * Itt egyetlen, egyszálú állapotgép dolgoz járművenként. Az indulás a
 * végállomás elhagyásának pillanatában, a beérkezés az utolsó megálló
 * elérésekor kiderül. Ugyanez a kód fut élőben és a múltbeli adatok
 * újraszámolásakor, így a kettő mindig ugyanazt az eredményt adja.
 */
import type { ProjectedShape } from "./geo.ts";
import { fastDistM } from "./geo.ts";
import type { Feed, StopAlong, Trip } from "./gtfs/feed.ts";
import type { ServiceDay } from "./gtfs/service.ts";
import { resolveTrip } from "./gtfs/service.ts";

export const MATCH = {
  /** ennél messzebb a nyomvonaltól a pont nem számít a menethez */
  MAX_OFF_ROUTE_M: 350,
  /** megálló-zóna sugara a nyomvonal mentén */
  ZONE_M: 40,
  /** álló jármű sebességküszöbe (m/s) */
  STOPPED_MPS: 1.0,
  /** két pont közti legnagyobb hézag, amin még interpolálunk */
  MAX_INTERP_GAP_S: 600,
  /** ennyi csend után a menetet lezárjuk */
  SILENCE_CLOSE_S: 20 * 60,
  /** az utolsó megállónál ekkora távolságon belül beérkezettnek tekintjük */
  FINAL_STOP_M: 60,
  /** váltás után ennyi ideig figyeljük még, beér-e az előző menet a végállomásra */
  FINAL_GRACE_S: 6 * 60,
  /** ekkora visszaugrás a nyomvonalon GPS-zajnak számít */
  JITTER_BACK_M: 60,
  COMPLETE_SHARE: 0.8,
} as const;

export type Ping = {
  vehicleId: string;
  ts: number;
  lat: number;
  lon: number;
  speed: number | null;
  bearing: number | null;
  rtTripId: string;
};

export type EventSource = "dwell" | "pass" | "final";

export type StopEventOut = {
  runKey: string;
  serviceDate: string;
  tripId: string;
  vehicleId: string;
  routeShort: string;
  stopId: string;
  stopSeq: number;
  stopIdx: number;
  isFirst: boolean;
  isLast: boolean;
  schedArrS: number;
  schedDepS: number;
  arrTs: number;
  depTs: number | null;
  /** első megállónál az indulás, máshol az érkezés késése */
  delayS: number;
  dwellS: number | null;
  src: EventSource;
};

export type RunStatus = "running" | "complete" | "partial" | "aborted";
export type CloseReason = "final-stop" | "switched" | "silence" | "flush";

export type RunOut = {
  runKey: string;
  serviceDate: string;
  tripId: string;
  vehicleId: string;
  routeId: string;
  routeShort: string;
  dir: number;
  pattern: string;
  headsign: string;
  feedVersion: string;
  schedStartS: number;
  schedEndS: number;
  stopsTotal: number;
  stopsSeen: number;
  openedTs: number;
  lastTs: number;
  actualStart: number | null;
  actualEnd: number | null;
  startDelayS: number | null;
  endDelayS: number | null;
  /** a legutóbb mért késés (élő kijelzéshez) */
  lastDelayS: number | null;
  lastStopIdx: number | null;
  distM: number;
  maxSpeed: number;
  status: RunStatus;
  closeReason: CloseReason | null;
};

export type PingOut = Ping & { tripId: string | null; routeId: string | null; serviceDate: string | null; alongM: number | null; offM: number | null };

export interface MatcherSink {
  ping?(p: PingOut): void;
  runOpened?(run: RunOut): void;
  /** indulás, késés-változás, megálló-esemény után */
  runUpdated?(run: RunOut): void;
  runClosed?(run: RunOut): void;
  stopEvent?(ev: StopEventOut, run: RunOut): void;
  /** a jármű a megállóba ért (még nem indult el) — csak élő kijelzéshez */
  atStop?(run: RunOut, stopIdx: number, arrTs: number): void;
}

/** Az illesztőnek kell: melyik szolgáltatási nap(ok) érvényesek egy időpontban. */
export type DayProvider = (ts: number) => { day: ServiceDay; midnightUnix: number }[];

type Run = {
  out: RunOut;
  trip: Trip;
  feed: Feed;
  shape: ProjectedShape;
  along: StopAlong[];
  midnight: number;
  lastPing: { ts: number; along: number; lat: number; lon: number } | null;
  /** a legutóbbi jel szerint áll-e a jármű (megálló, lámpa, dugó) */
  lastStopped: boolean;
  progressM: number;
  /**
   * Indult-e már a menet. Ha az MVK előre vált a következő menetre, a busz
   * még az előző menetén van; az új nyomvonalra vetítve a VÉGÉRE esne, és a
   * menet tönkremenne. Ezért az új menet csak akkor „indul”, ha a jármű az
   * első megállónál van, vagy egyértelműen menet közben csatlakozott be.
   */
  started: boolean;
  pending: { ts: number; along: number }[];
  nextIdx: number;
  zone: { idx: number; arrTs: number; lastTs: number; stopped: boolean } | null;
  events: Map<number, StopEventOut>;
  onRoute: number;
  offRoute: number;
};

/** A jármű helyzete a nyomvonalon (lásd `motion`). */
export type VehicleMotion = {
  tripId: string;
  shapeId: string;
  /** a legutóbbi jel helye a nyomvonalon (m) */
  alongM: number;
  /** a legutóbbi jel ideje (unix) */
  ts: number;
  fromStopId: string | null;
  toStopId: string;
  fromAlongM: number;
  /** a következő megálló helye a nyomvonalon (m) — a becslés eddig mehet */
  toAlongM: number;
  /** a mostani szakasz menetrendi ideje (mp) */
  schedSegS: number | null;
  /** a szakasz kezdetének menetrendi ideje (a szolgáltatási nap mp-e) */
  segDepS: number;
  /** a legutóbbi jelkor állt (megállóban, lámpánál) — a becslés ne vigye tovább */
  stopped: boolean;
};

type VehicleState = {
  current: Run | null;
  /** váltás után még figyelt menet: beér-e a végállomásra */
  closing: { run: Run; since: number } | null;
  lastTs: number;
};

export class TripMatcher {
  private vehicles = new Map<string, VehicleState>();
  private days: DayProvider;
  private sink: MatcherSink;

  constructor(days: DayProvider, sink: MatcherSink = {}) {
    this.days = days;
    this.sink = sink;
  }

  /** Egy jármű következő pontja. A pontoknak járművenként időrendben kell jönniük. */
  push(p: Ping): void {
    let vs = this.vehicles.get(p.vehicleId);
    if (!vs) this.vehicles.set(p.vehicleId, (vs = { current: null, closing: null, lastTs: 0 }));
    if (p.ts <= vs.lastTs) return; // duplikátum / régi pont
    vs.lastTs = p.ts;

    if (vs.closing) this.feedClosing(vs, p);

    const resolved = this.resolve(p);
    const cur = vs.current;

    if (cur && (!resolved || resolved.trip.id !== cur.out.tripId)) {
      // Üres hint: a jármű folytathatja a menetét (az MVK néha elhagyja a tripId-t).
      if (!p.rtTripId && cur) {
        this.advance(cur, p);
        this.emitPing(p, cur);
        return;
      }
      this.beginClosing(vs, cur, p.ts);
      vs.current = null;
    }

    if (!vs.current && resolved) {
      vs.current = this.open(p, resolved);
    }

    if (vs.current) {
      this.advance(vs.current, p);
      this.emitPing(p, vs.current);
    } else this.emitPing(p, null);
  }

  /** Csend miatti lezárás; az élő worker percenként hívja, a replay a végén. */
  sweep(nowTs: number): void {
    for (const vs of this.vehicles.values()) {
      if (vs.closing && nowTs - vs.closing.since > MATCH.FINAL_GRACE_S) {
        this.finalize(vs.closing.run, "switched");
        vs.closing = null;
      }
      const cur = vs.current;
      if (cur && cur.out.status === "running" && cur.lastPing && nowTs - cur.lastPing.ts > 150 && this.inferFinalArrival(cur)) {
        this.complete(cur, "final-stop");
        continue;
      }
      if (vs.current && nowTs - (vs.current.lastPing?.ts ?? vs.current.out.openedTs) > MATCH.SILENCE_CLOSE_S) {
        this.finalize(vs.current, "silence");
        vs.current = null;
      }
    }
  }

  /** Minden nyitott menet lezárása (replay vége, leállás). */
  flush(): void {
    for (const vs of this.vehicles.values()) {
      if (vs.closing) this.finalize(vs.closing.run, "switched");
      if (vs.current) this.finalize(vs.current, "flush");
      vs.closing = null;
      vs.current = null;
    }
  }

  /** Futó menetek (élő kijelzéshez). */
  activeRuns(): RunOut[] {
    const out: RunOut[] = [];
    for (const vs of this.vehicles.values()) {
      if (vs.current?.out.status === "running") out.push(vs.current.out);
      if (vs.closing) out.push(vs.closing.run.out);
    }
    return out;
  }

  runOfTrip(tripId: string): RunOut | null {
    for (const vs of this.vehicles.values()) if (vs.current?.out.tripId === tripId) return vs.current.out;
    return null;
  }

  /**
   * Hol tart most a jármű a menete nyomvonalán (a térképi becsléshez):
   * a legutóbbi jel helye méterben, és a következő megálló a nyomvonalon.
   */
  motion(vehicleId: string): VehicleMotion | null {
    const vs = this.vehicles.get(vehicleId);
    // Az MVK gyakran percekkel korábban kiosztja a következő menetet, miközben
    // a busz még az előzőn jár: amíg az új el nem indul, a régin becslünk.
    const r = vs?.current?.started ? vs.current : vs?.closing?.run.out.status === "running" ? vs.closing.run : null;
    if (!r || !r.lastPing || !r.started) return null;
    // Még a kiinduló megállóban áll (beállt, kiosztották, de nem indult el):
    // nincs mit becsülni — különben a térképen magától elindulna.
    if (r.out.actualStart == null && r.progressM <= r.along[0].alongM + MATCH.ZONE_M) return null;
    const a = r.along;
    let next = 0;
    while (next < a.length && a[next].alongM <= r.progressM + 5) next++;
    if (next >= a.length) return null;
    return {
      tripId: r.out.tripId,
      shapeId: r.trip.shapeId,
      alongM: Math.round(r.progressM),
      ts: r.lastPing.ts,
      fromStopId: next > 0 ? a[next - 1].stopId : null,
      toStopId: a[next].stopId,
      fromAlongM: next > 0 ? Math.round(a[next - 1].alongM) : 0,
      toAlongM: Math.round(a[next].alongM),
      schedSegS: next > 0 ? a[next].arr - a[next - 1].dep : null,
      segDepS: next > 0 ? a[next - 1].dep : a[next].dep,
      stopped: r.lastStopped,
    };
  }

  /**
   * Becsült késés most, a jármű helyzetéből: a legutóbbi két megálló közötti
   * menetrendi időhöz képest. Megálló-esemény nélkül is ad értéket.
   */
  liveDelay(tripId: string, nowTs: number): number | null {
    for (const vs of this.vehicles.values()) {
      const r = vs.current;
      if (!r || r.out.tripId !== tripId || !r.lastPing) continue;
      if (nowTs - r.lastPing.ts > 180) return r.out.lastDelayS;
      const pos = r.progressM;
      const a = r.along;
      let i = 0;
      while (i < a.length - 1 && a[i + 1].alongM <= pos) i++;
      const from = a[i];
      const to = a[Math.min(i + 1, a.length - 1)];
      if (!from) return r.out.lastDelayS;
      const frac = to.alongM > from.alongM ? Math.min(1, Math.max(0, (pos - from.alongM) / (to.alongM - from.alongM))) : 0;
      // Az első megállóban állva még nincs értelmes késés: az indulásig vár.
      if (i === 0 && frac === 0 && r.out.actualStart == null) {
        const late = nowTs - (r.midnight + from.dep);
        return late > 0 ? late : null;
      }
      const sched = r.midnight + from.dep + (to.arr - from.dep) * frac;
      return Math.round(r.lastPing.ts - sched);
    }
    return null;
  }

  // ── belső ──────────────────────────────────────────────────────────────

  private resolve(p: Ping) {
    if (!p.rtTripId) return null;
    for (const dc of this.days(p.ts)) {
      const t = resolveTrip(dc.day, p.rtTripId);
      if (!t) continue;
      const along = dc.day.feed.tripStopsAlong(t.id);
      const shape = t.shapeId ? dc.day.feed.shapes.get(t.shapeId) : undefined;
      if (!along || !shape) return null;
      return { trip: t, day: dc.day, midnight: dc.midnightUnix, along, shape };
    }
    return null;
  }

  private open(p: Ping, r: NonNullable<ReturnType<TripMatcher["resolve"]>>): Run {
    const feed = r.day.feed;
    const route = feed.routes.get(r.trip.routeId);
    const out: RunOut = {
      runKey: `${r.day.iso}|${r.trip.id}|${p.vehicleId}`,
      serviceDate: r.day.iso,
      tripId: r.trip.id,
      vehicleId: p.vehicleId,
      routeId: r.trip.routeId,
      routeShort: route?.short ?? r.trip.routeId,
      dir: Number(r.trip.dir) || 0,
      pattern: feed.patternHash(r.trip.id) ?? "",
      headsign: r.trip.headsign,
      feedVersion: feed.version,
      schedStartS: r.along[0].dep,
      schedEndS: r.along[r.along.length - 1].arr,
      stopsTotal: r.along.length,
      stopsSeen: 0,
      openedTs: p.ts,
      lastTs: p.ts,
      actualStart: null,
      actualEnd: null,
      startDelayS: null,
      endDelayS: null,
      lastDelayS: null,
      lastStopIdx: null,
      distM: 0,
      maxSpeed: 0,
      status: "running",
      closeReason: null,
    };
    const run: Run = {
      out,
      trip: r.trip,
      feed,
      shape: r.shape,
      along: r.along,
      midnight: r.midnight,
      lastPing: null,
      lastStopped: false,
      progressM: 0,
      started: false,
      pending: [],
      nextIdx: 0,
      zone: null,
      events: new Map(),
      onRoute: 0,
      offRoute: 0,
    };
    this.sink.runOpened?.(out);
    return run;
  }

  private advance(run: Run, p: Ping): void {
    run.out.lastTs = p.ts;
    if (p.speed != null && p.speed > run.out.maxSpeed) run.out.maxSpeed = p.speed;
    if (run.out.status !== "running") return; // már beért, csak a végállomáson áll
    run.lastStopped = p.speed != null && p.speed <= MATCH.STOPPED_MPS;

    const proj = this.projectRun(run, p);
    if (!proj || proj.distM > MATCH.MAX_OFF_ROUTE_M) {
      run.offRoute++;
      return;
    }
    run.onRoute++;

    if (!run.started) {
      const first = run.along[0];
      const dFirst = fastDistM(p.lat, p.lon, ...this.stopLatLon(run, 0));
      if (proj.alongM <= first.alongM + MATCH.ZONE_M || dFirst <= 150) {
        run.started = true;
      } else {
        // Menet közbeni becsatlakozás: 3 egymást követő, előre haladó pont kell.
        run.pending.push({ ts: p.ts, along: proj.alongM });
        if (run.pending.length > 4) run.pending.shift();
        const q = run.pending;
        const n = q.length;
        const increasing = n >= 3 && q[n - 1].along > q[n - 2].along && q[n - 2].along > q[n - 3].along;
        if (!increasing || q[n - 1].along - q[n - 3].along < 200 || q[n - 1].ts - q[n - 3].ts > 300) return;
        run.started = true;
        const base = q[n - 2];
        run.lastPing = { ts: base.ts, along: base.along, lat: p.lat, lon: p.lon };
        run.progressM = base.along;
        while (run.nextIdx < run.along.length - 1 && run.along[run.nextIdx].alongM - MATCH.ZONE_M <= base.along) run.nextIdx++;
      }
    }

    const prev = run.lastPing;
    // Monoton haladás: kis visszaugrás zaj, nagy visszaugrás = valószínűleg rossz vetítés.
    let along = proj.alongM;
    if (prev && along < run.progressM) {
      if (run.progressM - along > MATCH.JITTER_BACK_M) return;
      along = run.progressM;
    }
    const stopped = (p.speed ?? 99) <= MATCH.STOPPED_MPS;

    if (prev && along > prev.along) run.out.distM += along - prev.along;

    this.passStops(run, prev, { ts: p.ts, along }, stopped);
    run.lastPing = { ts: p.ts, along, lat: p.lat, lon: p.lon };
    run.progressM = Math.max(run.progressM, along);

    // Utolsó megálló: amint a zónába ér, a menet kész — nem várunk 10 perc csendre.
    const lastIdx = run.along.length - 1;
    const last = run.along[lastIdx];
    const enter = last.alongM - MATCH.ZONE_M;
    const distToLast = fastDistM(p.lat, p.lon, ...this.stopLatLon(run, lastIdx));
    if (!run.events.has(lastIdx) && run.nextIdx >= lastIdx - 1 && (along >= enter || distToLast <= MATCH.FINAL_STOP_M)) {
      this.closeZoneIfOpen(run, p.ts);
      const arrTs = prev && prev.along < enter && along >= enter && p.ts - prev.ts <= MATCH.MAX_INTERP_GAP_S ? interpolate(prev, { ts: p.ts, along }, enter) : p.ts;
      this.recordEvent(run, lastIdx, arrTs, null, "dwell");
      this.complete(run, "final-stop");
    }
  }

  /**
   * Vetítés a menet nyomvonalára. Ha már halad, előre az ELSŐ illeszkedő
   * helyet keressük egy reális sebességkorláton belül: az önmaga közelében
   * elhaladó nyomvonalaknál (oda-vissza utca, hurok) a legközelebbi pont
   * gyakran a nyomvonal egy későbbi részén van, ami hamis áthaladást okozna.
   */
  private projectRun(run: Run, p: Ping) {
    const lp = run.lastPing;
    if (!lp) return run.shape.project(p.lat, p.lon, 0, 300, 5000);
    const maxAdvance = Math.max(0, p.ts - lp.ts) * 25 + 250;
    const fwd = run.shape.projectForward(p.lat, p.lon, Math.max(0, run.progressM - MATCH.JITTER_BACK_M), 40, 0);
    if (fwd && fwd.alongM <= run.progressM + maxAdvance) return fwd;
    return run.shape.project(p.lat, p.lon, run.progressM, 300, maxAdvance);
  }

  /**
   * A végállomáson gyakran nincs GPS-pont (a jármű elnémul vagy azonnal a
   * következő menetre vált). Ha az utolsó ismert helyzet közel volt a
   * végállomáshoz, a beérkezést a hátralévő távolságból becsüljük.
   */
  private inferFinalArrival(run: Run): boolean {
    const lastIdx = run.along.length - 1;
    if (run.events.has(lastIdx) || !run.lastPing || run.nextIdx < lastIdx) return false;
    const remaining = run.along[lastIdx].alongM - run.progressM;
    if (remaining > 450) return false;
    const speed = Math.max(5, Math.min(12, run.out.maxSpeed || 8));
    const arrTs = run.lastPing.ts + Math.round(Math.max(0, remaining - MATCH.ZONE_M) / speed);
    this.closeZoneIfOpen(run, arrTs);
    this.recordEvent(run, lastIdx, arrTs, null, "final");
    return run.events.has(lastIdx);
  }

  /** Megállók, amelyeken a jármű az előző és a mostani pont között áthaladt / megállt. */
  private passStops(run: Run, prev: { ts: number; along: number } | null, cur: { ts: number; along: number }, stopped: boolean) {
    const a = run.along;
    // A zóna (aktuális megálló) kezelése: amíg benne van, frissítjük; ha kilépett, kiírjuk.
    if (run.zone) {
      const z = a[run.zone.idx];
      if (cur.along <= z.alongM + MATCH.ZONE_M) {
        run.zone.lastTs = cur.ts;
        run.zone.stopped ||= stopped;
        return;
      }
      const depTs = prev && prev.along < z.alongM + MATCH.ZONE_M ? interpolate(prev, cur, z.alongM + MATCH.ZONE_M) : run.zone.lastTs;
      this.recordEvent(run, run.zone.idx, run.zone.arrTs, Math.max(run.zone.arrTs, depTs), run.zone.stopped ? "dwell" : "pass");
      run.zone = null;
    }

    // Az utolsó megállót az advance() kezeli (az lezárja a menetet).
    while (run.nextIdx < a.length - 1) {
      const s = a[run.nextIdx];
      // Az első megállónál a jármű a zónán belül indul (végállomási várakozás).
      const enter = s.alongM - MATCH.ZONE_M;
      if (cur.along < enter) break;
      const gapOk = !prev || cur.ts - prev.ts <= MATCH.MAX_INTERP_GAP_S;
      if (cur.along <= s.alongM + MATCH.ZONE_M) {
        // A zónában van: érkezés most (vagy interpolálva a zóna határára).
        const arrTs = prev && gapOk && prev.along < enter ? interpolate(prev, cur, enter) : cur.ts;
        run.zone = { idx: run.nextIdx, arrTs, lastTs: cur.ts, stopped };
        if (run.nextIdx === 0 && !prev) run.zone.arrTs = cur.ts;
        this.sink.atStop?.(run.out, run.nextIdx, arrTs);
        run.nextIdx++;
        break;
      }
      // Átsuhant a megállón két pont között.
      if (prev && gapOk) {
        const t = interpolate(prev, cur, s.alongM);
        this.recordEvent(run, run.nextIdx, t, t, "pass");
      }
      run.nextIdx++;
    }
  }

  private closeZoneIfOpen(run: Run, ts: number) {
    if (!run.zone) return;
    this.recordEvent(run, run.zone.idx, run.zone.arrTs, Math.max(run.zone.arrTs, run.zone.lastTs), run.zone.stopped ? "dwell" : "pass");
    run.zone = null;
    void ts;
  }

  private recordEvent(run: Run, idx: number, arrTs: number, depTs: number | null, src: EventSource) {
    if (run.events.has(idx)) return;
    const s = run.along[idx];
    const isFirst = idx === 0;
    const isLast = idx === run.along.length - 1;
    const schedArr = run.midnight + s.arr;
    const schedDep = run.midnight + s.dep;
    // Az első megállónál az indulás számít (a busz korábban beállhat a végállomásra).
    const delayS = isFirst ? (depTs ?? arrTs) - schedDep : arrTs - schedArr;
    if (Math.abs(delayS) > 3 * 3600) return; // nem ez a menet / nem ez a nap
    const ev: StopEventOut = {
      runKey: run.out.runKey,
      serviceDate: run.out.serviceDate,
      tripId: run.out.tripId,
      vehicleId: run.out.vehicleId,
      routeShort: run.out.routeShort,
      stopId: s.stopId,
      stopSeq: s.seq,
      stopIdx: idx,
      isFirst,
      isLast,
      schedArrS: s.arr,
      schedDepS: s.dep,
      arrTs,
      depTs,
      delayS: Math.round(delayS),
      dwellS: depTs != null ? Math.max(0, depTs - arrTs) : null,
      src,
    };
    run.events.set(idx, ev);
    run.out.stopsSeen = run.events.size;
    run.out.lastDelayS = ev.delayS;
    run.out.lastStopIdx = idx;
    if (isFirst) {
      run.out.actualStart = depTs ?? arrTs;
      run.out.startDelayS = ev.delayS;
    } else if (run.out.actualStart == null) {
      // Az első megállót nem láttuk (pl. már menet közben kapcsolt be): az első esemény az indulás.
      run.out.actualStart = arrTs;
    }
    if (isLast) {
      run.out.actualEnd = arrTs;
      run.out.endDelayS = ev.delayS;
    }
    this.sink.stopEvent?.(ev, run.out);
    this.sink.runUpdated?.(run.out);
  }

  private complete(run: Run, reason: CloseReason) {
    run.out.status = "complete";
    run.out.closeReason = reason;
    this.sink.runClosed?.(run.out);
  }

  private beginClosing(vs: VehicleState, run: Run, ts: number) {
    if (run.out.status !== "running") return; // már kész (végállomáson beért)
    if (vs.closing) this.finalize(vs.closing.run, "switched");
    this.closeZoneIfOpen(run, ts);
    vs.closing = { run, since: ts };
  }

  /**
   * Váltás után: a régi menet még kapja a pontokat (a hátralévő megállóihoz),
   * és ha a jármű a végállomására ér, az a beérkezés.
   */
  private feedClosing(vs: VehicleState, p: Ping) {
    const c = vs.closing!;
    const run = c.run;
    this.advance(run, p);
    if (run.out.status !== "running") {
      vs.closing = null;
      return;
    }
    const lastIdx = run.along.length - 1;
    if (!run.events.has(lastIdx)) {
      const d = fastDistM(p.lat, p.lon, ...this.stopLatLon(run, lastIdx));
      const coveredEnough = run.nextIdx >= Math.floor(lastIdx * MATCH.COMPLETE_SHARE);
      if (d <= MATCH.FINAL_STOP_M && coveredEnough) {
        this.recordEvent(run, lastIdx, p.ts, null, "final");
        this.complete(run, "final-stop");
        vs.closing = null;
        return;
      }
    }
    if (p.ts - c.since > MATCH.FINAL_GRACE_S) {
      this.finalize(run, "switched");
      vs.closing = null;
    }
  }

  private finalize(run: Run, reason: CloseReason) {
    if (run.out.status !== "running") return;
    this.closeZoneIfOpen(run, run.out.lastTs);
    if (this.inferFinalArrival(run)) {
      this.complete(run, "final-stop");
      return;
    }
    const seen = run.events.size;
    run.out.status = seen === 0 ? "aborted" : seen >= run.along.length * MATCH.COMPLETE_SHARE ? "complete" : "partial";
    run.out.closeReason = reason;
    this.sink.runClosed?.(run.out);
  }

  private stopLatLon(run: Run, idx: number): [number, number] {
    const s = run.feed.stops.get(run.along[idx].stopId);
    return s ? [s.lat, s.lon] : run.shape.pointAt(run.along[idx].alongM);
  }

  private emitPing(p: Ping, run: Run | null) {
    if (!this.sink.ping) return;
    this.sink.ping({
      ...p,
      tripId: run?.out.tripId ?? null,
      routeId: run?.out.routeId ?? null,
      serviceDate: run?.out.serviceDate ?? null,
      alongM: run?.lastPing ? Math.round(run.progressM) : null,
      offM: null,
    });
  }
}

function interpolate(a: { ts: number; along: number }, b: { ts: number; along: number }, at: number): number {
  if (b.along <= a.along) return b.ts;
  const t = Math.min(1, Math.max(0, (at - a.along) / (b.along - a.along)));
  return Math.round(a.ts + t * (b.ts - a.ts));
}
