/**
 * Névtelen használati jel a rendszer-hubnak (POST /v3/usage).
 *
 * Megnyitáskor, utána percenként (csak ha volt új nézet vagy a kedvencek
 * változtak), és amikor az app háttérbe kerül. Küldi: az eszköz véletlen
 * azonosítóját, hogy telepített appként fut-e, a megnyitott nézeteket és a
 * kedvencek pillanatképét. Helyet, IP-t, keresést nem küld.
 */
import { API_BASE } from "@/lib/apiBase";
import { getSession } from "@/lib/account";
import { deviceId } from "@/lib/sync";

/** pillanatkép-mező → localStorage-kulcs */
const FAVORITE_KEYS = {
  lines: "mvk_timetable_favorites",
  stops: "mvk_monitored_stops",
  statStops: "mvk_stats_favorite_stops",
  vehicles: "mvk_stats_favorite_vehicles",
  parking: "mvk_parking_favorites",
  kiosk: "mvk_kiosk_stops",
} as const;
const FLUSH_MS = 60_000;
const URL_PATH = "/v3/usage";

let views: Record<string, number> = {};
let lastFavorites: string | null = null;
let started = false;

function readList(key: string): unknown[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function favoritesSnapshot(): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(FAVORITE_KEYS).map(([field, key]) => [field, readList(key)]));
}

function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

function send(open: boolean, beacon: boolean): void {
  let id: string;
  try {
    id = deviceId();
  } catch {
    return; // nincs localStorage (privát mód) — nincs mit azonosítani
  }
  const favorites = favoritesSnapshot();
  const favJson = JSON.stringify(favorites);
  const favChanged = favJson !== lastFavorites;
  if (!open && !favChanged && Object.keys(views).length === 0) return;

  const body = JSON.stringify({
    deviceId: id,
    open,
    standalone: isStandalone(),
    lang: navigator.language,
    screen: `${window.screen.width}x${window.screen.height}`,
    views,
    favorites: favChanged ? favorites : undefined,
  });
  views = {};
  lastFavorites = favJson;

  if (beacon && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(API_BASE + URL_PATH, new Blob([body], { type: "application/json" }));
    return;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  const session = open ? getSession() : null;
  if (session) headers["x-account-session"] = session.sessionToken;
  fetch(API_BASE + URL_PATH, { method: "POST", headers, body, keepalive: true }).catch(() => {
    /* a használati jel elveszhet — nem baj */
  });
}

/** Egy nézet megnyitása (fül, kijelző, stb.) — a következő jel viszi. */
export function trackView(view: string): void {
  views = { ...views, [view]: (views[view] ?? 0) + 1 };
}

export function startUsage(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  send(true, false);
  setInterval(() => send(false, false), FLUSH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") send(false, true);
  });
}
