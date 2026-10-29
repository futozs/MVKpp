/**
 * Utazási napló: a „Felszálltam” gombbal vagy automatikus felismeréssel
 * rögzített utazások.
 *
 * Bejelentkezés nélkül a telefonon gyűlnek (localStorage, eszközhöz kötve);
 * bejelentkezve minden feltöltődik a /v3/rides végpontra, és a többi eszközön
 * rögzítettek is letöltődnek. Utazásonként külön azonosító (UUID), így két
 * eszköz sem írja felül egymást.
 */
import { useSyncExternalStore } from "react";
import { API_BASE } from "@/lib/apiBase";
import { getSession } from "@/lib/account";

export interface Ride {
  id: string;
  serviceDate: string;
  vehicleId: string;
  tripId: string;
  route: string;
  headsign: string;
  color: string;
  text: string;
  boardedAt: number;
  alightedAt: number | null;
  fromStopId: string | null;
  fromStopName: string | null;
  toStopId: string | null;
  toStopName: string | null;
  /** hány megállónyit utazott */
  stops: number | null;
  /** légvonalban, megállóról megállóra összegezve (m) */
  distanceM: number | null;
  delayAtBoardS: number | null;
  delayAtAlightS: number | null;
  detected: "auto" | "manual";
}

export interface ActiveRide {
  id: string;
  serviceDate: string;
  vehicleId: string;
  tripId: string;
  route: string;
  headsign: string;
  color: string;
  text: string;
  boardedAt: number;
  fromIdx: number | null;
  fromStopId: string | null;
  fromStopName: string | null;
  delayAtBoardS: number | null;
  /** ahol le akar szállni (a menet megállóinak indexe) */
  destIdx: number | null;
  detected: "auto" | "manual";
}

type StoredRide = Ride & { synced?: boolean };

const RIDES_KEY = "mvk_rides";
const ACTIVE_KEY = "mvk_ride_active";
const MAX_LOCAL = 5000;
const BATCH = 200;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* privát mód / megtelt */
  }
}

let rides: StoredRide[] = read<StoredRide[]>(RIDES_KEY, []);
let active: ActiveRide | null = read<ActiveRide | null>(ACTIVE_KEY, null);
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setRides(next: StoredRide[]) {
  rides = next.slice(0, MAX_LOCAL);
  write(RIDES_KEY, rides);
  emit();
}

function setActive(next: ActiveRide | null) {
  active = next;
  write(ACTIVE_KEY, next);
  emit();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useRides(): Ride[] {
  return useSyncExternalStore(subscribe, () => rides, () => rides);
}

export function useActiveRide(): ActiveRide | null {
  return useSyncExternalStore(subscribe, () => active, () => active);
}

export function getActiveRide(): ActiveRide | null {
  return active;
}

export function startRide(r: Omit<ActiveRide, "id" | "destIdx">): ActiveRide {
  const ride: ActiveRide = { ...r, id: crypto.randomUUID(), destIdx: null };
  setActive(ride);
  return ride;
}

export function setDestination(idx: number | null) {
  if (active) setActive({ ...active, destIdx: idx });
}

/** A felszállás helye és a késés akkor derül ki, amikor a menet adatai megérkeznek. */
export function patchActiveRide(patch: Partial<Omit<ActiveRide, "id">>) {
  if (active) setActive({ ...active, ...patch });
}

/** Utazás vége: a napló elejére kerül, és bejelentkezve feltöltődik. */
export function finishRide(end: Pick<Ride, "alightedAt" | "toStopId" | "toStopName" | "stops" | "distanceM" | "delayAtAlightS">): Ride | null {
  if (!active) return null;
  const { destIdx: _dest, fromIdx: _from, ...rest } = active;
  const ride: StoredRide = { ...rest, ...end, synced: false };
  setActive(null);
  setRides([ride, ...rides.filter((x) => x.id !== ride.id)]);
  void syncRides();
  return ride;
}

/** Mégsem szállt fel (téves felismerés): nyom nélkül eltűnik. */
export function cancelRide() {
  setActive(null);
}

export async function deleteRide(id: string) {
  setRides(rides.filter((r) => r.id !== id));
  const session = getSession();
  if (!session) return;
  await fetch(`${API_BASE}/v3/rides/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Account-Session": session.sessionToken },
  }).catch(() => {});
}

let syncing: Promise<void> | null = null;

/** Feltölti a még fel nem töltött utazásokat, és letölti a többi eszközén rögzítetteket. */
export function syncRides(): Promise<void> {
  if (syncing) return syncing;
  syncing = doSync().finally(() => (syncing = null));
  return syncing;
}

async function doSync() {
  const session = getSession();
  if (!session) return;
  const headers = { "Content-Type": "application/json", "X-Account-Session": session.sessionToken };
  const pending = rides.filter((r) => !r.synced);
  const saved = new Set<string>();
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH).map(({ synced: _s, ...r }) => r);
    const res = await fetch(`${API_BASE}/v3/rides`, { method: "POST", headers, body: JSON.stringify({ rides: batch }) }).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json().catch(() => null)) as { saved?: string[] } | null;
    for (const id of body?.saved ?? []) saved.add(id);
  }
  const res = await fetch(`${API_BASE}/v3/rides`, { headers }).catch(() => null);
  const remote = res?.ok ? (((await res.json().catch(() => null)) as { rides?: Ride[] } | null)?.rides ?? []) : [];
  const byId = new Map<string, StoredRide>();
  for (const r of rides) byId.set(r.id, saved.has(r.id) ? { ...r, synced: true } : r);
  for (const r of remote) byId.set(r.id, { ...r, synced: true });
  setRides([...byId.values()].sort((a, b) => b.boardedAt - a.boardedAt));
}

// Bejelentkezéskor (vagy egy másik fülön történt belépéskor) azonnal szinkronizálunk.
if (typeof window !== "undefined") {
  window.addEventListener("mvk-session-change", () => void syncRides());
}
