/**
 * WebSocket-hub: a szerver küldi az adatot, a kliens nem kérdez.
 *
 * Témák (a kliens iratkozik fel):
 *   vehicles        — minden jármű; induláskor teljes lista, utána csak a változás
 *   stop:<stopId>   — a megálló érkezési táblája; csak ha tényleg változott
 *   trip:<tripId>   — egy menet élő állapota (hol tart, késés)
 *   runs:<YYYYMMDD> — a mai menetrend-napló (indult / beért), menetenként azonnal
 *   parking         — a parkoló: ki áll melyik végállomáson, ki van a kocsiszínben
 *   sync            — a bejelentkezett felhasználó más eszközön mentett beállításai
 *
 * Üzenetformátum: JSON, permessage-deflate tömörítéssel.
 */
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { arrivalsForStop, nowUnix, progressOnTrip, serviceClock, type DecodedVehicle, type RunOut } from "@mvk/core";
import { sql } from "@mvk/db";
import { sha256Hex } from "@mvk/db/crypto";
import type { Engine } from "./engine.ts";
import { journalRecord } from "./http/compat.ts";
import { errMsg, log } from "./log.ts";
import type { DelayForecaster } from "./forecast.ts";
import type { Parking } from "./parking.ts";
import type { VehiclePredictor } from "./predict.ts";

type Client = { ws: WebSocket; topics: Set<string>; userId: string | null; deviceId: string | null; alive: boolean };

const MAX_TOPICS = 40;
const STOP_LIMIT = 10;

export class Hub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private lastVehicles = new Map<string, string>();
  private lastSent = new Map<string, string>(); // téma → utolsó küldött tartalom (változásfigyeléshez)
  private engine: Engine;
  private predictor: VehiclePredictor;
  private parking: Parking;
  private forecaster: DelayForecaster;
  stats = { connections: 0, messages: 0 };

  constructor(server: Server, engine: Engine, predictor: VehiclePredictor, parking: Parking, forecaster: DelayForecaster) {
    this.engine = engine;
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
        if (!/^(vehicles|sync|parking|stop:[\w:.-]+|trip:[\w:.-]+|runs:\d{8})$/.test(t)) continue;
        c.topics.add(t);
        await this.initial(c, t);
      }
    } else if (msg.t === "unsub") for (const t of topics) c.topics.delete(t);
  }

  /** Feliratkozáskor azonnal a teljes állapot. */
  private async initial(c: Client, topic: string) {
    if (topic === "vehicles") return this.send(c, { t: "vehicles", full: this.engine.snapshot.decoded.map((v) => this.withMotion(v)), at: this.engine.snapshot.fetchedAt });
    if (topic === "parking") return this.send(c, { t: "parking", id: "", data: this.parking.snapshot() });
    if (topic.startsWith("stop:")) return this.send(c, { t: "stop", id: topic.slice(5), data: this.stopData(topic.slice(5)) });
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

  private stopData(stopId: string) {
    const now = nowUnix();
    return arrivalsForStop(stopId, STOP_LIMIT, this.engine.snapshot, this.engine.feeds.arrivalDays(now), now, {
      measuredDelay: (t) => this.engine.matcher.liveDelay(t, now),
      forecast: (t, s) => this.forecaster.forStop(t, s, now),
      predictedVehicle: (t) => this.predictor.predict(t),
      cancelled: this.engine.cancelled.ids,
    });
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
   * v = várható sebesség (m/s). A kliens ezzel viszi tovább a buszt két jel között.
   */
  private motionOf(id: string, gpsSpeed: number | null) {
    const m = this.engine.matcher.motion(id);
    if (!m) return null;
    // Álló busznál (megálló, lámpa) nincs becslés: a jel helyén marad, amíg újra el nem indul.
    if (m.stopped) return { s: m.shapeId, a: m.alongM, t: m.ts, e: m.toAlongM, v: 0 };
    const run = this.engine.todayRuns.get(m.tripId);
    const v = this.forecaster.segmentSpeed(m, run?.serviceDate ?? this.engine.today) ?? gpsSpeed ?? 6;
    return { s: m.shapeId, a: m.alongM, t: m.ts, e: m.toAlongM, v: Math.round(Math.min(22, Math.max(1.5, v)) * 10) / 10 };
  }

  private withMotion(v: DecodedVehicle) {
    return { ...v, motion: this.motionOf(v.id, v.speed) };
  }

  private onTick() {
    // Járművek: csak a változott sorok.
    const vehSubs = this.subscribers("vehicles");
    const cur = new Map<string, DecodedVehicle>();
    for (const v of this.engine.snapshot.decoded) cur.set(v.id, v);
    const upd: (DecodedVehicle & { motion: unknown })[] = [];
    for (const [id, v] of cur) {
      const sig = `${v.timestamp}|${v.lat}|${v.lon}|${v.tripId}|${v.bearing}`;
      if (this.lastVehicles.get(id) !== sig) {
        upd.push(this.withMotion(v));
        this.lastVehicles.set(id, sig);
      }
    }
    const del = [...this.lastVehicles.keys()].filter((id) => !cur.has(id));
    for (const id of del) this.lastVehicles.delete(id);
    if (vehSubs.length && (upd.length || del.length)) {
      const msg = JSON.stringify({ t: "vehicles", upd, del, at: this.engine.snapshot.fetchedAt });
      for (const c of vehSubs) this.sendRaw(c, msg);
    }

    // Megállók és menetek: újraszámolás, küldés csak változáskor.
    const stopTopics = new Set<string>();
    const tripTopics = new Set<string>();
    for (const c of this.clients)
      for (const t of c.topics) {
        if (t.startsWith("stop:")) stopTopics.add(t);
        else if (t.startsWith("trip:")) tripTopics.add(t);
      }
    for (const t of stopTopics) this.refreshStop(t.slice(5));
    for (const t of tripTopics) this.publishIfChanged(t, { t: "trip", id: t.slice(5), data: this.tripData(t.slice(5)) });
    const parkingWatched = this.subscribers("parking").length > 0;
    if (parkingWatched) this.publishIfChanged("parking", { t: "parking", id: "", data: this.parking.snapshot() });
    for (const key of this.lastSent.keys()) if (!stopTopics.has(key) && !tripTopics.has(key) && !(key === "parking" && parkingWatched)) this.lastSent.delete(key);
  }

  private refreshStop(stopId: string) {
    const topic = `stop:${stopId}`;
    if (!this.subscribers(topic).length) return;
    this.publishIfChanged(topic, { t: "stop", id: stopId, data: this.stopData(stopId) });
  }

  private publishIfChanged(topic: string, payload: { t: string; id: string; data: unknown }) {
    // A `now` / `at` időbélyeg minden körben változik — az összehasonlításból kihagyjuk.
    const body = JSON.stringify(payload.data, (k, v) => (k === "now" || k === "at" ? undefined : v));
    if (this.lastSent.get(topic) === body) return;
    this.lastSent.set(topic, body);
    const msg = JSON.stringify(payload);
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
    // Lassú kliensnél (nagy puffer) kihagyunk egy kört, nem fojtjuk meg a szervert.
    if (c.ws.bufferedAmount > 1_000_000) return;
    c.ws.send(msg);
    this.stats.messages++;
  }

  status() {
    return { clients: this.clients.size, ...this.stats };
  }
}
