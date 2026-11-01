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
  /** felismert, a „Felszálltam” gombbal indított, vagy utólag a menetrendből felvett */
  detected: RideSource;
  /** körbeutazás: az egymás után, ülve maradva megtett menetek közös azonosítója */
  chainId?: string | null;
  /**
   * Hogyan zárult: „Leszálltam” (user), a kijelölt leszállóhelynél (dest), a telefon
   * eltávolodott a busztól (away), vagy a menet végén, az utas jelzése nélkül (terminus).
   */
  endedBy?: RideEndedBy | null;
  /** utólagos javítás ideje (unix) — utána a fel- és leszállás helye végleges */
  editedAt?: number | null;
}

export type RideEndedBy = "user" | "dest" | "away" | "terminus";
export type RideSource = "auto" | "manual" | "later";

/**
 * A busz a végállomáson fordul, és az utas nem szállt le: a menet véget ért,
 * a következővel (körbeutazás) folytatjuk, amint a busz elindul.
 */
export interface RideTurn {
  /** mikor ért be a végállomásra (unix) */
  arrivedAt: number;
  /** a végállomás indexe a befejezett menet megállói között */
  atIdx: number;
  terminusName: string;
  /** „Maradok a buszon” (true) / „Leszálltam” (false); null = nem válaszolt */
  stay: boolean | null;
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
  /** felismert felszállás: ahol a telefon a busz mellett állt — ebből lesz a felszállás megállója */
  boardNear?: { lat: number; lon: number } | null;
  fromIdx: number | null;
  /** az utas megerősítette (vagy maga választotta) a felszállás megállóját */
  fromConfirmed?: boolean;
  /**
   * amikor a telefon utoljára a busszal volt: a busz által addig elhagyott megálló és
   * az időpont — bezárt app után is megmarad, ebből tudjuk, legkorábban hol szállhatott le
   */
  withBus?: { passed: number; at: number } | null;
  fromStopId: string | null;
  fromStopName: string | null;
  delayAtBoardS: number | null;
  /** ahol le akar szállni (a menet megállóinak indexe) */
  destIdx: number | null;
  detected: "auto" | "manual";
  /** körbeutazás: az első menet azonosítója — a láncolt menetek ezzel kapcsolódnak */
  chainId?: string | null;
  /** hányadik menet a körbeutazásban (1-től) */
  leg?: number;
  turn?: RideTurn | null;
}

type StoredRide = Ride & { synced?: boolean };

const RIDES_KEY = "mvk_rides";
const ACTIVE_KEY = "mvk_ride_active";
/** törölt, de a szerveren még nem törölt utazások (a szinkron ne hozza vissza őket) */
const DELETED_KEY = "mvk_ride_deleted";
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
let deleted: string[] = read<string[]>(DELETED_KEY, []);

function setDeleted(next: string[]) {
  deleted = next.slice(-1000);
  write(DELETED_KEY, deleted.length ? deleted : null);
}
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

type RideEnd = Pick<Ride, "alightedAt" | "toStopId" | "toStopName" | "stops" | "distanceM" | "delayAtAlightS"> & { endedBy?: RideEndedBy | null };

function closedRide(a: ActiveRide, end: RideEnd, chainId: string | null): StoredRide {
  const { destIdx: _dest, fromIdx: _from, leg: _leg, turn: _turn, boardNear: _near, fromConfirmed: _conf, withBus: _with, ...rest } = a;
  return { ...rest, ...end, chainId, synced: false };
}

export function setDestination(idx: number | null) {
  if (active) setActive({ ...active, destIdx: idx });
}

/** A felszállás helye és a késés akkor derül ki, amikor a menet adatai megérkeznek. */
export function patchActiveRide(patch: Partial<Omit<ActiveRide, "id">>) {
  if (active) setActive({ ...active, ...patch });
}

/** Utazás vége: a napló elejére kerül, és bejelentkezve feltöltődik. */
export function finishRide(end: RideEnd): Ride | null {
  if (!active) return null;
  const ride = closedRide(active, end, active.chainId ?? null);
  setActive(null);
  setRides([ride, ...rides.filter((x) => x.id !== ride.id)]);
  void syncRides();
  return ride;
}

export type NextLeg = Pick<ActiveRide, "tripId" | "route" | "headsign" | "color" | "text" | "boardedAt" | "fromStopId" | "fromStopName" | "delayAtBoardS">;

/**
 * Körbeutazás: a befejezett menet a naplóba kerül, és ugyanazon a buszon a
 * következő menet indul — a kettőt a közös `chainId` köti össze.
 */
export function continueRide(end: RideEnd, next: NextLeg): ActiveRide | null {
  if (!active) return null;
  const chainId = active.chainId ?? active.id;
  const done = closedRide(active, end, chainId);
  const ride: ActiveRide = {
    ...next,
    id: crypto.randomUUID(),
    serviceDate: active.serviceDate,
    vehicleId: active.vehicleId,
    fromIdx: 0,
    // a végállomáson ülve maradt: a felszállás helye biztos
    fromConfirmed: true,
    withBus: null,
    destIdx: null,
    detected: active.detected,
    chainId,
    leg: (active.leg ?? 1) + 1,
    turn: null,
  };
  rides = [done, ...rides.filter((x) => x.id !== done.id)].slice(0, MAX_LOCAL);
  write(RIDES_KEY, rides);
  setActive(ride);
  void syncRides();
  return ride;
}

export type RideFix = Partial<
  Pick<Ride, "fromStopId" | "fromStopName" | "toStopId" | "toStopName" | "boardedAt" | "alightedAt" | "stops" | "distanceM" | "delayAtBoardS" | "delayAtAlightS">
>;

/** Javítható-e még az utazás (körbeutazásnál bármelyik menete). */
export const canFixRide = (legs: readonly Ride[]) => legs.length > 0 && legs.every((r) => !r.editedAt);

/**
 * Utólagos javítás: hol szállt fel és le. Körbeutazásnál az egész út egyszerre
 * (`legIds` minden menete), menetenként a saját javításával.
 */
export function fixRide(legIds: readonly string[], fixes: Readonly<Record<string, RideFix>>): boolean {
  const ids = new Set(legIds);
  const legs = rides.filter((r) => ids.has(r.id));
  if (!canFixRide(legs)) return false;
  const editedAt = Math.round(Date.now() / 1000);
  setRides(
    rides
      .map((r) => (ids.has(r.id) ? { ...r, ...(fixes[r.id] ?? {}), editedAt, synced: false } : r))
      .sort((a, b) => b.boardedAt - a.boardedAt),
  );
  void syncRides();
  return true;
}

/**
 * Utólag felvett utazás (a menetrendből választott menet), körbeutazásnál az
 * összes menete — vagy egy meglévő út folytatása (a menetek `chainId`-ja annak az útnak a lánca).
 */
export function addRides(legs: readonly Ride[]) {
  if (!legs.length) return;
  const ids = new Set(legs.map((r) => r.id));
  setRides(
    [...legs.map((r): StoredRide => ({ ...r, synced: false })), ...rides.filter((r) => !ids.has(r.id))].sort((a, b) => b.boardedAt - a.boardedAt),
  );
  void syncRides();
}

/**
 * Egy út menetei sorrendben (körbeutazásnál mind). Egy utólag folytatott, addig
 * egymenetes utazás nem kap utólag `chainId`-t (egy javított utazás végleges):
 * a folytatás az ő azonosítóját viszi tovább, így az is a lánc első menete.
 */
export function journeyOf(all: readonly Ride[], ride: Ride): Ride[] {
  const key = ride.chainId ?? (all.some((r) => r.chainId === ride.id) ? ride.id : null);
  if (!key) return [ride];
  return all.filter((r) => r.chainId === key || r.id === key).sort((a, b) => a.boardedAt - b.boardedAt);
}

/** Utazások csoportosítva: a körbeutazás menetei egy utazásnak számítanak; legújabb elöl. */
export function groupJourneys(all: readonly Ride[]): Ride[][] {
  const heads = new Set(all.map((r) => r.chainId).filter((x): x is string => Boolean(x)));
  const chains = new Map<string, Ride[]>();
  const out: Ride[][] = [];
  for (const r of all) {
    const key = r.chainId ?? (heads.has(r.id) ? r.id : null);
    if (!key) {
      out.push([r]);
      continue;
    }
    const legs = chains.get(key);
    if (legs) legs.push(r);
    else {
      const fresh = [r];
      chains.set(key, fresh);
      out.push(fresh);
    }
  }
  for (const legs of chains.values()) legs.sort((a, b) => a.boardedAt - b.boardedAt);
  return out;
}

/** Mégsem szállt fel (téves felismerés): nyom nélkül eltűnik. */
export function cancelRide() {
  setActive(null);
}

export async function deleteRide(id: string) {
  const wasSynced = rides.some((r) => r.id === id && r.synced);
  setRides(rides.filter((r) => r.id !== id));
  if (!wasSynced && !getSession()) return;
  // Amíg a szerver nem erősíti meg a törlést, megjegyezzük — különben a következő szinkron visszahozná.
  setDeleted([...deleted.filter((x) => x !== id), id]);
  await flushDeletes();
}

async function flushDeletes() {
  const session = getSession();
  if (!session || !deleted.length) return;
  for (const id of [...deleted]) {
    const res = await fetch(`${API_BASE}/v3/rides/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Account-Session": session.sessionToken },
    }).catch(() => null);
    if (!res?.ok) return; // offline / lejárt munkamenet: a következő szinkron újrapróbálja
    setDeleted(deleted.filter((x) => x !== id));
  }
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
  await flushDeletes();
  const res = await fetch(`${API_BASE}/v3/rides`, { headers }).catch(() => null);
  if (!res?.ok) return;
  const body = (await res.json().catch(() => null)) as { rides?: Ride[] } | null;
  if (!body || !Array.isArray(body.rides)) return;
  const remote = body.rides;
  const gone = new Set(deleted);
  const remoteIds = new Set(remote.map((r) => r.id));
  // A teljes lista jött (a szerver legfeljebb 5000-et ad): ami nálunk feltöltöttként
  // szerepel, de a szerveren már nincs, azt egy másik eszközön törölték.
  const complete = remote.length < 5000;
  const byId = new Map<string, StoredRide>();
  for (const r of rides) {
    const synced = r.synced || saved.has(r.id);
    if (synced && complete && !remoteIds.has(r.id) && !saved.has(r.id)) continue;
    byId.set(r.id, synced ? { ...r, synced: true } : r);
  }
  for (const r of remote) if (!gone.has(r.id)) byId.set(r.id, { ...r, synced: true });
  setRides([...byId.values()].sort((a, b) => b.boardedAt - a.boardedAt));
}

// Bejelentkezéskor (vagy egy másik fülön történt belépéskor) azonnal szinkronizálunk.
if (typeof window !== "undefined") {
  window.addEventListener("mvk-session-change", () => void syncRides());
  // Kijelentkezéskor a fiók (már feltöltött) utazásai lekerülnek az eszközről —
  // a felhőben megmaradnak. A még fel nem töltöttek itt maradnak, hogy ne vesszenek el.
  window.addEventListener("mvk-rides-reset", () => {
    setDeleted([]);
    setActive(null);
    setRides(rides.filter((r) => !r.synced));
  });
}
