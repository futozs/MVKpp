import type { ArrivalItem } from "@/types";
import { withHungarianSuffix } from "@/lib/utils";

const STORAGE_KEY = "mvk_notify_watches";
export const DEFAULT_THRESHOLD_MIN = 5;

export type NotifyWatch = {
  stopId: string;
  stopName: string;
  thresholdMin: number;
  /** Ha üres/hiányzik, bármelyik vonal jó; ha van benne elem, csak ezekre a járatszámokra szól. */
  routeShorts?: string[];
  /**
   * Ha megadott, csak ez a pontos menetrendi menet vált ki riasztást (a
   * menetrend fülről beállítva) — felülírja a routeShorts szűrést, mert
   * egyértelműen csak arra AZ EGY indulásra kell szólni.
   */
  tripId?: string;
  /** A legutóbb riasztott menetek tripId-jei — védenek az ismételt riasztás ellen. */
  lastNotifiedTripIds?: string[];
  /**
   * Sikerült-e a szerveren is regisztrálni ezt a figyelést push-ra. Ha igen,
   * a helyi (nyitott lapos) Notification API NEM dob saját értesítést —
   * különben ugyanarra a buszra két értesítés jönne (egy helyi, egy push),
   * amíg a lap nyitva van. Csak akkor esünk vissza a helyi útra, ha a push
   * regisztráció nem sikerült.
   */
  pushRegistered?: boolean;
};

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const perm = await Notification.requestPermission();
  return perm === "granted";
}

function readAll(): Record<string, NotifyWatch> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, NotifyWatch>) : {};
  } catch {
    return {};
  }
}

function writeAll(watches: Record<string, NotifyWatch>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(watches));
  } catch {
    // localStorage megtelt vagy tiltott — a figyelmeztetés csendben elmarad.
  }
}

export function getWatch(stopId: string): NotifyWatch | null {
  return readAll()[stopId] ?? null;
}

export function setWatch(
  stopId: string,
  watch: Omit<NotifyWatch, "stopId" | "lastNotifiedTripIds"> | null,
): void {
  const all = readAll();
  if (!watch) {
    delete all[stopId];
  } else {
    all[stopId] = { ...watch, stopId };
  }
  writeAll(all);
}

function updateNotifiedTripIds(stopId: string, tripIds: string[]): void {
  const all = readAll();
  const w = all[stopId];
  if (!w) return;
  all[stopId] = { ...w, lastNotifiedTripIds: tripIds };
  writeAll(all);
}

export function setPushRegistered(stopId: string, ok: boolean): void {
  const all = readAll();
  const w = all[stopId];
  if (!w) return;
  all[stopId] = { ...w, pushRegistered: ok };
  writeAll(all);
}


/**
 * A StopCard minden sikeres lekérés után meghívja. Ha az adott megállóra van
 * beállított figyelés, megnézi, mely érkezések esnek a küszöbidőn belülre
 * (a beállított járatszámra szűkítve, ha van ilyen megadva), és HA VAN ÚJ
 * (még nem riasztott) találat, egyetlen rövid értesítést dob — a járat-
 * számokkal és a megállóval, iránymegjelölés nélkül. Egy adott menet
 * (tripId) csak egyszer vált ki riasztást, amíg be nem érkezik.
 *
 * Figyelem: ez a bejelentkezés csak addig működik, amíg az oldal/lap nyitva
 * (vagy háttérben fut a böngészőben) — teljesen bezárt alkalmazásból nem jön
 * push-értesítés, mert ehhez saját push-szerver infrastruktúra kellene.
 */
export function checkAndNotify(
  stopId: string,
  stopName: string,
  arrivals: ArrivalItem[],
): void {
  if (notificationPermission() !== "granted") return;
  const watch = getWatch(stopId);
  if (!watch) return;
  // Ha a push-regisztráció sikerült, a szerver saját maga küld értesítést —
  // ha itt is dobnánk egyet, amíg a lap nyitva van, duplán jönne.
  if (watch.pushRegistered) return;

  const matches = arrivals.filter(
    (a) =>
      (watch.tripId
        ? a.tripId === watch.tripId
        : !watch.routeShorts?.length || watch.routeShorts.includes(a.route)) &&
      a.etaMin >= 0 &&
      a.etaMin <= watch.thresholdMin,
  );
  if (!matches.length) return;

  const already = new Set(watch.lastNotifiedTripIds ?? []);
  const fresh = matches.filter((a) => !already.has(a.tripId));

  if (fresh.length) {
    const minEta = Math.max(0, Math.round(Math.min(...fresh.map((a) => a.etaMin))));
    const label = (a: ArrivalItem) =>
      a.vehicle?.id
        ? `${withHungarianSuffix(a.route)} busz (${a.vehicle.id})`
        : `${withHungarianSuffix(a.route)} busz`;
    const title =
      fresh.length > 1
        ? `${fresh.map(label).join(", ")}`
        : label(fresh[0]);
    const body = watch.tripId
      ? `kb. ${minEta} percen belül indul — ${stopName} (${stopId})`
      : `${stopName} (${stopId}) — kb. ${minEta} percen belül`;

    try {
      new Notification(title, {
        body,
        tag: `mvk-stop-${stopId}`,
        icon: "/icon-192.png",
      });
    } catch {
      // Néhány böngésző (pl. háttérben lévő mobil tab) eldobhatja — nem kritikus.
    }
  }

  // A jelenlegi küszöbön belüli menetek listája lesz az új "riasztott" halmaz —
  // ha egy busz kikerül innen (megérkezett), a helyére kerülő új menet ismét
  // kiválthat riasztást.
  updateNotifiedTripIds(
    stopId,
    matches.map((a) => a.tripId),
  );
}
