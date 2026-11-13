/**
 * POST /v3/usage  névtelen használati jel a webappból a rendszer-hubnak.
 *
 * Mit tárol: az eszköz véletlen azonosítóját (mvk_device_id), a platformot és
 * böngészőt (a User-Agentből), hogy telepített PWA-e, mely nézeteket nyitotta
 * meg, és a kedvencei pillanatképét. IP-címet NEM tárol. Bejelentkezve az
 * eszköz a fiókhoz kötődik (így a hub a felhasználónál is mutatja).
 */
import { sql } from "@mvk/db";
import { sessionUser } from "./account.ts";
import { dispatch, json, route, type Route } from "./http.ts";

const DEVICE_RE = /^[\w-]{8,64}$/;
const VIEW_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const ID_RE = /^[\w:.|-]{1,64}$/;
const MAX_VIEWS = 16;
const MAX_FAV_ITEMS = 40;
const MIN_INTERVAL_MS = 8_000;
const MAX_TRACKED = 50_000;
/** egy jel legfeljebb ekkora lehet (a Caddy is levágja a nagyobbat) */
const MAX_BODY_BYTES = 8_192;
/** egy címről óránként legfeljebb ennyi KÜLÖNBÖZŐ eszköz (egy családi Wi-Fi bőven belefér) */
const NEW_DEVICES_PER_IP_HOUR = 20;
/** az egész rendszerre percenként legfeljebb ennyi még nem látott eszköz (tömeges hamisítás ellen) */
const NEW_DEVICES_PER_MIN = 300;

export type FavoriteSnapshot = {
  lines: { routeId: string; dir: string }[];
  stops: string[];
  statStops: string[];
  vehicles: string[];
  parking: string[];
  kiosk: string[];
};

type UsageIn = {
  deviceId?: unknown;
  open?: unknown;
  standalone?: unknown;
  lang?: unknown;
  screen?: unknown;
  views?: unknown;
  favorites?: unknown;
};

const lastSeen = new Map<string, number>();

export function platformOf(ua: string): string {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Macintosh|Mac OS X/i.test(ua)) return /Mobile\//.test(ua) ? "ios" : "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|CrOS/i.test(ua)) return "linux";
  return "other";
}

export function browserOf(ua: string): string {
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\/|Opera/.test(ua)) return "opera";
  if (/SamsungBrowser/.test(ua)) return "samsung";
  if (/Firefox\/|FxiOS/.test(ua)) return "firefox";
  if (/CriOS|Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && ID_RE.test(x)))].slice(0, MAX_FAV_ITEMS) : [];

/** A kliens kedvenc-pillanatképe, szigorúan megszűrve (ismeretlen mező / túl hosszú elem kimarad). */
export function cleanFavorites(v: unknown): FavoriteSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  const lines = Array.isArray(f.lines)
    ? f.lines
        .filter((x): x is { routeId: string; dir: string } => {
          const l = x as Record<string, unknown> | null;
          return typeof l?.routeId === "string" && ID_RE.test(l.routeId) && typeof l.dir === "string" && /^[\w-]{0,8}$/.test(l.dir);
        })
        .map((l) => ({ routeId: l.routeId, dir: l.dir }))
        .slice(0, MAX_FAV_ITEMS)
    : [];
  return { lines, stops: ids(f.stops), statStops: ids(f.statStops), vehicles: ids(f.vehicles), parking: ids(f.parking), kiosk: ids(f.kiosk) };
}

export function cleanViews(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(0, MAX_VIEWS)) {
    if (VIEW_RE.test(k) && typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = Math.min(500, Math.round(n));
  }
  return out;
}

/** Korlátos Map: a legrégebben beírt kulcsot dobja el (nem üríti ki egyszerre  az kinyitná a korlátot). */
function remember<V>(m: Map<string, V>, key: string, value: V): void {
  m.delete(key);
  m.set(key, value);
  if (m.size > MAX_TRACKED) m.delete(m.keys().next().value as string);
}

/** A cím, amire korlátozunk: IPv4-nél maga a cím, IPv6-nál a /64 előtag (egy előfizető egész tartománya). */
export function clientKey(req: Request): string {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  if (!ip.includes(":")) return ip;
  return ip.split(":").slice(0, 4).join(":");
}

const perIp = new Map<string, { n: number; reset: number }>();
const IP_PER_MIN = 60;

/** Címenként percenként legfeljebb 60 jel (a cím csak memóriában, ehhez a kerethez él). */
function ipLimited(ip: string, now: number): boolean {
  const b = perIp.get(ip);
  if (!b || now > b.reset) {
    remember(perIp, ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  b.n++;
  return b.n > IP_PER_MIN;
}

const devicesByIp = new Map<string, { ids: Set<string>; reset: number }>();
const seenDevices = new Map<string, number>();
let globalNew = { n: 0, reset: 0 };

/** Új (ebben a folyamatban még nem látott) eszköz: címenként és összesen is korlátozva. */
function newDeviceBlocked(ip: string, deviceId: string, now: number): boolean {
  if (seenDevices.has(deviceId)) return false;
  const b = devicesByIp.get(ip);
  const entry = !b || now > b.reset ? { ids: new Set<string>(), reset: now + 3_600_000 } : b;
  if (!entry.ids.has(deviceId) && entry.ids.size >= NEW_DEVICES_PER_IP_HOUR) return true;
  if (now > globalNew.reset) globalNew = { n: 0, reset: now + 60_000 };
  if (globalNew.n >= NEW_DEVICES_PER_MIN) return true;
  globalNew.n++;
  entry.ids.add(deviceId);
  remember(devicesByIp, ip, entry);
  remember(seenDevices, deviceId, now);
  return false;
}

/** Eszközönként legfeljebb ~8 mp-enként egy jel; a többit csendben eldobjuk. */
function throttled(deviceId: string, now: number): boolean {
  const last = lastSeen.get(deviceId) ?? 0;
  if (now - last < MIN_INTERVAL_MS) return true;
  remember(lastSeen, deviceId, now);
  return false;
}

async function readCapped(req: Request): Promise<UsageIn | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as UsageIn) : null;
  } catch {
    return null;
  }
}

const routes: Route[] = [
  route("POST", "/v3/usage", async (req) => {
    const b = await readCapped(req);
    const deviceId = typeof b?.deviceId === "string" && DEVICE_RE.test(b.deviceId) ? b.deviceId : null;
    if (!b || !deviceId) return json({ ok: false }, 400);
    const now = Date.now();
    const ip = clientKey(req);
    if (ipLimited(ip, now)) return json({ ok: false }, 429);
    // Tömeges, kitalált eszközazonosítók: csendben eldobjuk (a statisztika nem szennyeződik, a lemez nem telik).
    if (newDeviceBlocked(ip, deviceId, now)) return new Response(null, { status: 204 });
    const opened = b.open === true;
    // A megnyitás és a kedvencek változása mindig átmegy, a puszta nézet-jel ritkítva.
    if (!opened && !b.favorites && throttled(deviceId, now)) return new Response(null, { status: 204 });

    const ua = req.headers.get("user-agent") ?? "";
    // A munkamenetet csak megnyitáskor nézzük meg (nem minden jelnél).
    const user = opened ? await sessionUser(req).catch(() => null) : null;
    const favorites = cleanFavorites(b.favorites);
    await sql(
      `INSERT INTO usage_device (device_id, user_id, platform, browser, standalone, lang, screen, opens, favorites, favorites_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, CASE WHEN $9::jsonb IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (device_id) DO UPDATE SET
         last_seen = now(),
         user_id = COALESCE(EXCLUDED.user_id, usage_device.user_id),
         platform = EXCLUDED.platform, browser = EXCLUDED.browser,
         standalone = EXCLUDED.standalone,
         lang = COALESCE(EXCLUDED.lang, usage_device.lang),
         screen = COALESCE(EXCLUDED.screen, usage_device.screen),
         opens = usage_device.opens + EXCLUDED.opens,
         favorites = COALESCE(EXCLUDED.favorites, usage_device.favorites),
         favorites_at = CASE WHEN EXCLUDED.favorites IS NULL THEN usage_device.favorites_at ELSE now() END`,
      [
        deviceId,
        user?.id ?? null,
        platformOf(ua),
        browserOf(ua),
        b.standalone === true,
        typeof b.lang === "string" ? b.lang.slice(0, 16) : null,
        typeof b.screen === "string" && /^\d{2,5}x\d{2,5}$/.test(b.screen) ? b.screen : null,
        opened ? 1 : 0,
        favorites ? JSON.stringify(favorites) : null,
      ],
    );
    await sql(
      `INSERT INTO usage_day (day, device_id, first_at, last_at, hits, views)
       VALUES ((now() AT TIME ZONE 'Europe/Budapest')::date, $1, now(), now(), 1, $2::jsonb)
       ON CONFLICT (day, device_id) DO UPDATE SET
         last_at = now(),
         hits = usage_day.hits + 1,
         views = (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) FROM (
                    SELECT k, SUM(v::int) AS n FROM (
                      SELECT * FROM jsonb_each_text(usage_day.views)
                      UNION ALL SELECT * FROM jsonb_each_text(EXCLUDED.views)) x(k, v)
                    GROUP BY k) y)`,
      [deviceId, JSON.stringify(cleanViews(b.views))],
    );
    return new Response(null, { status: 204 });
  }),
];

export const handleUsage = (req: Request) => dispatch(routes, req);
