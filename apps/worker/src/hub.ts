/**
 * WebSocket-hub: a szerver küldi az adatot, a kliens nem kérdez.
 *
 * Témák (a kliens iratkozik fel):
 *   vehicles         minden jármű; induláskor teljes lista, utána csak a változás
 *   stop:<stopId>    a megálló érkezési táblája; csak ha tényleg változott
 *   trip:<tripId>    egy menet élő állapota (hol tart, késés)
 *   runs:<YYYYMMDD>  a mai menetrend-napló (indult / beért), menetenként azonnal
 *   parking          a parkoló: ki áll melyik végállomáson, ki van a kocsiszínben
 *   sync             a bejelentkezett felhasználó más eszközön mentett beállításai
 *
 * Üzenetformátum: JSON, permessage-deflate tömörítéssel.
 */
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  isMvkId,
  MVK_MODES,
  nowUnix,
  parseModes,
  parseStopMerge,
  progressOnTrip,
  serviceClock,
  stopTwinsOf,
  type DecodedVehicle,
  type RunOut,
  type StopMerge,
  type TransitMode,
  type VehicleMotion,
} from "@mvk/core";
import { vehicleMode } from "./http/compat.ts";
import { sql } from "@mvk/db";
import { sha256Hex } from "@mvk/db/crypto";
import type { Engine } from "./engine.ts";
import { journalRecord } from "./http/compat.ts";
import { errMsg, log } from "./log.ts";
import type { DelayForecaster } from "./forecast.ts";
import type { TripInsights } from "./insights.ts";
import type { MotionPredictor } from "./motion/live.ts";
import type { Parking } from "./parking.ts";
import type { VehiclePredictor } from "./predict.ts";

type Client = { ws: WebSocket; topics: Set<string>; userId: string | null; deviceId: string | null; alive: boolean };

const MAX_TOPICS = 40;
const STOP_LIMIT = 10;
/** ha a jármű legutóbbi jele ennyivel frissebb, mint amit az illesztő felhasznált, nincs becslés (mp) */
const MOTION_STALE_S = 45;
/** a régi (modell nélküli) térképi pálya: ennyi megállón át, legfeljebb ennyi másodpercre előre */
const TRAJ_STOPS = 5;
const TRAJ_HORIZON_S = 240;
/** álló busznál (megálló, lámpa) a pálya ennyi várakozással indul  a következő jel úgyis jön */
const TRAJ_STOPPED_HOLD_S = 12;
/** a becsült sebesség plafonja módonként (m/s): városi busz/villamos, helyközi busz, vonat */
const SPEED_CAP: Record<TransitMode, number> = { tram: 22, bus: 22, coach: 30, rail: 45 };
/** `vehicles@tram,bus,coach,rail`, `stop:<id>@…`  a régi téma (mód nélkül) csak MVK */
const MODES_RE = "(?:@(?:tram|bus|coach|rail)(?:,(?:tram|bus|coach|rail))*)?";
/** a megállótábla témája a közös megállók összevonásával: `stop:<id>@<módok>~all` (lásd `mergedBoard`) */
const MERGE_RE = "(?:~(?:all|mvk|coach|off))?";
const TOPIC_RE = new RegExp(`^(vehicles${MODES_RE}|sync|parking|stop:[\\w:.-]+${MODES_RE}${MERGE_RE}|trip:[\\w:.-]+|runs:\\d{8})$`);

/** Feliratkozható-e a téma (minden más csendben eldobódik). */
export const isTopic = (t: string) => TOPIC_RE.test(t);

/** „stop:1:005511387@rail,tram” → { id, modes } */
/** `stop:<id>`, `stop:<id>@<módok>` vagy `stop:<id>@<módok>~<összevonás>` (közös megállók, lásd `mergedBoard`) */
function splitTopic(rest: string): { id: string; modes: Set<TransitMode>; rich: boolean; merge: StopMerge } {
  const at = rest.lastIndexOf("@");
  if (at < 0) return { id: rest, modes: new Set(MVK_MODES), rich: false, merge: "off" };
  const [modes, merge] = rest.slice(at + 1).split("~");
  return { id: rest.slice(0, at), modes: parseModes(modes), rich: true, merge: parseStopMerge(merge) };
}

export class Hub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private lastVehicles = new Map<string, string>();
  private lastSent = new Map<string, string>(); // téma → utolsó küldött tartalom (változásfigyeléshez)
  private engine: Engine;
  private predictor: VehiclePredictor;
  private parking: Parking;
  private forecaster: DelayForecaster;
  private motion: MotionPredictor;
  /** járművenként az utolsó jel helye/ideje és a simított tempó (a régi pályához) */
  private pace = new Map<string, { trip: string; a: number; t: number; pace: number }>();
  private insights: TripInsights;
  stats = { connections: 0, messages: 0 };

  constructor(server: Server, engine: Engine, predictor: VehiclePredictor, parking: Parking, forecaster: DelayForecaster, insights: TripInsights, motion: MotionPredictor) {
    this.engine = engine;
    this.motion = motion;
    this.insights = insights;
    this.predictor = predictor;
    this.parking = parking;
    this.forecaster = forecaster;
    this.wss = new WebSocketServer({ server, path: "/ws", perMessageDeflate: { threshold: 512 }, maxPayload: 64 * 1024 });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    engine.on("tick", () => this.onTick());
    engine.on("run", (r) => this.onRun(r));
    engine.on("stopEvent", (e) => this.refreshStop(e.stopId));
    engine.on("atStop", (r, idx) => {
      const stopId = this.engine.feeds.cachedDay(r.serviceDate)?.feed.tripStopsAlong(r.tripId)?.[idx]?.stopId;
      if (stopId) this.refreshStop(stopId);
    });
    setInterval(() => this.heartbeat(), 25_000).unref();
  }

  private onConnection(ws: WebSocket, _req: IncomingMessage) {
    const c: Client = { ws, topics: new Set(), userId: null, deviceId: null, alive: true };
    this.clients.add(c);
    this.stats.connections++;
    ws.on("pong", () => (c.alive = true));
    ws.on("close", () => this.clients.delete(c));
    ws.on("error", () => this.clients.delete(c));
    ws.on("message", (raw) => {
      let msg: { t?: string; topics?: unknown; token?: string; deviceId?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.handle(c, msg).catch((e) => log.warn("hub", "üzenetkezelési hiba", errMsg(e)));
    });
    this.send(c, { t: "hello", now: nowUnix(), serviceDate: this.engine.today });
  }

  private async handle(c: Client, msg: { t?: string; topics?: unknown; token?: string; deviceId?: string }) {
    if (msg.t === "ping") return this.send(c, { t: "pong", now: nowUnix() });
    if (msg.t === "auth" && typeof msg.token === "string") {
      const r = await sql<{ user_id: string }>(`SELECT user_id FROM user_session WHERE token_hash = $1 AND expires_at > now()`, [sha256Hex(msg.token)]);
      c.userId = r[0]?.user_id ?? null;
      c.deviceId = typeof msg.deviceId === "string" ? msg.deviceId.slice(0, 64) : null;
      return this.send(c, { t: "auth", ok: Boolean(c.userId) });
    }
    const topics = Array.isArray(msg.topics) ? msg.topics.filter((x): x is string => typeof x === "string" && x.length < 120) : [];
    if (msg.t === "sub") {
      for (const t of topics) {
        if (c.topics.size >= MAX_TOPICS) break;
        if (!isTopic(t)) continue;
        c.topics.add(t);
        await this.initial(c, t);
      }
    } else if (msg.t === "unsub") for (const t of topics) c.topics.delete(t);
  }

  /** Feliratkozáskor azonnal a teljes állapot. */
  private async initial(c: Client, topic: string) {
    if (topic === "vehicles" || topic.startsWith("vehicles@")) {
      const keep = this.vehicleFilter(topic);
      return this.send(c, { t: "vehicles", topic, full: this.engine.snapshot.decoded.filter(keep).map((v) => this.withMotion(v)), at: this.engine.snapshot.fetchedAt });
    }
    if (topic === "parking") return this.send(c, { t: "parking", id: "", data: this.parking.snapshot() });
    if (topic.startsWith("stop:")) return this.send(c, { t: "stop", topic, id: splitTopic(topic.slice(5)).id, data: this.stopData(topic.slice(5)) });
    if (topic.startsWith("trip:")) return this.send(c, { t: "trip", id: topic.slice(5), data: this.tripData(topic.slice(5)) });
    if (topic.startsWith("runs:")) {
      const ymd = topic.slice(5);
      if (ymd !== this.engine.today.replace(/-/g, "")) return;
      const now = nowUnix();
      const trips: Record<string, unknown> = {};
      for (const [id, r] of this.engine.todayRuns) trips[id] = journalRecord(r, this.engine.matcher.liveDelay(id, now));
      return this.send(c, { t: "runs", date: ymd, full: trips });
    }
  }

  /** `stop:<id>` vagy `stop:<id>@modes` téma adata (a régi téma csak MVK) */
  private stopData(rest: string) {
    const { id, modes, rich, merge } = splitTopic(rest);
    return this.insights.arrivals(id, rich ? STOP_LIMIT * 2 : STOP_LIMIT, nowUnix(), modes, rich, merge);
  }

  /** Melyik jármű megy egy `vehicles` témára (mód nélkül: csak az MVK-é, mint eddig). */
  private vehicleFilter(topic: string): (v: DecodedVehicle) => boolean {
    if (topic === "vehicles") return (v) => isMvkId(v.id);
    const { modes } = splitTopic(topic);
    const feed = this.engine.feeds.cachedDay(this.engine.today)?.feed;
    return (v) => modes.has(vehicleMode(v, feed));
  }

  private tripData(tripId: string) {
    const feed = this.engine.feeds.cachedDay(this.engine.today)?.feed;
    const v = this.engine.snapshot.vehicles.find((x) => x.tripId === tripId);
    const run = this.engine.todayRuns.get(tripId) ?? null;
    const prog = v && feed ? progressOnTrip(feed, tripId, v, serviceClock().secOfDay) : null;
    return {
      tripId,
      live: Boolean(v),
      vehicle: v ?? null,
      progress: prog,
      run,
      measuredDelaySec: this.engine.matcher.liveDelay(tripId, nowUnix()),
      forecast: this.forecaster.forTrip(tripId),
    };
  }

  private subscribers(topic: string): Client[] {
    const out: Client[] = [];
    for (const c of this.clients) if (c.topics.has(topic)) out.push(c);
    return out;
  }

  /**
   * A jármű mozgásállapota a térképi becsléshez (rövid kulcsokkal):
   * s = nyomvonal, a = hol tart (m), t = a jel ideje, e = a következő megálló (m),
   * v = várható sebesség (m/s), k = a várható pálya (ezt követi a térkép).
   * A pálya a tanított mozgás-modelltől jön; amíg nincs modell, a régi becslés.
   */
  private motionOf(veh: DecodedVehicle, offset: number) {
    const m = this.engine.matcher.motion(veh.id);
    if (!m) return null;
    // Az illesztő régóta nem tudta a jeleit a nyomvonalra tenni (terelés, rossz vetítés):
    // a becslés a következő megállónál tartaná a buszt  inkább a valós helye látszik.
    if (veh.timestamp && veh.timestamp - offset - m.ts > MOTION_STALE_S) return null;
    const gpsSpeed = veh.speed;
    const run = this.engine.todayRuns.get(m.tripId);
    const serviceDate = run?.serviceDate ?? this.engine.today;
    const mvk = isMvkId(veh.id);
    const cap = SPEED_CAP[vehicleMode(veh, this.engine.feeds.cachedDay(serviceDate)?.feed)];
    const segV = mvk ? this.forecaster.segmentSpeed(m, serviceDate) : null;
    // A tanított mozgás-modell az MVK-ra tanult: a Volánnál és a vonatnál a menetrendi tempó viszi.
    const k = (mvk ? this.motion.trajectory(veh.id, m, serviceDate, nowUnix()) : null) ?? this.trajectoryOf(veh.id, m, serviceDate, segV, cap);
    // Álló busznál (megálló, lámpa) a régi kliens a jel helyén tartja; a pálya (k) ilyenkor egy rövid várakozással indul.
    if (m.stopped) return { s: m.shapeId, a: m.alongM, t: m.ts, e: m.toAlongM, v: 0, k };
    const v = segV ?? (m.schedSegS && m.schedSegS > 0 ? (m.toAlongM - m.fromAlongM) / m.schedSegS : null) ?? gpsSpeed ?? 6;
    return { s: m.shapeId, a: m.alongM, t: m.ts, e: m.toAlongM, v: Math.round(Math.min(cap, Math.max(1.5, v)) * 10) / 10, k };
  }

  /**
   * Régi pálya (csak amíg nincs tanított mozgás-modell, pl. az első telepítés utáni ~15 percben):
   * szakaszonként a szokásos menetsebesség a busz tempójával, megállónként az átlagos álldogálás.
   * Visszamérve 60–70 m átlagos hibával megy (az álló buszt 12 mp után elindítja)  a modell ~25 m.
   */
  private trajectoryOf(vehicleId: string, m: VehicleMotion, serviceDate: string, segV: number | null, cap = 22): [number, number][] | null {
    const stops = this.engine.feeds.cachedDay(serviceDate)?.feed.tripStopsAlong(m.tripId);
    if (!stops?.length) return null;
    const pace = this.paceOf(vehicleId, m, segV);
    let n = 0;
    while (n < stops.length && stops[n].alongM <= m.alongM + 5) n++;
    const k: [number, number][] = [[m.alongM, 0]];
    let pos = m.alongM;
    let t = 0;
    if (m.stopped) {
      t += TRAJ_STOPPED_HOLD_S;
      k.push([pos, t]);
    }
    for (let i = n; i < stops.length && i < n + TRAJ_STOPS && t < TRAJ_HORIZON_S; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      // a regionális menetnél nincs szakaszprofil: a menetrend szerinti tempó
      const sched = a && b.arr > a.dep ? (b.alongM - a.alongM) / (b.arr - a.dep) : null;
      const base = a ? (isMvkId(vehicleId) ? this.forecaster.speedBetween(a, b, serviceDate) : sched) : segV;
      const v = Math.min(cap, Math.max(2, (base ?? 8) * pace));
      t += Math.max(0, b.alongM - pos) / v;
      k.push([b.alongM, t]);
      pos = b.alongM;
      const d = i === stops.length - 1 ? 0 : isMvkId(vehicleId) ? this.forecaster.expectedDwell(b.stopId, serviceDate, b.dep) : Math.max(0, b.dep - b.arr);
      if (d >= 1) {
        t += d;
        k.push([pos, t]);
      }
    }
    return k.map(([x, s]) => [Math.round(x), Math.round(s * 10) / 10]);
  }

  /** A busz tempója a szokásos menetsebességhez képest (0,7–1,3), az utolsó jelek közötti haladásból simítva. */
  private paceOf(vehicleId: string, m: VehicleMotion, segV: number | null): number {
    const prev = this.pace.get(vehicleId);
    if (prev && prev.t === m.ts) return prev.pace;
    let pace = prev?.pace ?? 1;
    if (prev && prev.trip === m.tripId && m.ts > prev.t && m.ts - prev.t <= 60 && !m.stopped && segV && segV > 1) {
      const obs = (m.alongM - prev.a) / (m.ts - prev.t);
      if (obs > 0.5) pace = 0.5 * pace + 0.5 * Math.min(1.3, Math.max(0.7, obs / segV));
    } else if (!prev || prev.trip !== m.tripId) pace = 1;
    this.pace.set(vehicleId, { trip: m.tripId, a: m.alongM, t: m.ts, pace });
    if (this.pace.size > 2000) this.pace.clear();
    return pace;
  }

  /** `offset`: a feed helyi idős időbélyegeinek eltolása (egy körön belül állandó) */
  private withMotion(v: DecodedVehicle, offset = serviceClock().offset) {
    // a saját illesztőnk mért késése (a térkép késés-szűrőjéhez; a regionálisnál a hivatalos is ott van)
    const liveDelaySec = v.tripId ? this.engine.matcher.liveDelay(v.tripId, nowUnix()) : null;
    return { ...v, motion: this.motionOf(v, offset), liveDelaySec };
  }

  private onTick() {
    // Járművek: csak a változott sorok, témánként (mód szerint) szűrve.
    const cur = new Map<string, DecodedVehicle>();
    for (const v of this.engine.snapshot.decoded) cur.set(v.id, v);
    const upd: (DecodedVehicle & { motion: unknown })[] = [];
    const offset = serviceClock().offset;
    for (const [id, v] of cur) {
      const sig = `${v.timestamp}|${v.lat}|${v.lon}|${v.tripId}|${v.bearing}|${v.delaySec ?? ""}`;
      if (this.lastVehicles.get(id) !== sig) {
        upd.push(this.withMotion(v, offset));
        this.lastVehicles.set(id, sig);
      }
    }
    const del = [...this.lastVehicles.keys()].filter((id) => !cur.has(id));
    for (const id of del) this.lastVehicles.delete(id);
    if (upd.length || del.length) {
      const byTopic = new Map<string, Client[]>();
      for (const c of this.clients)
        for (const t of c.topics)
          if (t === "vehicles" || t.startsWith("vehicles@")) {
            const list = byTopic.get(t);
            if (list) list.push(c);
            else byTopic.set(t, [c]);
          }
      for (const [topic, subs] of byTopic) {
        const keep = this.vehicleFilter(topic);
        const u = upd.filter(keep);
        // a törölt jármű módját már nem tudjuk: a régi téma csak az MVK-azonosítókat kapja
        const d = topic === "vehicles" ? del.filter((id) => isMvkId(id)) : del;
        if (!u.length && !d.length) continue;
        const msg = JSON.stringify({ t: "vehicles", topic, upd: u, del: d, at: this.engine.snapshot.fetchedAt });
        for (const c of subs) this.sendRaw(c, msg);
      }
    }

    // Megállók és menetek: újraszámolás, küldés csak változáskor.
    const stopTopics = new Set<string>();
    const tripTopics = new Set<string>();
    for (const c of this.clients)
      for (const t of c.topics) {
        if (t.startsWith("stop:")) stopTopics.add(t);
        else if (t.startsWith("trip:")) tripTopics.add(t);
      }
    for (const t of stopTopics) {
      const rest = t.slice(5);
      this.publishIfChanged(t, { t: "stop", id: splitTopic(rest).id, data: this.stopData(rest) });
    }
    for (const t of tripTopics) this.publishIfChanged(t, { t: "trip", id: t.slice(5), data: this.tripData(t.slice(5)) });
    const parkingWatched = this.subscribers("parking").length > 0;
    if (parkingWatched) this.publishIfChanged("parking", { t: "parking", id: "", data: this.parking.snapshot() });
    for (const key of this.lastSent.keys()) if (!stopTopics.has(key) && !tripTopics.has(key) && !(key === "parking" && parkingWatched)) this.lastSent.delete(key);
  }

  /** Egy megálló (vagy a stop:<id>@… változata) újraküldése, ha valaki figyeli. */
  private refreshStop(stopId: string) {
    const prefix = `stop:${stopId}`;
    const topics = new Set<string>();
    for (const c of this.clients) for (const t of c.topics) if (t === prefix || t.startsWith(`${prefix}@`)) topics.add(t);
    // állomásnál a vágányok eseménye az állomás témáját is frissíti, közös megállónál a pár témája is
    const feed = this.engine.feeds.cachedDay(this.engine.today)?.feed;
    const parent = feed?.stops.get(stopId)?.parent;
    if (parent) for (const c of this.clients) for (const t of c.topics) if (t === `stop:${parent}` || t.startsWith(`stop:${parent}@`)) topics.add(t);
    const twin = feed ? stopTwinsOf(feed).toMvk.get(stopId) : undefined;
    if (twin) for (const c of this.clients) for (const t of c.topics) if (t.startsWith(`stop:${twin}@`) && splitTopic(t.slice(5)).merge !== "off") topics.add(t);
    for (const t of topics) {
      const rest = t.slice(5);
      this.publishIfChanged(t, { t: "stop", id: splitTopic(rest).id, data: this.stopData(rest) });
    }
  }

  private publishIfChanged(topic: string, payload: { t: string; id: string; data: unknown }) {
    // A `now` / `at` időbélyeg minden körben változik  az összehasonlításból kihagyjuk.
    const body = JSON.stringify(payload.data, (k, v) => (k === "now" || k === "at" ? undefined : v));
    if (this.lastSent.get(topic) === body) return;
    this.lastSent.set(topic, body);
    // a téma is megy: a kliens ebből tudja, melyik feliratkozásé (stop:<id>@modes)
    const msg = JSON.stringify({ ...payload, topic });
    for (const c of this.subscribers(topic)) this.sendRaw(c, msg);
  }

  private onRun(r: RunOut) {
    const topic = `runs:${r.serviceDate.replace(/-/g, "")}`;
    const subs = this.subscribers(topic);
    if (subs.length) {
      const msg = JSON.stringify({ t: "runs", date: topic.slice(5), upd: { [r.tripId]: journalRecord(r, this.engine.matcher.liveDelay(r.tripId, nowUnix())) } });
      for (const c of subs) this.sendRaw(c, msg);
    }
    const tt = `trip:${r.tripId}`;
    if (this.subscribers(tt).length) this.publishIfChanged(tt, { t: "trip", id: r.tripId, data: this.tripData(r.tripId) });
  }

  /** A web szólt (Postgres NOTIFY), hogy egy felhasználó beállításai változtak. */
  notifySync(userId: string, keys: string[], originDevice: string | null) {
    const msg = JSON.stringify({ t: "sync", keys });
    for (const c of this.clients) if (c.userId === userId && c.topics.has("sync") && c.deviceId !== originDevice) this.sendRaw(c, msg);
  }

  private heartbeat() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        this.clients.delete(c);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  private send(c: Client, data: unknown) {
    this.sendRaw(c, JSON.stringify(data));
  }

  private sendRaw(c: Client, msg: string) {
    if (c.ws.readyState !== c.ws.OPEN) return;
    // Lassú kliens (nagy puffer): a kihagyott különbség-üzenet örökre elveszne (szellem-buszok),
    // ezért bontjuk  újracsatlakozáskor a teljes állapotot kapja.
    if (c.ws.bufferedAmount > 1_000_000) {
      c.ws.terminate();
      return;
    }
    c.ws.send(msg);
    this.stats.messages++;
  }

  status() {
    return { clients: this.clients.size, ...this.stats };
  }

  /** Kik vannak most fent: témánként, és hány bejelentkezett felhasználó / eszköz (a rendszer-hubnak). */
  liveBreakdown() {
    const topics: Record<string, number> = {};
    const stops = new Map<string, number>();
    const users = new Set<string>();
    const devices = new Set<string>();
    for (const c of this.clients) {
      if (c.userId) users.add(c.userId);
      if (c.deviceId) devices.add(c.deviceId);
      for (const t of c.topics) {
        const kind = t.split(":")[0];
        topics[kind] = (topics[kind] ?? 0) + 1;
        if (kind === "stop") stops.set(t.slice(5), (stops.get(t.slice(5)) ?? 0) + 1);
      }
    }
    const topStops = [...stops].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([stopId, n]) => ({ stopId, name: this.engine.feeds.latest()?.stops.get(stopId)?.name ?? stopId, watchers: n }));
    return { clients: this.clients.size, signedIn: users.size, devices: devices.size, topics, topStops };
  }
}
