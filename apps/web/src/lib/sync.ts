/**
 * Felhős szinkron — minden mvk_* localStorage-kulcs, mindkét irányban.
 *
 *  - Helyi változás: a localStorage írásait elkapjuk (az app sok helyen
 *    közvetlenül ír bele), és 1,5 mp-es összevárás után felküldjük.
 *  - Bejelentkezés új eszközön: minden letöltődik (kedvencek, figyelt
 *    megállók, beállítások), utána az oldal egyszer újratölt.
 *  - Másik eszköz változása: a szerver WebSocketen szól, lehúzzuk.
 *  - Ütközésnél a később módosított érték nyer (kulcsonként).
 */
import { API_BASE } from "@/lib/apiBase";
import { getSession } from "@/lib/account";
import { realtime } from "@/lib/realtime";

const DEVICE_KEY = "mvk_device_id";
const META_KEY = "mvk_sync_meta";
/** Eszközhöz kötött kulcsok — ezek nem utaznak. */
const DEVICE_ONLY = new Set(["mvk_account", DEVICE_KEY, META_KEY, "mvk_install_dismissed", "mvk_geo_last_fix", "mvk_view_state", "mvk_map_view", "mvk_timetable_view"]);
const PUSH_DEBOUNCE_MS = 1500;
const PULL_INTERVAL_MS = 5 * 60_000;

type Meta = { lastPull: string | null; stamps: Record<string, string>; dirty: string[] };
type Item = { key: string; value: unknown; deleted?: boolean; updatedAt: string };

const syncable = (k: string | null): k is string => Boolean(k && k.startsWith("mvk_") && !DEVICE_ONLY.has(k));

let original: { set: Storage["setItem"]; remove: Storage["removeItem"] } | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let pulling = false;
const listeners = new Set<(s: SyncStatus) => void>();

export type SyncStatus = { state: "off" | "idle" | "syncing" | "error"; lastSyncAt: string | null; pendingRemote: boolean; error?: string };
let status: SyncStatus = { state: "off", lastSyncAt: null, pendingRemote: false };

function setStatus(p: Partial<SyncStatus>) {
  status = { ...status, ...p };
  for (const l of listeners) l(status);
}
export const getSyncStatus = () => status;
export function onSyncStatus(l: (s: SyncStatus) => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function rawSet(k: string, v: string) {
  (original?.set ?? Storage.prototype.setItem).call(localStorage, k, v);
}
function rawRemove(k: string) {
  (original?.remove ?? Storage.prototype.removeItem).call(localStorage, k);
}

function readMeta(): Meta {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY) ?? "null") as Meta | null;
    if (m && typeof m === "object" && m.stamps) return { lastPull: m.lastPull ?? null, stamps: m.stamps, dirty: Array.isArray(m.dirty) ? m.dirty : [] };
  } catch {
    /* sérült meta → újrakezdés */
  }
  return { lastPull: null, stamps: {}, dirty: [] };
}
function writeMeta(m: Meta) {
  try {
    rawSet(META_KEY, JSON.stringify(m));
  } catch {
    /* tele a tárhely */
  }
}

export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    rawSet(DEVICE_KEY, id);
  }
  return id;
}

function markDirty(key: string) {
  const m = readMeta();
  m.stamps[key] = new Date().toISOString();
  if (!m.dirty.includes(key)) m.dirty.push(key);
  writeMeta(m);
  if (!getSession()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void push(), PUSH_DEBOUNCE_MS);
}

/** A localStorage írásainak elkapása (egyszer, az app indulásakor). */
function patchStorage() {
  if (original) return;
  original = { set: Storage.prototype.setItem, remove: Storage.prototype.removeItem };
  const o = original;
  Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
    const prev = this === localStorage ? this.getItem(k) : null;
    o.set.call(this, k, v);
    if (this === localStorage && syncable(k) && prev !== v) markDirty(k);
  };
  Storage.prototype.removeItem = function (this: Storage, k: string) {
    const had = this === localStorage && this.getItem(k) != null;
    o.remove.call(this, k);
    if (this === localStorage && syncable(k) && had) markDirty(k);
  };
}

async function api<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
  const s = getSession();
  if (!s) throw new Error("nincs bejelentkezve");
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-account-session": s.sessionToken, "x-device-id": deviceId() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("A munkamenet lejárt — jelentkezz be újra.");
  if (!res.ok) throw new Error(`szinkron HTTP ${res.status}`);
  return res.json();
}

export async function push(): Promise<void> {
  if (!getSession()) return;
  const m = readMeta();
  if (!m.dirty.length) return;
  const keys = [...m.dirty];
  const items: Item[] = keys.map((key) => {
    const v = localStorage.getItem(key);
    return { key, value: v, deleted: v == null, updatedAt: m.stamps[key] ?? new Date().toISOString() };
  });
  setStatus({ state: "syncing" });
  try {
    const r = await api<{ applied: string[]; stale: Item[]; serverTime: string }>("PUT", "/v3/sync", { deviceId: deviceId(), items });
    const after = readMeta();
    after.dirty = after.dirty.filter((k) => !keys.includes(k) || after.stamps[k] !== m.stamps[k]);
    // A szerveren újabb érték volt: azt vesszük át.
    const changed = applyRemote(r.stale, after);
    writeMeta(after);
    setStatus({ state: "idle", lastSyncAt: r.serverTime, error: undefined });
    if (changed.length) announce(changed);
  } catch (e) {
    setStatus({ state: "error", error: (e as Error).message });
  }
}

function applyRemote(items: Item[], m: Meta): string[] {
  const changed: string[] = [];
  for (const it of items) {
    if (!syncable(it.key)) continue;
    const local = m.stamps[it.key];
    if (local && local >= it.updatedAt && !m.dirty.includes(it.key)) continue;
    if (m.dirty.includes(it.key) && local && local > it.updatedAt) continue; // helyben újabb, majd felküldjük
    const value = it.deleted || it.value == null ? null : typeof it.value === "string" ? it.value : JSON.stringify(it.value);
    const cur = localStorage.getItem(it.key);
    if (value === cur) {
      m.stamps[it.key] = it.updatedAt;
      continue;
    }
    if (value == null) rawRemove(it.key);
    else rawSet(it.key, value);
    m.stamps[it.key] = it.updatedAt;
    m.dirty = m.dirty.filter((k) => k !== it.key);
    changed.push(it.key);
  }
  return changed;
}

export async function pull(opts: { full?: boolean } = {}): Promise<string[]> {
  if (!getSession() || pulling) return [];
  pulling = true;
  setStatus({ state: "syncing" });
  try {
    const m = readMeta();
    const since = opts.full ? null : m.lastPull;
    const r = await api<{ serverTime: string; items: Item[] }>("GET", `/v3/sync${since ? `?since=${encodeURIComponent(since)}` : ""}`);
    const m2 = readMeta();
    const changed = applyRemote(r.items, m2);
    m2.lastPull = r.serverTime;
    // Első szinkron ezen az eszközön: ami csak itt van, azt felküldjük.
    if (opts.full) {
      const remoteKeys = new Set(r.items.map((i) => i.key));
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (syncable(k) && !remoteKeys.has(k) && !m2.dirty.includes(k)) {
          m2.dirty.push(k);
          m2.stamps[k] ??= new Date().toISOString();
        }
      }
    }
    writeMeta(m2);
    setStatus({ state: "idle", lastSyncAt: r.serverTime, error: undefined });
    if (m2.dirty.length) void push();
    return changed;
  } catch (e) {
    setStatus({ state: "error", error: (e as Error).message });
    return [];
  } finally {
    pulling = false;
  }
}

/** Távoli változás: az app nagy része induláskor olvas a localStorage-ból, ezért jelezzük. */
function announce(keys: string[]) {
  window.dispatchEvent(new CustomEvent("mvk-sync-applied", { detail: keys }));
  for (const k of keys) window.dispatchEvent(new CustomEvent("mvk-pref-change", { detail: k }));
  if (document.visibilityState === "hidden") location.reload();
  else setStatus({ pendingRemote: true });
}

/** Indítás (egyszer, az app gyökeréből). */
export function startSync(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  patchStorage();
  // Be-/kijelentkezés (a fiók-modul eseményt küld).
  window.addEventListener("mvk-session-change", () => {
    if (getSession()) void onLoggedIn();
    else onLoggedOut();
  });
  const s = getSession();
  if (!s) return;
  setStatus({ state: "idle" });
  realtime.authenticate(s.sessionToken, deviceId());
  realtime.subscribe("sync", () => void pull().then((c) => c.length && announce(c)));
  const first = !readMeta().lastPull;
  if (first) writeMeta({ lastPull: null, stamps: {}, dirty: [] });
  void pull({ full: first }).then((changed) => {
    // Új eszközön az első letöltés után egy újratöltés, hogy minden komponens az új adatot lássa.
    if (first && changed.length) location.reload();
    else if (changed.length) announce(changed);
  });
  setInterval(() => void pull().then((c) => c.length && announce(c)), PULL_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void pull().then((c) => c.length && announce(c));
    else void push();
  });
  window.addEventListener("pagehide", () => void push());
}

/** Bejelentkezés után: teljes szinkron + valós idejű értesítés. */
export async function onLoggedIn(): Promise<void> {
  const s = getSession();
  if (!s) return;
  patchStorage();
  realtime.authenticate(s.sessionToken, deviceId());
  // Új eszközön a felhő nyer: az app induláskor írt alapértékei (pl. az
  // alapértelmezett figyelt megálló) ne írják felül a valódi kedvenceket.
  writeMeta({ lastPull: null, stamps: {}, dirty: [] });
  const changed = await pull({ full: true });
  if (changed.length) location.reload();
}

export function onLoggedOut(): void {
  realtime.authenticate(null, deviceId());
  writeMeta({ lastPull: null, stamps: {}, dirty: [] });
  setStatus({ state: "off", lastSyncAt: null, pendingRemote: false });
}
