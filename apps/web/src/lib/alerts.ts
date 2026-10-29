/**
 * A különleges értesítések ezen az eszközön: „indulj most” (a sétaidővel),
 * dugó a megálló felé tartó busz előtt, veszélybe került átszállás. A szerver
 * push-figyelése a forrás; itt csak azt tartjuk, mit kapcsolt be a felhasználó
 * (és hogy a push sikerült-e — ha nem, nyitott oldalnál helyben szólunk).
 */
import { useSyncExternalStore } from "react";
import { notificationPermission, requestNotificationPermission } from "@/lib/notifications";
import { registerPushWatch, unregisterPushWatch, type PushDiagnostic, type PushWatchKind } from "@/lib/push";

const KEY = "mvk_alert_watches";
const EVENT = "mvk-alerts-change";
const EMPTY: AlertWatch[] = [];

export type AlertWatch = {
  /** egyedi a megállón belül: `leave:<trip>`, `traffic`, `transfer:<trip>`, `commute:<…>` */
  slot: string;
  kind: Exclude<PushWatchKind, "arrival">;
  stopId: string;
  stopName: string;
  tripId?: string;
  routeShorts?: string[];
  /** ismétlődő (naponta ugyanakkor) */
  schedMin?: number;
  params?: Record<string, unknown>;
  pushRegistered: boolean;
  /** helyi értesítés már ment erre a menetre (push nélkül) */
  notifiedTripIds?: string[];
  createdAt: number;
};

function readAll(): AlertWatch[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as AlertWatch[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

let cache: AlertWatch[] | null = null;
function writeAll(list: AlertWatch[]) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* privát mód: a memóriában marad */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function listAlerts(): AlertWatch[] {
  cache ??= readAll();
  return cache;
}

const keyOf = (stopId: string, slot: string) => `${stopId}|${slot}`;

export function findAlert(stopId: string, slot: string): AlertWatch | null {
  return listAlerts().find((a) => keyOf(a.stopId, a.slot) === keyOf(stopId, slot)) ?? null;
}

/** A bekapcsolt értesítések (újrarajzol, ha változnak — másik lapon is). */
export function useAlerts(): AlertWatch[] {
  return useSyncExternalStore(
    (cb) => {
      const onStorage = (e: StorageEvent) => {
        if (e.key !== KEY) return;
        cache = null;
        cb();
      };
      window.addEventListener(EVENT, cb);
      window.addEventListener("storage", onStorage);
      return () => {
        window.removeEventListener(EVENT, cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    listAlerts,
    () => EMPTY,
  );
}

export type AddAlertResult = { ok: boolean; push: boolean; reason?: string };

/** Bekapcsolás: engedélyt kér, push-figyelést ment a szerverre; push nélkül helyben szól (nyitott oldalnál). */
export async function addAlert(a: Omit<AlertWatch, "pushRegistered" | "createdAt" | "notifiedTripIds">): Promise<AddAlertResult> {
  const granted = await requestNotificationPermission();
  if (!granted) return { ok: false, push: false, reason: notificationPermission() === "denied" ? "Az értesítések le vannak tiltva a böngészőben." : "Az értesítéshez engedély kell." };
  const diag: PushDiagnostic = await registerPushWatch({
    stopId: a.stopId,
    stopName: a.stopName,
    thresholdMin: 5,
    routeShorts: a.routeShorts,
    tripId: a.tripId,
    schedMin: a.schedMin,
    slot: a.slot,
    kind: a.kind,
    params: a.params,
  });
  const rest = listAlerts().filter((x) => keyOf(x.stopId, x.slot) !== keyOf(a.stopId, a.slot));
  writeAll([...rest, { ...a, pushRegistered: diag.ok, createdAt: Date.now() }]);
  return { ok: true, push: diag.ok, reason: diag.ok ? undefined : diag.reason };
}

/** Miért nem jön értesítés zárt appnál (a „push nélkül” megjegyzéshez). */
export function noPushNote(r: AddAlertResult): string {
  return r.reason ? `Csak nyitott oldalnál szólok: ${r.reason}` : "Push nélkül csak akkor szólok, ha nyitva van az oldal.";
}

export async function removeAlert(stopId: string, slot: string): Promise<void> {
  writeAll(listAlerts().filter((x) => keyOf(x.stopId, x.slot) !== keyOf(stopId, slot)));
  await unregisterPushWatch(stopId, slot);
}

/** Helyi (push nélküli) értesítés egyszer egy menetre; igaz, ha most szólt. */
export function notifyLocallyOnce(stopId: string, slot: string, tripId: string, title: string, body: string): boolean {
  const a = findAlert(stopId, slot);
  if (!a || a.pushRegistered || a.notifiedTripIds?.includes(tripId)) return false;
  if (notificationPermission() !== "granted") return false;
  try {
    new Notification(title, { body, tag: `mvk-${slot}-${tripId}`.slice(0, 60), icon: "/icon-192.png" });
  } catch {
    return false;
  }
  writeAll(listAlerts().map((x) => (x === a ? { ...x, notifiedTripIds: [...(x.notifiedTripIds ?? []).slice(-20), tripId] } : x)));
  return true;
}

/** A lejárt egyszeri (menethez kötött) figyelések kitakarítása — a szerver is törli őket. */
export function pruneAlerts(maxAgeMs = 4 * 3600_000) {
  const now = Date.now();
  const list = listAlerts();
  const keep = list.filter((a) => a.schedMin != null || a.kind === "traffic" || now - a.createdAt < maxAgeMs);
  if (keep.length !== list.length) writeAll(keep);
}
