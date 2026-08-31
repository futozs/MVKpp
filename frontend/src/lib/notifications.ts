import type { ArrivalItem } from "@/types";

const STORAGE_KEY = "mvk_notify_watches";
export const DEFAULT_THRESHOLD_MIN = 5;

export type NotifyWatch = {
  stopId: string;
  stopName: string;
  thresholdMin: number;
  /** Ha üres, bármelyik következő busz jó; ha megadott, csak ez a jármű. */
  vehicleId?: string;
  /** Az utoljára riasztott menet tripId-je — ez véd az ismételt riasztás ellen. */
  lastNotifiedTripId?: string;
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
  watch: Omit<NotifyWatch, "stopId" | "lastNotifiedTripId"> | null,
): void {
  const all = readAll();
  if (!watch) {
    delete all[stopId];
  } else {
    all[stopId] = { ...watch, stopId };
  }
  writeAll(all);
}

function markNotified(stopId: string, tripId: string): void {
  const all = readAll();
  const w = all[stopId];
  if (!w) return;
  all[stopId] = { ...w, lastNotifiedTripId: tripId };
  writeAll(all);
}

/**
 * A StopCard minden sikeres lekérés után meghívja. Ha az adott megállóra van
 * beállított figyelés, és a megfelelő busz (bármelyik, vagy a kijelölt
 * jármű) a küszöbidőn belülre ért, egy natív böngésző-értesítést dob — de
 * menetenként csak egyszer (a `lastNotifiedTripId` védi az ismétlést, amíg a
 * busz be nem érkezik és egy új menet nem kerül a küszöb alá).
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

  const candidate = watch.vehicleId
    ? arrivals.find(
        (a) => a.vehicle?.id?.trim() === watch.vehicleId?.trim(),
      )
    : arrivals[0];
  if (!candidate) return;
  if (candidate.tripId === watch.lastNotifiedTripId) return;
  if (candidate.etaMin > watch.thresholdMin || candidate.etaMin < 0) return;

  const title = watch.vehicleId
    ? `${watch.vehicleId} jármű közeleg`
    : `${candidate.route} busz közeleg`;
  const body = `${candidate.route} (${candidate.headsign}) kb. ${Math.max(0, Math.round(candidate.etaMin))} percen belül ideér: ${stopName}`;

  try {
    new Notification(title, {
      body,
      tag: `mvk-stop-${stopId}`,
      icon: "/icon-192.png",
    });
  } catch {
    // Néhány böngésző (pl. háttérben lévő mobil tab) eldobhatja — nem kritikus.
  }
  markNotified(stopId, candidate.tripId);
}
