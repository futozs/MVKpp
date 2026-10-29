/**
 * Valós idejű kapcsolat a szerverrel (WebSocket).
 *
 * Egyetlen megosztott kapcsolat az egész appnak; a komponensek témákra
 * iratkoznak fel (`vehicles`, `stop:SP85`, `trip:…`, `runs:20261029`, `sync`).
 * A szerver küldi az adatot, amint változik — nincs pollozás. Ha a kapcsolat
 * megszakad, növekvő várakozással újracsatlakozik és visszaállítja a
 * feliratkozásokat; amíg nincs kapcsolat, a hookok pollozó tartalékra váltanak.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type Msg = { t: string; [k: string]: unknown };
type Listener = (m: Msg) => void;

function wsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
}

let serverOffsetS = 0;

/** A szerver órája most (unix mp) — a kapcsolódáskor kapott „hello” alapján. */
export function serverNow(): number {
  return Date.now() / 1000 + serverOffsetS;
}

class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private globalListeners = new Set<Listener>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private statusListeners = new Set<() => void>();
  private auth: { token: string; deviceId: string } | null = null;
  connected = false;

  private ensure() {
    if (typeof window === "undefined") return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.timer) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
      if (this.auth) ws.send(JSON.stringify({ t: "auth", token: this.auth.token, deviceId: this.auth.deviceId }));
      const topics = [...this.listeners.keys()];
      if (topics.length) ws.send(JSON.stringify({ t: "sub", topics }));
    };
    ws.onmessage = (e) => {
      let m: Msg;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      // A szerver órája (pl. egy visszajátszott napon a kliensétől eltér): a „hello”-ból.
      if (m.t === "hello" && typeof m.now === "number") serverOffsetS = m.now - Date.now() / 1000;
      for (const l of this.globalListeners) l(m);
      const topic = topicOf(m);
      if (!topic) return;
      for (const l of this.listeners.get(topic) ?? []) l(m);
    };
    ws.onclose = () => {
      // Egy már lecserélt (újraélesztett) kapcsolat késve érkező lezárása ne bontsa az élőt.
      if (this.ws !== ws) return;
      this.setConnected(false);
      this.ws = null;
      if (this.listeners.size || this.globalListeners.size) this.schedule();
    };
    ws.onerror = () => ws.close();
  }

  private schedule() {
    if (this.timer) return;
    const delay = Math.min(15_000, 500 * 2 ** this.retry++) + Math.random() * 400;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.ensure();
    }, delay);
  }

  private setConnected(v: boolean) {
    if (this.connected === v) return;
    this.connected = v;
    for (const l of this.statusListeners) l();
  }

  subscribe(topic: string, l: Listener): () => void {
    let set = this.listeners.get(topic);
    const fresh = !set;
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(l);
    this.ensure();
    if (fresh && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "sub", topics: [topic] }));
    return () => {
      const s = this.listeners.get(topic);
      if (!s) return;
      s.delete(l);
      if (!s.size) {
        this.listeners.delete(topic);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "unsub", topics: [topic] }));
      }
    };
  }

  onAny(l: Listener): () => void {
    this.globalListeners.add(l);
    this.ensure();
    return () => this.globalListeners.delete(l);
  }

  /** Bejelentkezett felhasználó: a szerver a többi eszközön mentett változásokról szól. */
  authenticate(token: string | null, deviceId: string) {
    this.auth = token ? { token, deviceId } : null;
    if (token && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "auth", token, deviceId }));
  }

  onStatus(l: () => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  /** Visszatéréskor (háttérből előtérbe) azonnal újracsatlakozunk. */
  wake() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.retry = 0;
    this.ensure();
  }
}

function topicOf(m: Msg): string | null {
  switch (m.t) {
    case "vehicles":
      return "vehicles";
    case "stop":
      return `stop:${m.id as string}`;
    case "trip":
      return `trip:${m.id as string}`;
    case "runs":
      return `runs:${m.date as string}`;
    case "sync":
      return "sync";
    case "parking":
      return "parking";
    default:
      return null;
  }
}

export const realtime = new RealtimeClient();

if (typeof window !== "undefined") {
  const wake = () => document.visibilityState === "visible" && realtime.wake();
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", () => realtime.wake());
  window.addEventListener("pageshow", (e) => (e as PageTransitionEvent).persisted && realtime.wake());
}

/** Él-e a valós idejű kapcsolat. */
export function useRealtimeConnected(): boolean {
  return useSyncExternalStore(
    (cb) => realtime.onStatus(cb),
    () => realtime.connected,
    () => false,
  );
}

/**
 * Feliratkozás egy témára. A `handler` minden üzenetre lefut; a legfrissebb
 * függvényt használja (nem kell useCallback).
 */
export function useTopic(topic: string | null, handler: (m: Msg) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!topic) return;
    return realtime.subscribe(topic, (m) => ref.current(m));
  }, [topic]);
}

/**
 * Pollozó tartalék: csak akkor fut, ha nincs élő WebSocket-kapcsolat.
 * Így a felület akkor sem áll le, ha egy hálózat (pl. céges proxy) blokkolja a WS-t.
 */
export function useFallbackPoll(fn: () => void, ms: number, enabled = true) {
  const connected = useRealtimeConnected();
  const ref = useRef(fn);
  ref.current = fn;
  const [grace, setGrace] = useState(true);
  useEffect(() => {
    // Az első pár másodpercben megvárjuk, hogy felépül-e a kapcsolat.
    const t = setTimeout(() => setGrace(false), 2500);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!enabled || connected || grace) return;
    ref.current();
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [connected, enabled, grace, ms]);
}
