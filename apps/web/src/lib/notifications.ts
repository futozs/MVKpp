import type { ArrivalItem } from "@/types";
import { budapestMinuteOfDay } from "@/lib/serviceDay";
import { withHungarianSuffix } from "@/lib/utils";

const STORAGE_KEY = "mvk_notify_watches";
export const DEFAULT_THRESHOLD_MIN = 5;
const DELAY_MENTION_THRESHOLD_S = 60;
const RECURRING_WINDOW_MIN = 4;

function minuteDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 1440 - d);
}

function delaySuffix(delaySec: number | null): string {
  if (delaySec == null || Math.abs(delaySec) < DELAY_MENTION_THRESHOLD_S) return "";
  const min = Math.round(Math.abs(delaySec) / 60);
  return delaySec > 0 ? ` (${min} perc késés)` : ` (${min} perccel korábban)`;
}

export type NotifyWatch = {
  stopId: string;
  stopName: string;
  thresholdMin: number;
  routeShorts?: string[];
  tripId?: string;
  isDeparture?: boolean;
  schedMin?: number;
  lastNotifiedTripIds?: string[];
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
  }
}

export function getWatch(stopId: string): NotifyWatch | null {
  return readAll()[stopId] ?? null;
}

export function getAllWatches(): NotifyWatch[] {
  return Object.values(readAll());
}

export function removeWatch(stopId: string): void {
  const all = readAll();
  delete all[stopId];
  writeAll(all);
}


const SETTINGS_KEY = "mvk_notify_settings";

export type NotificationSettings = {
  enabled: boolean;
  dnd: {
    enabled: boolean;
    startMin: number;
    endMin: number;
  };
};

const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  dnd: { enabled: false, startMin: 22 * 60, endMin: 7 * 60 },
};

export function getNotificationSettings(): NotificationSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
    return {
      enabled: parsed.enabled ?? DEFAULT_SETTINGS.enabled,
      dnd: { ...DEFAULT_SETTINGS.dnd, ...parsed.dnd },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function setNotificationSettings(settings: NotificationSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
  }
}

export function isWithinDnd(
  dnd: NotificationSettings["dnd"],
  now: Date = new Date(),
): boolean {
  if (!dnd.enabled || dnd.startMin === dnd.endMin) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (dnd.startMin < dnd.endMin) {
    return nowMin >= dnd.startMin && nowMin < dnd.endMin;
  }
  return nowMin >= dnd.startMin || nowMin < dnd.endMin;
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


export function checkAndNotify(
  stopId: string,
  stopName: string,
  arrivals: ArrivalItem[],
): void {
  if (notificationPermission() !== "granted") return;
  const settings = getNotificationSettings();
  if (!settings.enabled || isWithinDnd(settings.dnd)) return;
  const watch = getWatch(stopId);
  if (!watch) return;
  if (watch.pushRegistered) return;

  const nowMin = budapestMinuteOfDay();
  const matches = arrivals.filter((a) => {
    // A törölt menet nem érkezik meg — arra nem szólunk (a push-oldal is így szűr).
    if (a.cancelled) return false;
    if (watch.schedMin != null) {
      if (watch.routeShorts?.length && !watch.routeShorts.includes(a.route)) return false;
      const delayMin = Math.round((a.delaySec ?? 0) / 60);
      const schedMin = (((nowMin + a.etaMin - delayMin) % 1440) + 1440) % 1440;
      if (minuteDistance(schedMin, watch.schedMin) > RECURRING_WINDOW_MIN) return false;
    } else if (watch.tripId) {
      if (a.tripId !== watch.tripId) return false;
    } else if (watch.routeShorts?.length && !watch.routeShorts.includes(a.route)) {
      return false;
    }
    return a.etaMin >= 0 && a.etaMin <= watch.thresholdMin;
  });
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
    const delayNote = fresh.length === 1 ? delaySuffix(fresh[0].delaySec) : "";
    const isSchedulePinned = watch.tripId != null || watch.schedMin != null;
    const body = isSchedulePinned
      ? `kb. ${minEta} percen belül ${watch.isDeparture ? "indul" : "ér ide"}${delayNote} — ${stopName} (${stopId})`
      : `${stopName} (${stopId}) — kb. ${minEta} percen belül${delayNote}`;

    try {
      new Notification(title, {
        body,
        tag: `mvk-stop-${stopId}`,
        icon: "/icon-192.png",
      });
    } catch {
    }
  }

  updateNotifiedTripIds(
    stopId,
    matches.map((a) => a.tripId),
  );
}
